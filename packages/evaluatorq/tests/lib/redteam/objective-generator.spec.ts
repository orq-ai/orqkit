import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import { AgentContextSchema } from "../../../src/lib/contracts.js";
import {
  AttackStrategySchema,
  AttackTechniqueSchema,
  buildObjectivePrompt,
  createStrategyFromObjective,
  fillTemplate,
  GeneratedObjectiveSchema,
  generateObjectivesForCategory,
  generateStrategiesForCategory,
  LLMConfig,
  objectivesToStrategies,
  TurnTypeSchema,
  VulnerabilitySchema,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/objective-python-goldens.json" with {
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
function contextOf(value: Record<string, unknown>) {
  return AgentContextSchema.parse({
    ...value,
    displayName: value.display_name,
    memoryStores: value.memory_stores,
  });
}
const base = {
  objective: "Synthetic objective",
  turnType: "single",
  deliveryMethod: "role-play",
};
it("matches Python's full SHA-256 seeded MT19937 choice for 1,028 texts including Unicode", () => {
  for (const fixture of goldens.techniques) {
    const objective = GeneratedObjectiveSchema.parse({
      ...base,
      objective: fixture.text,
    });
    expect(
      createStrategyFromObjective("ASI01", objective).attackTechnique,
    ).toBe(AttackTechniqueSchema.parse(fixture.expected));
  }
});
for (const fixture of goldens.strategies)
  it(`matches generated saved record ${fixture.index}/${fixture.category}/${fixture.turn}`, () => {
    const result = createStrategyFromObjective(
      fixture.category,
      GeneratedObjectiveSchema.parse(fixture.value),
      {
        turnType:
          fixture.turn === null ? null : TurnTypeSchema.parse(fixture.turn),
        objectiveIndex: fixture.index,
        vulnerability:
          fixture.vulnerability === null
            ? null
            : VulnerabilitySchema.parse(fixture.vulnerability),
      },
    );
    expect(result).toEqual(AttackStrategySchema.parse(fixture.expected));
  });
for (const [index, fixture] of goldens.prompts.entries())
  it(`matches untruncated objective prompt ${index}`, () => {
    expect(
      buildObjectivePrompt(
        contextOf(fixture.context),
        "Name",
        "ASI01",
        fixture.turn === null ? null : TurnTypeSchema.parse(fixture.turn),
        5,
        "Operator {count}",
      ),
    ).toBe(fixture.expected);
  });
for (const [index, fixture] of goldens.fill.entries())
  it(`matches attack template substitution ${index}`, () => {
    expect(fillTemplate(fixture.template, contextOf(fixture.context))).toBe(
      fixture.expected,
    );
  });
function response(value: unknown) {
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
for (const fixture of goldens.flows)
  it(`matches Python generation batch flow ${fixture.label}`, async () => {
    const requests: Record<string, unknown>[] = [];
    const pending = [...fixture.queue];
    const client = {
      baseURL: "https://native.test",
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            return response({ objectives: pending.shift() });
          },
        },
      },
    } as unknown as OpenAI;
    const result = await generateObjectivesForCategory(
      fixture.category,
      contextOf(fixture.context),
      client,
      {
        model: "echo",
        count: fixture.count,
        turnType:
          fixture.turn === null ? null : TurnTypeSchema.parse(fixture.turn),
        pipelineConfig: new LLMConfig({ maxObjectivesPerLlmCall: fixture.cap }),
      },
    );
    expect(result).toEqual(
      fixture.expected.map((value) => GeneratedObjectiveSchema.parse(value)),
    );
    expect(
      requests.map((request) => ({
        messages: request.messages,
        model: request.model,
      })),
    ).toEqual(fixture.calls);
  });
it("filters generated tool and memory requirements without renumbering original objective indices", () => {
  const objectives = [
    GeneratedObjectiveSchema.parse({ ...base, requiresTools: true }),
    GeneratedObjectiveSchema.parse({
      ...base,
      objective: "Memory",
      requiresMemory: true,
    }),
    GeneratedObjectiveSchema.parse({ ...base, objective: "Plain" }),
  ];
  const result = objectivesToStrategies(
    objectives,
    AgentContextSchema.parse({ key: "empty" }),
    "ASI01",
  );
  expect(result).toHaveLength(1);
  expect(result[0]?.name).toStartWith("generated_single_03_");
});
it("forces generated strategy turn type and leaves unresolved categories unmapped", async () => {
  const client = {
    chat: {
      completions: {
        create: async () =>
          response({
            objectives: [
              {
                objective: "Plain",
                turn_type: "single",
                delivery_method: "direct-request",
              },
            ],
          }),
      },
    },
  } as unknown as OpenAI;
  const result = await generateStrategiesForCategory(
    "future",
    AgentContextSchema.parse({ key: "empty" }),
    client,
    { model: "echo", turnType: "multi" },
  );
  expect(result[0]).toMatchObject({
    category: "future",
    vulnerability: null,
    turnType: "multi",
    isGenerated: true,
  });
});
it("retries HTTP content filters to the configured ceiling, then returns no objectives", async () => {
  let calls = 0;
  const error = Object.assign(new Error("filtered"), {
    status: 400,
    code: "content_filter",
  });
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
  expect(
    await generateObjectivesForCategory(
      "ASI01",
      AgentContextSchema.parse({ key: "empty" }),
      client,
      {
        model: "echo",
        pipelineConfig: new LLMConfig({ maxContentFilterRetries: 1 }),
      },
    ),
  ).toEqual([]);
  expect(calls).toBe(2);
});
it("propagates non-filter API failures and cancellation", async () => {
  const error = Object.assign(new Error("forbidden"), { status: 403 });
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
    generateObjectivesForCategory(
      "ASI01",
      AgentContextSchema.parse({ key: "empty" }),
      client,
      { model: "echo" },
    ),
  ).rejects.toBe(error);
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    generateObjectivesForCategory(
      "ASI01",
      AgentContextSchema.parse({ key: "empty" }),
      client,
      { model: "echo", signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("regenerates a 200-form content filter before parsing, then accepts a complete response", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          const reply = response({
            objectives: [
              {
                objective: "Plain",
                turn_type: "single",
                delivery_method: "direct-request",
              },
            ],
          });
          if (calls++ === 0) reply.choices[0].finish_reason = "content_filter";
          return reply;
        },
      },
    },
  } as unknown as OpenAI;
  const result = await generateObjectivesForCategory(
    "ASI01",
    AgentContextSchema.parse({ key: "empty" }),
    client,
    { model: "echo" },
  );
  expect(calls).toBe(2);
  expect(result).toHaveLength(1);
});
it("bounds exhausted 200-form content filters by the configured regeneration count", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          return {
            model: "echo",
            choices: [
              { finish_reason: "content_filter", message: { content: null } },
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
  expect(
    await generateObjectivesForCategory(
      "ASI01",
      AgentContextSchema.parse({ key: "empty" }),
      client,
      {
        model: "echo",
        pipelineConfig: new LLMConfig({ maxContentFilterRetries: 1 }),
      },
    ),
  ).toEqual([]);
  expect(calls).toBe(2);
});
