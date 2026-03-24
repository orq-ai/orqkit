import { describe, expect, mock, test } from "bun:test";

import type { SimulationResult } from "../../../../src/lib/integrations/simulation/types.js";
import type { DataPoint } from "../../../../src/lib/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSimulationResult(
  _overrides: Partial<SimulationResult> = {},
): SimulationResult {
  return {
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    terminated_by: "judge",
    reason: "Goal achieved",
    goal_achieved: true,
    goal_completion_score: 1.0,
    rules_broken: [],
    turn_count: 1,
    token_usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    turn_metrics: [],
    metadata: {},
  };
}

const samplePersona = {
  name: "Impatient User",
  patience: 0.2,
  assertiveness: 0.8,
  politeness: 0.3,
  technical_level: 0.5,
  communication_style: "terse" as const,
  background: "A busy professional",
};

const sampleScenario = {
  name: "Refund Request",
  goal: "Get a refund for order #123",
  context: "Customer ordered wrong item",
  starting_emotion: "frustrated" as const,
  criteria: [],
};

const sampleDatapoint = {
  id: "dp_test123",
  persona: samplePersona,
  scenario: sampleScenario,
  user_system_prompt: "You are simulating...",
  first_message: "I want a refund!",
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track calls to simulate()
let simulateCalls: unknown[] = [];

mock.module(
  "../../../../src/lib/integrations/simulation/simulation/index.js",
  () => ({
    simulate: mock(async (params: unknown) => {
      simulateCalls.push(params);
      return [makeSimulationResult()];
    }),
  }),
);

// Mock convert to isolate wrapper logic
mock.module("../../../../src/lib/integrations/simulation/convert.js", () => ({
  toOpenResponses: (result: SimulationResult, model?: string) => ({
    id: "resp_mock",
    object: "response",
    model: model ?? "simulation",
    status: "completed",
    input: [],
    output: [],
    metadata: { framework: "simulation", goal_achieved: result.goal_achieved },
  }),
}));

// Now import wrapper (after mocks)
const { wrapSimulationAgent } = await import(
  "../../../../src/lib/integrations/simulation/wrap-agent.js"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrapSimulationAgent", () => {
  // Reset call tracker before each test
  test("setup", () => {
    simulateCalls = [];
  });

  test("1. persona + scenario → calls simulate with correct params", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = {
      inputs: {
        persona: samplePersona,
        scenario: sampleScenario,
      },
    };

    await job(data, 0);

    expect(simulateCalls).toHaveLength(1);
    const call = simulateCalls[0] as Record<string, unknown>;
    expect(call.personas).toEqual([samplePersona]);
    expect(call.scenarios).toEqual([sampleScenario]);
    expect(call.datapoints).toBeUndefined();
  });

  test("2. datapoint input → calls simulate with datapoints", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = {
      inputs: { datapoint: sampleDatapoint },
    };

    await job(data, 0);

    expect(simulateCalls).toHaveLength(1);
    const call = simulateCalls[0] as Record<string, unknown>;
    expect(call.datapoints).toEqual([sampleDatapoint]);
    expect(call.personas).toBeUndefined();
    expect(call.scenarios).toBeUndefined();
  });

  test("3. datapoints array input → passes through", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = {
      inputs: { datapoints: [sampleDatapoint] },
    };

    await job(data, 0);

    const call = simulateCalls[0] as Record<string, unknown>;
    expect(call.datapoints).toEqual([sampleDatapoint]);
  });

  test("4. personas + scenarios arrays → passes through", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = {
      inputs: {
        personas: [samplePersona],
        scenarios: [sampleScenario],
      },
    };

    await job(data, 0);

    const call = simulateCalls[0] as Record<string, unknown>;
    expect(call.personas).toEqual([samplePersona]);
    expect(call.scenarios).toEqual([sampleScenario]);
  });

  test("5. returns { name, output } with OpenResponses format", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({
      targetCallback: callback,
      name: "my-sim",
    });

    const data: DataPoint = {
      inputs: { persona: samplePersona, scenario: sampleScenario },
    };

    const result = await job(data, 0);

    expect(result.name).toBe("my-sim");
    const output = result.output as Record<string, unknown>;
    expect(output.object).toBe("response");
    expect(output.metadata).toMatchObject({ framework: "simulation" });
  });

  test("6. default name is 'simulation'", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = {
      inputs: { persona: samplePersona, scenario: sampleScenario },
    };

    const result = await job(data, 0);
    expect(result.name).toBe("simulation");
  });

  test("7. passes maxTurns, model, evaluators to simulate", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({
      targetCallback: callback,
      maxTurns: 5,
      model: "gpt-4o",
      evaluators: ["goal_achieved"],
    });

    const data: DataPoint = {
      inputs: { persona: samplePersona, scenario: sampleScenario },
    };

    await job(data, 0);

    const call = simulateCalls[0] as Record<string, unknown>;
    expect(call.maxTurns).toBe(5);
    expect(call.model).toBe("gpt-4o");
    expect(call.evaluators).toEqual(["goal_achieved"]);
  });

  test("8. no targetCallback and no agentKey → throws", async () => {
    const job = wrapSimulationAgent({});

    const data: DataPoint = {
      inputs: { persona: samplePersona, scenario: sampleScenario },
    };

    expect(job(data, 0)).rejects.toThrow(
      "wrapSimulationAgent requires either targetCallback or agentKey",
    );
  });

  test("9. missing persona/scenario/datapoint → throws", async () => {
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = { inputs: {} };

    expect(job(data, 0)).rejects.toThrow("Expected data.inputs to contain");
  });

  test("10. passes targetCallback through to simulate", async () => {
    simulateCalls = [];
    const callback = async () => "response";
    const job = wrapSimulationAgent({ targetCallback: callback });

    const data: DataPoint = {
      inputs: { persona: samplePersona, scenario: sampleScenario },
    };

    await job(data, 0);

    const call = simulateCalls[0] as Record<string, unknown>;
    expect(call.targetCallback).toBe(callback);
  });
});
