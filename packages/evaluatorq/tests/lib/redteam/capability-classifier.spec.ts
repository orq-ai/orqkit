import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import OpenAI from "openai";

import { AgentContextSchema } from "../../../src/lib/contracts.js";
import {
  AgentCapabilities,
  classifyAgentCapabilities,
  LLMConfig,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/capability-python-goldens.json" with {
  type: "json",
};

let logged: ReturnType<typeof spyOn<typeof console, "error">>,
  oldTracing: string | undefined;
beforeEach(() => {
  oldTracing = process.env.ORQ_DISABLE_TRACING;
  process.env.ORQ_DISABLE_TRACING = "1";
  logged = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
  if (oldTracing === undefined) delete process.env.ORQ_DISABLE_TRACING;
  else process.env.ORQ_DISABLE_TRACING = oldTracing;
});
function reply(value: unknown) {
  return {
    model: "echo",
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(value) } },
    ],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      total_cost: 0.01,
    },
  };
}
for (const fixture of goldens.cases)
  it(`matches pinned capability flow and exact prompts: ${fixture.label}`, async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [fixture.resource, fixture.tools];
    const client = {
      baseURL: "https://native.test",
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            return reply(responses.shift());
          },
        },
      },
    } as unknown as OpenAI;
    const raw = fixture.context as Record<string, unknown>;
    const context = AgentContextSchema.parse({
      ...raw,
      memoryStores: raw.memory_stores,
      knowledgeBases: raw.knowledge_bases,
      isMultiAgent: raw.is_multi_agent,
    });
    const result = await classifyAgentCapabilities(context, client, {
      model: "echo",
    });
    expect(result.toJSON()).toEqual(
      new AgentCapabilities(fixture.expected).toJSON(),
    );
    expect(context.isMultiAgent).toBe(fixture.isMultiAgent);
    expect(
      requests.map((request) => ({
        name: (request.response_format as { json_schema: { name: string } })
          .json_schema.name,
        messages: request.messages,
      })),
    ).toEqual(fixture.calls);
  });
for (const error of [
  new OpenAI.APIConnectionError({ message: "offline" }),
  Object.assign(new Error("forbidden"), { status: 403 }),
  Object.assign(new Error("busy"), { status: 429 }),
])
  it(`propagates transport/auth errors instead of silently reducing coverage: ${error.message}`, async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            throw error;
          },
        },
      },
    } as unknown as OpenAI;
    await expect(
      classifyAgentCapabilities(
        AgentContextSchema.parse({ key: "echo" }),
        client,
        { model: "echo" },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(logged).not.toHaveBeenCalled();
  });
it("propagates a tool classification API failure after resource inference", async () => {
  let calls = 0;
  const error = Object.assign(new Error("forbidden"), { status: 403 });
  const client = {
    chat: {
      completions: {
        create: async () => {
          if (calls++ === 0)
            return reply({
              memory_read: false,
              memory_write: false,
              knowledge_retrieval: false,
              is_multi_agent: true,
            });
          throw error;
        },
      },
    },
  } as unknown as OpenAI;
  const context = AgentContextSchema.parse({
    key: "echo",
    tools: [{ name: "lookup" }],
  });
  await expect(
    classifyAgentCapabilities(context, client, { model: "echo" }),
  ).rejects.toBe(error);
  expect(context.isMultiAgent).toBe(true);
  expect(calls).toBe(2);
  expect(logged).not.toHaveBeenCalled();
});
it("honors attacker decode settings and stops cancellation before a request", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          return reply({
            memory_read: false,
            memory_write: false,
            knowledge_retrieval: false,
          });
        },
      },
    },
  } as unknown as OpenAI;
  const config = new LLMConfig({
    attacker: {
      maxTokens: 4000,
      timeoutMs: 1000,
      reasoningEffort: "low",
      temperature: 0.2,
      extraKwargs: { seed: 7 },
    },
  });
  await classifyAgentCapabilities(
    AgentContextSchema.parse({ key: "echo" }),
    client,
    { model: "echo", pipelineConfig: config },
  );
  expect(requests[0]).toMatchObject({
    max_completion_tokens: 4000,
    reasoning_effort: "low",
    temperature: 0.2,
    seed: 7,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    classifyAgentCapabilities(
      AgentContextSchema.parse({ key: "echo" }),
      client,
      { model: "echo", signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
