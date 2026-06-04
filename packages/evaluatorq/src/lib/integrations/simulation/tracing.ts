/**
 * OpenTelemetry tracing utilities for the agent simulation module.
 *
 * Provides span creation helpers that mirror the redteam module's tracing
 * patterns, adapted for the TypeScript simulation module. All functions
 * gracefully degrade to no-ops when tracing is not enabled.
 *
 * Span hierarchy:
 *   orq.simulation.pipeline (root)
 *     ├── orq.simulation.persona_generation
 *     ├── orq.simulation.scenario_generation
 *     ├── orq.simulation.run (per datapoint)
 *     │   ├── orq.simulation.first_message_generation
 *     │   └── orq.simulation.turn (per turn)
 *     │       ├── orq.simulation.target_call
 *     │       ├── orq.simulation.judge_evaluation
 *     │       └── orq.simulation.user_simulator_call
 */

import type { Span } from "@opentelemetry/api";

import { getTracer } from "../../tracing/setup.js";

// ---------------------------------------------------------------------------
// Internal span: orq.simulation.*
// ---------------------------------------------------------------------------

/**
 * Execute a function within a simulation span (SpanKind.INTERNAL).
 *
 * Gracefully returns `fn(undefined)` when tracing is not enabled.
 * Automatically records errors and sets span status.
 */
export async function withSimulationSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined> | undefined,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn(undefined);
  }

  let SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
  try {
    ({ SpanStatusCode } = await import("@opentelemetry/api"));
  } catch {
    // OTEL not available, run without span
    return fn(undefined);
  }

  const cleanAttrs: Record<string, string | number | boolean> = {};
  if (attributes) {
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) {
        cleanAttrs[k] = v;
      }
    }
  }

  return tracer.startActiveSpan(
    name,
    { attributes: cleanAttrs },
    async (span: Span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (error instanceof Error) {
          span.setAttribute("error.type", error.constructor.name);
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// LLM span: GenAI semantic conventions (SpanKind.CLIENT)
// ---------------------------------------------------------------------------

export interface LLMSpanOptions {
  model: string;
  operation?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  purpose?: string;
}

/**
 * Execute a function within a GenAI LLM span (SpanKind.CLIENT).
 *
 * Follows OTel GenAI semantic conventions for client inference spans.
 * Span name is derived as `"{operation} {model}"`.
 */
export async function withLLMSpan<T>(
  options: LLMSpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn(undefined);
  }

  let SpanKind: typeof import("@opentelemetry/api").SpanKind;
  let SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
  try {
    ({ SpanKind, SpanStatusCode } = await import("@opentelemetry/api"));
  } catch {
    return fn(undefined);
  }

  const operation = options.operation ?? "chat";
  const provider = options.provider ?? deriveProvider(options.model);
  const spanName = `${operation} ${options.model}`;

  const attrs: Record<string, string | number | boolean> = {
    "gen_ai.operation.name": operation,
    "gen_ai.system": provider,
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": options.model,
  };

  if (options.temperature !== undefined) {
    attrs["gen_ai.request.temperature"] = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    attrs["gen_ai.request.max_tokens"] = options.maxTokens;
  }
  if (options.purpose) {
    attrs["orq.simulation.llm_purpose"] = options.purpose;
  }

  return tracer.startActiveSpan(
    spanName,
    { kind: SpanKind.CLIENT, attributes: attrs },
    async (span: Span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (error instanceof Error) {
          span.setAttribute("error.type", error.constructor.name);
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Token usage recording
// ---------------------------------------------------------------------------

export interface TokenUsageAttrs {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Record token usage attributes on a span.
 *
 * Sets both OTel GenAI names and bare attribute keys for platform
 * compatibility (matches the redteam module's dual-naming convention).
 */
export function recordTokenUsage(
  span: Span | undefined,
  usage: TokenUsageAttrs,
): void {
  if (!span) return;

  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;

  // OTel GenAI semantic convention names
  span.setAttribute("gen_ai.usage.input_tokens", prompt);
  span.setAttribute("gen_ai.usage.output_tokens", completion);
  span.setAttribute("gen_ai.usage.total_tokens", total);

  if (usage.cacheReadInputTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.cache_read.input_tokens",
      usage.cacheReadInputTokens,
    );
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.cache_creation.input_tokens",
      usage.cacheCreationInputTokens,
    );
  }

  // Aliases for platform compatibility
  span.setAttribute("gen_ai.usage.prompt_tokens", prompt);
  span.setAttribute("gen_ai.usage.completion_tokens", completion);
  span.setAttribute("prompt_tokens", prompt);
  span.setAttribute("completion_tokens", completion);
  span.setAttribute("input_tokens", prompt);
  span.setAttribute("output_tokens", completion);
  span.setAttribute("total_tokens", total);
}

const TRUNCATION_MARKER = "... [truncated]";

/**
 * Resolve the per-message span text cap from `EVALUATORQ_SPAN_MAX_TEXT_CHARS`.
 *
 * **Defaults to no truncation (capture all).** Set a positive integer (e.g.
 * 8192) to cap span text at that many characters. `-1` / `0` / unset / invalid
 * all mean "capture all". Mirrors the Python `_default_span_max_text_chars`.
 */
function spanMaxTextChars(): number | null {
  const raw = process.env.EVALUATORQ_SPAN_MAX_TEXT_CHARS;
  if (raw === undefined || raw === "") return null;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
}

/**
 * Truncate text for span attribute storage. Output never exceeds the cap; the
 * marker is reserved within the budget. Capture-all (no cap) by default.
 */
function truncate(text: string): string {
  const maxChars = spanMaxTextChars();
  if (maxChars === null) return text;
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Serialize an array of chat messages to JSON for span attributes.
 */
function serializeMessages(
  messages: Array<{ role: string; content: string }>,
): string {
  return JSON.stringify(
    messages.map((m) => ({ role: m.role, content: truncate(m.content) })),
  );
}

/**
 * Whether to write LLM message text (prompts + responses) onto spans.
 *
 * The OTel GenAI semconv classifies `gen_ai.input.messages` and
 * `gen_ai.output.messages` as opt-in because they may carry PII. Controlled by
 * `EVALUATORQ_CAPTURE_MESSAGE_CONTENT`; defaults to enabled so the platform UI
 * keeps rendering input/output panels. Set to `false` / `0` to opt out.
 */
function captureMessageContent(): boolean {
  const flag = process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT;
  if (flag === undefined) return true;
  return flag.toLowerCase() === "true" || flag === "1";
}

/**
 * Record LLM input messages on a span.
 *
 * Sets both `gen_ai.input.messages` (OTel GenAI convention) and `input`
 * (platform fallback), matching the redteam module's dual-attribute pattern.
 * Suppressed when `EVALUATORQ_CAPTURE_MESSAGE_CONTENT=false`.
 */
export function recordLLMInput(
  span: Span | undefined,
  messages: Array<{ role: string; content: string }>,
): void {
  if (!span || messages.length === 0) return;
  if (!captureMessageContent()) return;

  const serialized = serializeMessages(messages);
  span.setAttribute("gen_ai.input.messages", serialized);
  span.setAttribute("input", serialized);
}

/**
 * Record a single LLM output string on a span.
 *
 * Sets `gen_ai.output.messages` and `output` (platform fallback). Suppressed
 * when `EVALUATORQ_CAPTURE_MESSAGE_CONTENT=false`.
 */
export function recordLLMOutput(span: Span | undefined, output: string): void {
  if (!span || !output) return;
  if (!captureMessageContent()) return;

  const serialized = serializeMessages([
    { role: "assistant", content: output },
  ]);
  span.setAttribute("gen_ai.output.messages", serialized);
  span.setAttribute("output", serialized);
}

/**
 * Record LLM response attributes on a span from an OpenAI-compatible response.
 *
 * Sets `gen_ai.output.messages` and `output` with the response content,
 * plus token usage, finish reasons, and response metadata.
 */
export function recordLLMResponse(
  span: Span | undefined,
  response: {
    id?: string;
    model?: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number } | null;
    } | null;
    choices?: Array<{
      finish_reason?: string | null;
      message?: { role?: string; content?: string | null };
    }>;
  },
): void {
  if (!span) return;

  if (response.id) {
    span.setAttribute("gen_ai.response.id", response.id);
  }
  if (response.model) {
    span.setAttribute("gen_ai.response.model", response.model);
  }

  if (response.usage) {
    recordTokenUsage(span, {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
      cacheReadInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
    });
  }

  // Record output content (dual-attribute pattern). Opt-in per GenAI semconv.
  if (captureMessageContent()) {
    const outputMessages = response.choices
      ?.filter((c) => c.message?.content)
      .map((c) => ({
        role: c.message?.role ?? "assistant",
        content: c.message?.content ?? "",
      }));
    if (outputMessages && outputMessages.length > 0) {
      const serialized = serializeMessages(outputMessages);
      span.setAttribute("gen_ai.output.messages", serialized);
      span.setAttribute("output", serialized);
    }
  }

  const finishReasons = response.choices
    ?.map((c) => c.finish_reason)
    .filter((r): r is string => Boolean(r));
  if (finishReasons && finishReasons.length > 0) {
    span.setAttribute("gen_ai.response.finish_reasons", finishReasons);
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Batch set multiple attributes on a span. Skips undefined values.
 */
export function setSpanAttrs(
  span: Span | undefined,
  attrs: Record<string, string | number | boolean | undefined>,
): void {
  if (!span) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}

/**
 * Get W3C trace context headers (traceparent/tracestate) for the current
 * active span. Returns an empty object when tracing is not available.
 *
 * Used to propagate trace context into outgoing HTTP requests so the
 * router can create child spans under the current simulation span.
 */
export async function getTraceContextHeaders(): Promise<
  Record<string, string>
> {
  try {
    const { context, propagation } = await import("@opentelemetry/api");
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    return headers;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// OTel GenAI semconv `gen_ai.system` enum values. The router uses prefixes
// like "azure/" that don't map 1:1 to the spec — translate the known ones.
const PROVIDER_ALIASES: Record<string, string> = {
  azure: "azure.ai.openai",
};

function deriveProvider(model: string): string {
  if (model.includes("/")) {
    const prefix = model.split("/")[0] as string;
    return PROVIDER_ALIASES[prefix] ?? prefix;
  }
  return "openai";
}
