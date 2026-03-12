import { describe, expect, mock, test } from "bun:test";

import type { DataPoint } from "../../../src/lib/types.js";

// ---------------------------------------------------------------------------
// Helpers — mock agents
// ---------------------------------------------------------------------------

/** Fake AI SDK agent that captures the args passed to generate(). */
function createMockAISdkAgent() {
  const calls: unknown[] = [];
  return {
    id: "test-agent",
    calls,
    generate: mock(async (args: unknown) => {
      calls.push(args);
      return {
        text: "response",
        steps: [],
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
        response: { id: "resp-1" },
      };
    }),
  };
}

/** Fake LangChain agent that captures the args passed to invoke(). */
function createMockLangChainAgent() {
  const calls: unknown[] = [];
  return {
    calls,
    invoke: mock(async (args: unknown) => {
      calls.push(args);
      return { messages: [] };
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock convert modules so we isolate wrapper logic from conversion
// ---------------------------------------------------------------------------

// AI SDK convert mock
mock.module("../../../src/lib/integrations/ai-sdk/convert.js", () => ({
  convertToOpenResponses: () => ({ output: [] }),
}));

// LangChain convert mock
mock.module("../../../src/lib/integrations/langchain/convert.js", () => ({
  convertToOpenResponses: () => ({ output: [] }),
}));

// LangChain dependency mocks — these are needed at import time
mock.module("@langchain/core/tools", () => ({
  toJsonSchema: (s: unknown) => s,
}));
mock.module("@langchain/core/utils/json_schema", () => ({
  toJsonSchema: (s: unknown) => s,
}));

// Now import the wrappers (after mocks are set up)
const { wrapAISdkAgent } = await import(
  "../../../src/lib/integrations/ai-sdk/wrap-agent.js"
);
const { wrapLangChainAgent } = await import(
  "../../../src/lib/integrations/langchain/wrap-agent.js"
);

// ---------------------------------------------------------------------------
// wrapAISdkAgent tests
// ---------------------------------------------------------------------------

describe("wrapAISdkAgent", () => {
  test("1. prompt only — uses agent.generate({ prompt })", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never);
    const data: DataPoint = { inputs: { prompt: "hi" } };

    await job(data, 0);

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toEqual({ prompt: "hi" });
  });

  test("2. messages only — uses agent.generate({ messages })", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never);
    const data: DataPoint = {
      inputs: { messages: [{ role: "user", content: "hi" }] },
    };

    await job(data, 0);

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("3. messages + prompt — merges both", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never);
    const data: DataPoint = {
      inputs: {
        prompt: "hi",
        messages: [{ role: "system", content: "ctx" }],
      },
    };

    await job(data, 0);

    expect(agent.calls).toHaveLength(1);
    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({ role: "system", content: "ctx" });
    expect(call.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("4. prompt + instructions (string) — prepends system message", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never, { instructions: "be nice" });
    const data: DataPoint = { inputs: { prompt: "hi" } };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "be nice",
    });
    expect(call.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("5. messages + instructions — prepends system message", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never, { instructions: "be nice" });
    const data: DataPoint = {
      inputs: { messages: [{ role: "user", content: "hi" }] },
    };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "be nice",
    });
    expect(call.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("6. messages + prompt + instructions — all combined", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never, { instructions: "be nice" });
    const data: DataPoint = {
      inputs: {
        prompt: "hi",
        messages: [{ role: "user", content: "q" }],
      },
    };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "be nice",
    });
    expect(call.messages[1]).toEqual({ role: "user", content: "q" });
    expect(call.messages[2]).toEqual({ role: "user", content: "hi" });
  });

  test("7. instructions as function — resolves dynamically", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never, {
      instructions: (data) => data.inputs.city as string,
    });
    const data: DataPoint = { inputs: { prompt: "hi", city: "SF" } };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages[0]).toEqual({ role: "system", content: "SF" });
  });

  test("8. no prompt, no messages — throws", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never);
    const data: DataPoint = { inputs: {} };

    expect(job(data, 0)).rejects.toThrow("neither was provided");
  });

  test("9. empty messages array — falls through to prompt path", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never);
    const data: DataPoint = { inputs: { prompt: "hi", messages: [] } };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({ prompt: "hi" });
  });

  test("10. messages is not an array — falls through to prompt path", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never);
    const data: DataPoint = {
      inputs: { prompt: "hi", messages: "not-an-array" },
    };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({ prompt: "hi" });
  });

  test("11. custom promptKey — uses alternate key", async () => {
    const agent = createMockAISdkAgent();
    const job = wrapAISdkAgent(agent as never, { promptKey: "question" });
    const data: DataPoint = { inputs: { question: "hi" } };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({ prompt: "hi" });
  });
});

// ---------------------------------------------------------------------------
// wrapLangChainAgent tests
// ---------------------------------------------------------------------------

describe("wrapLangChainAgent", () => {
  test("1. prompt only — wraps as user message", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never);
    const data: DataPoint = { inputs: { prompt: "hi" } };

    await job(data, 0);

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("2. messages only — passes directly", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never);
    const data: DataPoint = {
      inputs: { messages: [{ role: "user", content: "hi" }] },
    };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("3. messages + prompt — merges both", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never);
    const data: DataPoint = {
      inputs: {
        prompt: "hi",
        messages: [{ role: "system", content: "ctx" }],
      },
    };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({ role: "system", content: "ctx" });
    expect(call.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("4. prompt + instructions — prepends system message", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never, {
      instructions: "be nice",
    });
    const data: DataPoint = { inputs: { prompt: "hi" } };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "be nice",
    });
    expect(call.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("5. messages + instructions — prepends system message", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never, {
      instructions: "be nice",
    });
    const data: DataPoint = {
      inputs: { messages: [{ role: "user", content: "hi" }] },
    };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "be nice",
    });
    expect(call.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("6. messages + prompt + instructions — all combined", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never, {
      instructions: "be nice",
    });
    const data: DataPoint = {
      inputs: {
        prompt: "hi",
        messages: [{ role: "user", content: "q" }],
      },
    };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0]).toEqual({
      role: "system",
      content: "be nice",
    });
    expect(call.messages[1]).toEqual({ role: "user", content: "q" });
    expect(call.messages[2]).toEqual({ role: "user", content: "hi" });
  });

  test("7. instructions as function — resolves dynamically", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never, {
      instructions: (data) => data.inputs.city as string,
    });
    const data: DataPoint = { inputs: { prompt: "hi", city: "SF" } };

    await job(data, 0);

    const call = agent.calls[0] as { messages: unknown[] };
    expect(call.messages[0]).toEqual({ role: "system", content: "SF" });
  });

  test("8. no prompt, no messages — throws", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never);
    const data: DataPoint = { inputs: {} };

    expect(job(data, 0)).rejects.toThrow("neither was provided");
  });

  test("9. empty messages array — falls through to prompt path", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never);
    const data: DataPoint = { inputs: { prompt: "hi", messages: [] } };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("10. messages is not an array — falls through to prompt path", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never);
    const data: DataPoint = {
      inputs: { prompt: "hi", messages: "not-an-array" },
    };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("11. custom promptKey — uses alternate key", async () => {
    const agent = createMockLangChainAgent();
    const job = wrapLangChainAgent(agent as never, {
      promptKey: "question",
    });
    const data: DataPoint = { inputs: { question: "hi" } };

    await job(data, 0);

    expect(agent.calls[0]).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });
});
