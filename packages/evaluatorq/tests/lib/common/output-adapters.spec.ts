import { describe, expect, test } from "bun:test";

import {
  hasMeaningfulOutput,
  inputsToMessages,
  outputErrorText,
  outputToMessages,
  outputToText,
  RESPONSES_ASSISTANT_TURN_ORDER_KEY,
  RESPONSES_ITEM_ORDER_KEY,
  responsesTranscript,
} from "../../../src/lib/common/output-adapters.js";
import {
  AgentContextSchema,
  AgentResponse,
  textOutputItem,
  toolCallOutputItem,
} from "../../../src/lib/contracts.js";
import {
  isResponsesItem,
  itemsToInputMessages,
  itemsToOutputMessages,
} from "../../../src/lib/integrations/openresponses/otel-messages.js";

const call = {
  type: "function_call",
  call_id: "c",
  name: "t",
  arguments: "{}",
};
const output = { type: "function_call_output", call_id: "c", output: "o" };
const assistant = { type: "message", role: "assistant", content: "a" };
const user = { type: "message", role: "user", content: "u" };

describe("AgentResponse", () => {
  test("pairs tool results and promotes refusals to text", () => {
    const response = AgentResponse.fromOutputItems([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "a", annotations: [] },
          { type: "refusal", refusal: "r" },
        ],
      },
      call,
      output,
    ]);
    expect(response.text).toBe("ar");
    expect(response.refusal).toBe("r");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.result).toBe("o");
  });

  test("reads usage and identity from a Responses object", () => {
    const response = AgentResponse.fromOpenResponses({
      object: "response",
      id: "r",
      model: "m",
      status: "completed",
      output: [],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    expect(response.responseId).toBe("r");
    expect(response.usage?.totalTokens).toBe(5);
  });

  test("text shorthand and explicit output are exclusive", () => {
    expect(new AgentResponse({ text: "x" }).text).toBe("x");
    expect(() => new AgentResponse({ text: "x", output: [] })).toThrow();
  });
});

test("AgentContext normalizes wrong-typed metadata and requires a string key", () => {
  const context = AgentContextSchema.parse({
    key: "k",
    id: 5,
    instructions: 7,
    skills: ["a", 1],
    targetKind: "zzz",
  });
  expect(context.id).toBe("5");
  expect(context.instructions).toBe("7");
  expect(context.skills).toEqual(["a"]);
  expect(context.targetKind).toBeNull();
  expect(() => AgentContextSchema.parse({ key: 5 })).toThrow();
});

describe("output adapters", () => {
  test("text, error and blank detection on AgentResponse", () => {
    const failed = new AgentResponse({
      output: [],
      error: { message: "m", errorType: "t", code: null },
    });
    expect(outputErrorText(failed)).toContain("m");
    expect(hasMeaningfulOutput(new AgentResponse({ text: "  " }))).toBe(false);
    expect(outputToText(new AgentResponse({ text: "x" }))).toBe("x");
  });

  test("tool call items survive into messages", () => {
    const response = new AgentResponse({
      output: [
        textOutputItem("hi"),
        toolCallOutputItem({ name: "t", arguments: "{}", result: "o" }),
      ],
    });
    expect(hasMeaningfulOutput(response)).toBe(true);
    expect(outputToMessages(response).map((item) => item.type)).toEqual([
      "output_text",
      "function_call",
    ]);
  });

  test("inputs keep their messages and fall back to the input field", () => {
    const messages = [{ role: "user", content: "a" }];
    expect(inputsToMessages({ messages })).toEqual(messages);
    expect(inputsToMessages({ input: "x" })).toEqual([
      { role: "user", content: "x" },
    ]);
  });

  test("a transcript follows the recorded item order and merges one turn", () => {
    const turn = responsesTranscript({
      object: "response",
      input: [user],
      output: [assistant, call],
      metadata: {
        [RESPONSES_ITEM_ORDER_KEY]: ["input", "output", "output"],
        [RESPONSES_ASSISTANT_TURN_ORDER_KEY]: [0, 0],
      },
    });
    expect(turn?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(turn?.[1]?.tool_calls).toHaveLength(1);
    expect(responsesTranscript({ object: "other" })).toBeNull();
  });
});

describe("otel messages", () => {
  test("input items become role and parts", () => {
    expect(itemsToInputMessages([call, output])).toEqual([
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c", name: "t", arguments: {} }],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "c", response: "o" }],
      },
    ]);
    expect(itemsToInputMessages("hi")).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
  });

  test("output drops tool results and stamps the finish reason", () => {
    const messages = itemsToOutputMessages([call, output], "stop");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.finish_reason).toBe("stop");
  });

  test("encrypted reasoning leaves a marker, and an MCP error is a response", () => {
    expect(
      itemsToOutputMessages([{ type: "reasoning", encrypted_content: "z" }]),
    ).toEqual([
      {
        role: "assistant",
        parts: [{ type: "reasoning", content: "[encrypted]" }],
        finish_reason: "",
      },
    ]);
    const mcp = itemsToInputMessages([
      { type: "mcp_call", id: "m", name: "n", arguments: "{}", error: "bad" },
    ]);
    expect(mcp).toHaveLength(2);
    expect(mcp[1]?.role).toBe("tool");
  });

  test("item detection needs a known string type", () => {
    expect(isResponsesItem({ type: "mcp_call" })).toBe(true);
    expect(isResponsesItem({ type: "zzz" })).toBe(false);
    expect(isResponsesItem({ role: "user" })).toBe(false);
  });
});
