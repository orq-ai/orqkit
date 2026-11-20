import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  COMPACT,
  type ConversationViewOptions,
  type ConversationViewOverrides,
  conversationViewOptions,
  DETAILED,
  fullConversationView,
  type MessageKind,
  WHOLE,
} from "../../../src/lib/insights/conversation-view.js";
import { ReadableStyle } from "../../../src/lib/insights/readable-style.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

interface Case {
  trace: unknown;
  budget: number;
  options: string | Record<string, unknown>;
  kwargs: Record<string, unknown>;
  text?: string;
  error?: string;
}

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-conversation-view-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Case[];

const presets: Record<string, ConversationViewOptions> = {
  COMPACT,
  DETAILED,
  WHOLE,
};

function options(value: Case["options"]): ConversationViewOptions {
  if (typeof value === "string")
    return presets[value] as ConversationViewOptions;
  return conversationViewOptions({
    ...value,
    include: value.include as MessageKind[],
  });
}

function overrides(kwargs: Case["kwargs"]): ConversationViewOverrides {
  const { style, ...rest } = kwargs;
  return {
    ...rest,
    style: style ? new ReadableStyle(style as Record<string, boolean>) : null,
  } as ConversationViewOverrides;
}

for (const [i, c] of gold.entries())
  test(`conversation view matches Python case ${i}`, () => {
    const render = () =>
      String(
        fullConversationView(
          new TraceRecord(c.trace),
          c.budget,
          options(c.options),
          overrides(c.kwargs),
        ),
      );
    if (c.error !== undefined) expect(render).toThrow(c.error);
    else expect(render()).toBe(c.text as string);
  });
