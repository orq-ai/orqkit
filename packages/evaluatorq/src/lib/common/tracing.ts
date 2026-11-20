import type { Attributes, Context, Span } from "@opentelemetry/api";

import { extractUsage, type Usage } from "../contracts.js";
import { getTracer } from "../tracing/setup.js";
import { envBool, envRaw } from "./env-config.js";
import { getField } from "./fields.js";
import { coerceContentText, jsonWithFallback } from "./messages.js";

export type AttrMap = Record<
  string,
  string | number | boolean | null | undefined
>;

const TRUNCATION_MARKER = "... [truncated]";

function defaultSpanMaxTextChars(): number | undefined {
  const raw = envRaw("EVALUATORQ_SPAN_MAX_TEXT_CHARS");
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    console.warn(
      `EVALUATORQ_SPAN_MAX_TEXT_CHARS=${raw} is not a valid int; capturing all (no truncation)`,
    );
    return undefined;
  }
  const value = Number(raw);
  return value > 0 ? value : undefined;
}

function stringifySafely(value: unknown): string {
  try {
    return typeof value === "object" && value !== null
      ? jsonWithFallback(value)
      : String(value);
  } catch (error) {
    return `<unrepresentable ${typeof value}: ${error}>`;
  }
}

export function truncateForSpan(text: unknown, maxChars?: number): string {
  const s = typeof text === "string" ? text : stringifySafely(text);
  const limit = maxChars ?? defaultSpanMaxTextChars();
  if (limit === undefined || limit <= 0 || s.length <= limit) {
    return s;
  }
  if (limit <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, limit);
  }
  return s.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function cleanAttrs(attrs: AttrMap): Attributes {
  const clean: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) {
      clean[key] = value;
    }
  }
  return clean;
}

export function setSpanAttrs(span: Span | undefined, attrs: AttrMap): void {
  span?.setAttributes(cleanAttrs(attrs));
}

const STATUS_ERROR = 2;

export function setSpanError(span: Span | undefined, message: string): void {
  span?.setStatus({ code: STATUS_ERROR, message });
}

export function captureMessageContent(): boolean {
  return envBool("EVALUATORQ_CAPTURE_MESSAGE_CONTENT");
}

function spanPayloadValue(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Span payloads cannot carry non-finite numbers");
  }
  return typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
    ? stringifySafely(value)
    : value;
}

function limitText(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateForSpan(value);
  }
  if (Array.isArray(value)) {
    return value.map(limitText);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, limitText(inner)]),
    );
  }
  return value;
}

function normalizePayload(value: unknown): unknown {
  return limitText(
    JSON.parse(JSON.stringify(value, spanPayloadValue) ?? "null"),
  );
}

const errorName = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;

export function recordSpanPayload(
  span: Span | undefined,
  options: {
    key: string;
    payload: unknown;
    optionalFields?: Record<string, unknown>;
  },
): void {
  if (!span || !captureMessageContent()) {
    return;
  }
  const { key, payload, optionalFields } = options;
  try {
    let normalized = normalizePayload(payload);
    if (optionalFields && Object.keys(optionalFields).length > 0) {
      if (
        normalized === null ||
        typeof normalized !== "object" ||
        Array.isArray(normalized)
      ) {
        throw new TypeError("Optional span fields require an object payload");
      }
      try {
        normalized = {
          ...normalized,
          ...(normalizePayload(optionalFields) as object),
        };
      } catch (error) {
        console.warn(
          `Could not record optional span fields ${key}.${Object.keys(optionalFields).join(",")} (${errorName(error)}); omitting these fields`,
        );
      }
    }
    span.setAttribute(key, JSON.stringify(normalized));
  } catch (error) {
    console.warn(
      `Could not record span payload ${key} (${errorName(error)}); continuing without this payload`,
    );
  }
}

function serializeMessages(messages: readonly unknown[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: String(getField(message, "role", "")),
      content: truncateForSpan(
        coerceContentText(getField(message, "content", "")),
      ),
    })),
  );
}

type ToolCallPayload = Record<string, string>;

const serializeToolCallContent = (toolCalls: ToolCallPayload[]): string =>
  JSON.stringify({ tool_calls: toolCalls });

function chatToolCallPayloads(toolCalls: unknown): ToolCallPayload[] {
  const payloads: ToolCallPayload[] = [];
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    const fn = getField(toolCall, "function");
    const name = getField(fn, "name") || getField(toolCall, "name");
    const args = getField(fn, "arguments") || getField(toolCall, "arguments");
    const payload: ToolCallPayload = {};
    if (name) {
      payload.name = String(name);
    }
    if (args !== null && args !== undefined) {
      payload.arguments = String(args);
    }
    if (Object.keys(payload).length > 0) {
      payloads.push(payload);
    }
  }
  return payloads;
}

function responseToolCallPayloads(
  items: readonly unknown[],
): ToolCallPayload[] {
  const payloads: ToolCallPayload[] = [];
  for (const item of items) {
    const callId = getField(item, "call_id");
    const name = getField(item, "name");
    const args = getField(item, "arguments");
    if (callId || name || (args !== null && args !== undefined)) {
      const payload: ToolCallPayload = {};
      if (callId) {
        payload.call_id = String(callId);
      }
      if (name) {
        payload.name = String(name);
      }
      if (args !== null && args !== undefined) {
        payload.arguments = String(args);
      }
      payloads.push(payload);
    }
  }
  return payloads;
}

type OutputMessage = { role: string; content: string };

function chatOutputMessages(choices: unknown[]): OutputMessage[] {
  const out: OutputMessage[] = [];
  for (const choice of choices) {
    const message = getField(choice, "message");
    const content = message ? getField(message, "content") : null;
    const role = String((message && getField(message, "role")) || "assistant");
    if (content) {
      out.push({ role, content: String(content) });
      continue;
    }
    const payloads = chatToolCallPayloads(
      message ? getField(message, "tool_calls") : null,
    );
    if (payloads.length > 0) {
      out.push({ role, content: serializeToolCallContent(payloads) });
    }
  }
  return out;
}

function responsesOutputMessages(response: unknown): OutputMessage[] {
  const outputText = getField(response, "output_text");
  if (typeof outputText === "string" && outputText) {
    return [{ role: "assistant", content: outputText }];
  }
  const rawItems = getField(response, "output");
  const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];
  const parts: string[] = [];
  const pushText = (source: unknown) => {
    const text = getField(source, "text");
    if (typeof text === "string" && text) {
      parts.push(text);
    }
  };
  for (const item of items) {
    const content = getField(item, "content");
    if (Array.isArray(content) && content.length > 0) {
      content.forEach(pushText);
    } else {
      pushText(item);
    }
  }
  const joined = parts.join("");
  if (joined) {
    return [{ role: "assistant", content: joined }];
  }
  const payloads = responseToolCallPayloads(items);
  return payloads.length > 0
    ? [{ role: "assistant", content: serializeToolCallContent(payloads) }]
    : [];
}

function extractOutputMessages(response: unknown): OutputMessage[] {
  const choices = getField(response, "choices");
  return Array.isArray(choices) && choices.length > 0
    ? chatOutputMessages(choices)
    : responsesOutputMessages(response);
}

export interface TokenUsageFields {
  usage?: Usage | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  calls?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  inputCost?: number | null;
  outputCost?: number | null;
  totalCost?: number | null;
}

export function recordTokenUsage(
  span: Span | undefined,
  fields: TokenUsageFields = {},
): void {
  if (!span) {
    return;
  }
  const { usage } = fields;
  const prompt = fields.promptTokens ?? usage?.inputTokens ?? 0;
  const completion = fields.completionTokens ?? usage?.outputTokens ?? 0;
  const total = fields.totalTokens ?? usage?.totalTokens ?? prompt + completion;
  // An explicit 0 must beat usage.calls, which extractUsage defaults to 1.
  const calls = fields.calls === undefined ? (usage?.calls ?? 0) : fields.calls;
  span.setAttribute("gen_ai.usage.input_tokens", prompt);
  span.setAttribute("gen_ai.usage.output_tokens", completion);
  span.setAttribute("gen_ai.usage.total_tokens", total);
  if (calls) {
    span.setAttribute("gen_ai.usage.calls", calls);
  }
  // Zero-valued details count as absent so spans do not grow cache and
  // reasoning attributes for providers that never report them.
  const cacheRead =
    fields.cachedTokens ?? (usage?.cachedTokens || fields.cacheReadInputTokens);
  const reasoning = fields.reasoningTokens ?? (usage?.reasoningTokens || null);
  const cacheCreation =
    fields.cacheCreationInputTokens ?? (usage?.cacheCreationTokens || null);
  const inputCost = fields.inputCost ?? usage?.inputCost;
  const outputCost = fields.outputCost ?? usage?.outputCost;
  const totalCost = fields.totalCost ?? usage?.totalCost;
  setSpanAttrs(span, {
    "gen_ai.usage.cache_read.input_tokens": cacheRead,
    // The platform's generic OTel adapter reads this spelling.
    "gen_ai.usage.reasoning.output_tokens": reasoning,
    "gen_ai.usage.cache_creation.input_tokens": cacheCreation,
    "gen_ai.usage.input_cost": inputCost,
    "gen_ai.usage.output_cost": outputCost,
    "gen_ai.usage.total_cost": totalCost,
    "gen_ai.usage.cost": totalCost,
  });
}

function setOutputMessages(span: Span, serialized: string): void {
  span.setAttribute("gen_ai.output.messages", serialized);
  span.setAttribute("output", serialized);
}

export function recordLlmResponse(
  span: Span | undefined,
  response: unknown,
  options: { outputContent?: string | null; recordUsage?: boolean } = {},
): void {
  if (!span) {
    return;
  }
  const responseId = getField(response, "id");
  if (responseId) {
    span.setAttribute("gen_ai.response.id", String(responseId));
  }
  const responseModel = getField(response, "model");
  if (responseModel) {
    span.setAttribute("gen_ai.response.model", String(responseModel));
  }
  const usage =
    options.recordUsage === false ? null : getField(response, "usage");
  if (usage !== null && usage !== undefined) {
    recordTokenUsage(span, { usage: extractUsage(usage, 1), calls: 0 });
  }
  if (captureMessageContent()) {
    if (options.outputContent !== null && options.outputContent !== undefined) {
      setOutputMessages(
        span,
        JSON.stringify([
          {
            role: "assistant",
            content: truncateForSpan(options.outputContent),
          },
        ]),
      );
    } else {
      const output = extractOutputMessages(response);
      if (output.length > 0) {
        setOutputMessages(span, serializeMessages(output));
      }
    }
  }
  const choices = getField(response, "choices");
  const status = getField(response, "status");
  const reasons =
    Array.isArray(choices) && choices.length > 0
      ? choices
          .map((choice) => getField(choice, "finish_reason"))
          .filter(Boolean)
      : typeof status === "string" && status
        ? [status]
        : [];
  if (reasons.length > 0) {
    span.setAttribute("gen_ai.response.finish_reasons", reasons.map(String));
  }
}

export function recordLlmInput(
  span: Span | undefined,
  messages: readonly unknown[],
): void {
  if (!span || messages.length === 0 || !captureMessageContent()) {
    return;
  }
  const serialized = serializeMessages(messages);
  span.setAttribute("gen_ai.input.messages", serialized);
  span.setAttribute("input", serialized);
}

export function recordLlmOutput(span: Span | undefined, output: string): void {
  if (!span || !output || !captureMessageContent()) {
    return;
  }
  setOutputMessages(
    span,
    serializeMessages([{ role: "assistant", content: output }]),
  );
}

export function orqSpanTypeForOperation(operation: string): string | null {
  if (operation === "responses" || operation.endsWith(".responses")) {
    return "span.responses";
  }
  return operation === "invoke" ? "span.chat_completion" : null;
}

function deriveProvider(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) {
    return "openai";
  }
  const prefix = model.slice(0, slash);
  // The OTel semantic conventions spell the Azure OpenAI provider out.
  return prefix === "azure" ? "azure.ai.openai" : prefix;
}

async function runInSpan<T>(
  name: string,
  options: {
    kind: "CLIENT" | "INTERNAL";
    attributes: AttrMap;
    parentContext?: unknown;
  },
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn(undefined);
  }
  let api: typeof import("@opentelemetry/api");
  try {
    api = await import("@opentelemetry/api");
  } catch {
    return fn(undefined);
  }
  const parent = (options.parentContext as Context) ?? api.context.active();
  return tracer.startActiveSpan(
    name,
    {
      kind: api.SpanKind[options.kind],
      attributes: cleanAttrs(options.attributes),
    },
    parent,
    async (span) => {
      try {
        const result = await fn(span);
        // OK is final in the OTel spec and would hide a swallowed failure.
        const status = (span as { status?: { code?: number } }).status;
        if (status?.code !== api.SpanStatusCode.ERROR) {
          span.setStatus({ code: api.SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(stringifySafely(error));
        span.setAttribute("error.type", errorName(error));
        span.recordException(failure);
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: failure.message,
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function withSpan<T>(
  name: string,
  options: { attributes?: AttrMap; parentContext?: unknown },
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  return runInSpan(
    name,
    {
      kind: "INTERNAL",
      attributes: options.attributes ?? {},
      parentContext: options.parentContext,
    },
    fn,
  );
}

export interface LlmSpanOptions {
  model: string;
  operation?: string;
  provider?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  inputMessages?: readonly unknown[] | null;
  attributes?: AttrMap;
  parentContext?: unknown;
}

export function withLlmSpan<T>(
  options: LlmSpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const { model, inputMessages, parentContext } = options;
  const operation = options.operation ?? "chat";
  const provider = options.provider || deriveProvider(model);
  const serialized =
    inputMessages !== null &&
    inputMessages !== undefined &&
    getTracer() &&
    captureMessageContent()
      ? serializeMessages(inputMessages)
      : null;
  return runInSpan(
    `${operation} ${model}`,
    {
      kind: "CLIENT",
      attributes: {
        "gen_ai.operation.name": operation,
        "gen_ai.system": provider,
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": model,
        "orq.span_type": orqSpanTypeForOperation(operation),
        "gen_ai.request.temperature": options.temperature,
        "gen_ai.request.max_tokens": options.maxTokens,
        "gen_ai.input.messages": serialized,
        input: serialized,
        ...options.attributes,
      },
      parentContext,
    },
    fn,
  );
}

export async function currentOtelContext(): Promise<unknown | undefined> {
  try {
    const { context } = await import("@opentelemetry/api");
    return context.active();
  } catch {
    return undefined;
  }
}

export function propagateTraceContext(): boolean {
  return envBool("EVALUATORQ_PROPAGATE_TRACE_CONTEXT");
}

export async function getTraceContextHeaders(): Promise<
  Record<string, string>
> {
  if (!propagateTraceContext()) {
    return {};
  }
  try {
    const { context, propagation } = await import("@opentelemetry/api");
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    return headers;
  } catch {
    return {};
  }
}
