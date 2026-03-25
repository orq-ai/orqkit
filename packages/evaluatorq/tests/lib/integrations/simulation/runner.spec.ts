import { describe, expect, test } from "bun:test";

import { SimulationRunner } from "../../../../src/lib/integrations/simulation/runner/simulation.js";
import type { ChatMessage } from "../../../../src/lib/integrations/simulation/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyCallback = async (_msgs: ChatMessage[]) => "Agent response";

function makeDatapoint(overrides: Record<string, unknown> = {}) {
  return {
    id: "dp_test",
    persona: {
      name: "Test User",
      patience: 0.5,
      assertiveness: 0.5,
      politeness: 0.5,
      technical_level: 0.5,
      communication_style: "casual" as const,
      background: "Test background",
    },
    scenario: {
      name: "Test Scenario",
      goal: "Test goal",
      context: "Test context",
      starting_emotion: "neutral" as const,
      criteria: [],
    },
    user_system_prompt: "You are a simulated user.",
    first_message: "Hello, I need help.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("SimulationRunner constructor", () => {
  test("throws if no targetAgent or targetCallback", () => {
    expect(() => new SimulationRunner({} as never)).toThrow(
      "Must provide either targetAgent or targetCallback",
    );
  });

  test("throws if maxTurns < 1", () => {
    expect(
      () =>
        new SimulationRunner({
          targetCallback: dummyCallback,
          maxTurns: 0,
        }),
    ).toThrow("maxTurns must be >= 1");
  });

  test("throws if model is empty string", () => {
    expect(
      () =>
        new SimulationRunner({
          targetCallback: dummyCallback,
          model: "  ",
        }),
    ).toThrow("model must be a non-empty string");
  });

  test("accepts valid config", () => {
    const runner = new SimulationRunner({
      targetCallback: dummyCallback,
    });
    expect(runner).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// run() — never-throws contract
// ---------------------------------------------------------------------------

describe("SimulationRunner.run() never-throws contract", () => {
  test("returns error result when ORQ_API_KEY is missing", async () => {
    const originalKey = process.env.ORQ_API_KEY;
    delete process.env.ORQ_API_KEY;

    try {
      const runner = new SimulationRunner({
        targetCallback: dummyCallback,
      });
      const result = await runner.run({ datapoint: makeDatapoint() });

      // Should NOT throw — should return an error SimulationResult
      expect(result.terminated_by).toBe("error");
      expect(result.reason).toContain("ORQ_API_KEY");
    } finally {
      if (originalKey) {
        process.env.ORQ_API_KEY = originalKey;
      }
    }
  });

  test("returns error result when neither datapoint nor persona+scenario", async () => {
    const runner = new SimulationRunner({
      targetCallback: dummyCallback,
    });
    const result = await runner.run({});

    expect(result.terminated_by).toBe("error");
    expect(result.reason).toContain(
      "Must provide either datapoint or both persona and scenario",
    );
  });

  test("returns error result when only persona provided (no scenario)", async () => {
    const runner = new SimulationRunner({
      targetCallback: dummyCallback,
    });
    const result = await runner.run({
      persona: makeDatapoint().persona,
    });

    expect(result.terminated_by).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// runWithTimeout
// ---------------------------------------------------------------------------

describe("SimulationRunner.runBatch()", () => {
  test("returns error results for empty ORQ_API_KEY", async () => {
    const originalKey = process.env.ORQ_API_KEY;
    delete process.env.ORQ_API_KEY;

    try {
      const runner = new SimulationRunner({
        targetCallback: dummyCallback,
      });
      const results = await runner.runBatch({
        datapoints: [makeDatapoint()],
        timeoutPerSimulation: 5000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.terminated_by).toBe("error");
    } finally {
      if (originalKey) {
        process.env.ORQ_API_KEY = originalKey;
      }
    }
  });

  test("handles empty datapoints array", async () => {
    const runner = new SimulationRunner({
      targetCallback: dummyCallback,
    });
    const results = await runner.runBatch({
      datapoints: [],
    });

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("SimulationRunner.close()", () => {
  test("can be called safely when no client was created", async () => {
    const runner = new SimulationRunner({
      targetCallback: dummyCallback,
    });
    // Should not throw
    await runner.close();
  });

  test("can be called multiple times", async () => {
    const runner = new SimulationRunner({
      targetCallback: dummyCallback,
    });
    await runner.close();
    await runner.close();
  });
});
