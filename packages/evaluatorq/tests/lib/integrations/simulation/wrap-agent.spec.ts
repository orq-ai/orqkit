import { describe, expect, test } from "bun:test";

import { wrapSimulationAgent } from "../../../../src/lib/integrations/simulation/wrap-agent.js";
import type { DataPoint } from "../../../../src/lib/types.js";
import { finishTurn, makeFakeClient } from "./fake-client.js";

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

const callback = async () => "response";

describe("wrapSimulationAgent", () => {
  test("uses a first_message given next to persona + scenario", async () => {
    const { client, requests } = makeFakeClient();
    const seen: string[] = [];
    const job = wrapSimulationAgent({
      targetCallback: async (messages) => {
        seen.push(messages[0]?.content ?? "");
        return "reply";
      },
      client,
      maxTurns: 1,
    });

    await job(
      {
        inputs: {
          persona: samplePersona,
          scenario: sampleScenario,
          first_message: "from the dataset",
        },
      } as unknown as DataPoint,
      0,
    );

    expect(seen).toEqual(["from the dataset"]);
    expect(requests.firstMessage).toHaveLength(0);
  });

  test("generates a first message when the given one is blank", async () => {
    const { client, requests } = makeFakeClient();
    const job = wrapSimulationAgent({
      targetCallback: callback,
      client,
      maxTurns: 1,
    });

    await job(
      {
        inputs: {
          persona: samplePersona,
          scenario: sampleScenario,
          first_message: "   ",
        },
      } as unknown as DataPoint,
      0,
    );

    expect(requests.firstMessage).toHaveLength(1);
  });

  test.each([
    ["a scenario that is a string", { scenario: "not an object" }],
    ["a persona that is a string", { persona: "not an object" }],
    ["a scenario without a goal", { scenario: { name: "S" } }],
  ])("rejects a datapoint with %s", async (_label, bad) => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({
      targetCallback: callback,
      client,
      maxTurns: 1,
    });

    await expect(
      job(
        {
          inputs: { datapoint: { ...sampleDatapoint, ...bad } },
        } as unknown as DataPoint,
        0,
      ),
    ).rejects.toThrow("datapoint");
  });

  test("honours timeoutPerSimulation", async () => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({
      targetCallback: () => new Promise<string>(() => {}),
      client,
      timeoutPerSimulation: 5,
    });

    const pair = await job(
      { inputs: { datapoint: sampleDatapoint } } as unknown as DataPoint,
      0,
    );

    expect(pair.error).toContain("timed out");
  });

  test("decodes inputs stored as JSON strings", async () => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({
      targetCallback: callback,
      client,
      maxTurns: 1,
    });

    const pair = await job(
      {
        inputs: {
          persona: JSON.stringify(samplePersona),
          scenario: JSON.stringify(sampleScenario),
        },
      } as unknown as DataPoint,
      0,
    );
    const single = await job(
      {
        inputs: { datapoint: JSON.stringify(sampleDatapoint) },
      } as unknown as DataPoint,
      0,
    );

    expect(pair.error).toBeUndefined();
    expect(single.error).toBeUndefined();
  });

  test("1. persona + scenario → generates a first message and runs", async () => {
    const { client, requests } = makeFakeClient({
      firstMessage: () => "generated opener",
    });
    const seen: string[] = [];
    const job = wrapSimulationAgent({
      client,
      targetCallback: async (messages) => {
        seen.push(messages[0]?.content ?? "");
        return "response";
      },
    });

    await job(
      { inputs: { persona: samplePersona, scenario: sampleScenario } },
      0,
    );

    expect(requests.firstMessage).toHaveLength(1);
    expect(seen).toEqual(["generated opener"]);
  });

  test("2. datapoint input → uses its first message", async () => {
    const { client, requests } = makeFakeClient();
    const seen: string[] = [];
    const job = wrapSimulationAgent({
      client,
      targetCallback: async (messages) => {
        seen.push(messages[0]?.content ?? "");
        return "response";
      },
    });

    await job({ inputs: { datapoint: sampleDatapoint } }, 0);

    expect(requests.firstMessage).toHaveLength(0);
    expect(seen).toEqual(["I want a refund!"]);
  });

  test("3. datapoints with one entry runs", async () => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({ client, targetCallback: callback });

    const result = await job({ inputs: { datapoints: [sampleDatapoint] } }, 0);

    expect(result.error).toBeUndefined();
  });

  test("4. personas + scenarios with one entry each runs", async () => {
    const { client, requests } = makeFakeClient();
    const job = wrapSimulationAgent({ client, targetCallback: callback });

    await job(
      { inputs: { personas: [samplePersona], scenarios: [sampleScenario] } },
      0,
    );

    expect(requests.firstMessage).toHaveLength(1);
  });

  test("5. returns { name, output } with OpenResponses format", async () => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({
      client,
      targetCallback: callback,
      name: "my-sim",
    });

    const result = await job({ inputs: { datapoint: sampleDatapoint } }, 0);

    expect(result.name).toBe("my-sim");
    const output = result.output as Record<string, unknown>;
    expect(output.object).toBe("response");
    expect(output.metadata).toMatchObject({ framework: "simulation" });
  });

  test("6. default name is 'simulation'", async () => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({ client, targetCallback: callback });

    const result = await job({ inputs: { datapoint: sampleDatapoint } }, 0);

    expect(result.name).toBe("simulation");
  });

  test("7. evaluators option → throws", () => {
    expect(() =>
      wrapSimulationAgent({
        targetCallback: callback,
        evaluators: ["goal_achieved"],
      } as never),
    ).toThrow("no longer takes 'evaluators'");
  });

  test("8. no targetCallback and no agentKey → throws", async () => {
    const job = wrapSimulationAgent({});

    const data: DataPoint = {
      inputs: { persona: samplePersona, scenario: sampleScenario },
    };

    await expect(job(data, 0)).rejects.toThrow(
      "wrapSimulationAgent requires either targetCallback or agentKey",
    );
  });

  test("9. missing persona/scenario/datapoint → throws", async () => {
    const job = wrapSimulationAgent({ targetCallback: callback });

    await expect(job({ inputs: {} }, 0)).rejects.toThrow(
      "Expected data.inputs to contain",
    );
  });

  test("10. more than one datapoint in a row → throws", async () => {
    const job = wrapSimulationAgent({ targetCallback: callback });

    await expect(
      job({ inputs: { datapoints: [sampleDatapoint, sampleDatapoint] } }, 0),
    ).rejects.toThrow("must encode exactly one datapoint, got 2");
  });

  test("11. more than one persona in a row → throws", async () => {
    const job = wrapSimulationAgent({ targetCallback: callback });

    await expect(
      job(
        {
          inputs: {
            personas: [samplePersona, samplePersona],
            scenarios: [sampleScenario],
          },
        },
        0,
      ),
    ).rejects.toThrow("must encode exactly one datapoint, got 2");
  });

  test("12. maxTurns and model reach the run", async () => {
    let turns = 0;
    const { client, requests } = makeFakeClient({
      judge: () => {
        turns++;
        return {
          tool: "continue_conversation",
          args: { reason: "more", criteria_verdicts: [] },
        };
      },
    });
    const job = wrapSimulationAgent({
      client,
      targetCallback: callback,
      maxTurns: 2,
      model: "test/model",
    });

    const result = await job({ inputs: { datapoint: sampleDatapoint } }, 0);

    expect(turns).toBe(2);
    expect(requests.judge[0]?.model).toBe("test/model");
    expect((result.output as Record<string, unknown>).model).toBe("test/model");
  });

  test("13. a failed run surfaces as a job error with its output", async () => {
    const { client } = makeFakeClient();
    const job = wrapSimulationAgent({
      client,
      targetCallback: async () => {
        throw new Error("target is down");
      },
    });

    const result = await job({ inputs: { datapoint: sampleDatapoint } }, 0);

    expect(result.error).toBe("target is down");
    expect((result.output as Record<string, unknown>).object).toBe("response");
  });

  test("14. a failed first message fails only that row", async () => {
    const { client, requests } = makeFakeClient({
      firstMessage: () => {
        throw new Error("generator down");
      },
    });
    const job = wrapSimulationAgent({ client, targetCallback: callback });

    const result = await job(
      { inputs: { persona: samplePersona, scenario: sampleScenario } },
      0,
    );

    expect(result.error).toContain("generator down");
    expect(requests.judge).toHaveLength(0);
  });

  test("15. a successful run has no error", async () => {
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });
    const job = wrapSimulationAgent({ client, targetCallback: callback });

    const result = await job({ inputs: { datapoint: sampleDatapoint } }, 0);

    expect(result.error).toBeUndefined();
  });
});
