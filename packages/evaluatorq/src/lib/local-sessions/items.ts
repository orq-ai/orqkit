import { pythonJson } from "../formats/json.js";

export const MAX_TOOL_TEXT_CHARS = 20000;
export function trimToolText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_TOOL_TEXT_CHARS) return text;
  const half = MAX_TOOL_TEXT_CHARS / 2;
  return `${chars.slice(0, half).join("")}\n[truncated ${chars.length - half * 2} chars]\n${chars.slice(-half).join("")}`;
}
export function blocksText(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    if (
      ["text", "input_text", "output_text"].includes(block.type) &&
      typeof block.text === "string"
    )
      parts.push(block.text);
    else if (["image", "input_image"].includes(block.type))
      parts.push("[image]");
    else if (typeof block.type === "string") parts.push(`[${block.type}]`);
  }
  return parts.filter(Boolean).join("\n");
}
export function userText(text: string) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}
export function systemText(text: string) {
  return {
    type: "message",
    role: "system",
    content: [{ type: "input_text", text }],
  };
}
export function assistantText(text: string) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}
export function reasoning(text: string) {
  return { type: "reasoning", summary: [{ type: "summary_text", text }] };
}
function trimLeaves(value: unknown): unknown {
  if (typeof value === "string") return trimToolText(value);
  if (Array.isArray(value)) return value.map(trimLeaves);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trimLeaves(item)]),
    );
  return value;
}
export function functionCall(
  callId: string,
  name: string,
  argumentsValue: unknown,
) {
  if (typeof argumentsValue === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsValue);
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {
        type: "function_call",
        call_id: callId,
        name,
        arguments: trimToolText(argumentsValue),
      };
    argumentsValue = parsed;
  }
  let raw = pythonJson(trimLeaves(argumentsValue ?? {}), {
    ensureAscii: false,
  });
  if (Array.from(raw).length > MAX_TOOL_TEXT_CHARS + 100)
    raw = pythonJson({ _truncated: trimToolText(raw) }, { ensureAscii: false });
  return { type: "function_call", call_id: callId, name, arguments: raw };
}
export function functionCallOutput(
  callId: string,
  output: string,
  isError = false,
) {
  return {
    type: "function_call_output",
    call_id: callId,
    output: trimToolText(isError ? `Error: ${output}` : output),
  };
}
export function compactionSummary(summary: string) {
  return systemText(
    summary
      ? `Conversation compacted. Summary:\n${summary}`
      : "Conversation compacted.",
  );
}
