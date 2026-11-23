import type OpenAI from "openai";

import {
  executeChatCompletion,
  executeResponse,
  type NamedSchema,
} from "../../../common/llm-call.js";
import { clientRoutesThroughOrq } from "../../../common/llm-client.js";
import {
  applyCacheBreakpoints,
  cachingApplies,
  markResponsesInput,
  responsesVolatileItems,
} from "../../../common/prompt-cache.js";
import {
  firstResponsesRefusal,
  responsesOutputText,
  responsesStopReason,
} from "../../../common/responses.js";
import { withoutClientRetries, withRetry } from "../../../common/retry.js";
import { threadBodyParam } from "../../../common/thread-context.js";
import {
  addUsage,
  LLMCallConfig,
  type LLMCallConfigInput,
  MessageSchema,
  type Usage,
} from "../../../contracts.js";
import { messagesToResponsesInput } from "../../openresponses/input-items.js";
import { createRouterClient } from "../client.js";
import {
  explicitConfig,
  resolveSimLlmConfig,
  simRoleConfig,
} from "../config.js";
import { resolveLLMMaxTokens } from "../defaults.js";
import { recordLLMInput, withLLMSpan } from "../tracing.js";
import type { ChatMessage, TokenUsage } from "../types.js";
import { isSchemaRejection } from "../utils/strict-schema.js";

export interface LLMResult {
  content: string;
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  refusal?: string | null;
}

export interface AgentConfig extends LLMCallConfigInput {
  llmConfig?: LLMCallConfig;
  apiKey?: string;
}

export function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && (status === 429 || status >= 500);
}

export interface AgentCallOptions {
  temperature?: number | null;
  maxTokens?: number;
  timeout?: number;
  timeoutMs?: number;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: "auto" | "required";
  useResponsesApi?: boolean;
  responseFormat?: NamedSchema;
  signal?: AbortSignal;
  llmPurpose?: string;
  volatileTail?: number;
}

export abstract class BaseAgent {
  protected model: string;
  protected client: OpenAI;
  readonly config: LLMCallConfig;
  private clientOwned: boolean;
  private detailedUsage: Usage | null = null;
  private usage: TokenUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  protected get modelTask(): string {
    return "sim.user";
  }
  protected get requiredApi(): "responses" | undefined {
    return undefined;
  }

  constructor(options?: AgentConfig | LLMCallConfig) {
    const supplied =
      options instanceof LLMCallConfig
        ? options
        : (options?.llmConfig ?? new LLMCallConfig(options));
    let config = simRoleConfig(
      resolveSimLlmConfig(
        {
          llmConfig: supplied,
          model: options instanceof LLMCallConfig ? undefined : options?.model,
          client: options?.client,
        },
        this.constructor.name,
      ),
      this.modelTask,
    );
    const api =
      this.requiredApi ??
      (config.fieldsSet.has("api") ? config.api : "responses");
    if (
      this.requiredApi &&
      config.fieldsSet.has("api") &&
      config.api !== this.requiredApi
    ) {
      console.warn(
        `${this.constructor.name} runs on ${this.requiredApi}; llmConfig.api does not apply to it.`,
      );
    }
    config = new LLMCallConfig({ ...explicitConfig(config), api });
    this.config = config;
    this.model = config.model;
    const client = config.client as OpenAI | undefined;
    this.client = withoutClientRetries(
      client ??
        createRouterClient(
          options instanceof LLMCallConfig ? undefined : options?.apiKey,
        ),
    );
    this.clientOwned = !client;
  }

  abstract get name(): string;
  abstract get systemPrompt(): string;

  async respondAsync(
    messages: ChatMessage[],
    options?: AgentCallOptions,
  ): Promise<string> {
    const result = await this.callLLM(messages, options);
    if (!result.content)
      throw new Error(
        `${this.name}: LLM call failed -- no content in response`,
      );
    return result.content;
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }
  getUsageDetails(): Usage | null {
    return this.detailedUsage ? { ...this.detailedUsage } : null;
  }
  resetUsage(): void {
    this.detailedUsage = null;
    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  async close(): Promise<void> {
    const client = this.client as OpenAI & { close?: () => Promise<void> };
    if (this.clientOwned && client.close) await client.close();
  }

  private accumulate(usage: Usage | null): void {
    if (!usage) return;
    this.detailedUsage = this.detailedUsage
      ? addUsage(this.detailedUsage, usage)
      : usage;
    this.usage.prompt_tokens += usage.inputTokens;
    this.usage.completion_tokens += usage.outputTokens;
    this.usage.total_tokens += usage.totalTokens;
  }

  protected async callLLM(
    messages: ChatMessage[],
    options: AgentCallOptions = {},
  ): Promise<LLMResult> {
    const config = this.config;
    const temperature = config.fieldsSet.has("temperature")
      ? config.temperature
      : options.temperature;
    const maxTokens = config.fieldsSet.has("maxTokens")
      ? config.maxTokens
      : (options.maxTokens ?? resolveLLMMaxTokens());
    const envTimeout =
      Number(process.env.EVALUATORQ_LLM_TIMEOUT_S ?? 60) * 1000;
    const timeoutMs = config.resolveTimeoutMs(
      options.timeoutMs ??
        (options.timeout === undefined
          ? Number.isFinite(envTimeout) && envTimeout > 0
            ? envTimeout
            : 60_000
          : options.timeout * 1000),
    );
    const envEffort =
      process.env.EVALUATORQ_REASONING_EFFORT?.trim().toLowerCase();
    const reasoningEffort = config.fieldsSet.has("reasoningEffort")
      ? config.reasoningEffort
      : envEffort && !["none", "off"].includes(envEffort)
        ? envEffort
        : undefined;
    const responses =
      this.requiredApi !== undefined ||
      (options.useResponsesApi ?? config.api === "responses");
    if (options.responseFormat && !responses)
      throw new Error(
        `${this.name}: responseFormat is only supported on the Responses API`,
      );
    return withLLMSpan(
      {
        operation: responses ? "responses" : "chat",
        model: this.model,
        temperature: temperature ?? undefined,
        maxTokens,
        purpose: options.llmPurpose,
      },
      async (span) => {
        const fullMessages = [
          { role: "system", content: this.systemPrompt },
          ...messages,
        ];
        const extraBody = {
          ...(clientRoutesThroughOrq(this.client) ? threadBodyParam() : {}),
          ...config.extraBody,
        };
        let input = messagesToResponsesInput(
          messages.map((message) => MessageSchema.parse(message)),
        );
        let chatInput: Record<string, unknown>[] = fullMessages.map(
          (message) => ({ ...message }),
        );
        if (cachingApplies(this.client, this.model)) {
          input = markResponsesInput(input, {
            volatileItems: responsesVolatileItems(
              messages.map((message) => MessageSchema.parse(message)),
              { volatileTail: options.volatileTail ?? 0 },
            ),
          });
          chatInput = applyCacheBreakpoints(chatInput, {
            volatileTail: options.volatileTail ?? 0,
          });
        }
        const common = {
          client: this.client,
          model: this.model,
          span,
          timeoutMs,
          temperature,
          reasoningEffort,
          extraBody,
          extraKwargs: config.extraKwargs,
          signal: options.signal,
        };
        return withRetry(
          async () => {
            options.signal?.throwIfAborted();
            if (responses) {
              recordLLMInput(span, messages);
              span?.setAttribute(
                "gen_ai.request.instructions",
                this.systemPrompt.slice(0, 2000),
              );
              const tools = options.tools?.map((tool) => ({
                type: "function",
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters ?? {
                  type: "object",
                  properties: {},
                },
                strict: tool.function.strict ?? false,
              }));
              const send = (sentTools: typeof tools) =>
                executeResponse({
                  ...common,
                  messages: input,
                  instructions: this.systemPrompt,
                  tools: sentTools,
                  extraKwargs: {
                    ...(options.toolChoice
                      ? { tool_choice: options.toolChoice }
                      : {}),
                    ...config.extraKwargs,
                  },
                  responseTextFormat: options.responseFormat,
                  maxOutputTokens: maxTokens,
                  recordInput: false,
                });
              let called: Awaited<ReturnType<typeof send>>;
              try {
                called = await send(tools);
              } catch (error) {
                if (!tools?.length || !isSchemaRejection(error)) throw error;
                console.warn(
                  `${this.name}: model rejected strict tools, retrying without strict`,
                );
                called = await send(
                  tools.map((tool) => ({ ...tool, strict: false })),
                );
              }
              this.accumulate(called.usage);
              const raw = called.response as OpenAI.Responses.Response;
              if (raw.status === "failed")
                throw new Error(
                  `Responses API call failed: ${raw.error?.message ?? "no error details"}`,
                );
              const stop = responsesStopReason(raw);
              if (stop === "length")
                throw new Error(
                  `${this.name}: response truncated at max_output_tokens=${maxTokens}`,
                );
              if (raw.status === "incomplete")
                throw new Error(
                  `Responses API call incomplete: ${stop ?? "no reason given"}`,
                );
              const calls = (raw.output ?? []).flatMap((item) =>
                item.type === "function_call"
                  ? [
                      {
                        id: item.call_id,
                        type: "function" as const,
                        function: {
                          name: item.name,
                          arguments: item.arguments,
                        },
                      },
                    ]
                  : [],
              );
              return {
                content: responsesOutputText(raw),
                refusal: firstResponsesRefusal(raw),
                ...(calls.length && { tool_calls: calls }),
              };
            }
            const called = await executeChatCompletion({
              ...common,
              messages: chatInput,
              tools: options.tools,
              maxTokens,
              extraKwargs: {
                ...(options.tools?.length
                  ? { tool_choice: options.toolChoice ?? "auto" }
                  : {}),
                ...config.extraKwargs,
              },
            });
            this.accumulate(called.usage);
            const choice = called.response.choices[0];
            if (!choice)
              throw new Error(`${this.name}: No choices in response`);
            if (choice.finish_reason === "length")
              throw new Error(
                `${this.name}: response truncated at max_tokens=${maxTokens}`,
              );
            return {
              content: choice.message.content ?? "",
              refusal: choice.message.refusal,
              tool_calls: choice.message.tool_calls as LLMResult["tool_calls"],
            };
          },
          {
            maxAttempts: config.retryCount + 1,
            label: `${this.name}.callLLM`,
            signal: options.signal,
          },
        );
      },
    );
  }
}
