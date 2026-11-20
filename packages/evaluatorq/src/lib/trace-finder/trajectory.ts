import { contentPartText } from "../common/messages.js";
import { pythonString } from "../common/sanitize.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";

export type Kind =
  | "system"
  | "user"
  | "assistant"
  | "reasoning"
  | "call"
  | "result"
  | "other";
export const KIND_LABELS: Readonly<Record<Kind, string>> = Object.freeze({
  system: "System",
  user: "User",
  assistant: "Assistant",
  reasoning: "Reasoning",
  call: "Tool call",
  result: "Tool result",
  other: "Other",
});
export const PREVIEW_CHARS = 240;
const ROLE_KINDS: Readonly<Record<string, Kind>> = {
  system: "system",
  developer: "system",
  user: "user",
  assistant: "assistant",
  agent: "assistant",
  model: "assistant",
  tool: "result",
};
const TEXT_TYPES = new Set([
    "text",
    "input_text",
    "output_text",
    "summary_text",
    "refusal",
  ]),
  CALL_TYPES = new Set(["tool_call", "function_call", "function", "tool_use"]),
  RESULT_TYPES = new Set([
    "tool_call_response",
    "function_call_output",
    "tool_result",
  ]);
export interface Segment {
  readonly kind: Kind;
  readonly tokens: number;
  readonly index: number;
  readonly label: string | null;
  readonly preview: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : record(value)
      ? Object.keys(value).length > 0
      : Boolean(value));
const first = (...values: unknown[]): unknown => values.find(truth);
const text = (value: unknown): string =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : pythonJson(value, { ensureAscii: false, defaultString: true });
export function preview(text: string): string {
  try {
    text = pythonJson(parsePythonJson(text), { indent: 1, ensureAscii: false });
  } catch {}
  const chars = [...text];
  return chars.length <= PREVIEW_CHARS
    ? text
    : `${chars.slice(0, PREVIEW_CHARS).join("")}…`;
}
function segment(
  kind: Kind,
  body: string,
  index: number,
  label: string | null = null,
): Segment | null {
  return body
    ? Object.freeze({
        kind,
        tokens: Math.max(1, Math.ceil([...body].length / 4)),
        index,
        label,
        preview: preview(body),
      })
    : null;
}
function part(
  value: unknown,
  role: Kind,
  index: number,
  toolName: string | null,
): Segment | null {
  if (typeof value === "string")
    return segment(role, value, index, role === "result" ? toolName : null);
  if (!record(value)) return segment("other", text(value), index);
  const kind = first(value.type, value.kind),
    call = record(value.function) ? value.function : value;
  const shared = contentPartText(
    truth(value.type) ? value : { ...value, type: kind },
  );
  if (shared !== null)
    return segment(role, shared, index, role === "result" ? toolName : null);
  if (TEXT_TYPES.has(String(kind)))
    return segment(role, text(first(value.content, value.text)), index);
  if (kind === "reasoning")
    return segment(
      "reasoning",
      text(first(value.content, value.text, value.reasoning, value.summary)),
      index,
    );
  if (CALL_TYPES.has(String(kind)))
    return segment(
      "call",
      text(first(call.arguments, call.input)),
      index,
      text(first(call.name, call.tool_name)) || null,
    );
  if (RESULT_TYPES.has(String(kind))) {
    let body: unknown;
    for (const key of ["response", "output", "result", "content"])
      if (Object.hasOwn(value, key)) {
        body = value[key];
        break;
      }
    return segment("result", text(body), index, text(value.name) || toolName);
  }
  return segment("other", text(value), index);
}
export function segments(
  messages: readonly Record<string, unknown>[],
): Segment[] {
  const out: Segment[] = [];
  for (const [position, message] of messages.entries()) {
    const roleName = pythonString(message.role ?? ""),
      role = Object.hasOwn(ROLE_KINDS, roleName)
        ? (ROLE_KINDS[roleName] as Kind)
        : "other",
      toolName = text(message.name) || null,
      content = message.content;
    const empty =
        content == null ||
        content === "" ||
        (Array.isArray(content) && content.length === 0),
      body = empty ? message.parts : content,
      parts = Array.isArray(body)
        ? body
        : body != null && body !== ""
          ? [body]
          : [];
    for (const item of parts) {
      const result = part(item, role, position + 1, toolName);
      if (result) out.push(result);
    }
    for (const call of (truth(message.tool_calls)
      ? message.tool_calls
      : []) as Iterable<unknown>) {
      const result = part(
        record(call) ? { type: "function", ...call } : call,
        "call",
        position + 1,
        null,
      );
      if (result) out.push(result);
    }
  }
  return out;
}
