import {
  type ContentPart,
  ContentPartSchema,
  type Message,
  MessageSchema,
  StrategyToolCallSchema,
} from "../contracts.js";
import {
  messagesToResponsesInput,
  responsesFunctionCallItemId,
} from "../integrations/openresponses/input-items.js";
import { ChatConversation } from "./chat.js";
import { pythonJson } from "./json.js";
import {
  ResponsesConversation,
  type ResponsesItem,
  walkItems,
} from "./responses.js";
import { joinText, jsonArgumentsText, partText } from "./shared.js";

const textTypes = new Set([
  "input_text",
  "output_text",
  "text",
  "summary_text",
  "refusal",
]);
const contentTypes = new Set([...textTypes, "input_image", "input_file"]),
  roles = new Set(["user", "assistant", "system", "developer", "tool"]);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const pyType = (v: unknown) =>
  v === null
    ? "NoneType"
    : Array.isArray(v)
      ? "list"
      : typeof v === "string"
        ? "str"
        : typeof v === "number"
          ? Number.isInteger(v)
            ? "int"
            : "float"
          : typeof v === "boolean"
            ? "bool"
            : "dict";
const pyString = (v: unknown): string =>
  v == null
    ? "None"
    : typeof v === "boolean"
      ? v
        ? "True"
        : "False"
      : String(v);
export function chatToResponses(conv: ChatConversation): ResponsesConversation {
  return new ResponsesConversation({
    items: messagesToResponsesInput(conv.messages, { wire: false }),
  });
}
function part(raw: unknown): ContentPart {
  const marker = (text: string): ContentPart => ({ type: "input_text", text });
  if (!record(raw)) {
    console.warn(
      "Responses content part is not an object; rendering a marker.",
    );
    return marker(`[${pyType(raw)}]`);
  }
  const kind = raw.type;
  if (typeof kind === "string" && textTypes.has(kind))
    return marker(partText(raw, "Responses"));
  if (kind === "input_image") {
    const image_url =
        typeof raw.image_url === "string" ? raw.image_url : undefined,
      file_id = typeof raw.file_id === "string" ? raw.file_id : undefined,
      detail =
        typeof raw.detail === "string" &&
        ["auto", "low", "high"].includes(raw.detail)
          ? raw.detail
          : "auto";
    if (
      (raw.image_url != null && image_url === undefined) ||
      (raw.file_id != null && file_id === undefined) ||
      detail !== (raw.detail ?? "auto")
    )
      console.warn("Invalid input_image fields; dropping invalid values.");
    return ContentPartSchema.parse({ type: kind, image_url, file_id, detail });
  }
  if (kind === "input_file") {
    const fields = Object.fromEntries(
      ["file_id", "file_data", "file_url", "filename", "mime_type"].map(
        (key) => [key, typeof raw[key] === "string" ? raw[key] : undefined],
      ),
    );
    if (!fields.file_id && !fields.file_data && !fields.file_url) {
      console.warn("Invalid input_file part; rendering a marker.");
      return marker("[input_file]");
    }
    return ContentPartSchema.parse({ type: kind, ...fields });
  }
  console.warn(
    `Responses content part type ${String(kind)} has no chat equivalent; rendering a marker.`,
  );
  return marker(`[${pyString(kind)}]`);
}
function content(raw: unknown): string | ContentPart[] | null {
  if (raw == null || typeof raw === "string") return raw ?? null;
  if (!Array.isArray(raw)) {
    console.warn("Responses message content is not an array; dropping it.");
    return null;
  }
  const parts = raw.map(part);
  if (parts.every((p) => p.type === "input_text"))
    return joinText(parts.map((p) => (p.type === "input_text" ? p.text : "")));
  return parts;
}
export function responsesToChat(conv: ResponsesConversation): ChatConversation {
  const messages: Message[] = [],
    callNames = new Map<string, string>();
  let reasoningDropped = 0,
    developerWarned = false;
  const handlers = new Map<
    string,
    (index: number, item: ResponsesItem) => void
  >([
    [
      "reasoning",
      () => {
        reasoningDropped++;
      },
    ],
    [
      "message",
      (_, item) => {
        let role = item.role;
        if (typeof role !== "string" || !roles.has(role)) {
          console.warn(
            `Skipping Responses message with unknown role ${String(role)}.`,
          );
          return;
        }
        if (role === "developer") {
          if (!developerWarned) console.warn("developer role mapped to system");
          developerWarned = true;
          role = "system";
        }
        messages.push(
          MessageSchema.parse({ role, content: content(item.content) }),
        );
      },
    ],
    [
      "function_call",
      (_, item) => {
        const callId = item.call_id;
        if (typeof callId !== "string" || !callId) {
          console.warn("Responses function_call has no call_id; skipping it.");
          return;
        }
        let args = item.arguments ?? null;
        if (typeof args !== "string")
          args = record(args)
            ? jsonArgumentsText(args)
            : pythonJson(args, { compact: true, defaultString: true });
        const call = StrategyToolCallSchema.parse({
          id: callId,
          function: { name: pyString(item.name || ""), arguments: args },
          item_id: responsesFunctionCallItemId(
            typeof item.id === "string" ? item.id : null,
          ),
        });
        callNames.set(callId, call.function.name);
        const previous = messages.at(-1);
        if (previous?.role === "assistant")
          previous.tool_calls = [...(previous.tool_calls ?? []), call];
        else
          messages.push(
            MessageSchema.parse({
              role: "assistant",
              content: null,
              tool_calls: [call],
            }),
          );
      },
    ],
    [
      "function_call_output",
      (_, item) => {
        const callId = item.call_id,
          output = item.output ?? null;
        const value =
          Array.isArray(output) &&
          output.length > 0 &&
          output.every(
            (p) =>
              record(p) &&
              typeof p.type === "string" &&
              contentTypes.has(p.type),
          )
            ? (content(output) ?? pythonJson(output, { defaultString: true }))
            : typeof output === "string"
              ? output
              : pythonJson(output, { defaultString: true });
        messages.push(
          MessageSchema.parse({
            role: "tool",
            tool_call_id: typeof callId === "string" ? callId : null,
            name:
              typeof callId === "string"
                ? (callNames.get(callId) ?? null)
                : null,
            content: value,
          }),
        );
      },
    ],
  ]);
  walkItems(conv.items, handlers, "chat");
  if (reasoningDropped)
    console.warn(
      `dropped ${reasoningDropped} reasoning items (chat has no reasoning slot)`,
    );
  return new ChatConversation({ messages });
}
