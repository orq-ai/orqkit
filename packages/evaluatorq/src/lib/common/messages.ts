import type { Message, StrategyToolCall } from "../contracts.js";
import { getField } from "./fields.js";
import { pythonStrip } from "./sanitize.js";
import { warnOnce } from "./thread-context.js";

const TEXT_PART_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "summary_text",
  "refusal",
]);
const REASONING_PART_TYPES = new Set([
  "reasoning",
  "reasoning_content",
  "thinking",
]);
const MEDIA_PART_TYPES = new Map([
  ["image", "image"],
  ["image_url", "image"],
  ["input_image", "image"],
  ["file", "file"],
  ["input_file", "file"],
  ["audio", "audio"],
  ["input_audio", "audio"],
  ["output_audio", "audio"],
  ["video", "video"],
  ["input_video", "video"],
]);

export class MediaContent {
  constructor(
    readonly kind: string,
    readonly value: unknown,
  ) {}
}

export function jsonWithFallback(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, inner: unknown) =>
        typeof inner === "bigint" ? String(inner) : inner,
      ) ?? "null"
    );
  } catch {
    return String(value);
  }
}

/** `json.dumps(indent=2)` text: other surfaces render or hash it, and Python's `ensure_ascii` escapes all non-ASCII. */
export function indentedAsciiJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, inner: unknown) =>
        typeof inner === "bigint" ? String(inner) : inner,
      2,
    ) ?? "null"
  ).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function partType(part: unknown): string | undefined {
  const type = getField(part, "type");
  return typeof type === "string" ? type : undefined;
}

export function contentPartText(part: unknown): string | null {
  const type = partType(part);
  if (type === undefined || !TEXT_PART_TYPES.has(type)) {
    return null;
  }
  const keys =
    type === "refusal" ? ["refusal", "text", "content"] : ["text", "content"];
  for (const key of keys) {
    const value = getField(part, key);
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function jsonOrText(value: unknown): string {
  if (isObject(value)) {
    return jsonWithFallback(value);
  }
  return value === null || value === undefined ? "" : String(value);
}

function isImageUrlShape(imageUrl: unknown): boolean {
  if (typeof imageUrl === "string") {
    return imageUrl.length > 0;
  }
  return ["url", "data"].some((key) => {
    const value = getField(imageUrl, key);
    return typeof value === "string" && value.length > 0;
  });
}

function mediaKind(part: unknown): string | null {
  const type = getField(part, "type");
  const kind =
    typeof type === "string" ? MEDIA_PART_TYPES.get(type) : undefined;
  if (kind) {
    return kind;
  }
  const missingType = type === null || type === undefined;
  return missingType && isImageUrlShape(getField(part, "image_url"))
    ? "image"
    : null;
}

function renderPart(part: unknown): (string | MediaContent)[] {
  const type = partType(part);
  if (type !== undefined && REASONING_PART_TYPES.has(type)) {
    return [];
  }
  const text = contentPartText(part);
  if (text !== null) {
    return [text];
  }
  const kind = mediaKind(part);
  return [kind ? new MediaContent(kind, part) : jsonOrText(part)];
}

function isContentPart(part: unknown): boolean {
  if (typeof part === "string") {
    return true;
  }
  const type = partType(part);
  const known =
    type !== undefined &&
    (TEXT_PART_TYPES.has(type) ||
      REASONING_PART_TYPES.has(type) ||
      MEDIA_PART_TYPES.has(type));
  return known || mediaKind(part) !== null;
}

const present = (part: unknown) => part !== null && part !== undefined;

export function iterContentParts(content: unknown): (string | MediaContent)[] {
  if (!present(content)) {
    return [];
  }
  if (Array.isArray(content)) {
    const parts = content.filter(present);
    return parts.every(isContentPart)
      ? parts.flatMap(renderPart)
      : [jsonOrText(content)];
  }
  return renderPart(content);
}

export function containsMediaContent(content: unknown): boolean {
  const parts = Array.isArray(content) ? content : [content];
  return parts.some((part) => present(part) && mediaKind(part) !== null);
}

function firstString(source: unknown, keys: readonly string[]): string {
  for (const key of keys) {
    const value = getField(source, key);
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

export function reasoningText(message: unknown): string {
  // Providers mirror one reasoning text under several names, so each source
  // contributes its first string field.
  const texts = [
    firstString(message, ["reasoning_content", "reasoning", "thinking"]),
  ];
  const content = getField(message, "content");
  for (const part of Array.isArray(content) ? content : []) {
    const type = partType(part);
    if (type === undefined || !REASONING_PART_TYPES.has(type)) {
      continue;
    }
    texts.push(firstString(part, ["thinking", "text", "reasoning", "content"]));
    const summary = getField(part, "summary");
    for (const item of Array.isArray(summary) ? summary : []) {
      const text = getField(item, "text");
      if (typeof text === "string") {
        texts.push(text);
      }
    }
  }
  return texts.filter((text) => pythonStrip(text)).join("\n\n");
}

export function coerceContentText(content: unknown): string {
  return iterContentParts(content)
    .map((part) => (part instanceof MediaContent ? `[${part.kind}]` : part))
    .join("\n");
}

export const UNKNOWN_ARGUMENTS = "";
export const UNKNOWN_ARGUMENTS_TEXT = "arguments unavailable";
export const NO_RESULT_TEXT = "no result recorded";
export const EMPTY_ASSISTANT_TEXT = "[The agent sent no reply]";

export function toolCallText(
  call: unknown,
  options: { incomplete?: boolean | null; result?: string | null } = {},
): string {
  const fn = getField(call, "function");
  const source = fn === null || fn === undefined ? call : fn;
  const name = getField(source, "name");
  const args = getField(source, "arguments");
  let rendered = typeof args === "string" ? args : jsonOrText(args);
  if (args === UNKNOWN_ARGUMENTS) {
    rendered = UNKNOWN_ARGUMENTS_TEXT;
  }
  let suffix = "";
  if (options.result !== null && options.result !== undefined) {
    suffix = ` -> ${options.result}`;
  } else if (options.incomplete ?? getField(call, "incomplete") === true) {
    suffix = ` -> ${NO_RESULT_TEXT}`;
  }
  return `[tool_call: ${name || "unknown"}(${rendered})${suffix}]`;
}

function legacyResultText(result: unknown): string {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if ("output" in record) {
      return jsonOrText(record.output);
    }
    if ("result" in record) {
      return jsonOrText(record.result);
    }
  }
  return jsonOrText(result);
}

export function messagesToText(
  messages: Iterable<unknown>,
  options: { pairByPosition?: boolean } = {},
): string {
  const rows = [...messages];
  const pairing =
    options.pairByPosition && rows.length > 0
      ? pairToolRows(rows as Message[])
      : null;
  const lines: string[] = [];
  rows.forEach((message, index) => {
    const text = coerceContentText(getField(message, "content"));
    const parts = pythonStrip(text) ? [text] : [];
    const toolCalls = getField(message, "tool_calls");
    const legacyCall = getField(message, "function_call");
    const legacyResult = getField(message, "function_call_output");
    const calls: unknown[] = [
      ...(Array.isArray(toolCalls) ? toolCalls : []),
      ...(present(legacyCall) ? [legacyCall] : []),
    ];
    const answered = pairing?.resultsFor(index);
    calls.forEach((call, position) => {
      parts.push(
        toolCallText(call, {
          incomplete: callIsIncomplete(
            call,
            answered ? answered.has(position) : null,
          ),
        }),
      );
    });
    if (present(legacyResult)) {
      parts.push(`[tool_result: ${legacyResultText(legacyResult)}]`);
    }
    if (parts.length === 0) {
      return;
    }
    const body = parts.join("\n");
    const role = getField(message, "role");
    lines.push(
      present(role) && role !== "assistant" ? `[${role}] ${body}` : body,
    );
  });
  return lines.join("\n");
}

export function parseJsonOrValue(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function toolResultToText(result: unknown): string {
  return typeof result === "string" ? result : jsonWithFallback(result);
}

export class ToolPairing {
  readonly rows: Set<number>;

  constructor(readonly rowOf: Map<number, Map<number, number>>) {
    this.rows = new Set(
      [...rowOf.values()].flatMap((answers) => [...answers.values()]),
    );
  }

  resultsFor(index: number): Map<number, number> {
    return this.rowOf.get(index) ?? new Map();
  }
}

export type ToolRow = readonly [
  role: string | null | undefined,
  callIds: readonly (string | null | undefined)[],
  toolCallId: string | null | undefined,
];

export interface ToolMatches {
  pairs: Map<number, Map<number, number[]>>;
  orphans: number[];
}

// The window follows what providers accept, probed live through the Orq router:
// Anthropic wants the result after its call and before the next user turn but
// not adjacent, OpenAI chat completions wants it directly after the call, and
// OpenAI Responses accepts any order.
export function matchToolResults(
  rows: readonly ToolRow[],
  options: { tolerant?: boolean } = {},
): ToolMatches {
  const tolerant = options.tolerant ?? false;
  type Owner = readonly [row: number, position: number];
  const openCalls = new Map<string, Owner[]>();
  const answered = new Map<string, Owner>();
  const pairs: ToolMatches["pairs"] = new Map();
  const orphans: number[] = [];
  rows.forEach(([role, callIds, resultId], index) => {
    if (role === "user") {
      openCalls.clear();
      answered.clear();
    } else if (role === "assistant") {
      callIds.forEach((callId, position) => {
        if (callId === null || callId === undefined) {
          return;
        }
        const queue = openCalls.get(callId) ?? [];
        openCalls.set(callId, queue);
        if (tolerant && queue.length > 0 && queue[0]?.[0] !== index) {
          queue.length = 0;
        }
        if (tolerant || queue.length === 0) {
          queue.push([index, position]);
        }
      });
    } else if (role === "tool") {
      const key = resultId || "";
      let owner = openCalls.get(key)?.shift();
      if (owner) {
        answered.set(key, owner);
      } else if (tolerant) {
        owner = answered.get(key);
      }
      if (!owner) {
        orphans.push(index);
        return;
      }
      const [row, position] = owner;
      const byPosition = pairs.get(row) ?? new Map<number, number[]>();
      pairs.set(row, byPosition);
      byPosition.set(position, [...(byPosition.get(position) ?? []), index]);
    }
  });
  return { pairs, orphans };
}

export function pairToolRows(messages: readonly Message[]): ToolPairing {
  const { pairs } = matchToolResults(
    messages.map((m) => [
      m.role,
      (m.tool_calls ?? []).map((tc) => tc.id),
      m.tool_call_id,
    ]),
  );
  const rowOf = new Map<number, Map<number, number>>();
  for (const [row, byPosition] of pairs) {
    rowOf.set(
      row,
      new Map(
        [...byPosition].map(([position, results]) => [
          position,
          results[0] as number,
        ]),
      ),
    );
  }
  return new ToolPairing(rowOf);
}

export function callIsIncomplete(
  call: unknown,
  paired: boolean | null,
): boolean {
  return paired === null ? getField(call, "incomplete") === true : !paired;
}

export function wireArguments(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    return isObject(parsed) && !Array.isArray(parsed) ? args : "{}";
  } catch {
    return "{}";
  }
}

function sortedIds(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}

function warnDropped(
  calls: readonly (readonly string[])[],
  results: readonly (readonly string[])[],
): void {
  if (calls.length === 0 && results.length === 0) {
    return;
  }
  const parts: string[] = [];
  if (calls.length > 0) {
    parts.push(
      `tool call(s) ${sortedIds(calls.map((c) => c[1] as string))} (no result follows them)`,
    );
  }
  if (results.length > 0) {
    parts.push(
      `tool result(s) ${sortedIds(results.map((r) => r[1] as string))} (no call precedes them)`,
    );
  }
  warnOnce(
    [...calls, ...results].map((record) => JSON.stringify(record)),
    `Not replaying ${parts.join(" and ")} to the target. They stay in the recorded transcript.`,
  );
}

export function dropUnreplayableToolRecords(
  messages: readonly Message[],
  options: { incompleteAsText?: boolean } = {},
): Message[] {
  const incompleteAsText = options.incompleteAsText ?? false;
  const pairing = pairToolRows(messages);
  const droppedCalls: string[][] = [];
  const droppedResults: string[][] = [];
  const out: Message[] = [];
  messages.forEach((m, index) => {
    if (m.role === "tool") {
      if (!pairing.rows.has(index)) {
        droppedResults.push(["result", m.tool_call_id || "<no id>"]);
      }
      return;
    }
    if (m.role !== "assistant") {
      out.push(m);
      return;
    }
    const answered = pairing.resultsFor(index);
    const calls = m.tool_calls ?? [];
    const kept = calls.filter((_, position) => answered.has(position));
    const lost = calls.filter((_, position) => !answered.has(position));
    const unknown = kept.filter(
      (tc) => tc.function.arguments === UNKNOWN_ARGUMENTS,
    );
    const silent = !pythonStrip(coerceContentText(m.content));
    const results = [...answered]
      .sort(([a], [b]) => a - b)
      .map(([, row]) => messages[row] as Message);
    if (
      lost.length === 0 &&
      !(incompleteAsText && unknown.length > 0) &&
      (calls.length > 0 || !silent)
    ) {
      out.push(m, ...results);
      return;
    }
    let content = m.content;
    if (incompleteAsText) {
      content = withToolNotes(content, lost, unknown);
    } else {
      droppedCalls.push(
        ...lost.map((tc) => [
          "call",
          tc.id,
          tc.function.name,
          tc.function.arguments,
        ]),
      );
    }
    if (kept.length === 0 && !pythonStrip(coerceContentText(content))) {
      content = EMPTY_ASSISTANT_TEXT;
    }
    out.push(
      { ...m, content, tool_calls: kept.length > 0 ? kept : null },
      ...results,
    );
  });
  warnDropped(droppedCalls, droppedResults);
  return out;
}

function withToolNotes(
  content: Message["content"],
  lost: readonly StrategyToolCall[],
  unknown: readonly StrategyToolCall[],
): Message["content"] {
  const notes = [
    ...lost.map((tc) => toolCallText(tc, { incomplete: true })),
    ...unknown.map((tc) => toolCallText(tc, { incomplete: false })),
  ];
  if (notes.length === 0) {
    return content;
  }
  const marker = notes.join("\n");
  if (Array.isArray(content)) {
    return [...content, { type: "input_text", text: marker }];
  }
  return content && pythonStrip(content) ? `${content}\n${marker}` : marker;
}
