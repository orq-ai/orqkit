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

  try {
    const { SpanStatusCode } = await import("@opentelemetry/api");

    const cleanAttrs: Record<string, string | number | boolean> = {};
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== undefined) {
          cleanAttrs[k] = v;
        }
      }
    }

    return await tracer.startActiveSpan(
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
  } catch {
    // OTEL not available, run without span
    return fn(undefined);
  }
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

  try {
    const { SpanKind, SpanStatusCode } = await import("@opentelemetry/api");

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

    return await tracer.startActiveSpan(
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
  } catch {
    return fn(undefined);
  }
}

// ---------------------------------------------------------------------------
// Token usage recording
// ---------------------------------------------------------------------------

export interface TokenUsageAttrs {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
  const total = usage.totalTokens || prompt + completion;

  // OTel GenAI semantic convention names
  span.setAttribute("gen_ai.usage.input_tokens", prompt);
  span.setAttribute("gen_ai.usage.output_tokens", completion);
  span.setAttribute("gen_ai.usage.total_tokens", total);

  // Aliases for platform compatibility
  span.setAttribute("gen_ai.usage.prompt_tokens", prompt);
  span.setAttribute("gen_ai.usage.completion_tokens", completion);
  span.setAttribute("prompt_tokens", prompt);
  span.setAttribute("completion_tokens", completion);
  span.setAttribute("input_tokens", prompt);
  span.setAttribute("output_tokens", completion);
  span.setAttribute("total_tokens", total);
}

// Max content length per message to avoid oversized spans (matches redteam)
const MAX_CONTENT_LEN = 2000;

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_LEN) return text;
  return `${text.slice(0, MAX_CONTENT_LEN)}…`;
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
 * Record LLM input messages on a span.
 *
 * Sets both `gen_ai.input.messages` (OTel GenAI convention) and `input`
 * (platform fallback), matching the redteam module's dual-attribute pattern.
 */
export function recordLLMInput(
  span: Span | undefined,
  messages: Array<{ role: string; content: string }>,
): void {
  if (!span || messages.length === 0) return;

  const serialized = serializeMessages(messages);
  span.setAttribute("gen_ai.input.messages", serialized);
  span.setAttribute("input", serialized);
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
    });
  }

  // Record output content (dual-attribute pattern)
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

  const finishReasons = response.choices
    ?.map((c) => c.finish_reason)
    .filter(Boolean);
  if (finishReasons && finishReasons.length > 0) {
    span.setAttribute(
      "gen_ai.response.finish_reasons",
      JSON.stringify(finishReasons),
    );
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

function deriveProvider(model: string): string {
  if (model.includes("/")) {
    return model.split("/")[0] as string;
  }
  return "openai";
}
