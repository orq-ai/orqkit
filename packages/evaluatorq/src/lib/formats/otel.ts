import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { parentSpanIdOf, spanIdOf } from "../common/trace-input.js";
import { parsePythonJson, pythonJson } from "./json.js";
import { type OtelConversionOptions, otelToAtif } from "./otel-to-atif.js";
import { parseIso } from "./time.js";

type Row = Record<string, unknown>;
const record = (v: unknown): v is Row =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const truth = (v: unknown): boolean =>
  v != null &&
  (Array.isArray(v)
    ? v.length > 0
    : record(v)
      ? Object.keys(v).length > 0
      : Boolean(v));
const pyString = (v: unknown): string =>
  v == null
    ? "None"
    : typeof v === "boolean"
      ? v
        ? "True"
        : "False"
      : Array.isArray(v)
        ? `[${v.map(pyRepr).join(", ")}]`
        : record(v)
          ? `{${Object.entries(v)
              .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
              .join(", ")}}`
          : String(v);
function pyRepr(value: unknown): string {
  if (typeof value !== "string") return pyString(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return (
    quote +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll(quote, `\\${quote}`)
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t") +
    quote
  );
}
const dictionary = z
  .custom<Row>(record)
  .transform((v) => Object.fromEntries(Object.entries(v)));
function model<S extends z.ZodRawShape>(shape: S, open = false) {
  const schema = z.object(shape);
  return dictionary.transform((value, ctx) => {
    const input = { ...value };
    for (const key of Object.keys(shape)) {
      const legacy = snake(key);
      if (legacy === key || !Object.hasOwn(input, legacy)) continue;
      if (
        Object.hasOwn(input, key) &&
        !isDeepStrictEqual(input[key], input[legacy])
      ) {
        ctx.addIssue({
          code: "custom",
          message: `Conflicting ${key} and ${legacy}`,
        });
        return z.NEVER;
      }
      input[key] = input[legacy];
      delete input[legacy];
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
    return Object.freeze(
      (open
        ? {
            ...parsed.data,
            ...Object.fromEntries(
              Object.entries(input).filter(
                ([key]) => !Object.hasOwn(shape, key),
              ),
            ),
          }
        : parsed.data) as z.output<typeof schema>,
    );
  });
}
const nullable = z.string().nullable().default(null),
  any = z.unknown().refine((v) => v !== undefined, "Required field");
export const OtelTextPartSchema = model(
  { type: z.literal("text"), content: z.string() },
  true,
);
export const OtelReasoningPartSchema = model(
  { type: z.literal("reasoning"), content: z.string() },
  true,
);
export const OtelToolCallPartSchema = model(
  {
    type: z.literal("tool_call"),
    id: nullable,
    name: z.string(),
    arguments: z.unknown().default(null),
  },
  true,
);
export const OtelToolCallResponsePartSchema = model(
  { type: z.literal("tool_call_response"), id: nullable, response: any },
  true,
);
export const OtelServerToolCallPartSchema = model(
  {
    type: z.literal("server_tool_call"),
    id: nullable,
    name: z.string(),
    serverToolCall: any,
  },
  true,
);
export const OtelServerToolCallResponsePartSchema = model(
  {
    type: z.literal("server_tool_call_response"),
    id: nullable,
    serverToolCallResponse: any,
  },
  true,
);
export const OtelBlobPartSchema = model(
  {
    type: z.literal("blob"),
    mimeType: nullable,
    modality: z.string(),
    content: z.string(),
  },
  true,
);
export const OtelFilePartSchema = model(
  {
    type: z.literal("file"),
    mimeType: nullable,
    modality: z.string(),
    fileId: z.string(),
  },
  true,
);
export const OtelUriPartSchema = model(
  {
    type: z.literal("uri"),
    mimeType: nullable,
    modality: z.string(),
    uri: z.string(),
  },
  true,
);
export const OtelCompactionPartSchema = model(
  {
    type: z.literal("compaction"),
    id: nullable,
    content: z.unknown().default(null),
  },
  true,
);
export const OtelGenericPartSchema = model({ type: z.string() }, true);
export type OtelTextPart = z.infer<typeof OtelTextPartSchema>;
export type OtelReasoningPart = z.infer<typeof OtelReasoningPartSchema>;
export type OtelToolCallPart = z.infer<typeof OtelToolCallPartSchema>;
export type OtelToolCallResponsePart = z.infer<
  typeof OtelToolCallResponsePartSchema
>;
export type OtelServerToolCallPart = z.infer<
  typeof OtelServerToolCallPartSchema
>;
export type OtelServerToolCallResponsePart = z.infer<
  typeof OtelServerToolCallResponsePartSchema
>;
export type OtelBlobPart = z.infer<typeof OtelBlobPartSchema>;
export type OtelFilePart = z.infer<typeof OtelFilePartSchema>;
export type OtelUriPart = z.infer<typeof OtelUriPartSchema>;
export type OtelCompactionPart = z.infer<typeof OtelCompactionPartSchema>;
export type OtelGenericPart = z.infer<typeof OtelGenericPartSchema> & Row;
export type OtelPart =
  | OtelTextPart
  | OtelReasoningPart
  | OtelToolCallPart
  | OtelToolCallResponsePart
  | OtelServerToolCallPart
  | OtelServerToolCallResponsePart
  | OtelBlobPart
  | OtelFilePart
  | OtelUriPart
  | OtelCompactionPart
  | OtelGenericPart;
const partModels: ReadonlyMap<string, z.ZodType<OtelPart>> = new Map<
  string,
  z.ZodType<OtelPart>
>([
  ["text", OtelTextPartSchema],
  ["reasoning", OtelReasoningPartSchema],
  ["tool_call", OtelToolCallPartSchema],
  ["tool_call_response", OtelToolCallResponsePartSchema],
  ["server_tool_call", OtelServerToolCallPartSchema],
  ["server_tool_call_response", OtelServerToolCallResponsePartSchema],
  ["blob", OtelBlobPartSchema],
  ["file", OtelFilePartSchema],
  ["uri", OtelUriPartSchema],
  ["compaction", OtelCompactionPartSchema],
]);
export function parsePart(input: unknown): OtelPart {
  let raw = input;
  if (
    record(raw) &&
    !Object.hasOwn(raw, "type") &&
    Object.hasOwn(raw, "kind")
  ) {
    const part: Row = { ...raw, type: raw.kind };
    delete part.kind;
    if (
      raw.kind === "text" &&
      !Object.hasOwn(part, "content") &&
      Object.hasOwn(part, "text")
    ) {
      part.content = part.text;
      delete part.text;
    }
    raw = part;
  }
  const kind = record(raw) ? raw.type : null,
    schema = typeof kind === "string" ? partModels.get(kind) : undefined;
  if (schema) return schema.parse(raw);
  if (kind !== "refusal" && kind !== "data")
    console.warn(
      `Unknown OTel message part type ${String(kind)}; keeping it as a generic part`,
    );
  return OtelGenericPartSchema.parse(
    record(raw)
      ? { ...raw, type: typeof kind === "string" ? kind : pyString(kind) }
      : { type: "unknown", value: raw },
  ) as OtelGenericPart;
}
function asList(value: unknown): unknown {
  if (
    record(value) &&
    Object.keys(value).length &&
    Object.keys(value).every((k) => /^\d+$/.test(k))
  )
    return Object.keys(value)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => value[k]);
  return value;
}
const partSchema = z.unknown().transform((value, ctx) => {
  try {
    return parsePart(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) });
    return z.NEVER;
  }
});
export const OtelMessageSchema = model(
  {
    role: z
      .string()
      .transform((role) => (role === "agent" ? "assistant" : role)),
    parts: z.preprocess(asList, z.array(partSchema)),
    name: nullable,
    finishReason: nullable,
  },
  true,
);
export type OtelMessage = z.infer<typeof OtelMessageSchema>;
const numeric = z
  .preprocess(
    (v) =>
      typeof v === "boolean"
        ? Number(v)
        : typeof v === "string" &&
            v.trim() &&
            !Number.isNaN(Number(v.replaceAll("_", "")))
          ? Number(v.replaceAll("_", ""))
          : v,
    z.custom<number>((v) => typeof v === "number"),
  )
  .nullable()
  .default(null);
export const OtelUsageSchema = model({
  inputTokens: numeric,
  outputTokens: numeric,
  cachedTokens: numeric,
  reasoningTokens: numeric,
  costUsd: numeric,
});
export type OtelUsage = z.infer<typeof OtelUsageSchema>;
export function isoFromEpoch(epoch: number): string {
  const seconds = Math.floor(epoch),
    microsecond = Math.round((epoch - seconds) * 1e6),
    adjusted = seconds + Math.floor(microsecond / 1e6),
    micros = microsecond % 1e6;
  const date = new Date(adjusted * 1000),
    year = date.getUTCFullYear();
  if (
    !Number.isFinite(epoch) ||
    Number.isNaN(date.getTime()) ||
    year < 1 ||
    year > 9999
  )
    throw new RangeError("Span timestamp is outside the supported year range");
  return (
    date.toISOString().slice(0, 19) +
    (micros ? `.${String(micros).padStart(6, "0")}` : "") +
    "+00:00"
  );
}
export function parseTime(value: unknown): string | null {
  if (value == null) return null;
  try {
    if (value instanceof Date) return parseTime(value.toISOString());
    if (typeof value === "number")
      return isoFromEpoch(value > 10_000_000_000 ? value / 1000 : value);
    if (typeof value === "string") {
      const parsed = parseIso(value);
      return parsed.iso + (parsed.offsetSeconds === null ? "+00:00" : "");
    }
  } catch {}
  console.warn(`Unparseable or out-of-range span time ${String(value)}`);
  return null;
}
const datetime = z
  .unknown()
  .transform((value, ctx) => {
    if (value == null) return null;
    let parsed: string | null = null;
    if (
      typeof value === "number" ||
      (typeof value === "string" &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))
    ) {
      const n = Number(value);
      const adjusted =
        typeof value === "number" && n < 0 && !Number.isInteger(n)
          ? Math.floor(n) + Math.abs(n - Math.trunc(n))
          : n;
      try {
        parsed = isoFromEpoch(
          Math.abs(n) > 20_000_000_000 ? adjusted / 1000 : adjusted,
        );
      } catch {}
    } else if (typeof value !== "string" || /^\d{4}-\d{2}-\d{2}/.test(value))
      parsed = parseTime(value);
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "Invalid datetime" });
      return z.NEVER;
    }
    return parsed;
  })
  .nullable()
  .default(null);
export const OtelSpanSchema = model({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: nullable,
  name: z.string().default(""),
  spanType: nullable,
  operation: nullable,
  startTime: datetime,
  endTime: datetime,
  status: z.enum(["ok", "error", "unset"]).default("unset"),
  errorType: nullable,
  inputMessages: z.array(OtelMessageSchema).nullable().default(null),
  outputMessages: z.array(OtelMessageSchema).nullable().default(null),
  systemInstructions: z
    .array(z.union([...partModels.values(), OtelGenericPartSchema]))
    .nullable()
    .default(null),
  attributes: dictionary.default(() => ({})),
});
export type OtelSpanFields = z.infer<typeof OtelSpanSchema>;
export class OtelSpan implements OtelSpanFields {
  declare readonly traceId: string;
  declare readonly spanId: string;
  declare readonly parentSpanId: string | null;
  declare readonly name: string;
  declare readonly spanType: string | null;
  declare readonly operation: string | null;
  declare readonly startTime: string | null;
  declare readonly endTime: string | null;
  declare readonly status: "ok" | "error" | "unset";
  declare readonly errorType: string | null;
  declare readonly inputMessages: OtelMessage[] | null;
  declare readonly outputMessages: OtelMessage[] | null;
  declare readonly systemInstructions: OtelPart[] | null;
  declare readonly attributes: Row;
  constructor(input: unknown) {
    Object.assign(this, OtelSpanSchema.parse(input));
    Object.freeze(this);
  }
  toModelDict(): Row {
    return spanWire(this);
  }
}
export function orderSpans<T extends OtelSpanFields>(
  spans: readonly T[],
  options: { fallbackEnd?: boolean } = {},
): T[] {
  return [...spans].sort((a, b) => {
    const at = a.startTime || (options.fallbackEnd ? a.endTime : null),
      bt = b.startTime || (options.fallbackEnd ? b.endTime : null);
    if (at === null) return bt === null ? 0 : 1;
    if (bt === null) return -1;
    return parseIso(at).epochSeconds - parseIso(bt).epochSeconds;
  });
}
const messageAttributes = [
  ["inputMessages", "gen_ai.input.messages"],
  ["inputMessages", "gen_ai.input.message"],
  ["inputMessages", "gen_ai.input"],
  ["outputMessages", "gen_ai.output.messages"],
  ["outputMessages", "gen_ai.output"],
] as const;
const SYSTEM = "gen_ai.system_instructions",
  leafAttrs = new Set<string>([
    ...messageAttributes
      .map(([, key]) => key)
      .filter((k) => k !== "gen_ai.input" && k !== "gen_ai.output"),
    SYSTEM,
    "gen_ai.tool.definitions",
  ]);
const usageKeys = {
  inputTokens: ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"],
  outputTokens: [
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
  ],
  cachedTokens: ["gen_ai.usage.cache_read.input_tokens"],
  reasoningTokens: ["gen_ai.usage.reasoning.output_tokens"],
  costUsd: ["gen_ai.usage.total_cost", "gen_ai.usage.cost"],
} as const;
export function flattenAttributes(attrs: Row): Row {
  const derived = new Map<string, unknown>(),
    direct = new Map<string, unknown>();
  const leaf = (key: string, v: Row): boolean =>
    leafAttrs.has(key) ||
    (["gen_ai.input", "gen_ai.output"].includes(key) &&
      (Object.hasOwn(v, "role") ||
        record(v.message) ||
        Array.isArray(v.messages) ||
        (Object.keys(v).length > 0 &&
          Object.keys(v).every((k) => /^\d+$/.test(k)))));
  const walk = (prefix: string, value: Row) => {
    for (const [key, item] of Object.entries(value)) {
      const dotted = `${prefix}.${key}`;
      if (record(item) && !leaf(dotted, item)) walk(dotted, item);
      else if (!derived.has(dotted)) derived.set(dotted, item);
    }
  };
  for (const [key, value] of Object.entries(attrs))
    if (record(value) && !leaf(key, value)) walk(key, value);
    else direct.set(key, value);
  return Object.fromEntries([...derived, ...direct]);
}
export function spanUsage(span: OtelSpanFields): OtelUsage {
  return OtelUsageSchema.parse(
    Object.fromEntries(
      Object.entries(usageKeys).map(([field, keys]) => {
        const key = keys.find((k) => span.attributes[k] != null);
        let value = key ? span.attributes[key] : null;
        if (value != null && typeof value !== "number") {
          console.warn(
            `Ignoring non-numeric usage attribute ${key} on span ${span.spanId}`,
          );
          value = null;
        }
        return [field, value];
      }),
    ),
  );
}
function loadJson(value: unknown): [boolean, unknown] {
  if (typeof value !== "string") return [true, value];
  try {
    return [true, parsePythonJson(value)];
  } catch {
    console.warn(
      "Could not parse span attribute as JSON; keeping the raw value",
    );
    return [false, null];
  }
}
function contentParts(content: unknown): unknown[] {
  if (content == null || content === "") return [];
  if (typeof content === "string") return [{ type: "text", content }];
  if (Array.isArray(content))
    return content.map((item) =>
      typeof item === "string"
        ? { type: "text", content: item }
        : record(item) && item.type === "text" && Object.hasOwn(item, "text")
          ? { type: "text", content: item.text }
          : item,
    );
  return [
    { type: "text", content: pythonJson(content, { defaultString: true }) },
  ];
}
function toolCallPart(call: unknown): unknown {
  if (!record(call)) return call;
  const fn = record(call.function) ? call.function : {};
  let args = Object.hasOwn(fn, "arguments")
    ? fn.arguments
    : (call.arguments ?? null);
  if (typeof args === "string")
    try {
      const decoded: unknown = parsePythonJson(args);
      if (record(decoded) || Array.isArray(decoded)) args = decoded;
    } catch {}
  return {
    type: "tool_call",
    id: call.id ?? null,
    name: Object.hasOwn(fn, "name") ? fn.name : (call.name ?? null),
    arguments: args,
  };
}
function otelMessage(input: unknown): unknown {
  if (!record(input) || Object.hasOwn(input, "parts")) return input;
  const message = { ...input },
    content = message.content ?? null,
    calls = asList(message.tool_calls),
    callId = message.tool_call_id ?? null,
    refusal = message.refusal;
  for (const key of ["content", "tool_calls", "tool_call_id", "refusal"])
    delete message[key];
  const parts: unknown[] =
    message.role === "tool"
      ? [{ type: "tool_call_response", id: callId, response: content }]
      : contentParts(content);
  if (truth(refusal)) parts.push({ type: "refusal", content: refusal });
  if (truth(calls))
    parts.push(...(Array.isArray(calls) ? calls : [calls]).map(toolCallPart));
  message.parts = parts;
  return message;
}
function messagesFromAttribute(value: unknown): OtelMessage[] | null {
  const [ok, loaded] = loadJson(value);
  if (!ok) return null;
  let raw = asList(loaded);
  if (record(raw)) {
    if (Object.hasOwn(raw, "messages")) raw = asList(raw.messages);
    else if (Object.hasOwn(raw, "message")) raw = asList(raw.message);
  }
  if (record(raw)) raw = [raw];
  if (!Array.isArray(raw)) {
    console.warn("Span attribute is not a message list; keeping the raw value");
    return null;
  }
  const messages: OtelMessage[] = [];
  let invalid = 0;
  for (const message of raw) {
    const parsed = OtelMessageSchema.safeParse(otelMessage(message));
    if (parsed.success) messages.push(parsed.data);
    else {
      invalid++;
      console.warn("Could not parse OTel message; skipping it");
    }
  }
  return invalid && !messages.length ? null : messages;
}
function partsFromAttribute(value: unknown): OtelPart[] | null {
  const [ok, loaded] = loadJson(value);
  if (!ok) return null;
  let raw = asList(loaded);
  if (record(raw)) raw = [raw];
  if (!Array.isArray(raw)) {
    console.warn("Span attribute is not a part list; keeping the raw value");
    return null;
  }
  const parts: OtelPart[] = [];
  let invalid = 0;
  for (const part of raw)
    try {
      parts.push(parsePart(part));
    } catch {
      invalid++;
      console.warn("Could not parse OTel part; skipping it");
    }
  return invalid && !parts.length ? null : parts;
}
function fillUsage(attrs: Row, raw: Row): void {
  const summary = raw.usage,
    cost = raw.cost,
    reported: Row = {};
  if (record(summary))
    for (const [field, key] of Object.entries({
      inputTokens: "prompt_tokens",
      outputTokens: "completion_tokens",
      cachedTokens: "prompt_cached_tokens",
      reasoningTokens: "completion_reasoning_tokens",
    }))
      reported[field] = summary[key];
  if (record(cost)) reported.costUsd = cost.total;
  for (const [field, value] of Object.entries(reported)) {
    const keys = usageKeys[field as keyof typeof usageKeys];
    if (value != null && keys.every((key) => attrs[key] == null))
      attrs[keys[0]] = value;
  }
}
function spanFromOrq(raw: Row, index: number): OtelSpan {
  const attrs = flattenAttributes(record(raw.attributes) ? raw.attributes : {}),
    messages: {
      inputMessages: OtelMessage[] | null;
      outputMessages: OtelMessage[] | null;
    } = { inputMessages: null, outputMessages: null };
  for (const [field, key] of messageAttributes)
    if (Object.hasOwn(attrs, key) && messages[field] === null) {
      const parsed = messagesFromAttribute(attrs[key]);
      if (parsed !== null) {
        messages[field] = parsed;
        delete attrs[key];
      }
    }
  let systemInstructions: OtelPart[] | null = null;
  if (Object.hasOwn(attrs, SYSTEM)) {
    systemInstructions = partsFromAttribute(attrs[SYSTEM]);
    if (systemInstructions !== null) delete attrs[SYSTEM];
  }
  fillUsage(attrs, raw);
  const operation = attrs["gen_ai.operation.name"],
    op =
      typeof operation === "string" && operation
        ? operation === "chat-completion"
          ? "chat"
          : operation
        : ((
            {
              "span.chat_completion": "chat",
              "span.agent_execution": "invoke_agent",
            } as Record<string, string>
          )[typeof raw.type === "string" ? raw.type : ""] ?? null);
  let status = record(raw.status) ? raw.status.code : raw.status;
  status = pyString(status)
    .toLowerCase()
    .replace(/^status_code_/, "");
  return new OtelSpan({
    traceId: pyString(raw.trace_id || ""),
    spanId: spanIdOf(raw, index),
    parentSpanId: parentSpanIdOf(raw),
    name: pyString(raw.name || ""),
    spanType: typeof raw.type === "string" ? raw.type : null,
    operation: op,
    startTime: parseTime(raw.started_at ?? raw.start_time ?? null),
    endTime: parseTime(raw.ended_at ?? raw.end_time ?? null),
    status: ["ok", "error", "unset"].includes(String(status))
      ? status
      : String(status).includes("error")
        ? "error"
        : "unset",
    errorType:
      attrs["error.type"] != null ? pyString(attrs["error.type"]) : null,
    ...messages,
    systemInstructions,
    attributes: attrs,
  });
}
export function otelPartDict(part: OtelPart): Row {
  const known = new Set(
      part.type === "file"
        ? ["mimeType", "fileId"]
        : ["blob", "uri"].includes(part.type)
          ? ["mimeType"]
          : part.type === "server_tool_call"
            ? ["serverToolCall"]
            : part.type === "server_tool_call_response"
              ? ["serverToolCallResponse"]
              : [],
    ),
    out: Row = {};
  for (const [key, value] of Object.entries(part))
    Object.defineProperty(out, known.has(key) ? snake(key) : key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}
function messageWire(message: OtelMessage): Row {
  return Object.fromEntries(
    Object.entries(message).map(([key, value]) => [
      key === "finishReason" ? "finish_reason" : key,
      key === "parts" ? message.parts.map(otelPartDict) : value,
    ]),
  );
}
function spanWire(span: OtelSpanFields): Row {
  return Object.fromEntries(
    Object.entries(span).map(([key, value]) => [
      snake(key),
      (key === "inputMessages" || key === "outputMessages") &&
      Array.isArray(value)
        ? (value as OtelMessage[]).map(messageWire)
        : key === "systemInstructions" && Array.isArray(value)
          ? (value as OtelPart[]).map(otelPartDict)
          : (key === "startTime" || key === "endTime") &&
              typeof value === "string"
            ? value.replace(/\+00:00$/, "Z")
            : value,
    ]),
  );
}
export class OtelTrace {
  readonly spans: OtelSpan[];
  constructor(input: { spans: unknown[] }) {
    if (!input || !Array.isArray(input.spans))
      throw new TypeError("OTel spans must be an array");
    this.spans = input.spans.map((span) =>
      span instanceof OtelSpan ? span : new OtelSpan(span),
    );
    const ids = new Set(this.spans.map((s) => s.traceId).filter(Boolean));
    if (ids.size > 1)
      throw new TypeError(
        `OtelTrace spans carry ${ids.size} trace ids; split them into one OtelTrace per trace id`,
      );
    Object.freeze(this);
  }
  static fromOrq(spans: Row[]): OtelTrace {
    return new OtelTrace({ spans: spans.map(spanFromOrq) });
  }
  roots(): OtelSpan[] {
    const ids = new Set(this.spans.map((s) => s.spanId));
    return orderSpans(
      this.spans.filter(
        (s) => s.parentSpanId === null || !ids.has(s.parentSpanId),
      ),
    );
  }
  children(spanId: string): OtelSpan[] {
    return orderSpans(this.spans.filter((s) => s.parentSpanId === spanId));
  }
  toAtif(options: OtelConversionOptions = {}) {
    return otelToAtif(this, options);
  }
  toResponses(options: OtelConversionOptions = {}) {
    return this.toAtif(options).toResponses();
  }
  toChat(options: OtelConversionOptions = {}) {
    return this.toAtif(options).toChat();
  }
  toModelDict(): Row {
    return { spans: this.spans.map(spanWire) };
  }
}
