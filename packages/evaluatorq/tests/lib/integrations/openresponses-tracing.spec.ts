import { afterEach, beforeEach, expect, it } from "bun:test";

import type { Span } from "@opentelemetry/api";
import type OpenAI from "openai";

import { executeResponse } from "../../../src/lib/common/llm-call.js";
import {
  itemsToInputMessages,
  itemsToOutputMessages,
} from "../../../src/lib/integrations/openresponses/otel-messages.js";
import {
  recordOpenResponsesRequest,
  recordOpenResponsesResponse,
} from "../../../src/lib/integrations/openresponses/tracing.js";

let before: Record<string, string | undefined>;
beforeEach(() => {
  before = {
    EVALUATORQ_CAPTURE_MESSAGE_CONTENT:
      process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT,
    EVALUATORQ_SPAN_MAX_TEXT_CHARS: process.env.EVALUATORQ_SPAN_MAX_TEXT_CHARS,
  };
  process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT = "true";
  delete process.env.EVALUATORQ_SPAN_MAX_TEXT_CHARS;
});
afterEach(() => {
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const input = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Search" }],
  },
  {
    type: "function_call",
    call_id: "c",
    name: "lookup",
    arguments: '{"q":"hello"}',
  },
  { type: "function_call_output", call_id: "c", output: '{"ok":true}' },
  {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Consider sources" }],
  },
];
const output = [
  { type: "reasoning", summary: [{ type: "summary_text", text: "Checked" }] },
  { type: "function_call", call_id: "new", name: "lookup", arguments: "{}" },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Found it" }],
  },
];
function recorder() {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    span: {
      setAttributes: (values: Record<string, unknown>) =>
        Object.assign(attrs, values),
      setAttribute: (key: string, value: unknown) => {
        attrs[key] = value;
      },
    } as unknown as Span,
  };
}
it("records parts-shaped tool/reasoning messages alongside the exact Responses payload", () => {
  const { attrs, span } = recorder();
  const payload = {
    model: "test",
    input,
    instructions: "Only use evidence",
    max_output_tokens: 4000,
    reasoning: { effort: "low" },
  };
  recordOpenResponsesRequest(span, payload);
  expect(JSON.parse(String(attrs["gen_ai.input.messages"]))).toEqual(
    itemsToInputMessages(input),
  );
  expect(JSON.parse(String(attrs["openresponses.input"]))).toEqual(input);
  expect(JSON.parse(String(attrs["orq.openresponses.request"]))).toEqual(
    payload,
  );
  expect(attrs).toMatchObject({
    "gen_ai.request.model": "test",
    "gen_ai.request.reasoning_effort": "low",
    "gen_ai.request.max_tokens": 4000,
    "gen_ai.system_instructions": "Only use evidence",
    "openresponses.instructions": "Only use evidence",
  });
  expect(attrs.input).toBe(attrs["gen_ai.input.messages"]);
});
it("overrides flat output with full tool/reasoning parts and retains usage", () => {
  const { attrs, span } = recorder();
  const response = {
    id: "reply",
    model: "test",
    status: "completed",
    output,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
  recordOpenResponsesResponse(span, response);
  expect(JSON.parse(String(attrs["gen_ai.output.messages"]))).toEqual(
    itemsToOutputMessages(output, "completed"),
  );
  expect(JSON.parse(String(attrs["openresponses.output"]))).toEqual(output);
  expect(JSON.parse(String(attrs["orq.openresponses.response"]))).toEqual(
    response,
  );
  expect(attrs).toMatchObject({
    "gen_ai.usage.total_tokens": 5,
    "gen_ai.response.id": "reply",
  });
});
it("keeps model, budget, reasoning effort and usage while capture is disabled", () => {
  process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT = "false";
  const { attrs, span } = recorder();
  recordOpenResponsesRequest(span, {
    model: "test",
    input,
    instructions: "secret",
    max_output_tokens: 4000,
    reasoning: { effort: "low" },
  });
  recordOpenResponsesResponse(span, {
    output,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  for (const key of [
    "input",
    "output",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "openresponses.input",
    "openresponses.output",
    "openresponses.instructions",
    "orq.openresponses.request",
    "orq.openresponses.response",
  ])
    expect(attrs).not.toHaveProperty(key);
  expect(attrs).toMatchObject({
    "gen_ai.request.reasoning_effort": "low",
    "gen_ai.request.model": "test",
    "gen_ai.request.max_tokens": 4000,
    "gen_ai.usage.total_tokens": 5,
  });
});
it("allows absent spans and applies the shared trace text cap", () => {
  recordOpenResponsesRequest(undefined, { input });
  recordOpenResponsesResponse(undefined, { output });
  process.env.EVALUATORQ_SPAN_MAX_TEXT_CHARS = "80";
  const { attrs, span } = recorder();
  recordOpenResponsesRequest(span, { input, instructions: "x".repeat(100) });
  expect(
    String(attrs["openresponses.instructions"]).length,
  ).toBeLessThanOrEqual(80);
  expect(attrs["openresponses.instructions"]).toContain("truncated");
});
it("observes final request params after dropping rejected reasoning", async () => {
  let calls = 0;
  const requests: Record<string, unknown>[] = [];
  const client = {
    responses: {
      create: async () => {
        if (calls++ === 0)
          throw Object.assign(new Error("reasoning effort is not supported"), {
            status: 400,
          });
        return {
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
      },
    },
  } as unknown as OpenAI;
  const seen = await executeResponse({
    client,
    span: undefined,
    model: "observed-target",
    messages: input,
    reasoningEffort: "low",
    timeoutMs: 1000,
    onRequest: (payload) => requests.push(structuredClone(payload)),
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toHaveProperty("reasoning");
  expect(requests[1]).not.toHaveProperty("reasoning");
  expect(seen.usage?.totalTokens).toBe(2);
});
