import { randomUUID } from "node:crypto";

import type { Orq } from "@orq-ai/node";
import type { RetryConfig } from "@orq-ai/node/lib/retries.js";
import type { RequestOptions } from "@orq-ai/node/lib/sdks.js";
import type { AgentResponseRequest } from "@orq-ai/node/models/components/agentresponserequest.js";

import { DEFAULT_ORQ_BASE_URL, envRaw } from "../../common/env-config.js";
import { getField } from "../../common/fields.js";
import { extractStatusCode } from "../../common/target-call.js";
import {
  pipelineMetadataParam,
  threadBodyParam,
} from "../../common/thread-context.js";
import {
  getTraceContextHeaders,
  recordLlmInput,
  recordLlmResponse,
  withSpan,
} from "../../common/tracing.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  addUsage,
  contentToText,
  extractUsage,
  KnowledgeBaseInfoSchema,
  MemoryStoreInfoSchema,
  type Message,
  type OutputMessage,
  ToolInfoSchema,
  textOutputItem,
  toolCallOutputItem,
  UsageSchema,
} from "../../contracts.js";
import { PIPELINE_CONFIG } from "../config.js";
import { TargetKind } from "../contracts.js";
import { BackendError, CredentialError } from "../exceptions.js";
import { withRedteamLlmSpan as withLlmSpan } from "../tracing.js";
import { Backend, type MemoryCleanupOptions } from "./base.js";
import { mapProviderError } from "./errors.js";
import { warnIgnoredTargetRetries } from "./retry.js";

export interface OrqBackendOptions {
  orqClient?: Orq;
  timeoutMs?: number | null;
  retryCount?: number | null;
  retryOnCodes?: number[] | null;
  maxToolContinuations?: number | null;
}
export function orqRetryConfig(
  retryCount: number,
  timeoutMs = PIPELINE_CONFIG.targetAgentTimeoutMs,
): RetryConfig {
  if (retryCount <= 0) return { strategy: "none" };
  let backoffWindow = 0;
  for (let i = 0; i < retryCount; i++)
    backoffWindow += Math.min(500 * 2 ** i, 10000);
  return {
    strategy: "backoff",
    backoff: {
      initialInterval: 500,
      maxInterval: 10000,
      exponent: 2,
      maxElapsedTime: backoffWindow + retryCount * timeoutMs,
    },
    retryConnectionErrors: true,
  };
}
async function createOrqClient(options: OrqBackendOptions): Promise<Orq> {
  const apiKey = envRaw("ORQ_API_KEY");
  if (!apiKey)
    throw new CredentialError("ORQ_API_KEY environment variable is not set");
  let sdk: typeof import("@orq-ai/node");
  try {
    sdk = await import("@orq-ai/node");
  } catch (cause) {
    throw new BackendError(
      "ORQ backend requires @orq-ai/node. Install it with: bun add @orq-ai/node",
      { cause },
    );
  }
  return new sdk.Orq({
    apiKey,
    serverURL: envRaw("ORQ_BASE_URL", DEFAULT_ORQ_BASE_URL)
      .replace(/\/+$/, "")
      .replace(/\/v3\/router$/, ""),
    timeoutMs: options.timeoutMs || PIPELINE_CONFIG.targetAgentTimeoutMs,
    retryConfig: orqRetryConfig(
      options.retryCount ?? PIPELINE_CONFIG.retryCount,
      options.timeoutMs || PIPELINE_CONFIG.targetAgentTimeoutMs,
    ),
  });
}
function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function responseText(response: unknown): string {
  for (const item of rows(getField(response, "output")))
    for (const part of rows(getField(item, "parts"))) {
      const value = getField(part, "text");
      if (
        getField(part, "kind") === "text" &&
        typeof value === "string" &&
        value.trim()
      )
        return value;
    }
  return "";
}
function pendingCalls(response: unknown): unknown[] {
  return rows(getField(response, "pendingToolCalls"));
}
function pendingIds(response: unknown): string[] {
  return pendingCalls(response).flatMap((call) => {
    const id = getField(call, "id");
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}
function toolItems(response: unknown): OutputMessage[] {
  return pendingCalls(response).map((call) => {
    const fn = getField(call, "function") ?? call;
    const name = String(getField(fn, "name") || "");
    const raw = getField(fn, "arguments") || {};
    let args: string;
    if (typeof raw === "string") {
      try {
        JSON.parse(raw);
        args = raw;
      } catch {
        console.warn(
          `Failed to parse tool call arguments for ${name}; wrapping raw text`,
        );
        args = JSON.stringify({ raw });
      }
    } else
      args = JSON.stringify(
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? raw
          : {},
      );
    const id = text(getField(call, "id"));
    return toolCallOutputItem({
      name,
      arguments: args,
      ...(id ? { call_id: id } : {}),
    });
  });
}
async function cleanupMemory(
  client: Orq,
  context: AgentContext,
  ids: string[],
  options: RequestOptions,
): Promise<void> {
  for (const store of context.memoryStores) {
    options.signal?.throwIfAborted();
    if (!store.key) {
      console.warn(`Memory store ${store.id} has no key, skipping cleanup`);
      continue;
    }
    for (const id of ids) {
      options.signal?.throwIfAborted();
      try {
        await client.memoryStores.deleteMemory(
          { memoryStoreKey: store.key, memoryEntityId: id },
          options,
        );
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (extractStatusCode(error) !== 404)
          console.warn(
            `Failed to cleanup memory entity ${id} from ${store.key}: ${error}`,
          );
      }
    }
  }
}
export interface OrqAgentTargetOptions {
  memoryEntityId?: string | null;
  model?: string | null;
  timeoutMs?: number | null;
  maxToolContinuations?: number | null;
  retryOnCodes?: number[] | null;
}
export class OrqAgentTarget extends AgentTarget {
  override readonly historyMode = "target";
  readonly targetKind = TargetKind.AGENT;
  private taskId: string | null = null;
  private cachedContext?: AgentContext;
  private readonly client: () => Promise<Orq>;
  readonly timeoutMs: number;
  readonly maxToolContinuations: number;
  model: string | null;
  constructor(
    readonly agentKey: string,
    client: Orq | (() => Promise<Orq>),
    readonly options: OrqAgentTargetOptions = {},
  ) {
    super(options.memoryEntityId ?? null);
    this.model = options.model ?? null;
    this.client =
      typeof client === "function" ? client : () => Promise.resolve(client);
    if (this.memoryEntityId === null)
      this.mintMemoryEntityId(
        `red-team-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      );
    this.timeoutMs = options.timeoutMs || PIPELINE_CONFIG.targetAgentTimeoutMs;
    this.maxToolContinuations =
      options.maxToolContinuations ?? PIPELINE_CONFIG.maxToolContinuations;
  }
  get name(): string {
    return this.agentKey;
  }
  private contextOptions(): RequestOptions {
    return {
      timeoutMs: this.timeoutMs,
      retryCodes: (
        this.options.retryOnCodes ?? PIPELINE_CONFIG.retryOnCodes
      ).map(String),
    };
  }
  private async create(
    request: AgentResponseRequest,
    inputMessages: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = await this.client();
    return withLlmSpan(
      {
        model: this.model || this.agentKey,
        operation: "agents.responses",
        provider: "orq",
        inputMessages,
        attributes: {
          "orq.redteam.llm_purpose": "target",
          "orq.agent.key": this.agentKey,
        },
      },
      async (span) => {
        const response = await client.agents.responses.create(
          request,
          this.agentKey,
          {
            retries: { strategy: "none" },
            timeoutMs: this.timeoutMs,
            headers: await getTraceContextHeaders(),
            ...(signal ? { signal } : {}),
          },
        );
        if (!getField(response, "taskId"))
          throw new BackendError(
            "Orq agent returned no task ID or a streaming response",
          );
        recordLlmResponse(span, response, {
          outputContent: responseText(response),
        });
        return response;
      },
    );
  }
  override async respond(
    messages: Message[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    options.signal?.throwIfAborted();
    const last = messages.at(-1);
    if (!last || last.role !== "user")
      throw new TypeError(
        "OrqAgentTarget.respond requires messages[-1].role == 'user'. Server-side conversation state is held via taskId.",
      );
    const prompt = contentToText(last.content);
    let usage = UsageSchema.parse({});
    return withSpan(
      `agent ${this.agentKey}`,
      {
        attributes: {
          "orq.redteam.llm_purpose": "target",
          "gen_ai.system": "orq",
          "gen_ai.request.model": this.model || this.agentKey,
        },
      },
      async (span) => {
        recordLlmInput(span, [{ role: "user", content: prompt }]);
        try {
          let response = await this.create(
            {
              message: {
                role: "user",
                parts: [{ kind: "text", text: prompt }],
              },
              background: false,
              ...(this.taskId ? { taskId: this.taskId } : {}),
              ...(this.memoryEntityId
                ? { memory: { entityId: this.memoryEntityId } }
                : {}),
              ...threadBodyParam(),
              ...pipelineMetadataParam(),
            },
            [{ role: "user", content: prompt }],
            options.signal,
          );
          this.taskId = text(getField(response, "taskId")) || this.taskId;
          usage = addUsage(usage, extractUsage(getField(response, "usage"), 1));
          let outputText = responseText(response);
          const output = toolItems(response);
          let pending = pendingIds(response);
          for (
            let i = 0;
            pending.length && i < this.maxToolContinuations;
            i++
          ) {
            const parts = pending.map((id) => ({
              kind: "tool_result" as const,
              toolCallId: id,
              result: {
                ok: false,
                error: "Tool execution unavailable in red-teaming harness",
              },
            }));
            response = await this.create(
              {
                message: { role: "tool", parts },
                taskId: this.taskId || undefined,
                background: false,
                ...threadBodyParam(),
                ...pipelineMetadataParam(),
              },
              [{ role: "tool", content: JSON.stringify(parts) }],
              options.signal,
            );
            this.taskId = text(getField(response, "taskId")) || this.taskId;
            usage = addUsage(
              usage,
              extractUsage(getField(response, "usage"), 1),
            );
            outputText = responseText(response) || outputText;
            output.push(...toolItems(response));
            pending = pendingIds(response);
          }
          if (pending.length)
            throw new BackendError(
              `Unresolved pending tool calls after ${this.maxToolContinuations} continuations (${pending.length} remaining)`,
            );
          output.push(textOutputItem(outputText));
          const model = text(getField(response, "model"));
          const telemetry = getField(response, "telemetry");
          const traceId = text(getField(telemetry, "traceId")),
            spanId = text(getField(telemetry, "spanId"));
          if (model) span?.setAttribute("gen_ai.response.model", model);
          if (traceId) span?.setAttribute("orq.trace_id", traceId);
          recordLlmResponse(
            span,
            { model },
            { outputContent: outputText, recordUsage: false },
          );
          return new AgentResponse({
            output,
            usage: usage.calls > 0 ? usage : null,
            model,
            responseId: text(getField(response, "taskId")),
            traceId,
            spanId,
            finishReason: null,
          });
        } catch (error) {
          if (
            usage.calls > 0 &&
            error instanceof Error &&
            Object.isExtensible(error)
          )
            Object.assign(error, { usage });
          throw error;
        }
      },
    );
  }
  override newInstance(): OrqAgentTarget {
    return new OrqAgentTarget(this.agentKey, this.client, {
      ...this.options,
      model: this.model,
      memoryEntityId: this.memoryEntitySeeded ? this.memoryEntityId : null,
    });
  }
  override async getAgentContext(): Promise<AgentContext> {
    if (this.cachedContext) return this.cachedContext;
    const client = await this.client(),
      options = this.contextOptions();
    const agent = await client.agents.retrieve(this.agentKey, options);
    const knowledgeBases = await Promise.all(
      rows(agent.knowledgeBases).map(async (ref) => {
        const id = text(getField(ref, "knowledgeId")) || String(ref);
        try {
          const data = await client.knowledge.retrieve(
            { knowledgeId: id },
            options,
          );
          return KnowledgeBaseInfoSchema.parse({
            id,
            key: data.key,
            name: data.key,
            description: data.description || null,
          });
        } catch (error) {
          console.warn(`Failed to enrich knowledge base ${id}: ${error}`);
          return KnowledgeBaseInfoSchema.parse({ id });
        }
      }),
    );
    const memoryStores = await Promise.all(
      rows(agent.memoryStores).map(async (ref) => {
        const id =
          typeof ref === "string"
            ? ref
            : text(getField(ref, "key")) || String(ref);
        try {
          const data = await client.memoryStores.retrieve(
            { memoryStoreKey: id },
            options,
          );
          return MemoryStoreInfoSchema.parse({
            id: data.id ?? id,
            key: data.key ?? id,
            description: data.description || null,
          });
        } catch (error) {
          console.warn(`Failed to enrich memory store ${id}: ${error}`);
          return MemoryStoreInfoSchema.parse({ id });
        }
      }),
    );
    const tools = await Promise.all(
      rows(getField(agent.settings, "tools")).map(async (binding) => {
        const name =
          getField(binding, "key") ||
          getField(binding, "displayName") ||
          getField(binding, "id", "unknown");
        let description = getField(binding, "description"),
          parameters: unknown = null;
        const id = text(getField(binding, "toolId"));
        if (id)
          try {
            const rich = await client.tools.retrieve({ toolId: id }, options);
            const fn = getField(rich, "function"),
              js = getField(rich, "jsonSchema");
            description =
              getField(fn ?? js, "description") ||
              getField(rich, "description") ||
              description;
            parameters = fn
              ? getField(fn, "parameters", null)
              : js
                ? getField(js, "schema", null)
                : null;
          } catch (error) {
            console.warn(`Failed to enrich tool ${id}: ${error}`);
          }
        return ToolInfoSchema.parse({
          name,
          description,
          parameters,
          actionType: getField(binding, "actionType"),
        });
      }),
    );
    this.cachedContext = AgentContextSchema.parse({
      key: this.agentKey,
      id: agent.id,
      workspaceId: getField(agent, "workspaceId"),
      targetKind: "agent",
      displayName: agent.displayName,
      description: agent.description,
      systemPrompt: getField(agent, "systemPrompt"),
      instructions: agent.instructions,
      tools,
      memoryStores,
      knowledgeBases,
      model: getField(agent.model, "id"),
      version:
        [getField(agent, "version"), getField(agent, "versionHash")].find(
          (value) => typeof value === "string" && value,
        ) ?? null,
      skills: agent.skills,
      agentType: agent.type,
      engine: agent.engine,
    });
    return this.cachedContext;
  }
  override async cleanupMemory(
    context: AgentContext,
    ids: string[],
    options?: MemoryCleanupOptions,
  ): Promise<void> {
    await cleanupMemory(await this.client(), context, ids, {
      ...this.contextOptions(),
      signal: options?.signal,
    });
  }
  override mapError(error: unknown) {
    return mapProviderError("orq", error);
  }
}
export class OrqBackend extends Backend {
  private clientPromise?: Promise<Orq>;
  private readonly getClient = (): Promise<Orq> => {
    this.clientPromise ??= this.options.orqClient
      ? Promise.resolve(this.options.orqClient)
      : createOrqClient(this.options);
    return this.clientPromise;
  };
  constructor(readonly options: OrqBackendOptions = {}) {
    super("orq");
    warnIgnoredTargetRetries("ORQ", options);
  }
  override createTarget(key: string): OrqAgentTarget {
    return new OrqAgentTarget(key, this.getClient, this.options);
  }
  override async cleanupMemory(
    context: AgentContext,
    ids: string[],
    options?: MemoryCleanupOptions,
  ): Promise<void> {
    await this.createTarget(context.key).cleanupMemory(context, ids, options);
  }
  override mapError(error: unknown) {
    return mapProviderError("orq", error);
  }
}
export function createOrqAgentTarget(
  key: string,
  options: OrqBackendOptions = {},
): OrqAgentTarget {
  return new OrqBackend(options).createTarget(key);
}
