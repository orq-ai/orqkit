import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { getField } from "../../common/fields.js";
import { pythonString } from "../../common/sanitize.js";
import { pythonJson } from "../../formats/json.js";
import {
  type RedTeamInput,
  RedTeamInputSchema,
  type RedTeamSample,
  RedTeamSampleSchema,
  type StaticDataset,
  StaticDatasetSchema,
} from "../../redteam/input.js";
import type { Turn } from "../../redteam/turn.js";

type Item = Record<string, unknown>;
export const userInputItem = (content: string): Item => ({
  role: "user",
  content,
});
export const assistantInputItem = (content: string): Item => ({
  role: "assistant",
  content,
});
export const systemInputItem = (content: string): Item => ({
  role: "system",
  content,
});
export function buildOpenResponsesRequest(options: {
  model: string;
  prompt?: string | null;
  conversation?: readonly Item[] | null;
  instructions?: string | null;
  extra?: Item | null;
}): Item {
  const input = [...(options.conversation ?? [])];
  if (options.prompt != null) input.push(userInputItem(options.prompt));
  if (!input.length)
    throw new Error(
      "build_openresponses_request: requires at least one of prompt or non-empty conversation",
    );
  return {
    model: options.model,
    input,
    ...(options.instructions == null
      ? {}
      : { instructions: options.instructions }),
    ...options.extra,
  };
}
function textFromItem(item: unknown): string {
  const kind = getField(item, "type");
  if (kind === "output_text" || kind === "input_text")
    return String(getField(item, "text") || "");
  if (kind === "message") {
    const content = getField(item, "content");
    return Array.isArray(content) ? content.map(textFromItem).join("") : "";
  }
  return "";
}
function toolCall(item: unknown): Item | null {
  if (getField(item, "type") !== "function_call") return null;
  const name = getField(item, "name"),
    args = getField(item, "arguments"),
    id =
      getField(item, "call_id") ||
      getField(item, "callId") ||
      getField(item, "id"),
    result = getField(item, "result");
  return {
    type: "function_call",
    name: String(name || ""),
    arguments:
      typeof args === "string"
        ? args
        : pythonJson(args || {}, { ensureAscii: true }),
    ...(id ? { call_id: String(id) } : {}),
    ...(result != null ? { result } : {}),
  };
}
export function appendAssistantTurn(input: Item[], response: unknown): Item[] {
  const output = getField(response, "output"),
    items: Item[] = [];
  if (Array.isArray(output))
    for (const item of output) {
      const call = toolCall(item),
        text = textFromItem(item);
      if (call) items.push(call);
      else if (text) items.push(assistantInputItem(text));
    }
  if (items.length) {
    input.push(...items);
    return input;
  }
  const fallback = getField(response, "text"),
    text =
      typeof fallback === "string" && fallback
        ? fallback
        : Array.isArray(output)
          ? output.map(textFromItem).join("")
          : "";
  if (text) input.push(assistantInputItem(text));
  const calls =
    getField(response, "tool_calls") ?? getField(response, "toolCalls");
  if (Array.isArray(calls))
    for (const item of calls) {
      const call = toolCall(item);
      if (call) input.push(call);
    }
  return input;
}
export function appendUserFollowup(input: Item[], prompt: string): Item[] {
  input.push(userInputItem(prompt));
  return input;
}
export function turnsToOpenResponsesInput(
  turns: readonly Turn[],
  options: { includeFinalAssistant?: boolean } = {},
): Item[] {
  const out: Item[] = [];
  for (const [index, turn] of turns.entries()) {
    out.push(userInputItem(turn.attacker.text));
    if (index !== turns.length - 1 || options.includeFinalAssistant !== false)
      appendAssistantTurn(out, turn.target);
  }
  return out;
}
export const orchestratorResultToOpenResponsesInput = turnsToOpenResponsesInput;
export function messagesFromOpenResponsesInput(
  input: readonly unknown[],
): Item[] {
  const result: Item[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Item,
      role = row.role;
    if (["user", "assistant", "system"].includes(String(role))) {
      if (row.content == null) continue;
      const text = Array.isArray(row.content)
        ? row.content
            .map((block) =>
              block && typeof block === "object"
                ? String((block as Item).text || "")
                : "",
            )
            .join("")
        : typeof row.content === "string"
          ? row.content
          : pythonString(row.content);
      result.push({ role, content: text });
      continue;
    }
    if (row.type === "message") {
      const text = Array.isArray(row.content)
        ? row.content.map(textFromItem).join("")
        : "";
      if (text) result.push({ role: row.role ?? "assistant", content: text });
    }
  }
  return result;
}
export function redteamSampleFromOpenResponses(
  input: RedTeamInput,
  items: readonly Item[],
): RedTeamSample {
  const messages = messagesFromOpenResponsesInput(items);
  if (!messages.length)
    throw new Error(
      "redteam_sample_from_openresponses: openresponses_input produced no messages - the array must contain at least one role/content item or message block",
    );
  return RedTeamSampleSchema.parse({ input, messages });
}
export async function loadOpenResponsesDataset(
  path: string,
): Promise<StaticDataset> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Dataset file not found: ${path}`);
    throw error;
  }
  let rows: unknown;
  if (extname(path).toLowerCase() === ".jsonl") {
    rows = raw.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        throw new Error(
          `Malformed JSONL on line ${index + 1} of ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  } else {
    const data: unknown = JSON.parse(raw);
    rows = Array.isArray(data)
      ? data
      : data && typeof data === "object"
        ? (data as Item).samples
        : null;
  }
  if (!Array.isArray(rows))
    throw new Error(
      `Unexpected dataset shape in ${path}: expected a top-level list or {"samples": [...]} object`,
    );
  const samples = rows.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Dataset row ${index} is not an object`);
    const row = value as Item,
      meta = row.input,
      conversation =
        row.openresponses_input ??
        row.openresponsesInput ??
        row.input_messages ??
        row.inputMessages;
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      throw new Error(
        `Dataset row ${index} is missing the 'input' metadata object`,
      );
    if (!Array.isArray(conversation))
      throw new Error(
        `Dataset row ${index} is missing 'openresponses_input' (or legacy 'input_messages') - expected a list of OpenResponses input items`,
      );
    let parsed: RedTeamInput;
    try {
      parsed = RedTeamInputSchema.parse(meta);
    } catch (error) {
      throw new Error(
        `Dataset row ${index}: 'input' metadata failed validation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return redteamSampleFromOpenResponses(parsed, conversation);
  });
  return StaticDatasetSchema.parse({ samples });
}
