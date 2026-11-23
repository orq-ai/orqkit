import { randomUUID } from "node:crypto";

import type OpenAI from "openai";

import { getField } from "../../common/fields.js";
import { executeResponse } from "../../common/llm-call.js";
import {
  clientRoutesThroughOrq,
  type ResolvedClient,
  resolveLlmClient,
} from "../../common/llm-client.js";
import {
  cachingApplies,
  markResponsesInput,
} from "../../common/prompt-cache.js";
import {
  firstResponsesRefusal,
  responsesStopReason,
} from "../../common/responses.js";
import { withoutClientRetries, withRetry } from "../../common/retry.js";
import { threadBodyParam } from "../../common/thread-context.js";
import {
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  type LLMCallConfig,
  type Message,
} from "../../contracts.js";
import { messagesToResponsesInput } from "./input-items.js";
import {
  recordOpenResponsesRequest,
  recordOpenResponsesResponse,
  withOpenResponsesSpan,
} from "./tracing.js";

export interface OrqResponsesTargetOptions {
  instructions?: string | null;
  tools?: Record<string, unknown>[] | null;
  memoryEntityId?: string | null;
  client?: OpenAI;
  retryAttempts?: number;
  retryStatuses?: Iterable<number>;
  requireOrq?: boolean;
}

export class OrqResponsesTarget extends AgentTarget {
  private resolved?: Promise<ResolvedClient>;
  constructor(
    readonly config: LLMCallConfig,
    readonly options: OrqResponsesTargetOptions = {},
  ) {
    super(options.memoryEntityId ?? null);
    if (
      options.retryAttempts !== undefined &&
      (!Number.isInteger(options.retryAttempts) || options.retryAttempts < 1)
    )
      throw new RangeError("retryAttempts must be >= 1");
  }

  private client(): Promise<ResolvedClient> {
    this.resolved ??= resolveLlmClient(
      this.options.client ?? (this.config.client as OpenAI | undefined),
      { requireOrq: this.options.requireOrq, maxRetries: 0 },
    );
    return this.resolved;
  }

  override newInstance(): OrqResponsesTarget {
    const clone = new OrqResponsesTarget(this.config, {
      ...this.options,
      memoryEntityId: this.memoryEntitySeeded ? this.memoryEntityId : null,
    });
    if (!this.memoryEntitySeeded && this.memoryEntityId !== null)
      clone.mintMemoryEntityId(randomUUID());
    return clone;
  }

  override async getAgentContext() {
    return AgentContextSchema.parse({
      key: this.config.model,
      model: this.config.model,
      instructions: this.options.instructions ?? "",
      tools: (this.options.tools ?? []).map((tool) => {
        const spec =
          typeof tool.function === "object" && tool.function !== null
            ? (tool.function as Record<string, unknown>)
            : tool;
        return {
          name: String(spec.name ?? tool.type ?? "unknown"),
          description: spec.description,
          parameters: spec.parameters,
          actionType: tool.type,
        };
      }),
    });
  }

  override async respond(
    messages: Message[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    const { client: supplied } = await this.client();
    const client = withoutClientRetries(supplied);
    let input = messagesToResponsesInput(messages);
    if (cachingApplies(client, this.config.model))
      input = markResponsesInput(input, { volatileItems: 0 });
    const routed = clientRoutesThroughOrq(client);
    const extraBody = {
      ...(routed ? threadBodyParam() : {}),
      ...(routed && this.memoryEntityId
        ? { memory: { entity_id: this.memoryEntityId } }
        : {}),
      ...this.config.extraBody,
    };
    return withRetry(
      () =>
        withOpenResponsesSpan(
          {
            model: this.config.model,
            operation: "responses",
            purpose: "target",
            maxTokens: this.config.maxTokens,
          },
          async (span) => {
            let headers: Headers | undefined;
            const called = await executeResponse({
              client,
              onRequest: (payload) => recordOpenResponsesRequest(span, payload),
              model: this.config.model,
              messages: input,
              span,
              timeoutMs: this.config.timeoutMs,
              maxOutputTokens: this.config.maxTokens,
              ...this.config.setValues(
                "temperature",
                "reasoningEffort",
                "extraKwargs",
              ),
              extraBody,
              instructions: this.options.instructions,
              tools: this.options.tools,
              signal: options.signal,
              onResponseHeaders: (value) => {
                headers = value;
              },
            });
            const raw = called.response;
            recordOpenResponsesResponse(span, raw);
            if (responsesStopReason(raw) === "length")
              throw new Error(
                `OrqResponsesTarget: response truncated at max_output_tokens=${this.config.maxTokens}; raise the configured token budget and retry.`,
              );
            const response = AgentResponse.fromOpenResponses(raw);
            if (!response.output.length)
              throw new Error(
                `OrqResponsesTarget: response contained no extractable output items (model=${this.config.model}).`,
              );
            const telemetry = getField(raw, "telemetry");
            const traceId =
              headers?.get("x-orq-trace-id") ??
              (getField(telemetry, "trace_id") as string | null | undefined) ??
              response.traceId;
            const spanId =
              headers?.get("x-orq-trace-span-id") ??
              (getField(telemetry, "span_id") as string | null | undefined) ??
              response.spanId;
            if (traceId) span?.setAttribute("orq.trace_id", traceId);
            return new AgentResponse({
              ...response,
              model: response.model ?? this.config.model,
              usage: called.usage,
              traceId,
              spanId,
              refusal: firstResponsesRefusal(raw),
            });
          },
        ),
      {
        maxAttempts: this.options.retryAttempts ?? 1,
        retryStatuses: this.options.retryStatuses,
        label: "OrqResponsesTarget.respond",
        signal: options.signal,
      },
    );
  }

  async close(): Promise<void> {
    if (!this.resolved) return;
    const resolved = await this.resolved;
    if (resolved.owned)
      await (
        resolved.client as OpenAI & { close?: () => Promise<void> }
      ).close?.();
    this.resolved = undefined;
  }
}
