import type OpenAI from "openai";

import { getField } from "../../common/fields.js";
import { executeChatCompletion } from "../../common/llm-call.js";
import { clientRoutesThroughOrq } from "../../common/llm-client.js";
import {
  applyCacheBreakpoints,
  cachingApplies,
} from "../../common/prompt-cache.js";
import { withoutClientRetries } from "../../common/retry.js";
import { threadBodyParam } from "../../common/thread-context.js";
import { withLlmSpan } from "../../common/tracing.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  DEFAULT_TARGET_MAX_TOKENS,
  DEFAULT_TARGET_TIMEOUT_MS,
  type Message,
  type OutputMessage,
  textOutputItem,
  toChatCompletion,
  toolCallOutputItem,
} from "../../contracts.js";
import { TargetKind } from "../contracts.js";
import { Backend } from "./base.js";
import { createAsyncLlmClient } from "./client.js";
import { mapProviderError } from "./errors.js";
export interface OpenAIModelTargetOptions {
  systemPrompt?: string | null;
  client?: OpenAI;
  maxTokens?: number | null;
  timeoutMs?: number | null;
  reasoningEffort?: string | null;
}
export class OpenAIModelTarget extends AgentTarget {
  readonly targetKind = TargetKind.OPENAI;
  readonly systemPrompt: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly reasoningEffort: string | null;
  private state: { client?: Promise<OpenAI> } = {};
  constructor(
    readonly model: string,
    readonly options: OpenAIModelTargetOptions = {},
  ) {
    super();
    this.systemPrompt = options.systemPrompt || "You are a helpful assistant.";
    this.maxTokens = options.maxTokens || DEFAULT_TARGET_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs || DEFAULT_TARGET_TIMEOUT_MS;
    this.reasoningEffort = options.reasoningEffort ?? null;
  }
  get name(): string {
    return this.model;
  }
  private client(): Promise<OpenAI> {
    this.state.client ??= (
      this.options.client
        ? Promise.resolve(this.options.client)
        : createAsyncLlmClient(undefined, { maxRetries: 0 })
    ).then(withoutClientRetries);
    return this.state.client;
  }
  override async respond(
    messages: Message[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    const client = await this.client();
    const raw = [
      { role: "system", content: this.systemPrompt },
      ...messages
        .filter((message) => message.role !== "system")
        .map(toChatCompletion),
    ];
    const requestMessages = cachingApplies(client, this.model)
      ? applyCacheBreakpoints(raw, { volatileTail: 0 })
      : raw;
    return withLlmSpan(
      {
        model: this.model,
        inputMessages: requestMessages,
        attributes: {
          "orq.llm.purpose": "target",
          "orq.redteam.llm_purpose": "target",
        },
      },
      async (span) => {
        const called = await executeChatCompletion({
          client,
          model: this.model,
          messages: requestMessages,
          span,
          timeoutMs: this.timeoutMs,
          signal: options.signal,
          retryUnsupportedReasoning: false,
          ...(this.reasoningEffort
            ? {
                reasoningEffort: this.reasoningEffort,
                maxCompletionTokens: this.maxTokens,
              }
            : { maxTokens: this.maxTokens }),
          extraBody: clientRoutesThroughOrq(client)
            ? threadBodyParam()
            : undefined,
        });
        const choice = called.response.choices[0];
        if (!choice)
          throw new Error("OpenAIModelTarget: response contained no choices");
        const message = choice.message,
          content = message.content ?? "";
        if (typeof content !== "string")
          throw new Error(
            "OpenAIModelTarget: response content must be text or null",
          );
        const output: OutputMessage[] = [];
        const calls = getField(message, "tool_calls");
        if (Array.isArray(calls))
          for (const call of calls) {
            const fn = getField(call, "function");
            if (!fn) continue;
            const id = getField(call, "id");
            output.push(
              toolCallOutputItem({
                name: String(getField(fn, "name") ?? ""),
                arguments: getField(fn, "arguments") || "{}",
                ...(typeof id === "string" && id ? { call_id: id } : {}),
              }),
            );
          }
        output.push(textOutputItem(content));
        const refusal = getField(message, "refusal");
        return new AgentResponse({
          output,
          usage: called.usage,
          model: called.response.model ?? null,
          responseId: called.response.id ?? null,
          finishReason: choice.finish_reason ?? null,
          refusal: typeof refusal === "string" ? refusal : null,
        });
      },
    );
  }
  override newInstance(): OpenAIModelTarget {
    const target = new OpenAIModelTarget(this.model, { ...this.options });
    target.state = this.state;
    return target;
  }
  override async getAgentContext(): Promise<AgentContext> {
    await this.client();
    return AgentContextSchema.parse({
      key: this.model,
      displayName: this.model,
      description: "OpenAI model target",
      model: this.model,
    });
  }
  override mapError(error: unknown) {
    return mapProviderError("openai", error);
  }
}
export class OpenAIBackend extends Backend {
  private readonly templates = new Map<string, OpenAIModelTarget>();
  constructor(readonly options: OpenAIModelTargetOptions = {}) {
    super("openai");
  }
  override createTarget(key: string): OpenAIModelTarget {
    let template = this.templates.get(key);
    if (!template) {
      template = new OpenAIModelTarget(key, this.options);
      this.templates.set(key, template);
    }
    return template.newInstance();
  }
  override async cleanupMemory(
    _context: AgentContext,
    _ids: string[],
  ): Promise<void> {}
  override mapError(error: unknown) {
    return mapProviderError("openai", error);
  }
}
