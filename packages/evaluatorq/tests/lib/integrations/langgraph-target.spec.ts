import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult, LLMResult } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

import {
  AgentContextSchema,
  MessageSchema,
} from "../../../src/lib/contracts.js";
import {
  LangGraphTarget,
  langGraphOutputItems,
} from "../../../src/lib/integrations/langchain/target.js";
import type { LangChainInvocable } from "../../../src/lib/integrations/langchain/types.js";
import goldens from "../fixtures/langgraph-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
const user = (content: string) =>
  MessageSchema.parse({ role: "user", content });
const normalize = (value: unknown) => {
  const item = { ...(value as Record<string, unknown>) };
  delete item.id;
  if (item.type === "function_call") {
    item.arguments = JSON.parse(String(item.arguments));
    if (String(item.call_id).startsWith("call_")) item.call_id = "generated";
    if (item.result)
      try {
        item.result = JSON.parse(String(item.result));
      } catch {}
  }
  return item;
};
for (const [index, entry] of goldens.cases.entries())
  it(`matches pinned LangGraph ordered output case ${index}`, () => {
    expect(
      langGraphOutputItems(entry.messages).map(normalize) as unknown,
    ).toEqual(
      entry.output.map((item) => {
        if (item.type === "function_call" && "result" in item && item.result)
          try {
            return { ...item, result: JSON.parse(item.result) };
          } catch {}
        return item;
      }),
    );
  });
class SyntheticChatModel extends BaseChatModel {
  override _llmType(): string {
    return "synthetic";
  }
  override async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    return {
      generations: [
        {
          text: "mango",
          message: new AIMessage({
            content: "mango",
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 2,
              total_tokens: 5,
            },
          }),
        },
      ],
    };
  }
}
it("runs a real graph with isolated persistent threads, latest-user input and callback usage", async () => {
  const model = new SyntheticChatModel({});
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("echo", async (state, config) => ({
      messages: [await model.invoke(state.messages, config)],
    }))
    .addEdge(START, "echo")
    .addEdge("echo", END)
    .compile({ checkpointer: new MemorySaver() });
  const target = new LangGraphTarget(graph);
  const first = await target.respond([user("first")]);
  expect(first.text).toBe("mango");
  expect(first.usage).toMatchObject({
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    calls: 1,
  });
  const second = await target.respond([
    user("first"),
    MessageSchema.parse({ role: "assistant", content: "mango" }),
    user("second"),
  ]);
  expect(second.output).toHaveLength(1);
  expect(second.usage?.totalTokens).toBe(5);
  const state = await graph.getState({
    configurable: { thread_id: target.memoryEntityId },
  });
  expect(state.values.messages).toHaveLength(4);
  const clone = target.newInstance();
  expect(clone.memoryEntityId).not.toBe(target.memoryEntityId);
  await clone.respond([user("first")]);
  expect(
    (
      await graph.getState({
        configurable: { thread_id: clone.memoryEntityId },
      })
    ).values.messages,
  ).toHaveLength(2);
  expect(target.historyMode).toBe("target");
  const context = await target.getAgentContext();
  expect(context.memoryStores[0]?.id as unknown).toBe(target.memoryEntityId);
  const id = target.memoryEntityId;
  target.resetConversation();
  expect(target.memoryEntityId).not.toBe(id);
  await target.respond([user("reset")]);
  expect(
    (
      await graph.getState({
        configurable: { thread_id: target.memoryEntityId },
      })
    ).values.messages,
  ).toHaveLength(2);
});
function collector(config: RunnableConfig | undefined): BaseCallbackHandler {
  const callbacks = config?.callbacks;
  const handlers = Array.isArray(callbacks)
    ? callbacks
    : (callbacks?.handlers ?? []);
  const handler = handlers.find(
    (handler) =>
      "name" in handler && handler.name === "evaluatorq_langgraph_usage",
  );
  if (!handler) throw new Error("Missing usage collector");
  return handler as BaseCallbackHandler;
}
const usageEvent = () =>
  ({
    generations: [
      [
        {
          message: {
            usage_metadata: {
              input_tokens: 2,
              output_tokens: 1,
              total_tokens: 3,
            },
          },
        },
        {
          message: {
            usage_metadata: {
              input_tokens: 2,
              output_tokens: 1,
              total_tokens: 3,
            },
          },
        },
      ],
    ],
  }) as unknown as LLMResult;
it("copies callback managers without accumulating handlers and counts only one sampling candidate", async () => {
  const manager = new CallbackManager();
  manager.addHandler(BaseCallbackHandler.fromMethods({}));
  const seen: RunnableConfig[] = [];
  const graph: LangChainInvocable = {
    async invoke(_input, config) {
      if (!config) throw new Error("no config");
      seen.push(config);
      collector(config).handleLLMEnd?.(usageEvent(), "call");
      return { messages: [{ role: "assistant", content: "ok" }] };
    },
  };
  const options = {
    config: {
      callbacks: manager,
      configurable: { custom: "value", thread_id: "ignored" },
    },
  };
  const target = new LangGraphTarget(graph, options);
  expect((await target.respond([user("hi")])).usage?.totalTokens).toBe(3);
  expect((await target.respond([user("again")])).usage?.totalTokens).toBe(3);
  expect(manager.handlers).toHaveLength(1);
  expect((seen[0]?.callbacks as CallbackManager).handlers).toHaveLength(2);
  expect((seen[1]?.callbacks as CallbackManager).handlers).toHaveLength(2);
  expect(seen[0]?.configurable).toEqual({
    custom: "value",
    thread_id: target.memoryEntityId,
  });
  expect(options.config.configurable.thread_id).toBe("ignored");
});
it("does not mutate callback arrays or mix usage across clones", async () => {
  const callbacks: BaseCallbackHandler[] = [];
  const graph: LangChainInvocable = {
    async invoke(_input, config) {
      collector(config).handleLLMEnd?.(usageEvent(), "call");
      return { messages: [{ role: "assistant", content: "ok" }] };
    },
  };
  const target = new LangGraphTarget(graph, { config: { callbacks } }),
    clone = target.newInstance();
  const results = await Promise.all([
    target.respond([user("a")]),
    clone.respond([user("b")]),
  ]);
  expect(results.map((result) => result.usage?.calls)).toEqual([1, 1]);
  expect(callbacks).toHaveLength(0);
});
it("rejects missing or empty message state, and accepts an explicit capability context", async () => {
  for (const state of [{ other: [] }, { messages: [] }]) {
    const target = new LangGraphTarget({
      async invoke() {
        return state;
      },
    });
    await expect(target.respond([user("hi")])).rejects.toThrow("messages");
  }
  const context = AgentContextSchema.parse({
    key: "custom",
    tools: [{ name: "lookup" }],
  });
  expect(
    await new LangGraphTarget(
      {
        async invoke() {
          return { messages: [] };
        },
      },
      { agentContext: context },
    ).getAgentContext(),
  ).toBe(context);
});
it("preserves partial billed usage on errors and keeps its history cursor stable", async () => {
  let turn = 0;
  const graph: LangChainInvocable = {
    async invoke(_input, config) {
      collector(config).handleLLMEnd?.(usageEvent(), "call");
      if (turn++ === 0) throw new Error("provider failed");
      return { messages: [{ role: "assistant", content: "recovered" }] };
    },
  };
  const target = new LangGraphTarget(graph);
  try {
    await target.respond([user("hi")]);
    throw new Error("expected error");
  } catch (error) {
    expect((error as { usage: unknown }).usage).toMatchObject({
      totalTokens: 3,
      calls: 1,
    });
  }
  expect((await target.respond([user("retry")])).text).toBe("recovered");
});
it("requires the latest turn to be a user without invoking the graph", async () => {
  let calls = 0;
  const target = new LangGraphTarget({
    async invoke() {
      calls++;
      return { messages: [] };
    },
  });
  await expect(target.respond([])).rejects.toThrow("role user");
  await expect(
    target.respond([MessageSchema.parse({ role: "tool", content: "result" })]),
  ).rejects.toThrow("role user");
  expect(calls).toBe(0);
});
it("retains graph-reported partial spend in failed simulation rows", async () => {
  const graph: LangChainInvocable = {
    async invoke(_input, config) {
      collector(config).handleLLMEnd?.(usageEvent(), "call");
      throw new Error("provider failed");
    },
  };
  const { simulate } = await import(
    "../../../src/lib/integrations/simulation/index.js"
  );
  const { parseSavedDatapoint } = await import(
    "../../../src/lib/integrations/simulation/run-store.js"
  );
  const { makeFakeClient } = await import("./simulation/fake-client.js");
  const fixture = await import(
    "../fixtures/simulation-run-python-goldens.json",
    { with: { type: "json" } }
  );
  const result = await simulate({
    target: new LangGraphTarget(graph),
    client: makeFakeClient().client,
    datapoints: [parseSavedDatapoint(fixture.default.run.datapoints?.[0])],
    maxTurns: 1,
    maxTargetRetries: 0,
    raiseOnExecutionFailure: false,
    uploadResults: false,
    recommendations: false,
    executiveSummary: false,
  });
  expect(result[0]?.terminated_by).toBe("error");
  expect(result[0]?.usage).toMatchObject({ totalTokens: 3, calls: 1 });
});
it("describes tools from every graph node and the isolated checkpointer store", async () => {
  const graph = {
    name: "tools",
    nodes: {
      one: { bound: { tools: [{ name: "a", description: "First" }] } },
      two: {
        bound: {
          tools: [
            { name: "b", description: "Second" },
            { name: "a", description: "Duplicate" },
          ],
        },
      },
    },
    checkpointer: {},
    async invoke() {
      return { messages: [] };
    },
  };
  const target = new LangGraphTarget(graph);
  const context = await target.getAgentContext();
  expect(context.tools.map((tool) => tool.name)).toEqual(["a", "b"]);
  expect(context.memoryStores[0]?.key).toBe("langgraph_checkpointer");
});
