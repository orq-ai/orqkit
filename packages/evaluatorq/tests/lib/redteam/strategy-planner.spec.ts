import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import { AgentContextSchema } from "../../../src/lib/contracts.js";
import {
  AgentCapabilities,
  AttackStrategySchema,
  planStrategiesForCategories,
  type StrategySelection,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/planner-attack-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  errorLog: ReturnType<typeof spyOn<typeof console, "error">>,
  oldTracing: string | undefined;
beforeEach(() => {
  oldTracing = process.env.ORQ_DISABLE_TRACING;
  process.env.ORQ_DISABLE_TRACING = "1";
  warn = spyOn(console, "warn").mockImplementation(() => {});
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  errorLog.mockRestore();
  if (oldTracing === undefined) delete process.env.ORQ_DISABLE_TRACING;
  else process.env.ORQ_DISABLE_TRACING = oldTracing;
});
function selectionOf(raw: Record<string, unknown>): StrategySelection {
  return {
    allHardcoded: (raw.all_hardcoded as unknown[]).map((value) =>
      AttackStrategySchema.parse(value),
    ),
    applicable: (raw.applicable as unknown[]).map((value) =>
      AttackStrategySchema.parse(value),
    ),
    allHardcodedCount: Number(raw.all_hardcoded_count),
    applicableCount: Number(raw.applicable_count),
    generatedCount: Number(raw.generated_count),
    generatedSingleCount: Number(raw.generated_single_count),
    generatedMultiCount: Number(raw.generated_multi_count),
    filteredCount: Number(raw.filtered_count),
    totalSelected: Number(raw.total_selected),
    ...(Object.hasOwn(raw, "generation_error")
      ? { generationError: raw.generation_error as string | null }
      : {}),
  };
}
for (const fixture of goldens.plans)
  it(`matches pinned complete strategy plan: ${fixture.label}`, async () => {
    const raw = fixture.context as Record<string, unknown>;
    const context = AgentContextSchema.parse({
      ...raw,
      memoryStores: raw.memory_stores,
      isMultiAgent: raw.is_multi_agent,
    });
    const requests: Record<string, unknown>[] = [];
    const client = {
      baseURL: "https://native.test",
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            if (fixture.label === "error")
              throw Object.assign(new Error("generation failed"), {
                status: 403,
              });
            return {
              model: "echo",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      objectives: [
                        {
                          objective: "Synthetic 0",
                          turn_type: "single",
                          delivery_method: "direct-request",
                        },
                        {
                          objective: "Synthetic 1",
                          turn_type: "single",
                          delivery_method: "role-play",
                        },
                      ],
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
                total_cost: 0.01,
              },
            };
          },
        },
      },
    } as unknown as OpenAI;
    const [strategies, selection, capabilities] =
      await planStrategiesForCategories({
        agentContext: context,
        categories: fixture.categories,
        llmClient: fixture.generate ? client : null,
        attackModel: "echo",
        maxTurns: 1,
        maxPerCategory: fixture.limit,
        generateAdditionalStrategies: fixture.generate,
        generatedStrategyCount: 2,
        agentCapabilities:
          fixture.capabilities === null
            ? null
            : new AgentCapabilities(fixture.capabilities),
        strategyNames: fixture.names === null ? null : new Set(fixture.names),
        deliveryMethods:
          fixture.methods === null ? null : new Set(fixture.methods),
      });
    expect(strategies).toEqual(
      Object.fromEntries(
        Object.entries(fixture.expected).map(([key, values]) => [
          key,
          values.map((value: unknown) => AttackStrategySchema.parse(value)),
        ]),
      ),
    );
    expect(selection).toEqual(
      Object.fromEntries(
        Object.entries(fixture.selection).map(([key, value]) => [
          key,
          Object.keys(value).length ? selectionOf(value) : {},
        ]),
      ),
    );
    expect(capabilities.toJSON()).toEqual(
      new AgentCapabilities(fixture.capabilitiesResult).toJSON(),
    );
    expect(requests).toHaveLength(fixture.calls.length);
    for (const request of requests) {
      const prompt = (request.messages as { content: string }[])[0]?.content;
      expect(prompt).toContain('All objectives MUST use turn_type="multi"');
      expect(prompt).toContain("Maximum turns available: 1");
    }
  });
it("classifies once before gating multi-agent-only generation and propagates cancellation", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return {
            model: "echo",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    memory_read: false,
                    memory_write: false,
                    knowledge_retrieval: false,
                    is_multi_agent: false,
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
              total_cost: 0.01,
            },
          };
        },
      },
    },
  } as unknown as OpenAI;
  const options = {
    agentContext: AgentContextSchema.parse({ key: "echo" }),
    categories: ["ASI07", "ASI08"],
    llmClient: client,
    attackModel: "echo",
    maxTurns: 3,
    maxPerCategory: null,
    generateAdditionalStrategies: true,
    generatedStrategyCount: 2,
  };
  const [strategies] = await planStrategiesForCategories(options);
  expect(strategies).toEqual({ ASI07: [], ASI08: [] });
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    planStrategiesForCategories({ ...options, signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
