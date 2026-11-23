import { isDeepStrictEqual } from "node:util";

import {
  parseJsonOrValue,
  toolResultToText,
  UNKNOWN_ARGUMENTS,
} from "../../common/messages.js";
import {
  failurePayload,
  isToolRecord,
  normalizeToolRecords,
} from "./tool-records.js";

// Kept close to orquesta-web's libs/go/gateway/tracing.go so the two can be
// diffed; this is what Orq's gateway runs before emitting a Responses span.

type Part = Record<string, unknown>;
type OtelMessage = Record<string, unknown>;

const TEXT_PART_TYPES = new Set([
  "input_text",
  "output_text",
  "text",
  "summary_text",
]);
const REASONING_PART_TYPES = new Set(["reasoning_text", "reasoning"]);
const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

export const RESPONSES_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "mcp_call",
  "reasoning",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return isRecord(value) ? Object.keys(value).length > 0 : Boolean(value);
}

function genericPart(value: unknown): Part {
  return { type: "data", content: value };
}

function contentToParts(content: unknown, asReasoning = false): Part[] {
  const textType = asReasoning ? "reasoning" : "text";
  if (typeof content === "string") {
    return content ? [{ type: textType, content }] : [];
  }
  if (!Array.isArray(content)) {
    return content === null || content === undefined
      ? []
      : [genericPart(content)];
  }
  return content.map((raw: unknown): Part => {
    if (!isRecord(raw)) {
      return genericPart(raw);
    }
    const partType = raw.type as string;
    if (TEXT_PART_TYPES.has(partType)) {
      return { type: textType, content: raw.text || "" };
    }
    if (REASONING_PART_TYPES.has(partType)) {
      return { type: "reasoning", content: raw.text || raw.reasoning || "" };
    }
    return partType === "refusal"
      ? { type: "refusal", content: raw.refusal || "" }
      : genericPart(raw);
  });
}

function toolCallPart(
  item: Record<string, unknown>,
  argsKey = "arguments",
): Part {
  const part: Part = {
    type: "tool_call",
    id: item.call_id || item.id || null,
    name: item.name || item.tool_name || "",
  };
  const rawArguments = item[argsKey] ?? null;
  if (rawArguments !== null && rawArguments !== UNKNOWN_ARGUMENTS) {
    part.arguments = parseJsonOrValue(rawArguments);
  }
  return part;
}

function reasoningParts(item: Record<string, unknown>): Part[] {
  const parts = contentToParts(item.content, true);
  for (const summaryPart of contentToParts(item.summary, true)) {
    if (!parts.some((part) => isDeepStrictEqual(part, summaryPart))) {
      parts.push(summaryPart);
    }
  }
  if (parts.length === 0 && item.encrypted_content) {
    parts.push({ type: "reasoning", content: "[encrypted]" });
  }
  return parts;
}

/** Whether `value` is a typed Responses item rather than a chat message or content part. */
export function isResponsesItem(value: unknown): boolean {
  const itemType = isRecord(value) ? value.type : undefined;
  return (
    typeof itemType === "string" &&
    (RESPONSES_ITEM_TYPES.has(itemType) || isToolRecord(itemType))
  );
}

function toolResponseMessage(callId: unknown, response: unknown): OtelMessage {
  return {
    role: "tool",
    parts: [
      {
        type: "tool_call_response",
        id: callId ?? null,
        response: parseJsonOrValue(response ?? null),
      },
    ],
  };
}

function itemTypeOf(item: Record<string, unknown>): string {
  const declared = item.type;
  if (typeof declared === "string" && declared) {
    return declared;
  }
  return "role" in item ? "message" : "unknown";
}

export function itemsToInputMessages(items: unknown): OtelMessage[] {
  if (typeof items === "string") {
    return [{ role: "user", parts: [{ type: "text", content: items }] }];
  }
  if (!Array.isArray(items)) {
    return [];
  }
  const messages: OtelMessage[] = [];
  const assistant = (parts: Part[]) =>
    messages.push({ role: "assistant", parts });
  for (const raw of normalizeToolRecords(items)) {
    if (!isRecord(raw)) {
      assistant([genericPart(raw)]);
      continue;
    }
    const itemType = itemTypeOf(raw);
    if (itemType === "message") {
      messages.push({
        role: raw.role || "user",
        parts: contentToParts(raw.content),
      });
    } else if (itemType === "function_call") {
      assistant([toolCallPart(raw)]);
    } else if (TOOL_OUTPUT_TYPES.has(itemType)) {
      messages.push(toolResponseMessage(raw.call_id, raw.output));
    } else if (itemType === "custom_tool_call") {
      assistant([toolCallPart(raw, "input")]);
    } else if (itemType === "mcp_call") {
      assistant([toolCallPart(raw)]);
      if (isSet(raw.error)) {
        const output = raw.output ?? null;
        const payload = failurePayload(
          output === null ? null : toolResultToText(output),
          toolResultToText(raw.error),
        );
        messages.push(toolResponseMessage(raw.call_id, payload));
      } else if (isSet(raw.output)) {
        messages.push(toolResponseMessage(raw.call_id, raw.output));
      }
    } else if (itemType === "reasoning") {
      assistant(reasoningParts(raw));
    } else {
      assistant([genericPart(raw)]);
    }
  }
  return messages;
}

/** Tool results are dropped, so a result is never attributed to the model. */
export function itemsToOutputMessages(
  items: unknown,
  finishReason = "",
): OtelMessage[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const messages: OtelMessage[] = [];
  for (const raw of normalizeToolRecords(items)) {
    if (!isRecord(raw)) {
      messages.push({
        role: "assistant",
        parts: [genericPart(raw)],
        finish_reason: finishReason,
      });
      continue;
    }
    const itemType = itemTypeOf(raw);
    if (TOOL_OUTPUT_TYPES.has(itemType)) {
      continue;
    }
    let parts: Part[];
    let role: unknown = "assistant";
    if (itemType === "message") {
      parts = contentToParts(raw.content);
      role = raw.role || "assistant";
    } else if (itemType === "function_call" || itemType === "mcp_call") {
      parts = [toolCallPart(raw)];
    } else if (itemType === "custom_tool_call") {
      parts = [toolCallPart(raw, "input")];
    } else if (itemType === "reasoning") {
      parts = reasoningParts(raw);
    } else {
      parts = [genericPart(raw)];
    }
    messages.push({ role, parts, finish_reason: finishReason });
  }
  return messages;
}
