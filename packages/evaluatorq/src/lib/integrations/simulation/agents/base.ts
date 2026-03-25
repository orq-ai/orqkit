/**
 * Base agent class for simulation agents.
 *
 * Provides common functionality for all agents in the simulation system,
 * including LLM interaction with retry logic.
 */

import OpenAI from "openai";

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
  /** Model identifier (default: "azure/gpt-4o-mini"). */
  model?: string;
  /** Pre-existing OpenAI client to reuse. The agent will NOT close an injected client. */
  client?: OpenAI;
  /** API key override. Ignored when `client` is provided. */
  apiKey?: string;
}

/**
 * Determines whether an HTTP status code is retryable.
 */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status >= 500;
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
    this.model = config?.model ?? "azure/gpt-4o-mini";

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
        baseURL: process.env.ROUTER_BASE_URL ?? "https://api.orq.ai/v2/router",
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
    },
  ): Promise<string> {
    const result = await this.callLLM(messages, {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      timeout: options?.timeout,
      signal: options?.signal,
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
      /** External abort signal — aborts in-flight LLM requests immediately. */
      signal?: AbortSignal;
    },
  ): Promise<LLMResult> {
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 2048;
    const timeoutS = options?.timeout ?? DEFAULT_TIMEOUT_S;

    const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system" as const, content: this.systemPrompt },
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
    ];

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
            params.tool_choice = "auto";
          }

          const response = await this.client.chat.completions.create(params, {
            signal: controller.signal,
          });

          clearTimeout(timer);

          const choice = response.choices[0];
          if (!choice) {
            throw new Error(`${this.name}: No choices in response`);
          }

          const message = choice.message;

          // Accumulate token usage
          if (response.usage) {
            this.usage.prompt_tokens += response.usage.prompt_tokens;
            this.usage.completion_tokens += response.usage.completion_tokens;
            this.usage.total_tokens += response.usage.total_tokens;
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
          ("code" in err ||
            err.message.includes("ECONNREFUSED") ||
            err.message.includes("ETIMEDOUT") ||
            err.message.includes("fetch failed"));

        if (!isRetryableStatus(status) && !isNetworkError) {
          throw err;
        }

        if (attempt < MAX_RETRY_ATTEMPTS) {
          const baseWait = RETRY_MIN_WAIT_MS * 2 ** (attempt - 1);
          const waitMs = Math.min(baseWait, RETRY_MAX_WAIT_MS);
          // Add jitter (0-25% of wait time)
          const jitter = Math.random() * waitMs * 0.25;
          await sleep(waitMs + jitter);
        }
      }
    }

    throw (
      lastError ??
      new Error(`${this.name}: Max retries (${MAX_RETRY_ATTEMPTS}) exceeded`)
    );
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
