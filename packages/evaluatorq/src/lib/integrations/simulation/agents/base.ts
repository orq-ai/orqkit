/**
 * Base agent class for simulation agents.
 *
 * Provides common functionality for all agents in the simulation system,
 * including LLM interaction with retry logic.
 */

import OpenAI from "openai";

import {
  DEFAULT_SIMULATION_MODEL,
  resolveLLMMaxTokens,
  resolveRouterBaseUrl,
} from "../defaults.js";
import {
  getTraceContextHeaders,
  recordLLMInput,
  recordLLMResponse,
  withLLMSpan,
} from "../tracing.js";
import type { ChatMessage, TokenUsage } from "../types.js";

// Retry configuration
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_MIN_WAIT_MS = 2_000;
const RETRY_MAX_WAIT_MS = 60_000;
const DEFAULT_TIMEOUT_S = 60;

/**
 * Result of a single LLM call, including optional tool calls.
 */
export interface LLMResult {
  content: string;
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
}

/**
 * Configuration options for constructing an agent.
 */
export interface AgentConfig {
  /** Model identifier (default: DEFAULT_SIMULATION_MODEL). */
  model?: string;
  /** Pre-existing OpenAI client to reuse. The agent will NOT close an injected client. */
  client?: OpenAI;
  /** API key override. Ignored when `client` is provided. */
  apiKey?: string;
}

/**
 * Determines whether an HTTP status code is retryable.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status >= 500;
}

/**
 * Send a chat request through the Responses API and return it in chat shape.
 *
 * The judge needs this: a model that reasons by default answers function tools
 * on chat completions with a 400.
 */
async function createViaResponses(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  requestOptions: OpenAI.RequestOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const response = await client.responses.create(
    {
      model: params.model,
      input: params.messages as OpenAI.Responses.ResponseInput,
      temperature: params.temperature,
      max_output_tokens: params.max_tokens,
      tools: params.tools?.map((tool) => ({
        type: "function" as const,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? null,
        // Responses defaults to strict, which the judge's optional fields fail.
        strict: false,
      })),
      tool_choice:
        params.tool_choice as OpenAI.Responses.ResponseCreateParams["tool_choice"],
    },
    requestOptions,
  );

  // These arrive as a 200, so the status check is what stops a partial output
  // from being read as the judge's decision.
  if (response.status === "failed") {
    throw new Error(
      `Responses API call failed: ${response.error?.message ?? "no error details"}`,
    );
  }
  const incompleteReason = response.incomplete_details?.reason;
  if (
    (response.status === "incomplete" || incompleteReason) &&
    incompleteReason !== "max_output_tokens"
  ) {
    throw new Error(
      `Responses API call incomplete: ${incompleteReason ?? "no reason given"}`,
    );
  }

  const toolCalls = response.output.flatMap((item) =>
    item.type === "function_call"
      ? [
          {
            id: item.call_id,
            type: "function" as const,
            function: { name: item.name, arguments: item.arguments },
          },
        ]
      : [],
  );

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: incompleteReason
          ? "length"
          : toolCalls.length > 0
            ? "tool_calls"
            : "stop",
        message: {
          role: "assistant",
          content: response.output_text || null,
          refusal: null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
      },
    ],
    usage: response.usage && {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens,
      prompt_tokens_details: {
        cached_tokens: response.usage.input_tokens_details?.cached_tokens,
      },
    },
  };
}

/**
 * Abstract base class for simulation agents.
 *
 * Provides common LLM interaction functionality with exponential-backoff
 * retry logic and cumulative token-usage tracking.
 *
 * **Client injection**: pass an existing `OpenAI` client via `config.client`
 * to share a single HTTP connection across multiple agents. The agent will
 * NOT close an injected client -- the caller is responsible for its lifecycle.
 */
export abstract class BaseAgent {
  protected model: string;
  protected client: OpenAI;
  private clientOwned: boolean;
  private usage: TokenUsage;

  constructor(config?: AgentConfig) {
    this.model = config?.model ?? DEFAULT_SIMULATION_MODEL;

    if (config?.client) {
      this.client = config.client;
      this.clientOwned = false;
    } else {
      const resolvedApiKey = config?.apiKey ?? process.env.ORQ_API_KEY;
      if (!resolvedApiKey) {
        throw new Error(
          "ORQ_API_KEY environment variable is not set. Set it or pass apiKey in AgentConfig.",
        );
      }
      this.client = new OpenAI({
        baseURL: resolveRouterBaseUrl(),
        apiKey: resolvedApiKey,
      });
      this.clientOwned = true;
    }

    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  // ---------------------------------------------------------------------------
  // Abstract interface
  // ---------------------------------------------------------------------------

  /** Agent name for identification. */
  abstract get name(): string;

  /** System prompt for this agent. */
  abstract get systemPrompt(): string;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate a text response for a conversation.
   *
   * @param messages - Conversation history
   * @param options  - Temperature, maxTokens, and timeout overrides
   * @returns The agent's response text
   * @throws {Error} If the LLM call returns no content
   */
  async respondAsync(
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      timeout?: number;
      signal?: AbortSignal;
      llmPurpose?: string;
    },
  ): Promise<string> {
    const result = await this.callLLM(messages, {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      timeout: options?.timeout,
      signal: options?.signal,
      llmPurpose: options?.llmPurpose,
    });

    if (!result.content) {
      throw new Error(
        `${this.name}: LLM call failed -- no content in response`,
      );
    }

    return result.content;
  }

  /**
   * Get cumulative token usage for this agent.
   */
  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  /**
   * Reset token usage counters to zero.
   */
  resetUsage(): void {
    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  /**
   * Close the underlying HTTP client.
   *
   * Only closes clients that the agent created itself (not injected ones).
   */
  async close(): Promise<void> {
    // The OpenAI Node SDK does not currently expose a public close() method,
    // but we guard against future changes and respect ownership semantics.
    if (
      this.clientOwned &&
      typeof (this.client as unknown as { close?: () => Promise<void> })
        .close === "function"
    ) {
      await (this.client as unknown as { close: () => Promise<void> }).close();
    }
  }

  // ---------------------------------------------------------------------------
  // Protected helpers
  // ---------------------------------------------------------------------------

  /**
   * Call the LLM with retry logic (exponential backoff).
   *
   * Retries on rate-limit (429) and server errors (500+). All other errors
   * are raised immediately.
   */
  protected async callLLM(
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      timeout?: number;
      tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
      toolChoice?: "auto" | "required";
      /** Send through the Responses API instead of chat completions. */
      useResponsesApi?: boolean;
      /** External abort signal — aborts in-flight LLM requests immediately. */
      signal?: AbortSignal;
      /** Semantic purpose for OTel span (e.g. "judge", "user_simulator"). */
      llmPurpose?: string;
    },
  ): Promise<LLMResult> {
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? resolveLLMMaxTokens();
    const timeoutS = options?.timeout ?? DEFAULT_TIMEOUT_S;

    return withLLMSpan(
      {
        model: this.model,
        temperature,
        maxTokens,
        purpose: options?.llmPurpose,
      },
      async (span) => {
        const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
          [
            { role: "system" as const, content: this.systemPrompt },
            ...messages.map((m) => ({
              role: m.role as "user" | "assistant" | "system",
              content: m.content,
            })),
          ];

        // Record input messages on the span for platform UI display
        recordLLMInput(
          span,
          fullMessages.map((m) => ({
            role: String(m.role),
            content: typeof m.content === "string" ? m.content : "",
          })),
        );

        // Inject W3C trace context so the router links its spans to the
        // current simulation trace. The active span and trace context don't
        // change across retries, so compute the headers once.
        const traceHeaders = await getTraceContextHeaders();

        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
          try {
            // Bail immediately if already cancelled
            if (options?.signal?.aborted) {
              throw new Error("Cancelled");
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutS * 1000);

            // Link external signal to this request's controller
            const onAbort = () => controller.abort();
            options?.signal?.addEventListener("abort", onAbort, { once: true });

            try {
              const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
                {
                  model: this.model,
                  messages: fullMessages,
                  temperature,
                  max_tokens: maxTokens,
                };

              if (options?.tools && options.tools.length > 0) {
                params.tools = options.tools;
                params.tool_choice = options.toolChoice ?? "auto";
              }

              const requestOptions = {
                signal: controller.signal,
                headers: traceHeaders,
              };
              const response = options?.useResponsesApi
                ? await createViaResponses(this.client, params, requestOptions)
                : await this.client.chat.completions.create(
                    params,
                    requestOptions,
                  );

              clearTimeout(timer);

              const choice = response.choices[0];
              if (!choice) {
                throw new Error(`${this.name}: No choices in response`);
              }

              const message = choice.message;

              // Record LLM response on the span (token usage, finish reason, etc.)
              recordLLMResponse(span, response);

              // Accumulate token usage
              if (response.usage) {
                this.usage.prompt_tokens += response.usage.prompt_tokens;
                this.usage.completion_tokens +=
                  response.usage.completion_tokens;
                this.usage.total_tokens += response.usage.total_tokens;
              }

              if (choice.finish_reason === "length") {
                throw new Error(
                  `${this.name}: response truncated at max_output_tokens=${maxTokens}`,
                );
              }

              const result: LLMResult = {
                content: message.content ?? "",
              };

              if (message.tool_calls && message.tool_calls.length > 0) {
                result.tool_calls = message.tool_calls;
              }

              return result;
            } finally {
              clearTimeout(timer);
              options?.signal?.removeEventListener("abort", onAbort);
            }
          } catch (err: unknown) {
            lastError = err;

            // Abort errors (from timeout cancellation) should never be retried
            if (err instanceof Error && err.name === "AbortError") {
              throw err;
            }

            // Determine if retryable
            const isApiError = err instanceof OpenAI.APIError;
            const status = isApiError ? err.status : undefined;
            const isNetworkError =
              !isApiError &&
              err instanceof Error &&
              "code" in err &&
              typeof (err as NodeJS.ErrnoException).code === "string" &&
              /^E(CONN|TIMEOUT|NOTFOUND|RESET)/.test(
                (err as NodeJS.ErrnoException).code ?? "",
              );

            // Re-throw immediately for external cancellation
            if (options?.signal?.aborted) throw err;

            if (!isRetryableStatus(status) && !isNetworkError) {
              throw err;
            }

            if (attempt < MAX_RETRY_ATTEMPTS) {
              const baseWait = RETRY_MIN_WAIT_MS * 2 ** (attempt - 1);
              const waitMs = Math.min(baseWait, RETRY_MAX_WAIT_MS);
              // Add jitter (0-25% of wait time)
              const jitter = Math.random() * waitMs * 0.25;
              await sleepCancellable(waitMs + jitter, options?.signal);
            }
          }
        }

        throw (
          lastError ??
          new Error(
            `${this.name}: Max retries (${MAX_RETRY_ATTEMPTS}) exceeded`,
          )
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
