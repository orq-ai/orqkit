import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { ChatConversation } from "../../../src/lib/formats/chat.js";
import {
  isOutputItem,
  isRawToolCall,
  isSdkOutputItem,
  itemType,
  outputItem,
  outputTurns,
  ResponsesConversation,
  responseStarts,
} from "../../../src/lib/formats/responses.js";
import goldens from "../fixtures/responses-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  debug: ReturnType<typeof spyOn<typeof console, "debug">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  debug = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  debug.mockRestore();
});
for (const [i, row] of goldens.outputs.entries())
  test(`Python Responses SDK output ${i}`, () => {
    if (!row.ok) expect(() => outputItem(row.input)).toThrow();
    else expect<unknown>(outputItem(row.input)).toEqual(row.expected);
  });
for (const [i, row] of goldens.recognition.entries())
  test(`Python Responses classification ${i}`, () => {
    expect(itemType(row.input)).toEqual(row.kind);
    expect(isOutputItem(row.input)).toBe(row.output);
    expect(isSdkOutputItem(row.input)).toBe(row.sdk);
    expect(isRawToolCall(row.input)).toBe(row.raw);
  });
for (const [i, row] of goldens.conversations.entries())
  test(`Python Responses metadata alignment ${i}`, () => {
    expect(outputTurns(row.input.items)).toEqual(row.turns);
    const create = () => new ResponsesConversation(row.input);
    if (!row.ok) expect(create).toThrow();
    else {
      const conv = create();
      expect<unknown>(conv).toEqual(row.expected);
      expect(
        Object.fromEntries(
          [...responseStarts(conv.items, conv.responses ?? [])].map(
            ([index, response]) => [index, response.id],
          ),
        ),
      ).toEqual(row.starts as Record<string, string>);
    }
  });
for (const [i, row] of goldens.conversions.entries())
  test(`Python Responses to chat ${i}`, () => {
    const convert = () =>
      new ResponsesConversation({ items: row.input }).toChat();
    if (!row.ok) expect(convert).toThrow();
    else expect<unknown>(convert()).toEqual(row.expected);
  });
for (const [i, row] of goldens.chats.entries())
  test(`Python chat to Responses ${i}`, () => {
    const conv = new ChatConversation(
      row.input as ConstructorParameters<typeof ChatConversation>[0],
    );
    expect<unknown>(conv.toResponses()).toEqual(row.expected);
  });
test("Responses preserves future raw items and freezes the container", () => {
  const item = { type: "future_call", free_key: { keep: null } },
    conv = new ResponsesConversation({ items: [item] });
  expect(conv.items).toEqual([item]);
  expect(conv.responses).toBeNull();
  expect(Object.isFrozen(conv)).toBe(true);
  expect(warn).toHaveBeenCalled();
});
