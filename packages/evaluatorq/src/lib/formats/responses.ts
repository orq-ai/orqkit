import { isDeepStrictEqual } from "node:util";

import type {
  Response,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

import { RESPONSES_ITEM_TYPES } from "../integrations/openresponses/otel-messages.js";
import { responsesToChat } from "./convert-chat-responses.js";
import {
  type AtifConversionOptions,
  responsesToAtif,
} from "./convert-responses-atif.js";
import { contentSeed, stableHex } from "./ids.js";
import {
  sdkInputSchema,
  sdkOutputSchema,
  sdkResponseSchema,
} from "./sdk-models.js";
import { atifToolArguments, jsonArgumentsText } from "./shared.js";

export type ResponsesItem = Record<string, unknown>;
export const SDK_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "apply_patch_call",
  "apply_patch_call_output",
  "code_interpreter_call",
  "compaction",
  "computer_call",
  "computer_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "file_search_call",
  "function_call",
  "function_call_output",
  "image_generation_call",
  "local_shell_call",
  "local_shell_call_output",
  "mcp_approval_request",
  "mcp_approval_response",
  "mcp_call",
  "mcp_list_tools",
  "message",
  "reasoning",
  "shell_call",
  "shell_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
]);
const restorable = new Set(
  [...SDK_OUTPUT_TYPES].filter(
    (kind) => !kind.endsWith("_output") && kind !== "compaction",
  ),
);
const knownTypes = new Set([
  ...RESPONSES_ITEM_TYPES,
  ...SDK_OUTPUT_TYPES,
  "message",
  "compaction",
]);
const record = (v: unknown): v is ResponsesItem =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
export function itemType(item: ResponsesItem): unknown {
  return item.type == null && Object.hasOwn(item, "role")
    ? "message"
    : item.type;
}
export function walkItems(
  items: ResponsesItem[],
  handlers: ReadonlyMap<string, (index: number, item: ResponsesItem) => void>,
  target: string,
): void {
  for (const [index, item] of items.entries()) {
    const kind = itemType(item),
      handler = typeof kind === "string" ? handlers.get(kind) : undefined;
    if (handler) handler(index, item);
    else
      console.warn(
        `Skipping Responses item of type ${String(kind)}: ${target} has no equivalent.`,
      );
  }
}
export function isOutputItem(item: ResponsesItem): boolean {
  const kind = itemType(item);
  if (
    kind === "function_call" &&
    (typeof item.call_id !== "string" || !item.call_id)
  )
    return false;
  return (
    typeof kind === "string" &&
    ((restorable.has(kind) && kind !== "message") ||
      (kind === "message" && item.role === "assistant"))
  );
}
export function isSdkOutputItem(item: ResponsesItem): boolean {
  const kind = itemType(item);
  return typeof kind === "string" && SDK_OUTPUT_TYPES.has(kind);
}
export function isRawToolCall(item: ResponsesItem): boolean {
  const kind = itemType(item);
  return (
    typeof kind === "string" && kind.endsWith("_call") && !isOutputItem(item)
  );
}
export function outputItem(item: ResponsesItem): ResponseOutputItem {
  const data: ResponsesItem = { ...item, type: itemType(item) },
    seed = contentSeed(data);
  if (data.type === "message") {
    if (!Object.hasOwn(data, "id")) data.id = `msg_${stableHex([seed], 24)}`;
    if (!Object.hasOwn(data, "status")) data.status = "completed";
    let content = data.content;
    if (content == null || typeof content === "string")
      content = [{ type: "output_text", text: content || "" }];
    if (Array.isArray(content))
      content = content.map((part) =>
        record(part) && part.type === "output_text"
          ? { annotations: [], ...part }
          : part,
      );
    data.content = content;
  } else if (data.type === "reasoning") {
    if (!Object.hasOwn(data, "id")) data.id = `rs_${stableHex([seed], 24)}`;
    if (!Object.hasOwn(data, "summary")) data.summary = [];
  } else if (
    data.type === "function_call" &&
    typeof data.arguments !== "string"
  ) {
    const [args, raw] = atifToolArguments(data.arguments ?? null, data.name);
    data.arguments = raw ?? jsonArgumentsText(args);
  }
  const result = sdkOutputSchema.safeParse(data);
  if (!result.success)
    throw new TypeError(
      `Responses ${String(data.type)} item is not a valid Responses output item: ${result.error.message}`,
    );
  return result.data as ResponseOutputItem;
}
export function outputTurns(items: ResponsesItem[]): number[][] {
  const turns: number[][] = [];
  let open = false;
  for (const [i, item] of items.entries()) {
    if (!isOutputItem(item)) open = false;
    else if (open) turns[turns.length - 1]?.push(i);
    else {
      turns.push([i]);
      open = true;
    }
  }
  return turns;
}
export function responseStarts(
  items: ResponsesItem[],
  responses: Response[],
): Map<number, Response> {
  const order = outputTurns(items).flat(),
    starts = new Map<number, Response>();
  let position = 0;
  for (const response of responses) {
    const index = order[position];
    if (index === undefined)
      throw new RangeError("Response has no corresponding output item");
    starts.set(index, response);
    position += response.output.length;
  }
  return starts;
}
function withoutNone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNone);
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, withoutNone(v)]),
    );
  return value;
}
export class ResponsesConversation {
  readonly items: ResponsesItem[];
  readonly responses: Response[] | null;
  constructor(input: { items: ResponsesItem[]; responses?: unknown[] | null }) {
    if (
      !record(input) ||
      !Array.isArray(input.items) ||
      !input.items.every(record)
    )
      throw new TypeError("Responses items must be an array of objects");
    this.items = input.items.map((item) => ({ ...item }));
    for (const item of this.items) {
      const kind = itemType(item);
      if (typeof kind !== "string" || !knownTypes.has(kind)) {
        console.warn(
          `Unrecognised Responses item type ${String(kind)}; keeping it.`,
        );
        continue;
      }
      try {
        if (isOutputItem(item)) outputItem(item);
        else sdkInputSchema.parse(item);
      } catch {
        console.warn(
          `Responses ${String(kind)} item does not validate as a Responses item; keeping it.`,
        );
      }
    }
    this.responses =
      input.responses == null ? null : this.checkResponses(input.responses);
    Object.freeze(this);
  }
  private checkResponses(input: unknown[]): Response[] {
    if (!Array.isArray(input))
      throw new TypeError("Responses must be an array");
    const responses = input.map(
      (value) => sdkResponseSchema.parse(value) as Response,
    );
    for (const response of responses)
      for (const item of response.output)
        if (
          !restorable.has(item.type) &&
          !(item.type === "message" && item.role === "assistant")
        )
          throw new TypeError(
            `Response.output item type ${item.type} is not supported by ResponsesConversation.responses`,
          );
    const turns = outputTurns(this.items),
      typed = new Map(
        turns
          .flat()
          .map((index) => [
            index,
            outputItem(this.items[index] as ResponsesItem),
          ]),
      );
    if (responses.every((response) => response.output.length === 0)) {
      if (responses.length !== turns.length)
        throw new TypeError(
          `Got ${responses.length} responses with no output for ${turns.length} runs of output items`,
        );
      return responses.map((response, i) => ({
        ...response,
        output: (turns[i] ?? []).map(
          (index) => typed.get(index) as ResponseOutputItem,
        ),
      }));
    }
    const order = turns.flat(),
      turnOf = new Map(
        turns.flatMap((turn, n) => turn.map((index) => [index, n] as const)),
      );
    let position = 0;
    for (const response of responses) {
      const span = order.slice(position, position + response.output.length);
      if (
        !response.output.length ||
        span.length !== response.output.length ||
        new Set(span.map((index) => turnOf.get(index))).size !== 1 ||
        !isDeepStrictEqual(
          response.output.map(withoutNone),
          span.map((index) => withoutNone(typed.get(index))),
        )
      )
        throw new TypeError(
          `Response ${response.id} output does not match the next output items of the transcript`,
        );
      position += response.output.length;
    }
    if (position !== order.length)
      throw new TypeError(
        `${order.length - position} output items of the transcript belong to no Response`,
      );
    return responses;
  }
  toOtel(options: Omit<AtifConversionOptions, "sessionId"> = {}) {
    return this.toAtif(options).toOtel();
  }
  toAtif(options: AtifConversionOptions = {}) {
    return responsesToAtif(this, options);
  }
  toChat() {
    return responsesToChat(this);
  }
}
