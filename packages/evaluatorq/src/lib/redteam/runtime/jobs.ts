import type { Span } from "@opentelemetry/api";

import type { Orq } from "@orq-ai/node";

import { envRaw } from "../../common/env-config.js";
import { getField } from "../../common/fields.js";
import { coerceContentText } from "../../common/messages.js";
import { priceUsage } from "../../common/model-catalogue.js";
import { resolveOrqClient } from "../../common/orq-client.js";
import { withRetry } from "../../common/retry.js";
import {
  callTargetWithRetry,
  closeTarget,
  defaultMapError,
  extractStatusCode,
  type MappedError,
} from "../../common/target-call.js";
import {
  buildStaticThreadId,
  conversationThread,
  pipelineMetadataParam,
  threadBodyParam,
} from "../../common/thread-context.js";
import {
  getTraceContextHeaders,
  recordLlmResponse,
  setSpanAttrs,
  truncateForSpan,
} from "../../common/tracing.js";
import {
  type AgentTarget,
  extractUsage,
  MessageSchema,
} from "../../contracts.js";
import { job } from "../../job-helper.js";
import type { DataPoint, Job } from "../../types.js";
import { getActiveProgress } from "../adaptive/progress.js";
import { makeAgentBackend } from "../backends/registry.js";
import { type LLMConfig, PIPELINE_CONFIG } from "../config.js";
import { parseTarget, TargetKind } from "../contracts.js";
import { CredentialError } from "../exceptions.js";
import { TargetConfigSchema } from "../input.js";
import { withRedteamLlmSpan, withRedteamSpan } from "../tracing.js";

export function sanitizeJobName(value: string): string {
  return (
    value.replace(/[^\p{L}\p{N}_-]/gu, "-").replace(/^-+|-+$/g, "") || "unknown"
  );
}
export function buildStaticMessages(
  data: DataPoint,
): Record<string, unknown>[] {
  const raw = data.inputs.messages ?? [];
  if (!Array.isArray(raw))
    throw new TypeError("Static datapoint messages must be an array");
  return raw.map((message) => {
    if (
      message !== null &&
      typeof message === "object" &&
      !Array.isArray(message)
    ) {
      const parsed = MessageSchema.safeParse(message);
      return parsed.success
        ? Object.fromEntries(
            Object.entries(parsed.data).filter(([, value]) => value !== null),
          )
        : { ...message };
    }
    console.warn(
      `Unexpected message type ${typeof message} in DataPoint, coercing to string`,
    );
    return { role: "user", content: String(message) };
  });
}
export function extractStaticPrompt(data: DataPoint): string {
  return buildStaticMessages(data)
    .filter((message) => message.role !== "system" && message.content != null)
    .map((message) => coerceContentText(message.content))
    .filter(Boolean)
    .join("\n\n");
}
function staticAttackAttrs(data: DataPoint) {
  return {
    "orq.redteam.category": String(data.inputs.category ?? ""),
    "orq.redteam.vulnerability": String(
      data.inputs.vulnerability ?? data.inputs.category ?? "",
    ),
    "orq.redteam.strategy_name": String(
      data.inputs.strategyName ?? data.inputs.strategy_name ?? "",
    ),
  };
}
export async function staticTargetSpans<T>(
  data: DataPoint,
  safe: string,
  runId: string | null | undefined,
  row: number,
  targetInput: string,
  fn: (span: Span | undefined, threadId: string) => Promise<T>,
): Promise<T> {
  const attributes = staticAttackAttrs(data),
    threadId = buildStaticThreadId(runId, safe, row);
  return withRedteamSpan("orq.redteam.attack", attributes, () =>
    withRedteamSpan(
      "orq.redteam.target_call",
      { ...attributes, input: targetInput, "orq.redteam.input": targetInput },
      (span) => conversationThread(threadId, (id) => fn(span, id)),
    ),
  );
}
export interface StaticTargetJobOptions {
  pipelineConfig?: LLMConfig | null;
  mapError?: (error: unknown) => MappedError | null | undefined;
  runId?: string | null;
  signal?: AbortSignal;
}
export function createStaticJobForAgentTarget(
  targetFactory: () => AgentTarget,
  label: string,
  options: StaticTargetJobOptions = {},
): Job {
  const safe = sanitizeJobName(label),
    cfg = options.pipelineConfig ?? PIPELINE_CONFIG;
  return job(`redteam:static:${safe}`, async (data, row) => {
    options.signal?.throwIfAborted();
    const prompt = extractStaticPrompt(data);
    if (!prompt)
      throw new RangeError(
        `Static datapoint ${JSON.stringify(data.inputs.id ?? "unknown")} for target ${JSON.stringify(label)} produced an empty prompt (${buildStaticMessages(data).length} messages, none with user content).`,
      );
    const target = targetFactory();
    try {
      return await staticTargetSpans(
        data,
        safe,
        options.runId,
        row,
        truncateForSpan(prompt),
        (targetSpan, threadId) =>
          withRedteamSpan(
            `agent ${label}`,
            {
              "orq.redteam.llm_purpose": "target",
              input: truncateForSpan(prompt),
              "orq.redteam.input": truncateForSpan(prompt),
            },
            async (agentSpan) => {
              const call = await callTargetWithRetry(
                target,
                [MessageSchema.parse({ role: "user", content: prompt })],
                {
                  targetAgentTimeoutMs: cfg.targetAgentTimeoutMs,
                  maxTargetRetries: cfg.maxTargetRetries,
                  mapError: options.mapError ?? defaultMapError,
                  signal: options.signal,
                },
              );
              await getActiveProgress()?.finishAttack(null);
              const response = call.response,
                errors = call.errorPayload();
              const attrs =
                errors.error !== null
                  ? {
                      "orq.redteam.error_type": errors.errorType,
                      "orq.redteam.error_code": errors.errorCode,
                    }
                  : {
                      output: truncateForSpan(response.text),
                      "orq.redteam.output": truncateForSpan(response.text),
                    };
              setSpanAttrs(targetSpan, attrs);
              setSpanAttrs(agentSpan, attrs);
              return {
                response: response.text,
                ...errors,
                toolCalls: response.toolCalls,
                tokenUsage: response.usage,
                finishReason: response.finishReason,
                model: response.model,
                threadId,
              };
            },
          ),
      );
    } finally {
      await closeTarget(target);
    }
  });
}
function deploymentMessages(
  messages: Record<string, unknown>[],
): Parameters<Orq["deployments"]["invoke"]>[0]["messages"] {
  return messages.map((message) => {
    const { tool_calls: calls, tool_call_id: callId, ...raw } = message;
    if (message.role === "tool") return { ...raw, toolCallId: callId };
    if (message.role === "assistant" && Array.isArray(calls))
      return {
        ...raw,
        toolCalls: calls.map((call) => ({
          id: getField(call, "id"),
          type: "function",
          function: getField(call, "function"),
        })),
      };
    return raw;
  }) as Parameters<Orq["deployments"]["invoke"]>[0]["messages"];
}
export function extractDeploymentContent(response: unknown): string {
  const choices = getField(response, "choices");
  if (!Array.isArray(choices) || !choices.length) {
    console.warn("Deployment returned no choices");
    return "";
  }
  const message = getField(choices[0], "message");
  if (!message) {
    console.warn("Deployment choice has no message");
    return "";
  }
  const content = getField(message, "content");
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((part) => getField(part, "type") === "text")
      .map((part) => String(getField(part, "text", "")))
      .join("\n");
  console.warn(
    `Unexpected content type in deployment response: ${typeof content}`,
  );
  return "";
}
export function createDeploymentJob(
  deploymentKey: string,
  options: {
    jobLabel?: string;
    runId?: string | null;
    pipelineConfig?: LLMConfig | null;
    orqClient?: Orq;
    signal?: AbortSignal;
  } = {},
): Job {
  const cfg = options.pipelineConfig ?? PIPELINE_CONFIG,
    safe = sanitizeJobName(options.jobLabel ?? deploymentKey);
  if (cfg.targetReasoningEffort)
    console.warn(
      `targetReasoningEffort=${JSON.stringify(cfg.targetReasoningEffort)} is set but deployment ${JSON.stringify(deploymentKey)} manages reasoning effort through platform configuration; this value is not forwarded.`,
    );
  if (!options.orqClient && !envRaw("ORQ_API_KEY"))
    throw new CredentialError("ORQ_API_KEY environment variable is not set");
  let client: Promise<Orq> | undefined;
  return job(`redteam:static:${safe}`, async (data, row) => {
    options.signal?.throwIfAborted();
    const messages = buildStaticMessages(data);
    const targetInput = truncateForSpan(
      messages
        .map((message) => coerceContentText(message.content))
        .join("\n\n"),
    );
    const result = await staticTargetSpans(
      data,
      safe,
      options.runId,
      row,
      targetInput,
      (targetSpan, threadId) =>
        withRedteamLlmSpan(
          {
            model: `deployment:${deploymentKey}`,
            operation: "invoke",
            provider: "orq",
            inputMessages: messages,
            attributes: { "orq.redteam.llm_purpose": "target" },
          },
          async (llmSpan) => {
            client ??= options.orqClient
              ? Promise.resolve(options.orqClient)
              : resolveOrqClient();
            const sdk = await client,
              headers = await getTraceContextHeaders();
            const request = {
              key: deploymentKey,
              messages: deploymentMessages(messages),
              ...pipelineMetadataParam(),
              ...threadBodyParam(),
            };
            const completion = await withRetry(
              async () => {
                const controller = new AbortController(),
                  timer = setTimeout(
                    () =>
                      controller.abort(
                        Object.assign(new Error("Deployment timed out"), {
                          name: "TimeoutError",
                        }),
                      ),
                    cfg.targetAgentTimeoutMs,
                  );
                const signal = options.signal
                  ? AbortSignal.any([options.signal, controller.signal])
                  : controller.signal;
                try {
                  return await sdk.deployments.invoke(request, {
                    retries: { strategy: "none" },
                    timeoutMs: cfg.targetAgentTimeoutMs,
                    signal,
                    ...(Object.keys(headers).length ? { headers } : {}),
                  });
                } catch (error) {
                  if (options.signal?.aborted) throw options.signal.reason;
                  if (controller.signal.aborted)
                    throw Object.assign(new Error("Deployment timed out"), {
                      name: "TimeoutError",
                    });
                  const status = extractStatusCode(error);
                  if (status !== null)
                    throw Object.assign(
                      new Error(
                        error instanceof Error ? error.message : String(error),
                        { cause: error },
                      ),
                      { status },
                    );
                  throw error;
                } finally {
                  clearTimeout(timer);
                }
              },
              {
                maxAttempts: cfg.maxTargetRetries + 1,
                label: `deployment:${deploymentKey}`,
                signal: options.signal,
              },
            );
            const response = extractDeploymentContent(completion);
            recordLlmResponse(llmSpan, completion, { outputContent: response });
            setSpanAttrs(targetSpan, {
              output: truncateForSpan(response),
              "orq.redteam.output": truncateForSpan(response),
            });
            const tokenUsage = await priceUsage(
              extractUsage(getField(completion, "usage")),
              deploymentKey,
              null,
              {
                servedModel:
                  typeof getField(completion, "model") === "string"
                    ? (getField(completion, "model") as string)
                    : null,
              },
            );
            return { response, tokenUsage, threadId };
          },
        ),
    );
    await getActiveProgress()?.finishAttack(null);
    return result;
  });
}
export function createJobForTarget(
  target: string,
  options: StaticTargetJobOptions & { systemPrompt?: string | null } = {},
): Job {
  const [kind, key] = parseTarget(target);
  if (kind === TargetKind.AGENT) {
    const backend = makeAgentBackend({
      targetConfig: TargetConfigSchema.parse({
        systemPrompt: options.systemPrompt ?? null,
      }),
      pipelineConfig: options.pipelineConfig,
    });
    return createStaticJobForAgentTarget(() => backend.createTarget(key), key, {
      ...options,
      mapError: (error) => backend.mapError(error),
    });
  }
  if (kind === TargetKind.DEPLOYMENT) return createDeploymentJob(key, options);
  throw new RangeError(
    `No static job leg for target kind ${JSON.stringify(kind)} (target ${JSON.stringify(target)}).`,
  );
}
