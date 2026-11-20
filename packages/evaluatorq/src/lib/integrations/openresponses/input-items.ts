import { wireArguments } from "../../common/messages.js";
import type { ContentPart, Message } from "../../contracts.js";

type Item = Record<string, unknown>;
type Content = string | ContentPart[] | null | undefined;

/**
 * Keeps only `fc_*` ids: the Responses API rejects a foreign provider's tool-call
 * id with a 400, and `call_id` is what pairs a call with its output anyway.
 */
export function responsesFunctionCallItemId(
  itemId: string | null | undefined,
): string | null {
  if (!itemId) {
    return null;
  }
  if (itemId.startsWith("fc_")) {
    return itemId;
  }
  console.error(
    `Dropping non-Responses function_call item id '${itemId}' from the Responses input: the API only accepts item ids prefixed 'fc_'. Pairing is unaffected; call_id carries the provider's id.`,
  );
  return null;
}

// A bare string or `input_text` parts on an assistant item are dropped by the
// router, leaving the model a transcript with no assistant turns (RES-1308).
function assistantContent(content: Content): Item[] {
  if (content === null || content === undefined) {
    return [{ type: "output_text", text: "" }];
  }
  if (typeof content === "string") {
    return [{ type: "output_text", text: content }];
  }
  const parts: Item[] = [];
  const dropped: string[] = [];
  for (const part of content) {
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") {
      parts.push({ type: "output_text", text });
    } else {
      dropped.push(part.type);
    }
  }
  if (dropped.length > 0) {
    console.warn(
      `Dropping non-text part(s) ${dropped.join(", ")} from an assistant turn in the Responses input: assistant content only supports output_text. The model will not see them.`,
    );
  }
  return parts.length > 0 ? parts : [{ type: "output_text", text: "" }];
}

function toolOutput(content: Content): string | ContentPart[] {
  return content ?? "";
}

/**
 * Renders one `Message` as Responses `input` items. That API has no `tool` role
 * and ignores `tool_calls` on a message, so tool turns become function items.
 */
export function messageToResponsesInputItems(
  message: Message,
  options: { wire?: boolean } = {},
): Item[] {
  const wire = options.wire ?? true;
  if (message.role === "tool") {
    if (!message.tool_call_id) {
      console.warn(
        "Dropping a tool message with no tool_call_id from the Responses input: a function_call_output cannot be sent without a call_id to reference. The model will not see this tool result.",
      );
      return [];
    }
    return [
      {
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: toolOutput(message.content),
      },
    ];
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    const items: Item[] = [];
    if (message.content?.length) {
      items.push({
        role: "assistant",
        content: assistantContent(message.content),
      });
    }
    for (const call of message.tool_calls) {
      const itemId = responsesFunctionCallItemId(call.item_id);
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: wire
          ? wireArguments(call.function.arguments)
          : call.function.arguments,
        ...(itemId === null ? {} : { id: itemId }),
      });
    }
    return items;
  }
  if (message.role === "assistant") {
    return [{ role: "assistant", content: assistantContent(message.content) }];
  }
  return [
    {
      role: message.role,
      content: Array.isArray(message.content)
        ? message.content
        : message.content || "",
    },
  ];
}

/** `wire: false` keeps tool-call arguments as recorded, for format converters. */
export function messagesToResponsesInput(
  messages: readonly Message[],
  options: { wire?: boolean } = {},
): Item[] {
  return messages.flatMap((message) =>
    messageToResponsesInputItems(message, options),
  );
}
