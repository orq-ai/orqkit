import type { Message } from "../contracts.js";
import { messagesToResponsesInput } from "../integrations/openresponses/input-items.js";
import { clientRoutesThroughOrq } from "./llm-client.js";

export const CACHE_MIN_PROMPT_TOKENS = 1024;

// Crude on purpose: it only separates a two-line prompt from a replayed transcript.
const CHARS_PER_TOKEN = 4;

// `tool` and tool-calling `assistant` turns keep their content shape for the provider.
const MARKABLE_ROLES = new Set(["system", "user"]);

type Item = Record<string, unknown>;

const charCount = (text: string): number => Array.from(text).length;

/**
 * Marks only routed Anthropic-capable targets: `cache_control` in a content part
 * is outside the direct OpenAI schema, and other providers cache automatically.
 * `agent/` and `orq/` resolve their model server-side, and the router ignores
 * the marker on a non-Anthropic model.
 */
export function cachingApplies(
  client: Parameters<typeof clientRoutesThroughOrq>[0] | null | undefined,
  model: string,
): boolean {
  if (!clientRoutesThroughOrq(client ?? null)) {
    return false;
  }
  const name = model.toLowerCase();
  return (
    ["anthropic/", "agent/", "orq/"].some((prefix) =>
      name.startsWith(prefix),
    ) || name.includes("claude")
  );
}

function textLength(value: unknown): number {
  if (typeof value === "string") {
    return charCount(value);
  }
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.reduce<number>((total, part) => {
    const text = (part as Item | null)?.text;
    return typeof text === "string" ? total + charCount(text) : total;
  }, 0);
}

function clearsMinimum(items: readonly Item[]): boolean {
  const total = items.reduce((sum, item) => sum + textLength(item.content), 0);
  return total >= CACHE_MIN_PROMPT_TOKENS * CHARS_PER_TOKEN;
}

function assertTail(name: string, count: number): void {
  if (count < 0) {
    throw new RangeError(`${name} must be >= 0, got ${count}`);
  }
}

function prefixIndex(
  items: readonly Item[],
  volatileTail: number,
  isMarkable: (item: Item) => boolean,
  unit: string,
): number {
  assertTail("volatileTail", volatileTail);
  let index = items.length - 1 - volatileTail;
  while (index >= 0 && !isMarkable(items[index] as Item)) {
    index -= 1;
  }
  if (index < 0 && items.length > 0) {
    console.warn(
      `No cacheable ${unit} in the prompt-cache prefix (${items.length} ${unit}s, volatileTail=${volatileTail}): the transcript is re-encoded on every turn.`,
    );
  }
  return index;
}

const isMarkableMessage = (message: Item): boolean =>
  MARKABLE_ROLES.has(message.role as string) &&
  typeof message.content === "string" &&
  message.content !== "";

const EPHEMERAL = { type: "ephemeral" };

/**
 * Copies `messages` with breakpoints on the system message and the prefix end.
 * `volatileTail` counts trailing messages rebuilt every turn and has no default:
 * marking one costs a cache write that no later turn can read back.
 */
export function applyCacheBreakpoints(
  messages: readonly Item[],
  options: { volatileTail: number },
): Item[] {
  const out = [...messages];
  const prefixEnd = prefixIndex(
    out,
    options.volatileTail,
    isMarkableMessage,
    "message",
  );
  if (!clearsMinimum(out)) {
    console.error(
      `Prompt below the ${CACHE_MIN_PROMPT_TOKENS}-token cache minimum (${out.length} messages); no breakpoint placed.`,
    );
    return out;
  }
  const leading = out[0]?.role === "system" ? 0 : -1;
  for (const index of new Set([leading, prefixEnd])) {
    const message = out[index];
    if (message && isMarkableMessage(message)) {
      out[index] = {
        ...message,
        content: [
          { type: "text", text: message.content, cache_control: EPHEMERAL },
        ],
      };
    }
  }
  return out;
}

function hasMarkableParts(item: Item): boolean {
  const { content } = item;
  if (!("role" in item)) {
    return false;
  }
  if (typeof content === "string") {
    return content !== "";
  }
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (part) =>
        part !== null && typeof part === "object" && !Array.isArray(part),
    )
  );
}

/**
 * Copies a Responses `input` list with a breakpoint on the end of the persisted
 * prefix. One message can render to several items, so the count is in items;
 * `responsesVolatileItems` converts from messages.
 */
export function markResponsesInput(
  inputItems: readonly Item[],
  options: { volatileItems: number },
): Item[] {
  const out = [...inputItems];
  const index = prefixIndex(
    out,
    options.volatileItems,
    hasMarkableParts,
    "item",
  );
  if (index < 0) {
    return out;
  }
  if (!clearsMinimum(out)) {
    console.error(
      `Responses input below the ${CACHE_MIN_PROMPT_TOKENS}-token cache minimum (${out.length} items); no breakpoint placed.`,
    );
    return out;
  }
  const item = out[index] as Item;
  const parts: Item[] =
    typeof item.content === "string"
      ? [{ type: "input_text", text: item.content }]
      : [...(item.content as Item[])];
  parts[parts.length - 1] = {
    ...(parts.at(-1) as Item),
    cache_control: EPHEMERAL,
  };
  out[index] = { ...item, content: parts };
  return out;
}

/** How many Responses `input` items the last `volatileTail` messages render to. */
export function responsesVolatileItems(
  messages: readonly Message[],
  options: { volatileTail: number },
): number {
  assertTail("volatileTail", options.volatileTail);
  return options.volatileTail === 0
    ? 0
    : messagesToResponsesInput(messages.slice(-options.volatileTail)).length;
}
