import {
  AgentResponse,
  type Message,
  MessageSchema,
  type OutputMessage,
  StrategyToolCallSchema,
  type ToolCallOutputItem,
  textOutputItem,
  toolCallOutputItem,
} from "../contracts.js";
import { isResponsesItem } from "../integrations/openresponses/otel-messages.js";
import { getField } from "./fields.js";
import {
  coerceContentText,
  indentedAsciiJson,
  jsonWithFallback,
  messagesToText,
  pairToolRows,
} from "./messages.js";

const MESSAGE_SHAPE_KEYS = [
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "function_call",
  "function_call_output",
];
const CONTENT_PART_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "refusal",
]);
const CANONICAL_MESSAGE_KEYS = [
  "content",
  "name",
  "role",
  "tool_call_id",
  "tool_calls",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageShape(item: unknown): boolean {
  return (
    isRecord(item) &&
    !("type" in item) &&
    MESSAGE_SHAPE_KEYS.some((key) => key in item)
  );
}

function agentResponseText(response: AgentResponse): string {
  const turns: Record<string, unknown>[] = [];
  for (const item of response.output) {
    if (item.type === "output_text") {
      turns.push({ role: "assistant", content: item.text });
    } else if (item.type === "function_call") {
      turns.push({ role: "assistant", tool_calls: [item] });
    }
  }
  return messagesToText(turns);
}

function jsonText(value: unknown, caller: string): string {
  try {
    return indentedAsciiJson(value);
  } catch (error) {
    console.warn(
      `${caller}: JSON serialization failed, falling back to String(): ${error}`,
    );
    return String(value);
  }
}

/** Best-effort plain-text view of any output. Never throws. */
export function outputToText(output: unknown): string {
  if (output === null || output === undefined) {
    return "";
  }
  if (output instanceof AgentResponse) {
    return agentResponseText(output);
  }
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    if (output.every(isMessageShape)) {
      // Not a bare join: dropping tool calls hands the judge an empty string
      // for an agent that acted.
      return messagesToText(output);
    }
    if (output.every(isResponsesItem)) {
      return agentResponseText(AgentResponse.fromOutputItems(output));
    }
    if (
      output.every(
        (item) => isRecord(item) && CONTENT_PART_TYPES.has(item.type as string),
      )
    ) {
      return coerceContentText(output);
    }
    return jsonText(output, "outputToText");
  }
  if (isRecord(output)) {
    if (output.object === "response") {
      try {
        return agentResponseText(AgentResponse.fromOpenResponses(output));
      } catch (error) {
        console.warn(
          `outputToText: fromOpenResponses failed, falling back to JSON: ${error}`,
        );
      }
    }
    return jsonText(output, "outputToText");
  }
  return String(output);
}

/** The target-level error message an output carries, if any. */
export function outputErrorText(output: unknown): string | null {
  if (output instanceof AgentResponse) {
    // Presence marks the failure, since a provider may send an empty message.
    return output.error === null ? null : output.error.message;
  }
  if (
    !isRecord(output) ||
    output.error === undefined ||
    output.error === null
  ) {
    return null;
  }
  const { error } = output;
  if (typeof error === "string") {
    return error;
  }
  const message = getField(error, "message") ?? null;
  return String(message === null ? jsonWithFallback(error) : message);
}

function isBlank(content: unknown): boolean {
  return coerceContentText(content).trim() === "";
}

function messageHasMeaningfulOutput(message: Record<string, unknown>): boolean {
  if (Object.keys(message).sort().join() === CANONICAL_MESSAGE_KEYS.join()) {
    return (
      Boolean((message.tool_calls as unknown[] | null)?.length) ||
      !isBlank(message.content)
    );
  }
  if (typeof message.role !== "string") {
    return Object.keys(message).length > 0;
  }
  if (
    message.tool_calls ||
    message.function_call ||
    message.function_call_output
  ) {
    return true;
  }
  if ("content" in message) {
    return message.content === null
      ? Object.keys(message).some((key) => key !== "role" && key !== "content")
      : !isBlank(message.content);
  }
  return Object.keys(message).some((key) => key !== "role" && key !== "name");
}

function isOutputItem(item: unknown): item is OutputMessage {
  const type = getField(item, "type");
  return (
    type === "function_call" ||
    ((type === "output_text" || type === "reasoning") &&
      typeof getField(item, "text") === "string")
  );
}

function outputItemHasMeaningfulOutput(item: OutputMessage): boolean {
  return item.type === "function_call" || item.text.trim() !== "";
}

/**
 * Whether `output` is a non-blank recorded response. Whitespace-only assistant
 * content is blank, while tool calls and unfamiliar non-empty shapes count, so
 * trace replay fails only on a really blank response.
 */
export function hasMeaningfulOutput(output: unknown): boolean {
  if (output === null || output === undefined) {
    return false;
  }
  if (output instanceof AgentResponse) {
    return (
      output.error === null && output.output.some(outputItemHasMeaningfulOutput)
    );
  }
  if (typeof output === "string") {
    return output.trim() !== "";
  }
  if (Array.isArray(output)) {
    if (output.length === 0) {
      return false;
    }
    if (output.every(isOutputItem)) {
      return output.some(outputItemHasMeaningfulOutput);
    }
    return output.every(isRecord)
      ? output.some(messageHasMeaningfulOutput)
      : true;
  }
  if (!isRecord(output)) {
    return true;
  }
  if (output.object === "response" && "output" in output) {
    const inner = output.output;
    return Array.isArray(inner) ? hasMeaningfulOutput(inner) : Boolean(inner);
  }
  if ("response" in output || "tool_calls" in output || "toolCalls" in output) {
    const toolCalls = Object.hasOwn(output, "toolCalls")
      ? output.toolCalls
      : output.tool_calls;
    return (
      !isBlank(output.response ?? null) ||
      (Array.isArray(toolCalls) ? toolCalls.length > 0 : Boolean(toolCalls))
    );
  }
  return Object.keys(output).length > 0;
}

function isCanonicalToolCall(call: unknown): call is ToolCallOutputItem {
  return (
    isRecord(call) &&
    call.type === "function_call" &&
    typeof call.id === "string" &&
    typeof call.call_id === "string" &&
    typeof call.arguments === "string"
  );
}

function adaptToolCall(call: unknown): ToolCallOutputItem {
  if (isCanonicalToolCall(call)) {
    return call;
  }
  const fn = getField(call, "function", call);
  const rawArguments = getField(fn, "arguments", "{}");
  const id = String(getField(call, "id") || "");
  return toolCallOutputItem({
    id,
    call_id: id,
    name: String(getField(fn, "name", "")),
    arguments:
      typeof rawArguments === "string"
        ? rawArguments
        : jsonWithFallback(rawArguments || {}),
    result: (getField(call, "result") ?? null) as string | null,
  });
}

function stringified(value: unknown): string {
  return typeof value === "object" ? jsonWithFallback(value) : String(value);
}

function adaptStaticOutput(output: unknown): OutputMessage[] {
  if (isRecord(output)) {
    const text = output.response;
    return [
      ...(text ? [textOutputItem(stringified(text))] : []),
      ...(
        ((Object.hasOwn(output, "toolCalls")
          ? output.toolCalls
          : output.tool_calls) || []) as unknown[]
      ).map(adaptToolCall),
    ];
  }
  const present = Array.isArray(output) ? output.length > 0 : Boolean(output);
  return present ? [textOutputItem(stringified(output))] : [];
}

/** Coerces a datapoint's inputs into a `{role, content}` message list. Never throws. */
export function inputsToMessages(
  inputs: unknown,
): { role: string; content: string }[] {
  if (isRecord(inputs) && Array.isArray(inputs.messages)) {
    return inputs.messages.map((message: unknown) => ({
      role: String(getField(message, "role", "user")),
      content: coerceContentText(getField(message, "content", "")),
    }));
  }
  if (isRecord(inputs) && "input" in inputs) {
    return [{ role: "user", content: coerceContentText(inputs.input) }];
  }
  return [{ role: "user", content: jsonText(inputs, "inputsToMessages") }];
}

/** Converts any output into structured output items. Never throws. */
export function outputToMessages(output: unknown): OutputMessage[] {
  if (output === null || output === undefined) {
    return [];
  }
  if (output instanceof AgentResponse) {
    return [...output.output];
  }
  if (isRecord(output) && output.object === "response") {
    try {
      return [...AgentResponse.fromOpenResponses(output).output];
    } catch (error) {
      console.warn(
        `outputToMessages: fromOpenResponses failed, degrading to flat text: ${error}`,
      );
      return [textOutputItem(outputToText(output))];
    }
  }
  if (typeof output === "string") {
    return output ? [textOutputItem(output)] : [];
  }
  const adapted = adaptStaticOutput(output);
  return adapted.length > 0 ? adapted : [textOutputItem(outputToText(output))];
}

export const RESPONSES_ITEM_ORDER_KEY = "item_order";
export const RESPONSES_ASSISTANT_TURN_ORDER_KEY = "assistant_turn_order";

function clearIncompleteWhenAnswered(messages: Message[]): void {
  for (const [index, answered] of pairToolRows(messages).rowOf) {
    for (const position of answered.keys()) {
      const call = messages[index]?.tool_calls?.[position];
      if (call) {
        call.incomplete = false;
      }
    }
  }
}

function required(item: Record<string, unknown>, key: string): unknown {
  if (!(key in item)) {
    throw new TypeError(`missing key ${key}`);
  }
  return item[key];
}

function validTurnOrder(order: unknown, outputCount: number): boolean {
  return (
    Array.isArray(order) &&
    order.length === outputCount &&
    order.every(
      (value: unknown) =>
        value === null ||
        (typeof value === "number" && Number.isInteger(value) && value >= 0),
    )
  );
}

/**
 * Rebuilds the ordered chat transcript from a simulation OpenResponses object.
 * Null unless `metadata.item_order` matches the `input` and `output` counts.
 */
export function responsesTranscript(output: unknown): Message[] | null {
  if (!isRecord(output) || output.object !== "response") {
    return null;
  }
  const { metadata } = output;
  if (!isRecord(metadata) || !(RESPONSES_ITEM_ORDER_KEY in metadata)) {
    return null;
  }
  const order = metadata[RESPONSES_ITEM_ORDER_KEY];
  const { input: inputs, output: outputs } = output;
  const count = (entry: string) =>
    (order as unknown[]).filter((value) => value === entry).length;
  if (
    !Array.isArray(order) ||
    !Array.isArray(inputs) ||
    !Array.isArray(outputs) ||
    order.some((entry) => entry !== "input" && entry !== "output") ||
    count("input") !== inputs.length ||
    count("output") !== outputs.length
  ) {
    console.warn(
      `ignoring malformed OpenResponses '${RESPONSES_ITEM_ORDER_KEY}': does not match input/output`,
    );
    return null;
  }
  const hasTurnOrder = RESPONSES_ASSISTANT_TURN_ORDER_KEY in metadata;
  const turnOrder = metadata[RESPONSES_ASSISTANT_TURN_ORDER_KEY];
  if (hasTurnOrder && !validTurnOrder(turnOrder, outputs.length)) {
    console.warn(
      `ignoring malformed OpenResponses '${RESPONSES_ASSISTANT_TURN_ORDER_KEY}': does not match output items`,
    );
    return null;
  }
  const groups =
    turnOrder === undefined || turnOrder === null
      ? null
      : (turnOrder as (number | null)[]);

  const cursors = { input: 0, output: 0 };
  const sources = { input: inputs, output: outputs };
  const messages: Message[] = [];
  let lastAssistantGroup: number | null = null;
  try {
    for (const entry of order as ("input" | "output")[]) {
      const position = cursors[entry];
      cursors[entry] += 1;
      const item: unknown = sources[entry][position];
      if (!isRecord(item)) {
        throw new TypeError("item is not an object");
      }
      const currentGroup =
        entry === "output" && groups !== null
          ? (groups[position] ?? null)
          : null;
      if (item.type === "message") {
        const role = required(item, "role");
        messages.push(
          MessageSchema.parse({
            role,
            content: coerceContentText(item.content ?? null),
          }),
        );
        if (role === "assistant" && entry === "output") {
          lastAssistantGroup = currentGroup;
        } else if (role !== "assistant") {
          lastAssistantGroup = null;
        }
      } else if (item.type === "function_call") {
        const toolCall = StrategyToolCallSchema.parse({
          id: required(item, "call_id"),
          function: {
            name: required(item, "name"),
            arguments: required(item, "arguments"),
          },
          item_id: item.id ?? null,
          incomplete: item.status === "incomplete",
        });
        const previous = messages.at(-1);
        if (
          previous?.role === "assistant" &&
          (groups === null ||
            (lastAssistantGroup === currentGroup && currentGroup !== null))
        ) {
          previous.tool_calls = [...(previous.tool_calls ?? []), toolCall];
        } else {
          messages.push(
            MessageSchema.parse({
              role: "assistant",
              content: "",
              tool_calls: [toolCall],
            }),
          );
        }
        lastAssistantGroup = currentGroup;
      } else if (item.type === "function_call_output") {
        messages.push(
          MessageSchema.parse({
            role: "tool",
            tool_call_id: required(item, "call_id"),
            content: coerceContentText(item.output ?? null),
          }),
        );
      } else {
        console.warn(
          `ignoring OpenResponses transcript with unknown item type ${JSON.stringify(item.type)}`,
        );
        return null;
      }
    }
  } catch (error) {
    console.warn(`ignoring malformed OpenResponses transcript item: ${error}`);
    return null;
  }
  clearIncompleteWhenAnswered(messages);
  return messages;
}
