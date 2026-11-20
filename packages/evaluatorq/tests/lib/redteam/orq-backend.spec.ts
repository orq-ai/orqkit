import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import { Orq } from "@orq-ai/node";
import type { RequestOptions } from "@orq-ai/node/lib/sdks.js";

import { callTargetWithRetry } from "../../../src/lib/common/target-call.js";
import {
  conversationThread,
  evaluatorqPipeline,
  evaluatorqRunId,
} from "../../../src/lib/common/thread-context.js";
import {
  AgentContextSchema,
  MessageSchema,
  parseUsage,
} from "../../../src/lib/contracts.js";
import {
  BackendError,
  createOpenAIBackend,
  createOpenResponsesBackend,
  LLMConfig,
  makeAgentBackend,
  OpenAIBackend,
  OpenResponsesBackend,
  OrqAgentTarget,
  OrqBackend,
  orqRetryConfig,
  registerBackend,
  resolveBackend,
  warnIgnoredTargetRetries,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/redteam-orq-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
let oldTracing: string | undefined;
beforeEach(() => {
  oldTracing = process.env.ORQ_DISABLE_TRACING;
  process.env.ORQ_DISABLE_TRACING = "1";
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (oldTracing === undefined) delete process.env.ORQ_DISABLE_TRACING;
  else process.env.ORQ_DISABLE_TRACING = oldTracing;
  warn.mockRestore();
});
const messages = () => [
  MessageSchema.parse({ role: "system", content: "ignored" }),
  MessageSchema.parse({ role: "user", content: "old" }),
  MessageSchema.parse({ role: "assistant", content: "old reply" }),
  MessageSchema.parse({ role: "user", content: "latest" }),
];
function camel(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(camel);
  if (raw === null || typeof raw !== "object") return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      camel(value),
    ]),
  );
}
for (const fixture of goldens.cases)
  it(`matches pinned Python Orq flow ${fixture.label}`, async () => {
    const calls: { request: unknown; options?: RequestOptions }[] = [];
    const queue = fixture.responses.map(camel);
    const client = {
      agents: {
        responses: {
          create: async (
            request: unknown,
            _key: string,
            options?: RequestOptions,
          ) => {
            calls.push({ request, options });
            return queue.shift();
          },
        },
      },
    } as unknown as Orq;
    const target = new OrqAgentTarget("echo", client, {
      memoryEntityId: "seed",
      maxToolContinuations: fixture.limit,
    });
    if (fixture.error) {
      try {
        await target.respond(messages());
        throw new Error("Expected continuation error");
      } catch (error) {
        expect(error).toBeInstanceOf(BackendError);
        expect((error as { usage?: unknown }).usage).toMatchObject({
          calls: 1,
          totalTokens: 5,
        });
      }
    } else {
      const expected = fixture.expected;
      if (!expected) throw new Error("Missing fixture result");
      const result = await target.respond(messages());
      expect({
        text: result.text,
        usage: result.usage,
        model: result.model,
        responseId: result.responseId,
        traceId: result.traceId,
        spanId: result.spanId,
        tools: result.output.flatMap((item) =>
          item.type === "function_call"
            ? [
                {
                  name: item.name,
                  arguments: JSON.parse(item.arguments),
                  callId: item.call_id,
                },
              ]
            : [],
        ),
      }).toEqual({ ...expected, usage: parseUsage(expected.usage) });
    }
    expect(calls).toHaveLength(fixture.calls.length);
    for (let i = 0; i < calls.length; i++) {
      const python = fixture.calls[i];
      if (!python) throw new Error("Missing fixture call");
      const { agent_key: _key, retries: _retries, ...request } = python;
      expect(calls[i]?.request).toEqual(camel(request));
      expect(calls[i]?.options?.retries).toEqual({ strategy: "none" });
    }
  });
it("uses the real SDK against a local HTTP server for nested tools, task continuity, wire metadata and usage", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v2/agents/echo/responses");
      requests.push((await request.json()) as Record<string, unknown>);
      const index = requests.length;
      return Response.json({
        _id: `response-${index}`,
        task_id: index === 1 ? "task-one" : "task-two",
        created_at: "2026-11-09T12:00:00.000Z",
        model: "echo",
        output:
          index === 1
            ? []
            : [
                {
                  messageId: "message",
                  role: "agent",
                  parts: [{ kind: "text", text: "Done" }],
                },
              ],
        ...(index === 1
          ? {
              pending_tool_calls: [
                {
                  id: "provider-tool",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"hi"}' },
                },
              ],
            }
          : {}),
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
        telemetry: { trace_id: "trace", span_id: "span" },
      });
    },
  });
  try {
    const client = new Orq({
      apiKey: "synthetic-key",
      serverURL: server.url.toString(),
      retryConfig: {
        strategy: "backoff",
        backoff: {
          initialInterval: 1,
          maxInterval: 1,
          exponent: 1,
          maxElapsedTime: 500,
        },
      },
    });
    const target = new OrqAgentTarget("echo", client, {
      memoryEntityId: "seed",
    });
    const result = await evaluatorqPipeline("redteam", () =>
      evaluatorqRunId("run", () =>
        conversationThread("thread", () => target.respond(messages())),
      ),
    );
    expect(result.text).toBe("Done");
    expect(result.usage).toMatchObject({
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
      cachedTokens: 2,
      reasoningTokens: 2,
      calls: 2,
    });
    expect(result.output[0]).toMatchObject({
      type: "function_call",
      name: "lookup",
      call_id: "provider-tool",
      arguments: '{"q":"hi"}',
    });
    const tool = result.output[0];
    if (tool?.type !== "function_call") throw new Error("Missing tool call");
    expect(tool.id).not.toBe("provider-tool");
    expect(requests[0]).toMatchObject({
      message: { role: "user", parts: [{ kind: "text", text: "latest" }] },
      memory: { entity_id: "seed" },
      thread: { id: "thread" },
      metadata: { evaluatorq_pipeline: "redteam", evaluatorq_run_id: "run" },
      background: false,
    });
    expect(requests[0]).not.toHaveProperty("task_id");
    expect(requests[1]).toMatchObject({
      task_id: "task-one",
      message: {
        role: "tool",
        parts: [
          {
            kind: "tool_result",
            tool_call_id: "provider-tool",
            result: {
              ok: false,
              error: "Tool execution unavailable in red-teaming harness",
            },
          },
        ],
      },
    });
    expect(requests[1]).not.toHaveProperty("memory");
    await target.respond([
      MessageSchema.parse({ role: "user", content: "again" }),
    ]);
    expect(requests[2]).toMatchObject({ task_id: "task-two" });
    const clone = target.newInstance();
    await clone.respond([
      MessageSchema.parse({ role: "user", content: "fresh" }),
    ]);
    expect(requests[3]).not.toHaveProperty("task_id");
  } finally {
    server.stop(true);
  }
});
it("does not multiply real Orq SDK retries under outer target retries", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json({ message: "Temporary" }, { status: 503 });
    },
  });
  try {
    const client = new Orq({
      apiKey: "synthetic-key",
      serverURL: server.url.toString(),
      retryConfig: {
        strategy: "backoff",
        backoff: {
          initialInterval: 1,
          maxInterval: 1,
          exponent: 1,
          maxElapsedTime: 500,
        },
      },
    });
    const target = new OrqAgentTarget("echo", client);
    const result = await callTargetWithRetry(target, messages(), {
      targetAgentTimeoutMs: 1000,
      maxTargetRetries: 1,
    });
    expect(result.error).not.toBeNull();
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
  }
});
it("requires a final user text and rejects image input before a request", async () => {
  let calls = 0;
  const client = {
    agents: {
      responses: {
        create: async () => {
          calls++;
          throw new Error("unexpected");
        },
      },
    },
  } as unknown as Orq;
  const target = new OrqAgentTarget("echo", client);
  await expect(target.respond([])).rejects.toThrow("requires");
  await expect(
    target.respond([
      MessageSchema.parse({ role: "assistant", content: "bad" }),
    ]),
  ).rejects.toThrow("requires");
  await expect(
    target.respond([
      MessageSchema.parse({
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/image",
          },
        ],
      }),
    ]),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it("isolates automatic entities and preserves constructor and later assigned seeds", () => {
  const client = {} as Orq;
  const target = new OrqAgentTarget("echo", client);
  expect(target.memoryEntityId).toMatch(/^red-team-[a-f0-9]{12}$/);
  expect(target.newInstance().memoryEntityId).not.toBe(target.memoryEntityId);
  target.memoryEntityId = "later-seed";
  expect(target.newInstance().memoryEntityId).toBe("later-seed");
  expect(
    new OrqAgentTarget("echo", client, { memoryEntityId: "seed" }).newInstance()
      .memoryEntityId,
  ).toBe("seed");
  target.memoryEntityId = null;
  expect(target.newInstance().memoryEntityId).toMatch(/^red-team-/);
});
it("enriches context, caches retrieval and leaves failed optional resources as limited context", async () => {
  const calls: string[] = [];
  const client = {
    agents: {
      retrieve: async (key: string) => {
        calls.push(`agent:${key}`);
        return {
          id: "agent-id",
          displayName: "Agent",
          instructions: "Instruction",
          systemPrompt: "System",
          version: "",
          versionHash: "fallback",
          workspaceId: 123,
          model: { id: "echo" },
          type: "internal",
          engine: "text",
          skills: ["skill", 7],
          settings: {
            tools: [
              {
                key: "lookup",
                description: "old",
                toolId: "tool-id",
                actionType: "function",
              },
              { key: "broken", toolId: "broken" },
            ],
          },
          knowledgeBases: [{ knowledgeId: "kb" }, { knowledgeId: "missing" }],
          memoryStores: ["store"],
        };
      },
    },
    knowledge: {
      retrieve: async ({ knowledgeId }: { knowledgeId: string }) => {
        calls.push(`kb:${knowledgeId}`);
        if (knowledgeId === "missing") throw new Error("optional");
        return { key: "kb-key", description: "Knowledge" };
      },
    },
    memoryStores: {
      retrieve: async () => ({
        id: "store-id",
        key: "store-key",
        description: "Memory",
      }),
    },
    tools: {
      retrieve: async ({ toolId }: { toolId: string }) => {
        if (toolId === "broken") throw new Error("optional");
        return {
          function: {
            description: "Rich",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        };
      },
    },
  } as unknown as Orq;
  const target = new OrqAgentTarget("echo", client);
  const context = await target.getAgentContext();
  expect(await target.getAgentContext()).toBe(context);
  expect(calls.filter((call) => call.startsWith("agent:"))).toHaveLength(1);
  expect(context).toMatchObject({
    key: "echo",
    targetKind: "agent",
    workspaceId: "123",
    version: "fallback",
    skills: ["skill"],
    instructions: "Instruction",
    systemPrompt: "System",
    model: "echo",
    knowledgeBases: [
      { id: "kb", key: "kb-key", name: "kb-key", description: "Knowledge" },
      { id: "missing", key: null },
    ],
    memoryStores: [{ id: "store-id", key: "store-key" }],
    tools: [
      { name: "lookup", description: "Rich", parameters: { type: "object" } },
      { name: "broken", parameters: null },
    ],
  });
  expect(warn).toHaveBeenCalledTimes(2);
});
it("retains JSON schema tools and propagates main context auth failures", async () => {
  const client = {
    agents: {
      retrieve: async () => ({
        settings: { tools: [{ key: "shape", toolId: "shape" }] },
      }),
    },
    tools: {
      retrieve: async () => ({
        jsonSchema: { description: "Schema", schema: { type: "object" } },
      }),
    },
  } as unknown as Orq;
  expect(
    (await new OrqAgentTarget("echo", client).getAgentContext()).tools[0],
  ).toMatchObject({ description: "Schema", parameters: { type: "object" } });
  const error = Object.assign(new Error("forbidden"), { statusCode: 403 });
  const backend = new OrqBackend({
    orqClient: {
      agents: {
        retrieve: async () => {
          throw error;
        },
      },
    } as unknown as Orq,
  });
  await expect(backend.resolveContext("echo")).rejects.toBe(error);
  expect(backend.mapError(error).code).toBe("orq.http.403");
});
it("cleans every store/entity combination, ignores missing entities and warns for other failures", async () => {
  const deleted: unknown[] = [];
  const client = {
    memoryStores: {
      deleteMemory: async (request: unknown) => {
        deleted.push(request);
        const entity = (request as { memoryEntityId: string }).memoryEntityId;
        if (entity === "missing") throw { statusCode: 404 };
        if (entity === "bad") throw { statusCode: 403 };
      },
    },
  } as unknown as Orq;
  const context = AgentContextSchema.parse({
    key: "echo",
    memoryStores: [
      { id: "one", key: "store-one" },
      { id: "two", key: "store-two" },
      { id: "no-key" },
    ],
  });
  await new OrqBackend({ orqClient: client }).cleanupMemory(context, [
    "good",
    "missing",
    "bad",
  ]);
  expect(deleted).toHaveLength(6);
  expect(deleted).toContainEqual({
    memoryStoreKey: "store-two",
    memoryEntityId: "bad",
  });
  expect(warn).toHaveBeenCalledTimes(3);
});
it("normalizes registry keys, replaces custom registrations and rejects unknown names", () => {
  expect(resolveBackend(" OPENAI ")).toBeInstanceOf(OpenAIBackend);
  expect(resolveBackend("OpenResponses")).toBeInstanceOf(OpenResponsesBackend);
  expect(resolveBackend()).toBeInstanceOf(OrqBackend);
  registerBackend(" custom ", () => new OpenAIBackend());
  expect(resolveBackend("CUSTOM")).toBeInstanceOf(OpenAIBackend);
  registerBackend("custom", () => new OpenResponsesBackend());
  expect(resolveBackend("custom")).toBeInstanceOf(OpenResponsesBackend);
  expect(() => resolveBackend("missing")).toThrow("Available:");
});
it("projects target settings and keeps attacker clients out of the hybrid execution backend", () => {
  const config = new LLMConfig({
    targetAgentTimeoutMs: 1234,
    targetReasoningEffort: "low",
    retryCount: 4,
  });
  const openai = createOpenAIBackend({
    pipelineConfig: config,
    targetConfig: { systemPrompt: "System" },
  }).createTarget("echo");
  expect(openai.options).toMatchObject({
    systemPrompt: "System",
    timeoutMs: 1234,
    reasoningEffort: "low",
  });
  const responses = createOpenResponsesBackend({
    pipelineConfig: config,
    targetConfig: { systemPrompt: "Instruction" },
  }).createTarget("echo");
  expect(responses.options).toMatchObject({
    instructions: "Instruction",
    requireOrq: true,
  });
  expect(responses.config.timeoutMs).toBe(1234);
  const hybrid = makeAgentBackend({ pipelineConfig: config });
  expect(hybrid.options.execBackend).toBeInstanceOf(OpenResponsesBackend);
  expect(
    (hybrid.options.execBackend as OpenResponsesBackend).options.client,
  ).toBeUndefined();
  expect(hybrid.createTarget("echo").memoryEntityId).not.toBeNull();
});
it("only warns for independently changed retry settings and budgets slow context attempts", () => {
  warnIgnoredTargetRetries("native", { retryCount: 3 });
  warnIgnoredTargetRetries("native", {
    retryOnCodes: [429, 500, 502, 503, 504],
  });
  expect(warn).not.toHaveBeenCalled();
  warnIgnoredTargetRetries("native", { retryOnCodes: [429] });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(orqRetryConfig(0)).toEqual({ strategy: "none" });
  expect(orqRetryConfig(3, 1000)).toMatchObject({
    backoff: {
      initialInterval: 500,
      maxInterval: 10000,
      exponent: 2,
      maxElapsedTime: 6500,
    },
    retryConnectionErrors: true,
  });
});

it("cancels an already aborted exchange before touching the SDK", async () => {
  let calls = 0;
  const target = new OrqAgentTarget("echo", {
    agents: {
      responses: {
        create: async () => {
          calls++;
        },
      },
    },
  } as unknown as Orq);
  const controller = new AbortController();
  controller.abort();
  await expect(
    target.respond(messages(), { signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
