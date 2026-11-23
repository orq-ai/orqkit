import type { Message, StrategyToolCall } from "../contracts.js";
import { MessageSchema } from "../contracts.js";
import {
  isResponsesItem,
  itemsToInputMessages,
  itemsToOutputMessages,
} from "../integrations/openresponses/otel-messages.js";
import {
  parseIsoTimestamp,
  Trace,
  TraceInput,
  type TraceMessageFormat,
} from "../trace.js";
import { envRaw } from "./env-config.js";
import { contentPartText } from "./messages.js";
import { orqServerUrl } from "./orq-client.js";
import { withRetry } from "./retry.js";
import { pythonStrip } from "./sanitize.js";

const SPAN_FETCH_CONCURRENCY = 5;
const API_PAGE_LIMIT = 200;
const HTTP_TIMEOUT_MS = 60_000;

export type MessageFormat = Exclude<TraceMessageFormat, "mixed">;
type Role = Message["role"];
type JsonRecord = Record<string, unknown>;
type SpanCandidate = readonly [MessageFormat | null, unknown];

const ROLES: ReadonlySet<unknown> = new Set([
  "user",
  "assistant",
  "tool",
  "system",
  "developer",
]);
const MEDIA_PART_TYPES: ReadonlySet<unknown> = new Set([
  "image",
  "image_url",
  "input_image",
  "input_file",
  "file",
  "audio",
  "input_audio",
]);
const MESSAGE_KEYS = [
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "call_id",
  "name",
  "refusal",
];
// The trailing dots matter: a bare `orq.evaluator` prefix also matches
// `orq.evaluatorq_run_id`, stamped on the root span of every evaluatorq run.
const EVALUATOR_ATTRIBUTE_PREFIXES = ["orq.evaluator.", "gen_ai.evaluation."];
const EVALUATOR_ATTRIBUTES = new Set(["orq.evaluator", "gen_ai.evaluation"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapping(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

function firstTruthy(...values: unknown[]): unknown {
  return values.find(isTruthy) ?? values.at(-1);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  return value === null ? "null" : typeof value;
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const stripped = pythonStrip(value);
  if (!["{", "[", '"'].includes(stripped.slice(0, 1))) {
    return value;
  }
  try {
    return JSON.parse(stripped);
  } catch {
    return value;
  }
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta =
      ((left[i] as string).codePointAt(0) as number) -
      ((right[i] as string).codePointAt(0) as number);
    if (delta !== 0) {
      return delta;
    }
  }
  return left.length - right.length;
}

function asciiString(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Written out because JSON.stringify emits integer-like keys in numeric order
// whatever order they were inserted in.
function sortedJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return asciiString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareCodePoints)
      .map((key) => `${asciiString(key)}:${sortedJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return asciiString(String(value));
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : sortedJson(value);
}

function contentText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    console.warn(
      `Unknown trace message content shape ${describeType(value)}; JSON-encoding it.`,
    );
    return jsonText(value);
  }
  const text: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!isRecord(part)) {
      console.warn(
        `Unknown trace content part shape ${describeType(part)}; JSON-encoding it.`,
      );
      text.push(jsonText(part));
      continue;
    }
    const partType = part.type ?? null;
    // Recorded traces carry untyped {text: ...} parts, which the shared table does not accept.
    const content = contentPartText(
      partType !== null ? part : { ...part, type: "text" },
    );
    if (content !== null) {
      if (content) {
        text.push(content);
      }
      continue;
    }
    if (MEDIA_PART_TYPES.has(partType)) {
      console.warn(
        `Trace message contains a ${String(partType)} part that cannot be scored as text; preserving a marker.`,
      );
      text.push(`[${String(partType)}]`);
      continue;
    }
    console.warn(
      `Unknown trace content part type ${JSON.stringify(partType)}; JSON-encoding it.`,
    );
    text.push(jsonText(part));
  }
  return text.length > 0 ? text.join("\n") : null;
}

function toolCall(raw: unknown): StrategyToolCall | null {
  if (!isRecord(raw)) {
    console.warn(
      `Unknown trace tool-call shape ${describeType(raw)}; dropping it.`,
    );
    return null;
  }
  const fn = isRecord(raw.function) ? raw.function : raw;
  const name = fn.name;
  if (typeof name !== "string" || !name) {
    console.warn("Trace tool call has no function name; dropping it.");
    return null;
  }
  const args = "arguments" in fn ? fn.arguments : "{}";
  const callId = firstTruthy(raw.call_id, raw.id);
  if (typeof callId !== "string" || !callId) {
    console.warn(`Trace tool call '${name}' has no call ID; dropping it.`);
    return null;
  }
  return {
    id: callId,
    type: "function",
    item_id:
      typeof raw.id === "string" && raw.id.startsWith("fc_") ? raw.id : null,
    incomplete: false,
    function: { name, arguments: jsonText(args) },
  };
}

function optionalMessageString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value || null;
  }
  console.warn(`Trace message ${field} must be a string; dropping it.`);
  return null;
}

function normalizeRole(raw: JsonRecord, defaultRole: Role): unknown {
  const role = isTruthy(raw.role) ? raw.role : defaultRole;
  return typeof role === "string" ? pythonStrip(role).toLowerCase() : role;
}

function chatMessage(raw: unknown, defaultRole: Role): Message | null {
  if (typeof raw === "string") {
    return MessageSchema.parse({ role: defaultRole, content: raw });
  }
  if (!isRecord(raw)) {
    console.warn(
      `Unknown trace message shape ${describeType(raw)}; dropping it.`,
    );
    return null;
  }
  if (!MESSAGE_KEYS.some((key) => key in raw)) {
    // A request-parameter mapping would otherwise parse as a user turn and stop the search before the real one.
    console.warn(
      `Trace message mapping carries no message keys (saw ${JSON.stringify(Object.keys(raw).sort().slice(0, 8))}); dropping it.`,
    );
    return null;
  }
  const role = normalizeRole(raw, defaultRole);
  if (!ROLES.has(role)) {
    console.warn(
      `Unknown trace message role ${JSON.stringify(role)}; dropping it.`,
    );
    return null;
  }
  const calls = (Array.isArray(raw.tool_calls) ? raw.tool_calls : [])
    .map(toolCall)
    .filter((call): call is StrategyToolCall => call !== null);
  // A chat-completions refusal carries content=None and its text under 'refusal'.
  const content = raw.content ?? raw.refusal;
  return MessageSchema.parse({
    role,
    content: contentText(content),
    tool_calls: calls.length > 0 ? calls : null,
    tool_call_id: optionalMessageString(
      firstTruthy(raw.tool_call_id, raw.call_id),
      "tool_call_id",
    ),
    name: optionalMessageString(raw.name, "name"),
  });
}

function chatMessages(input: unknown, defaultRole: Role): Message[] {
  let value = decodeJson(input);
  if (isRecord(value)) {
    if (Array.isArray(value.messages)) {
      value = value.messages;
    } else if (Array.isArray(value.choices)) {
      value = value.choices.filter(isRecord).map((choice) => choice.message);
    } else if (isRecord(value.message)) {
      value = [value.message];
    } else if (typeof value.prompt === "string") {
      value = [value.prompt];
    } else if (typeof value.completion === "string") {
      value = [value.completion];
    } else {
      value = [value];
    }
  } else if (typeof value === "string") {
    value = [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((raw) => chatMessage(raw, defaultRole))
    .filter((message): message is Message => message !== null);
}

function otelParts(parts: unknown[]): {
  text: string[];
  toolCalls: StrategyToolCall[];
  toolResponses: Message[];
} {
  const text: string[] = [];
  const toolCalls: StrategyToolCall[] = [];
  const toolResponses: Message[] = [];
  for (const part of parts) {
    if (!isRecord(part)) {
      console.warn(
        `Unknown OTel GenAI part shape ${describeType(part)}; dropping it.`,
      );
      continue;
    }
    const partType = part.type ?? null;
    if (partType === null || partType === "text" || partType === "refusal") {
      const content = firstTruthy(part.content, part.text, part.refusal);
      if (typeof content === "string") {
        text.push(content);
      }
    } else if (partType === "tool_call") {
      const call = toolCall(part);
      if (call !== null) {
        toolCalls.push(call);
      }
    } else if (partType === "tool_call_response") {
      const callId = firstTruthy(part.id, part.call_id);
      if (typeof callId === "string" && callId) {
        const result =
          "response" in part
            ? part.response
            : "result" in part
              ? part.result
              : "output" in part
                ? part.output
                : "";
        toolResponses.push(
          MessageSchema.parse({
            role: "tool",
            tool_call_id: callId,
            name: part.name ?? null,
            content: jsonText(result),
          }),
        );
      } else {
        console.warn("OTel GenAI tool response has no call ID; dropping it.");
      }
    } else if (MEDIA_PART_TYPES.has(partType)) {
      console.warn(
        `Trace message contains a ${String(partType)} part that cannot be scored as text; preserving a marker.`,
      );
      text.push(`[${String(partType)}]`);
    } else if (partType === "reasoning") {
      console.error(
        "Dropping an OTel GenAI reasoning part from the imported transcript.",
      );
    } else {
      console.warn(
        `Unknown OTel GenAI part type ${JSON.stringify(partType)}; preserving JSON text.`,
      );
      text.push(jsonText(part));
    }
  }
  return { text, toolCalls, toolResponses };
}

function otelMessages(input: unknown, defaultRole: Role): Message[] {
  let value = decodeJson(input);
  if (isRecord(value) && Array.isArray(value.messages)) {
    value = value.messages;
  }
  if (isRecord(value) && Array.isArray(value.parts)) {
    // One bare OTel message object: chatMessages reads only 'content' and would drop its parts.
    value = [value];
  }
  if (!Array.isArray(value)) {
    return chatMessages(value, defaultRole);
  }
  const messages: Message[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.parts)) {
      const message = chatMessage(raw, defaultRole);
      if (message !== null) {
        messages.push(message);
      }
      continue;
    }
    let role = normalizeRole(raw, defaultRole);
    if (role === "agent") {
      role = "assistant";
    }
    const { text, toolCalls, toolResponses } = otelParts(raw.parts);
    if (role === "tool" && toolResponses.length > 0) {
      messages.push(...toolResponses);
    } else if (ROLES.has(role) && (text.length > 0 || toolCalls.length > 0)) {
      messages.push(
        MessageSchema.parse({
          role,
          content: text.length > 0 ? text.join("\n") : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : null,
        }),
        ...toolResponses,
      );
    } else if (!ROLES.has(role)) {
      console.warn(
        `Unknown OTel GenAI message role ${JSON.stringify(role)}; dropping it.`,
      );
    }
  }
  return messages;
}

function responsesMessages(input: unknown, defaultRole: Role): Message[] {
  let value = decodeJson(input);
  if (
    isRecord(value) &&
    !isResponsesItem(value) &&
    ("input" in value || "output" in value)
  ) {
    value = (defaultRole === "user" ? value.input : value.output) ?? null;
  }
  if (typeof value === "string") {
    return [MessageSchema.parse({ role: defaultRole, content: value })];
  }
  if (isRecord(value)) {
    if (isResponsesItem(value)) {
      value = [value];
    } else if (Array.isArray(value.messages)) {
      return chatMessages(value, defaultRole);
    } else if ("role" in value || "content" in value) {
      return chatMessages([value], defaultRole);
    }
  }
  const itemIds = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        isRecord(item) &&
        item.type === "function_call" &&
        typeof item.call_id === "string" &&
        typeof item.id === "string" &&
        item.id.startsWith("fc_")
      ) {
        itemIds.set(item.call_id, item.id);
      }
    }
  }
  const otel =
    defaultRole === "user"
      ? itemsToInputMessages(value)
      : itemsToOutputMessages(value);
  const messages = otelMessages(otel, defaultRole);
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      call.item_id = itemIds.get(call.id) ?? null;
    }
  }
  return messages;
}

function looksLikeOtel(value: unknown): boolean {
  let decoded = decodeJson(value);
  if (isRecord(decoded)) {
    decoded = "messages" in decoded ? decoded.messages : [decoded];
  }
  return (
    Array.isArray(decoded) &&
    decoded.some((item) => isRecord(item) && "parts" in item)
  );
}

function looksLikeResponses(value: unknown): boolean {
  const decoded = decodeJson(value);
  if (isRecord(decoded)) {
    // Either side of the Responses envelope may be a scalar or a Chat-style shorthand list.
    return (
      "input" in decoded || "output" in decoded || isResponsesItem(decoded)
    );
  }
  return (
    Array.isArray(decoded) &&
    decoded.some((item) => isRecord(item) && isResponsesItem(item))
  );
}

export function detectMessageFormat(value: unknown): MessageFormat {
  if (looksLikeOtel(value)) {
    return "otel_genai";
  }
  return looksLikeResponses(value) ? "responses" : "chat_completions";
}

export function parseMessages(
  value: unknown,
  options: { hinted?: MessageFormat | null; defaultRole: Role },
): { messages: Message[]; format: MessageFormat } {
  const format = options.hinted ?? detectMessageFormat(value);
  if (format === "otel_genai") {
    return { messages: otelMessages(value, options.defaultRole), format };
  }
  if (format === "responses") {
    return { messages: responsesMessages(value, options.defaultRole), format };
  }
  return { messages: chatMessages(value, options.defaultRole), format };
}

function nested(source: unknown, ...path: string[]): unknown {
  let value = source;
  for (const key of path) {
    if (!isRecord(value) || !(key in value)) {
      return null;
    }
    value = value[key];
  }
  return value;
}

function attributeValue(value: unknown): unknown {
  const decoded = decodeJson(value);
  return isRecord(decoded) && "_value" in decoded
    ? decodeJson(decoded._value)
    : decoded;
}

function attributeSideCandidates(
  attributes: JsonRecord,
  side: "input" | "output",
): SpanCandidate[] {
  const genAi = mapping(attributes.gen_ai);
  const openresponses = mapping(attributes.openresponses);
  const orqOpenresponses = mapping(mapping(attributes.orq).openresponses);
  const candidates: SpanCandidate[] = [
    ["otel_genai", attributes[`gen_ai.${side}.messages`]],
    ["otel_genai", attributes[`gen_ai.${side}`]],
    [
      "otel_genai",
      attributes[
        side === "input" ? "gen_ai.input.prompt" : "gen_ai.output.completion"
      ],
    ],
    ["otel_genai", nested(genAi, side, "messages")],
    ["responses", attributes[`openresponses.${side}`]],
    ["responses", openresponses[side]],
  ];
  const envelope = attributeValue(
    firstTruthy(
      ...(side === "input"
        ? [
            attributes["openresponses.request"],
            openresponses.request,
            attributes["orq.openresponses.request"],
            orqOpenresponses.request,
          ]
        : [
            attributes["openresponses.response"],
            openresponses.response,
            attributes["orq.openresponses.response"],
            orqOpenresponses.response,
          ]),
    ),
  );
  candidates.push([
    "responses",
    isRecord(envelope) ? nested(envelope, side) : null,
  ]);
  candidates.push([null, genAi[side]], [null, attributes[side]]);
  return candidates
    .map(([format, value]) => [format, attributeValue(value)] as SpanCandidate)
    .filter(([, value]) => value !== null && value !== undefined);
}

function messageCandidates(
  span: JsonRecord,
  side: "input" | "output",
): SpanCandidate[] {
  const candidates = attributeSideCandidates(mapping(span.attributes), side);
  if (Array.isArray(span.events)) {
    for (const event of span.events) {
      if (isRecord(event)) {
        candidates.push(
          ...attributeSideCandidates(mapping(event.attributes), side),
        );
      }
    }
  }
  if (span[side] !== null && span[side] !== undefined) {
    candidates.push([null, span[side]]);
  }
  return candidates;
}

function parseSide(
  span: JsonRecord,
  side: "input" | "output",
  defaultRole: Role,
): { messages: Message[]; format: MessageFormat } | null {
  for (const [hinted, value] of messageCandidates(span, side)) {
    const parsed = parseMessages(value, { hinted, defaultRole });
    // Content-less messages would stop the search at a shape that merely looked like a conversation.
    if (
      parsed.messages.some(
        (message) =>
          message.content || message.tool_calls?.length || message.tool_call_id,
      )
    ) {
      return parsed;
    }
  }
  return null;
}

function parseExchange(span: JsonRecord): {
  inputMessages: Message[];
  outputMessages: Message[];
  messageFormat: TraceMessageFormat | null;
} {
  const input = parseSide(span, "input", "user");
  const output = parseSide(span, "output", "assistant");
  const formats = new Set(
    [input, output]
      .filter((side) => side !== null && side.messages.length > 0)
      .map((side) => side?.format as MessageFormat),
  );
  return {
    inputMessages: input?.messages ?? [],
    outputMessages: output?.messages ?? [],
    messageFormat:
      formats.size === 1
        ? ([...formats][0] as MessageFormat)
        : formats.size > 0
          ? "mixed"
          : null,
  };
}

/** A raw span's id, or a synthetic `__span_<index>` when it has none. */
export function spanIdOf(span: JsonRecord, index: number): string {
  const value = firstTruthy(span.span_id, span._id, span.id);
  return isTruthy(value) ? String(value) : `__span_${index}`;
}

/** A raw span's parent id, or null for a root (missing or empty parent). */
export function parentSpanIdOf(span: JsonRecord): string | null {
  const value = firstTruthy(span.parent_span_id, span.parent_id);
  return isTruthy(value) ? String(value) : null;
}

function isEvaluatorType(value: string): boolean {
  return value.includes("evaluator") || value.includes("evaluation");
}

function isEvaluator(span: JsonRecord): boolean {
  if (isEvaluatorType(String(firstTruthy(span.type, "")).toLowerCase())) {
    return true;
  }
  const attributes = mapping(span.attributes);
  const orqSpanType = firstTruthy(
    attributes["orq.span_type"],
    nested(attributes, "orq", "span_type"),
  );
  if (isEvaluatorType(String(orqSpanType).toLowerCase())) {
    return true;
  }
  return Object.keys(attributes).some(
    (key) =>
      EVALUATOR_ATTRIBUTES.has(key) ||
      EVALUATOR_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}

function timeOf(span: JsonRecord, index: number): number {
  const value = firstTruthy(
    span.started_at,
    span.start_time,
    span.ended_at,
    span.end_time,
  );
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseIsoTimestamp(value, { naive: "local" });
    if (parsed !== null) {
      return parsed;
    }
    console.warn(
      `Could not parse trace span timestamp '${value}'; using response order.`,
    );
  }
  return index;
}

function messageText(message: Message): string {
  return typeof message.content === "string" ? message.content : "";
}

function firstAttribute(
  spans: JsonRecord[],
  ...names: string[]
): string | null {
  for (const span of spans) {
    const attributes = mapping(span.attributes);
    for (const name of names) {
      let value = attributes[name];
      if ((value === null || value === undefined) && name.includes(".")) {
        value = nested(attributes, ...name.split("."));
      }
      if (typeof value === "string" && value) {
        return value;
      }
    }
  }
  return null;
}

function retrievalsOf(span: JsonRecord): string[] {
  const attributes = mapping(span.attributes);
  let value = decodeJson(
    firstTruthy(
      attributes.retrievals,
      attributes["gen_ai.retrievals"],
      attributes["orq.retrievals"],
    ),
  );
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    console.warn(
      `Unknown trace retrievals shape ${describeType(value)}; preserving it as one JSON string.`,
    );
    value = [value];
  }
  return (value as unknown[]).map(jsonText);
}

function humanExpectedOutput(traceMetadata: JsonRecord): string | null {
  for (const field of ["feedback", "annotations"]) {
    let annotations = traceMetadata[field];
    if (isRecord(annotations)) {
      annotations = [annotations];
    }
    if (!Array.isArray(annotations)) {
      continue;
    }
    for (const annotation of annotations) {
      if (!isRecord(annotation)) {
        continue;
      }
      const property = firstTruthy(
        annotation.property,
        annotation.name,
        annotation.key,
      );
      if (
        typeof property === "string" &&
        pythonStrip(property).toLowerCase() === "correction" &&
        typeof annotation.value === "string" &&
        pythonStrip(annotation.value)
      ) {
        return annotation.value;
      }
    }
  }
  return null;
}

function failedTrace(
  traceId: string,
  error: string,
  requestedSpanId?: string | null,
): Trace {
  console.warn(`Could not import trace ${traceId}: ${error}`);
  return new Trace({ traceId, requestedSpanId, importError: error });
}

function evaluatorSubtreeIds(
  indexed: readonly (readonly [string, JsonRecord, number])[],
): Set<string> {
  const children = new Map<string | null, string[]>();
  for (const [spanId, span] of indexed) {
    const parent = parentSpanIdOf(span);
    children.set(parent, [...(children.get(parent) ?? []), spanId]);
  }
  const evaluatorIds = new Set(
    indexed.filter(([, span]) => isEvaluator(span)).map(([spanId]) => spanId),
  );
  const queue = [...evaluatorIds];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as string) ?? []) {
      if (!evaluatorIds.has(child)) {
        evaluatorIds.add(child);
        queue.push(child);
      }
    }
  }
  return evaluatorIds;
}

/**
 * Select and normalize one exchange from a trace's spans. An explicit span
 * request is exact and never replaced by a parent span. Otherwise the latest
 * eligible span is selected, walking toward its parent only when it has no
 * messages.
 */
export function traceFromSpans(
  traceId: string,
  spans: JsonRecord[],
  options: {
    requestedSpanId?: string | null;
    traceMetadata?: JsonRecord | null;
  } = {},
): Trace {
  const requestedSpanId = options.requestedSpanId ?? null;
  if (spans.length === 0) {
    return failedTrace(traceId, "the trace has no spans.", requestedSpanId);
  }
  const indexed = spans.map(
    (span, index) => [spanIdOf(span, index), span, index] as const,
  );
  const byId = new Map(indexed.map(([spanId, span]) => [spanId, span]));
  const evaluatorIds = evaluatorSubtreeIds(indexed);

  let selectedId: string | undefined;
  let selectedSpan: JsonRecord | undefined;
  let exchange: ReturnType<typeof parseExchange> | undefined;
  if (requestedSpanId !== null) {
    const requested = byId.get(requestedSpanId);
    if (requested === undefined) {
      return failedTrace(
        traceId,
        `requested span '${requestedSpanId}' was not found.`,
        requestedSpanId,
      );
    }
    if (evaluatorIds.has(requestedSpanId)) {
      return failedTrace(
        traceId,
        `requested span '${requestedSpanId}' belongs to an evaluator span or its subtree.`,
        requestedSpanId,
      );
    }
    selectedId = requestedSpanId;
    selectedSpan = requested;
    exchange = parseExchange(requested);
    if (
      exchange.inputMessages.length === 0 &&
      exchange.outputMessages.length === 0
    ) {
      return failedTrace(
        traceId,
        `requested span '${requestedSpanId}' has no input or output messages.`,
        requestedSpanId,
      );
    }
  } else {
    const eligible = indexed.filter(([spanId]) => !evaluatorIds.has(spanId));
    if (eligible.length === 0) {
      return failedTrace(
        traceId,
        "every span belongs to an evaluator span or its subtree.",
      );
    }
    let leaf = eligible[0] as (typeof eligible)[number];
    let leafTime = Number.NEGATIVE_INFINITY;
    for (const candidate of eligible) {
      const time = timeOf(candidate[1], candidate[2]);
      if (time >= leafTime) {
        leaf = candidate;
        leafTime = time;
      }
    }
    let currentId: string | null = leaf[0];
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const span: JsonRecord | undefined = byId.get(currentId);
      if (span === undefined) {
        break;
      }
      const candidate = parseExchange(span);
      if (
        candidate.inputMessages.length > 0 ||
        candidate.outputMessages.length > 0
      ) {
        selectedId = currentId;
        selectedSpan = span;
        exchange = candidate;
        break;
      }
      currentId = parentSpanIdOf(span);
    }
  }
  if (
    selectedSpan === undefined ||
    selectedId === undefined ||
    exchange === undefined
  ) {
    return failedTrace(
      traceId,
      "no non-evaluator span on the latest span path contains input or output messages.",
    );
  }

  const { inputMessages, outputMessages, messageFormat } = exchange;
  const conversation = [...inputMessages, ...outputMessages];
  const toolsCalled = [
    ...new Set(
      conversation
        .flatMap((message) => message.tool_calls ?? [])
        .map((call) => call.function.name)
        .filter(Boolean),
    ),
  ];
  const lastUser = [...conversation]
    .reverse()
    .find(
      (message) => message.role === "user" && pythonStrip(messageText(message)),
    );
  const source = options.traceMetadata ?? {};
  const metadata: JsonRecord = Object.fromEntries(
    Object.entries({
      traceName: source.name,
      spanName: selectedSpan.name,
      spanType: selectedSpan.type,
      operation: selectedSpan.operation,
      provider: selectedSpan.provider,
      model: selectedSpan.model,
      status: selectedSpan.status,
    }).filter(([, value]) => value !== null && value !== undefined),
  );
  if (isRecord(source.metadata)) {
    Object.assign(metadata, source.metadata);
  }
  return new Trace({
    traceId,
    requestedSpanId,
    messageSpanId: selectedId.startsWith("__span_") ? null : selectedId,
    messageFormat,
    inputMessages,
    outputMessages,
    query: lastUser ? messageText(lastUser) : null,
    retrievals: retrievalsOf(selectedSpan),
    toolsCalled,
    sessionId:
      firstAttribute(
        spans,
        "session_id",
        "session.id",
        "gen_ai.conversation.id",
        "orq.session_id",
      ) ?? (typeof source.session_id === "string" ? source.session_id : null),
    actorId: firstAttribute(spans, "actor_id", "actor.id", "enduser.id"),
    threadId:
      firstAttribute(
        spans,
        "thread_id",
        "thread.id",
        "gen_ai.thread.id",
        "orq.thread_id",
      ) ?? (typeof source.thread_id === "string" ? source.thread_id : null),
    metadata,
    expectedOutput: humanExpectedOutput(source),
  });
}

class OrqHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "OrqHttpError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface OrqRequest {
  fetchFn: FetchLike;
  headers: Record<string, string>;
}

async function requestJson(
  request: OrqRequest,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await request.fetchFn(url, {
      ...init,
      headers: { ...request.headers, ...init.headers },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    // `withRetry` keys off this name; a raw fetch failure has no shared shape across runtimes.
    throw Object.assign(new Error(String(error), { cause: error }), {
      name: "APIConnectionError",
    });
  }
  if (!response.ok) {
    throw new OrqHttpError(response.status, url);
  }
  return response.json();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listPage(
  payload: unknown,
  label: string,
): { data: JsonRecord[]; next: string | null } {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.data) ||
    !payload.data.every(isRecord)
  ) {
    throw new Error(`${label} returned an invalid list payload.`);
  }
  if (payload.has_more !== undefined && typeof payload.has_more !== "boolean") {
    throw new Error(`${label} returned an invalid has_more value.`);
  }
  if (!payload.has_more) return { data: payload.data, next: null };
  if (typeof payload.next_page_token !== "string" || !payload.next_page_token) {
    throw new Error(
      `${label} has more results but returned no next_page_token; refusing a partial import.`,
    );
  }
  return { data: payload.data, next: payload.next_page_token };
}

function advancePage(
  token: string | null,
  seen: Set<string>,
  label: string,
): string | null {
  if (token === null) return null;
  if (seen.has(token))
    throw new Error(
      `${label} repeated a page token; refusing a partial import.`,
    );
  seen.add(token);
  return token;
}

async function listTraceRows(
  source: TraceInput,
  host: string,
  request: OrqRequest,
): Promise<JsonRecord[]> {
  if (!source.startTime || !source.endTime) {
    throw new Error("Trace search on v3 requires both startTime and endTime.");
  }
  const rows: JsonRecord[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let token: string | null = null;
  do {
    const body: JsonRecord = {
      from: source.startTime.toISOString(),
      to: source.endTime.toISOString(),
      filters: source.filters,
      filter_operator: "and",
      query: source.search,
      limit: Math.min(source.queryLimit - rows.length, API_PAGE_LIMIT),
      ...(token ? { page_token: token } : {}),
    };
    let page: ReturnType<typeof listPage>;
    try {
      page = listPage(
        await withRetry(
          () =>
            requestJson(request, `${host}/v3/traces/search`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          { label: "Orq trace list" },
        ),
        "Orq trace list",
      );
    } catch (error) {
      throw new Error(`Failed to list Orq traces: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const before = rows.length;
    for (const row of page.data) {
      if (typeof row.trace_id !== "string" || !row.trace_id)
        throw new Error("Orq trace list returned a row without a trace_id.");
      if (!ids.has(row.trace_id)) {
        ids.add(row.trace_id);
        rows.push(row);
      }
    }
    if (rows.length >= source.queryLimit) break;
    if (page.next && rows.length === before)
      throw new Error(
        "Orq trace list made no progress; refusing a partial import.",
      );
    token = advancePage(page.next, tokens, "Orq trace list");
  } while (token);
  return rows;
}

async function fetchTraceSpans(
  traceId: string,
  host: string,
  request: OrqRequest,
): Promise<JsonRecord[]> {
  const base = `${host}/v3/traces/${encodeURIComponent(traceId)}/spans`;
  const summaries = new Map<string, JsonRecord>();
  const tokens = new Set<string>();
  let token: string | null = null;
  do {
    const query = new URLSearchParams({
      limit: String(API_PAGE_LIMIT),
      ...(token ? { page_token: token } : {}),
    });
    const page = listPage(
      await withRetry(
        () => requestJson(request, `${base}?${query}`, { method: "GET" }),
        { label: `Orq trace ${traceId} spans` },
      ),
      `Orq trace ${traceId} spans`,
    );
    const before = summaries.size;
    for (const summary of page.data) {
      if (typeof summary.span_id !== "string" || !summary.span_id)
        throw new Error("Span list returned a row without a span_id.");
      if (summary.trace_id && summary.trace_id !== traceId)
        throw new Error("Span list returned a different trace_id.");
      summaries.set(summary.span_id, summary);
    }
    if (page.next && summaries.size === before)
      throw new Error("Span list made no progress; refusing a partial import.");
    token = advancePage(page.next, tokens, `Orq trace ${traceId} spans`);
  } while (token);
  const spans: JsonRecord[] = [];
  // The outer trace workers own concurrency; keep detail requests in each worker serial.
  for (const [spanId, listed] of summaries) {
    const payload = await withRetry(
      () =>
        requestJson(request, `${base}/${encodeURIComponent(spanId)}`, {
          method: "GET",
        }),
      { label: `Orq trace ${traceId} span ${spanId}` },
    );
    const detail = isRecord(payload) ? payload.span : null;
    if (
      !isRecord(detail) ||
      !isRecord(detail.summary) ||
      detail.summary.span_id !== spanId
    )
      throw new Error(
        `Span ${spanId} returned an invalid or mismatched detail payload.`,
      );
    if (detail.summary.trace_id && detail.summary.trace_id !== traceId)
      throw new Error(`Span ${spanId} returned a different trace_id.`);
    if (detail.attributes !== undefined && !isRecord(detail.attributes))
      throw new Error(`Span ${spanId} returned invalid attributes.`);
    spans.push({
      ...listed,
      ...detail.summary,
      attributes: detail.attributes ?? {},
    });
  }
  return spans;
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export interface FetchTracesOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
}

/**
 * Fetch Orq traces and normalize each one. One unreadable trace becomes a
 * `Trace` with `importError` set; the others stay available. Partition the
 * result with `partitionTraces` so every surface reports failures the same way.
 */
export async function fetchTraces(
  source: TraceInput,
  options: FetchTracesOptions = {},
): Promise<Trace[]> {
  const key = options.apiKey || envRaw("ORQ_API_KEY");
  if (!key) {
    throw new Error("Missing Orq API key: set ORQ_API_KEY or pass apiKey.");
  }
  const host = (options.baseUrl || orqServerUrl()).replace(/\/+$/, "");
  const request: OrqRequest = {
    fetchFn: options.fetchFn ?? ((input, init) => fetch(input, init)),
    headers: { Authorization: `Bearer ${key}` },
  };
  const rows =
    source.traceId !== null
      ? [{ trace_id: source.traceId } as JsonRecord]
      : await listTraceRows(source, host, request);

  const fetchOne = async (row: JsonRecord): Promise<Trace> => {
    const traceId = String(row.trace_id);
    let spans: JsonRecord[];
    try {
      spans = await fetchTraceSpans(traceId, host, request);
    } catch (error) {
      return failedTrace(
        traceId,
        `could not fetch its spans: ${errorMessage(error)}`,
        source.spanId,
      );
    }
    return traceFromSpans(traceId, spans, {
      requestedSpanId: source.spanId,
      traceMetadata: row,
    });
  };

  const selected =
    source.traceId !== null ? rows : rows.slice(0, source.queryLimit);
  if (selected.length === 0 && source.traceId === null) {
    // A green run over no datapoints reads as "everything passed".
    console.warn(
      `Trace query matched no traces (limit=${source.queryLimit}, search='${source.search}', filters=${source.filters.length}, startTime=${source.startTime?.toISOString() ?? null}, endTime=${source.endTime?.toISOString() ?? null}).`,
    );
  }
  return mapWithLimit(
    selected.filter((row) => isTruthy(row.trace_id)),
    SPAN_FETCH_CONCURRENCY,
    fetchOne,
  );
}

/** Split imported traces into usable and failed, logging the failures once. */
export function partitionTraces(
  traces: readonly Trace[],
  options: { caller: string },
): { usable: Trace[]; failed: Trace[] } {
  const usable = traces.filter((trace) => trace.importError === null);
  const failed = traces.filter((trace) => trace.importError !== null);
  if (failed.length > 0) {
    const details = failed
      .map((trace) => `${trace.traceId}: ${trace.importError}`)
      .join("; ");
    console.warn(
      `${options.caller}: ${failed.length} of ${traces.length} imported trace(s) failed and were excluded: ${details}`,
    );
  }
  return { usable, failed };
}

export interface TraceBatch {
  traces: Trace[];
  usable: Trace[];
  failed: Trace[];
}

/**
 * Resolve a trace source for any surface. What an empty or all-failed batch
 * means is the surface's own rule, so this never throws on one.
 */
export async function loadTraces(
  source: TraceInput | Iterable<Trace>,
  options: FetchTracesOptions & { caller: string },
): Promise<TraceBatch> {
  const { caller, ...fetchOptions } = options;
  const traces =
    source instanceof TraceInput
      ? await fetchTraces(source, fetchOptions)
      : [...source];
  return { traces, ...partitionTraces(traces, { caller }) };
}
