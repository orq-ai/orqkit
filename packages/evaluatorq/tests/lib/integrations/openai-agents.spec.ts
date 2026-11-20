import { expect, test } from "bun:test";

import { MessageSchema } from "../../../src/lib/contracts.js";
import { OpenAIAgentTarget } from "../../../src/lib/integrations/openai-agents/index.js";

const user = (content: string) =>
  MessageSchema.parse({ role: "user", content });
const agent = {
  name: "Support",
  instructions: "Answer accurately",
  model: "openai/test-model",
  tools: [
    {
      name: "lookup",
      description: "Look up an order",
      parameters: { type: "object" },
    },
  ],
};
const completed = (overrides: Record<string, unknown> = {}) => ({
  finalOutput: "Done",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done" }],
    },
  ],
  lastResponseId: "resp-1",
  runContext: {
    usage: {
      requests: 2,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      inputTokensDetails: [{ cached_tokens: 2 }, { cached_tokens: 3 }],
      outputTokensDetails: [{ reasoning_tokens: 1 }, { reasoning_tokens: 4 }],
    },
  },
  ...overrides,
});

test("preserves ordered tool activity, result pairing, final output and complete SDK usage", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Checking" }],
            },
            {
              type: "function_call",
              id: "fc-original",
              callId: "call-original",
              name: "lookup",
              arguments: '{"order":"42"}',
            },
            {
              type: "function_call_result",
              callId: "call-original",
              name: "lookup",
              output: { status: "refunded" },
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
        }),
    },
  });
  const response = await target.respond([user("Refund order 42")]);
  expect(response.output.map((item) => item.type)).toEqual([
    "output_text",
    "function_call",
    "output_text",
  ]);
  expect(response.toolCalls[0]).toMatchObject({
    id: "fc-original",
    call_id: "call-original",
    arguments: '{"order":"42"}',
    result: '{"status":"refunded"}',
  });
  expect(response.text).toBe("CheckingDone");
  expect(response.responseId).toBe("resp-1");
  expect(response.usage).toMatchObject({
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cachedTokens: 5,
    reasoningTokens: 5,
    calls: 2,
    totalCost: null,
  });
});

test("replays full caller history with native SDK tool fields and no shared clone conversation", async () => {
  const inputs: unknown[] = [];
  const runner = {
    async run(_agent: object, input: unknown) {
      inputs.push(input);
      return completed();
    },
  };
  const target = new OpenAIAgentTarget(agent, { runner });
  const long = `${"full input ".repeat(1000)}END-MARKER`;
  const history = [
    user(long),
    MessageSchema.parse({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-42",
          item_id: "fc_42",
          type: "function",
          function: { name: "lookup", arguments: '{"order":"42"}' },
        },
      ],
    }),
    MessageSchema.parse({
      role: "tool",
      tool_call_id: "call-42",
      content: "refunded",
    }),
    user("Thanks"),
  ];
  await target.respond(history);
  await target.newInstance().respond([user("Independent")]);
  expect(inputs[0]).toEqual([
    { type: "message", role: "user", content: long },
    {
      type: "function_call",
      id: "fc_42",
      callId: "call-42",
      name: "lookup",
      arguments: '{"order":"42"}',
      status: "completed",
    },
    {
      type: "function_call_result",
      callId: "call-42",
      name: "lookup",
      output: "refunded",
      status: "completed",
    },
    { type: "message", role: "user", content: "Thanks" },
  ]);
  expect(inputs[1]).toEqual([
    { type: "message", role: "user", content: "Independent" },
  ]);
});

test.each([undefined, null])(
  "rejects incomplete runs with finalOutput=%s",
  async (finalOutput) => {
    const target = new OpenAIAgentTarget(agent, {
      runner: { run: async () => completed({ finalOutput }) },
    });
    await expect(target.respond([user("hello")])).rejects.toThrow(
      "no finalOutput",
    );
  },
);

test("structured final output stays JSON and missing usage stays unknown", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          finalOutput: { approved: false },
          output: [],
          runContext: {},
        }),
    },
  });
  const response = await target.respond([user("hello")]);
  expect(response.text).toBe('{"approved":false}');
  expect(response.usage).toBeNull();
});

test("preserves auth failures and usage from failed SDK runs", async () => {
  const error = Object.assign(new Error("Unauthorized"), {
    status: 401,
    state: { _context: completed().runContext },
  });
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () => {
        throw error;
      },
    },
  });
  await expect(target.respond([user("hello")])).rejects.toBe(error);
  expect(error).toMatchObject({
    status: 401,
    usage: { totalTokens: 30, calls: 2 },
  });
});

test("forwards cancellation and never runs a pre-aborted request", async () => {
  let calls = 0;
  const controller = new AbortController();
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async (
        _agent: object,
        _input: unknown,
        options: { signal: AbortSignal },
      ) => {
        calls++;
        expect(options.signal.aborted).toBe(false);
        controller.abort();
        return completed();
      },
    },
  });
  await expect(
    target.respond([user("hello")], { signal: controller.signal }),
  ).rejects.toThrow();
  await expect(
    target.respond([user("hello")], { signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("reads agent context and leaves supplied runner resources caller-owned", async () => {
  let closed = false;
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () => completed(),
      close() {
        closed = true;
      },
    },
  });
  const context = await target.getAgentContext();
  expect(context).toMatchObject({
    key: "Support",
    displayName: "Support",
    systemPrompt: "Answer accurately",
    model: "openai/test-model",
    tools: agent.tools,
    memoryStores: [],
  });
  await target.respond([user("hello")]);
  await target.close();
  expect(closed).toBe(false);
});

test.each(["session", "conversationId", "previousResponseId"])(
  "rejects shared %s state",
  (key) => {
    expect(
      () => new OpenAIAgentTarget(agent, { runOptions: { [key]: {} } }),
    ).toThrow("caller-owned history");
  },
);

test("unwraps SDK text tool outputs, retains hosted tool activity and router trace links", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          rawResponses: [
            {
              providerData: {
                telemetry: { trace_id: "trace-42", span_id: "span-42" },
              },
            },
          ],
          output: [
            {
              type: "function_call",
              id: "fc_42",
              callId: "call-42",
              name: "lookup",
              arguments: "{}",
            },
            {
              type: "function_call_result",
              callId: "call-42",
              output: { type: "text", text: "original tool output" },
            },
            {
              type: "hosted_tool_call",
              id: "web-42",
              name: "web_search",
              arguments: "{}",
              output: "search result",
            },
          ],
        }),
    },
  });
  const result = await target.respond([user("hello")]);
  expect(result.toolCalls.map((call) => call.result)).toEqual([
    "original tool output",
    "search result",
  ]);
  expect(result).toMatchObject({ traceId: "trace-42", spanId: "span-42" });
});

test("fails explicitly when an SDK output type cannot be preserved", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () => completed({ output: [{ type: "future_tool_event" }] }),
    },
  });
  await expect(target.respond([user("hello")])).rejects.toThrow(
    "unsupported output item type",
  );
});

test("keeps billed usage when a completed SDK call returns an interrupted result", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: { run: async () => completed({ finalOutput: undefined }) },
  });
  await expect(target.respond([user("hello")])).rejects.toMatchObject({
    usage: { totalTokens: 30, calls: 2 },
  });
});

test("maps image and file payloads into the native SDK content schema", async () => {
  let received: unknown;
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async (_agent: object, input: unknown) => {
        received = input;
        return completed();
      },
    },
  });
  await target.respond([
    MessageSchema.parse({
      role: "user",
      content: [
        {
          type: "input_image",
          image_url: "https://example.com/image.png",
          detail: "high",
        },
        { type: "input_image", file_id: "file-image" },
        { type: "input_file", file_id: "file-document", filename: "note.pdf" },
        { type: "input_file", file_url: "https://example.com/note.pdf" },
        { type: "input_file", file_data: "data:application/pdf;base64,AAAA" },
      ],
    }),
  ]);
  expect(received).toEqual([
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_image",
          image: "https://example.com/image.png",
          detail: "high",
        },
        { type: "input_image", image: { id: "file-image" }, detail: "auto" },
        {
          type: "input_file",
          file: { id: "file-document" },
          filename: "note.pdf",
        },
        {
          type: "input_file",
          file: { url: "https://example.com/note.pdf" },
          filename: undefined,
        },
        {
          type: "input_file",
          file: "data:application/pdf;base64,AAAA",
          filename: undefined,
        },
      ],
    },
  ]);
});

test.each([
  { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
  { status: "failed", error: { message: "provider failed" } },
  { status: "cancelled" },
  { status: "queued" },
  { status: "in_progress" },
  { choices: [{ finish_reason: "length" }] },
])(
  "rejects partial final output when provider termination is %j and retains billed usage",
  async (providerData) => {
    const target = new OpenAIAgentTarget(agent, {
      runner: {
        run: async () =>
          completed({
            finalOutput: "partial answer",
            rawResponses: [{ providerData }],
          }),
      },
    });
    await expect(target.respond([user("hello")])).rejects.toMatchObject({
      usage: { totalTokens: 30, calls: 2 },
    });
  },
);

test("retains a completed refusal without treating it as truncation", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          finalOutput: "I cannot do that",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "refusal", refusal: "I cannot do that" }],
            },
          ],
          rawResponses: [
            { providerData: { status: "completed", incomplete_details: null } },
          ],
        }),
    },
  });
  const result = await target.respond([user("hello")]);
  expect(result.text).toBe("I cannot do that");
  expect(result.refusal).toBe("I cannot do that");
});

test("renders pretty native structured output once", async () => {
  const pretty = '{\n  "approved": false,\n  "reasons": ["policy"]\n}';
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          finalOutput: { approved: false, reasons: ["policy"] },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: pretty }],
            },
          ],
        }),
    },
  });
  const result = await target.respond([user("hello")]);
  expect(result.text).toBe(pretty);
  expect(JSON.parse(result.text)).toEqual({
    approved: false,
    reasons: ["policy"],
  });
});

test.each([
  {
    call: {
      type: "shell_call",
      id: "shell-item",
      callId: "shell-42",
      status: "in_progress",
      action: { commands: ["ls"], timeoutMs: 1000, maxOutputLength: 100 },
    },
    result: {
      type: "shell_call_output",
      callId: "shell-42",
      output: [
        { stdout: "ok", stderr: "", outcome: { type: "exit", exitCode: 0 } },
      ],
    },
    name: "shell",
    arguments: { commands: ["ls"], timeoutMs: 1000, maxOutputLength: 100 },
  },
  {
    call: {
      type: "computer_call",
      id: "computer-item",
      callId: "computer-42",
      status: "completed",
      action: { type: "screenshot" },
    },
    result: {
      type: "computer_call_result",
      callId: "computer-42",
      output: {
        type: "computer_screenshot",
        data: "data:image/png;base64,AAAA",
      },
    },
    name: "computer",
    arguments: { type: "screenshot" },
  },
  {
    call: {
      type: "apply_patch_call",
      callId: "patch-42",
      status: "in_progress",
      operation: { type: "delete_file", path: "x" },
    },
    result: {
      type: "apply_patch_call_output",
      callId: "patch-42",
      status: "failed",
      output: "File does not exist",
    },
    name: "apply_patch",
    arguments: { type: "delete_file", path: "x" },
  },
  {
    call: {
      type: "tool_search_call",
      id: "search-item",
      providerData: { call_id: "search-42" },
      arguments: { query: "refund" },
    },
    result: {
      type: "tool_search_output",
      id: "search-output",
      providerData: { call_id: "search-42" },
      tools: [{ name: "refund", type: "function" }],
    },
    name: "tool_search",
    arguments: { query: "refund" },
  },
  {
    call: {
      type: "program",
      callId: "program-42",
      code: "return 42",
      fingerprint: "program-fingerprint",
    },
    result: {
      type: "program_output",
      callId: "program-42",
      status: "completed",
      output: "42",
    },
    name: "program",
    arguments: { code: "return 42", fingerprint: "program-fingerprint" },
  },
])(
  "preserves SDK builtin $name calls, arguments and paired result payloads",
  async (fixture) => {
    const target = new OpenAIAgentTarget(agent, {
      runner: {
        run: async () => completed({ output: [fixture.call, fixture.result] }),
      },
    });
    const result = await target.respond([user("hello")]);
    expect(result.toolCalls).toHaveLength(1);
    const call = result.toolCalls[0];
    expect(call?.name).toBe(fixture.name);
    expect(JSON.parse(call?.arguments ?? "")).toEqual(fixture.arguments);
    const payload = Object.fromEntries(
      Object.entries(fixture.result).filter(
        ([key]) => !["type", "callId"].includes(key),
      ),
    );
    expect(JSON.parse(call?.result ?? "")).toEqual(payload);
  },
);

test("correlates client tool-search output without an explicit provider call id", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          output: [
            {
              type: "tool_search_call",
              id: "search-input",
              execution: "client",
              arguments: { query: "refund" },
            },
            {
              type: "tool_search_output",
              id: "search-result",
              execution: "client",
              tools: [{ name: "refund" }],
            },
          ],
        }),
    },
  });
  const result = await target.respond([user("hello")]);
  expect(result.toolCalls[0]?.call_id).toBe("search-input");
  expect(result.toolCalls[0]?.result).toContain("refund");
});

test("rejects a shared SDK RunContext-shaped object before running but allows plain context data", async () => {
  const context = {
    context: {},
    usage: {},
    getRejectionMessage() {},
    isToolApproved() {},
    approveTool() {},
    rejectTool() {},
  };
  expect(
    () => new OpenAIAgentTarget(agent, { runOptions: { context } }),
  ).toThrow("shared SDK RunContext");
  const target = new OpenAIAgentTarget(agent, {
    runner: { run: async () => completed() },
    runOptions: {
      context: { context: "application data", usage: "application data" },
    },
  });
  expect((await target.respond([user("hello")])).usage?.totalTokens).toBe(30);
});

test("renders the SDK-normalized structured result without appending a second document", async () => {
  const target = new OpenAIAgentTarget(agent, {
    runner: {
      run: async () =>
        completed({
          finalOutput: { answer: "padded" },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: '{"answer":" padded "}' }],
            },
          ],
        }),
    },
  });
  const result = await target.respond([user("hello")]);
  expect(result.output).toHaveLength(1);
  expect(JSON.parse(result.text)).toEqual({ answer: "padded" });
});
