import { describe, expect, test } from "bun:test";

import {
  coerceContentText,
  dropUnreplayableToolRecords,
  messagesToText,
  parseJsonOrValue,
  toolCallText,
  wireArguments,
} from "../../../src/lib/common/messages.js";
import {
  capText,
  cleanModelText,
  edgeText,
  isJevModel,
  ModelInputCapError,
} from "../../../src/lib/common/model-input.js";
import {
  normalizePlaceholders,
  scrubKnownSecrets,
} from "../../../src/lib/common/redact.js";
import { orqSpanTypeForOperation } from "../../../src/lib/common/tracing.js";
import {
  isResponsesItem,
  itemsToInputMessages,
  itemsToOutputMessages,
} from "../../../src/lib/integrations/openresponses/otel-messages.js";
import {
  failurePayload,
  isToolRecord,
  normalizeToolRecords,
  pairToolRecords,
} from "../../../src/lib/integrations/openresponses/tool-records.js";

const call = {
  id: "c1",
  type: "function",
  function: { name: "lookup", arguments: '{"q":"x"}' },
};

describe("messages", () => {
  test("coerceContentText flattens parts and names media", () => {
    expect(coerceContentText("plain")).toBe("plain");
    expect(coerceContentText(null)).toBe("");
    expect(
      coerceContentText([
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "u" } },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n[image]\nb");
  });

  test("toolCallText renders the call, a result, or the missing result", () => {
    expect(toolCallText(call)).toBe('[tool_call: lookup({"q":"x"})]');
    expect(toolCallText(call, { incomplete: true })).toBe(
      '[tool_call: lookup({"q":"x"}) -> no result recorded]',
    );
    expect(toolCallText(call, { result: "R" })).toBe(
      '[tool_call: lookup({"q":"x"}) -> R]',
    );
  });

  test("messagesToText lays out a transcript", () => {
    expect(
      messagesToText([
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
        { role: "assistant", content: "done" },
      ]),
    ).toBe(
      '[user] hi\n[tool_call: lookup({"q":"x"})]\n[tool] {"ok":true}\ndone',
    );
  });

  test("parseJsonOrValue returns the input when it is not JSON", () => {
    expect(parseJsonOrValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonOrValue("{a")).toBe("{a");
    expect(parseJsonOrValue(3)).toBe(3);
  });

  test("wireArguments only lets a JSON object through", () => {
    expect(wireArguments('{"a":1}')).toBe('{"a":1}');
    expect(wireArguments("[1]")).toBe("{}");
    expect(wireArguments("{")).toBe("{}");
  });

  test("dropUnreplayableToolRecords removes unpaired calls and results", () => {
    const rows = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "user", content: "next" },
      { role: "tool", tool_call_id: "zz", content: "x" },
    ] as never;
    const pick = (messages: { role: string; content?: unknown }[]) =>
      messages.map((message) => [message.role, message.content]);
    expect(pick(dropUnreplayableToolRecords(rows))).toEqual([
      ["user", "hi"],
      ["assistant", "[The agent sent no reply]"],
      ["user", "next"],
    ]);
    expect(
      pick(dropUnreplayableToolRecords(rows, { incompleteAsText: true })),
    ).toEqual([
      ["user", "hi"],
      ["assistant", '[tool_call: lookup({"q":"x"}) -> no result recorded]'],
      ["user", "next"],
    ]);
  });
});

describe("redact", () => {
  test("normalizePlaceholders drops only uppercase placeholder counters", () => {
    expect(
      normalizePlaceholders("a <EMAIL_1> b <PHONE_NUMBER_22> c <x_1>"),
    ).toBe("a <EMAIL> b <PHONE_NUMBER> c <x_1>");
  });

  test.each([
    [
      "Authorization: Bearer abc.def-123456789012",
      "Authorization: Bearer <SECRET>",
    ],
    ["key=sk-abcdefghijklmnopqrstuvwxyz012345", "key=<API_KEY>"],
    ["postgres://u:p4ss@host/db", "postgres://<CREDENTIALS>@host/db"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "<API_KEY>"],
    ["AKIAIOSFODNN7EXAMPLE", "<API_KEY>"],
    ["nothing here", "nothing here"],
  ])("scrubKnownSecrets(%s)", (input, expected) => {
    expect(scrubKnownSecrets(input)).toBe(expected);
  });
});

describe("model input", () => {
  test("capText passes short text and rejects unusable caps", () => {
    expect(capText("abc", 5)).toEqual(["abc", 0]);
    expect(() => capText("abc", 0)).toThrow(ModelInputCapError);
    expect(() => capText("a".repeat(50), 20)).toThrow(
      "model input character cap is too small for an omission marker",
    );
  });

  test("edgeText keeps both ends around a marker", () => {
    expect(String(edgeText("abcdefghijklmnopqrstuvwxyz", 10, 3))).toBe(
      "abc[... 20 chars left out ...]xyz",
    );
    expect(String(edgeText("abc", 10, 3))).toBe("abc");
  });

  test("cleanModelText serializes objects with sorted keys", () => {
    expect(cleanModelText({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(cleanModelText(null)).toBe("");
  });

  test("isJevModel matches the provider prefix case-insensitively", () => {
    expect(isJevModel("typesafe/jev-1")).toBe(true);
    expect(isJevModel("TypeSafe/JEV")).toBe(true);
    expect(isJevModel("openai/x")).toBe(false);
  });
});

describe("tracing", () => {
  test("orqSpanTypeForOperation maps responses and invoke only", () => {
    expect(orqSpanTypeForOperation("responses")).toBe("span.responses");
    expect(orqSpanTypeForOperation("agent.responses")).toBe("span.responses");
    expect(orqSpanTypeForOperation("invoke")).toBe("span.chat_completion");
    expect(orqSpanTypeForOperation("chat")).toBeNull();
  });
});

describe("tool records", () => {
  const items = [
    {
      type: "function_call",
      id: "i1",
      call_id: "c1",
      name: "f",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "c1", output: "r" },
  ];

  test("isToolRecord accepts function calls and orq records", () => {
    expect(
      ["function_call", "orq:web_search", "message", 3].map(isToolRecord),
    ).toEqual([true, true, false, false]);
  });

  test("failurePayload omits an absent result", () => {
    expect(JSON.parse(failurePayload(null, "boom"))).toEqual({
      status: "failed",
      error: "boom",
    });
    expect(JSON.parse(failurePayload("partial", "boom"))).toEqual({
      status: "failed",
      error: "boom",
      result: "partial",
    });
  });

  test("normalizeToolRecords leaves canonical items alone", () => {
    expect(normalizeToolRecords(items)).toEqual(items);
  });

  test("normalizeToolRecords splits an orq record into a call and output", () => {
    const [first, second] = normalizeToolRecords([
      {
        type: "orq:web_search",
        id: "o1",
        call_id: "c9",
        status: "completed",
        arguments: { q: "x" },
        result: "found",
      },
    ]) as Record<string, unknown>[];
    expect(first).toMatchObject({
      type: "function_call",
      id: "o1",
      call_id: "c9",
      name: "web_search",
    });
    expect(JSON.parse(first?.arguments as string)).toEqual({ q: "x" });
    expect(second).toEqual({
      type: "function_call_output",
      call_id: "c9",
      output: "found",
    });
  });

  test("a failed record without a call id gets a minted id and failure output", () => {
    const [first, second] = normalizeToolRecords([
      {
        type: "orq:web_search",
        id: "o1",
        status: "failed",
        arguments: { q: "x" },
        error: "bad",
      },
    ]) as Record<string, unknown>[];
    expect(first?.call_id).toMatch(/^call_unpaired_/);
    expect(second?.call_id).toBe(first?.call_id);
    expect(JSON.parse(second?.output as string)).toEqual({
      status: "failed",
      error: "bad",
    });
  });

  test("pairToolRecords joins a call to its output", () => {
    expect(pairToolRecords(items)).toMatchObject([
      { name: "f", arguments_: "{}", result: "r", indices: [0, 1] },
    ]);
  });
});

describe("otel messages", () => {
  const items = [
    {
      type: "function_call",
      id: "i1",
      call_id: "c1",
      name: "f",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "c1", output: "r" },
  ];

  test("itemsToInputMessages handles strings and non-lists", () => {
    expect(itemsToInputMessages("hi")).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(itemsToInputMessages(3)).toEqual([]);
  });

  test("itemsToInputMessages converts each item type", () => {
    expect(
      itemsToInputMessages([
        ...items,
        {
          role: "user",
          content: [
            { type: "input_text", text: "x" },
            { type: "refusal", refusal: "no" },
            { type: "blob" },
          ],
        },
        { type: "reasoning", summary: [{ type: "summary_text", text: "s" }] },
        { type: "reasoning", encrypted_content: "z" },
        { type: "custom_tool_call", call_id: "c2", name: "g", input: "free" },
      ]),
    ).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c1", name: "f", arguments: {} }],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "c1", response: "r" }],
      },
      {
        role: "user",
        parts: [
          { type: "text", content: "x" },
          { type: "refusal", content: "no" },
          { type: "data", content: { type: "blob" } },
        ],
      },
      { role: "assistant", parts: [{ type: "reasoning", content: "s" }] },
      {
        role: "assistant",
        parts: [{ type: "reasoning", content: "[encrypted]" }],
      },
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c2", name: "g", arguments: "free" }],
      },
    ]);
  });

  test("an mcp call with an error adds a failed tool response", () => {
    const [, response] = itemsToInputMessages([
      { type: "mcp_call", id: "m", name: "h", arguments: "{}", error: "E" },
    ]);
    expect(response?.role).toBe("tool");
    expect((response?.parts as unknown[])[0]).toMatchObject({
      type: "tool_call_response",
      response: { status: "failed", error: "E" },
    });
  });

  test("itemsToOutputMessages drops tool results and sets finish_reason", () => {
    expect(
      itemsToOutputMessages(
        [...items, { type: "message", role: "assistant", content: "yo" }],
        "stop",
      ),
    ).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c1", name: "f", arguments: {} }],
        finish_reason: "stop",
      },
      {
        role: "assistant",
        parts: [{ type: "text", content: "yo" }],
        finish_reason: "stop",
      },
    ]);
    expect(itemsToOutputMessages("x")).toEqual([]);
  });

  test("isResponsesItem recognizes typed items only", () => {
    expect(
      [
        { type: "message" },
        { type: "input_text" },
        { role: "user" },
        { type: "orq:x" },
        "s",
      ].map(isResponsesItem),
    ).toEqual([true, false, false, true, false]);
  });
});
