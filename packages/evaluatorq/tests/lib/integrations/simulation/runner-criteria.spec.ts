import { describe, expect, spyOn, test } from "bun:test";

import { resolveLLMMaxTokens } from "../../../../src/lib/integrations/simulation/defaults.js";
import {
  criteriaMetScorer,
  failureReason,
} from "../../../../src/lib/integrations/simulation/evaluators/index.js";
import { SimulationRunner } from "../../../../src/lib/integrations/simulation/runner/simulation.js";
import type {
  Datapoint,
  Scenario,
} from "../../../../src/lib/integrations/simulation/types.js";
import {
  continueTurn,
  type FakeScript,
  finishTurn,
  makeFakeClient,
} from "./fake-client.js";

const scenario: Scenario = {
  name: "Refund",
  goal: "Get a refund",
  criteria: [
    { description: "offers a refund", type: "must_happen" },
    { description: "insults the user", type: "must_not_happen" },
  ],
};

const datapoint: Datapoint = {
  id: "dp",
  persona: {
    name: "Test User",
    patience: 0.5,
    assertiveness: 0.5,
    politeness: 0.5,
    technical_level: 0.5,
    communication_style: "casual",
    background: "bg",
  },
  scenario,
  user_system_prompt: "You are a simulated user.",
  first_message: "I want a refund",
};

const occurred = (id: string) => ({
  criterion_id: id,
  occurred: true,
  evidence: "quote",
});
const notOccurred = (id: string) => ({ criterion_id: id, occurred: false });

function runWith(script: FakeScript, maxTurns = 5) {
  const { client, requests } = makeFakeClient(script);
  const runner = new SimulationRunner({
    targetCallback: async () => "target reply",
    client,
    maxTurns,
  });
  return { result: runner.run({ datapoint }), requests };
}

describe("SimulationRunner criteria", () => {
  test("a must_happen seen on an earlier turn still passes at the end", async () => {
    const { result } = runWith({
      judge: (call) =>
        call === 0
          ? continueTurn([occurred("criteria_0"), notOccurred("criteria_1")])
          : finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });

    const r = await result;
    expect(r.terminated_by).toBe("judge");
    expect(r.rules_broken).toEqual([]);
    expect(r.criteria_verified).toBe(true);
    expect(r.criteria_results).toEqual({
      "offers a refund": true,
      "insults the user": true,
    });
    expect(criteriaMetScorer(r)).toBe(1);
  });

  test("a must_happen that never occurred fails even when the goal is met", async () => {
    const { result } = runWith({
      judge: () =>
        finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });

    const r = await result;
    expect(r.goal_achieved).toBe(true);
    expect(r.rules_broken).toEqual(["criteria_0"]);
    expect(criteriaMetScorer(r)).toBe(0.5);
  });

  test("a must_not_happen that occurred stays broken after later clean turns", async () => {
    const { result } = runWith({
      judge: (call) =>
        call === 0
          ? continueTurn([occurred("criteria_0"), occurred("criteria_1")])
          : finishTurn([notOccurred("criteria_1")]),
    });

    const r = await result;
    expect(r.rules_broken).toEqual(["criteria_1"]);
    expect(r.criteria_results?.["insults the user"]).toBe(false);
  });

  test("max_turns results carry criteria data and the last goal score", async () => {
    const { result } = runWith(
      {
        judge: () =>
          continueTurn([occurred("criteria_0"), notOccurred("criteria_1")], {
            goal_completion_score: 0.4,
          }),
      },
      2,
    );

    const r = await result;
    expect(r.terminated_by).toBe("max_turns");
    expect(r.goal_completion_score).toBe(0.4);
    expect(r.criteria_verified).toBe(true);
    expect(r.criteria_results).toEqual({
      "offers a refund": true,
      "insults the user": true,
    });
    expect(r.metadata.criteria_meta).toHaveLength(2);
  });

  test("an error reports only confirmed breaks and scores 0", async () => {
    const { result } = runWith({
      judge: (call) => {
        if (call === 0) {
          return continueTurn([
            notOccurred("criteria_0"),
            occurred("criteria_1"),
          ]);
        }
        throw new Error("judge exploded");
      },
    });

    const r = await result;
    expect(r.terminated_by).toBe("error");
    expect(r.rules_broken).toEqual(["criteria_1"]);
    expect(r.criteria_verified).toBe(true);
    expect(criteriaMetScorer(r)).toBe(0);
  });

  test("a judge that never calls a tool leaves the run unverified", async () => {
    const { result } = runWith({ judge: () => null });

    const r = await result;
    expect(r.criteria_verified).toBe(false);
    expect(criteriaMetScorer(r)).toBe(0);
  });

  test("verdicts that all fail validation leave the run unverified", async () => {
    const { result } = runWith({
      judge: () =>
        finishTurn([
          occurred("criteria_7"),
          occurred("criteria_00"),
          { criterion_id: "criteria_0", occurred: "yes" },
        ]),
    });

    const r = await result;
    expect(r.criteria_verified).toBe(false);
    expect(criteriaMetScorer(r)).toBe(0);
  });

  test("a duplicate verdict keeps the last entry", async () => {
    const lastOccurred = runWith({
      judge: () =>
        finishTurn([
          notOccurred("criteria_0"),
          occurred("criteria_0"),
          notOccurred("criteria_1"),
        ]),
    });
    const lastNotOccurred = runWith({
      judge: () =>
        finishTurn([
          occurred("criteria_0"),
          notOccurred("criteria_0"),
          notOccurred("criteria_1"),
        ]),
    });

    expect((await lastOccurred.result).rules_broken).toEqual([]);
    expect((await lastNotOccurred.result).rules_broken).toEqual(["criteria_0"]);
  });

  test("a criterion the judge skipped is not met, and is marked unaudited", async () => {
    const { result } = runWith({
      judge: () => finishTurn([occurred("criteria_0")]),
    });

    const r = await result;
    expect(r.criteria_verified).toBe(true);
    expect(r.metadata.criteria_meta).toMatchObject([
      { passed: true, audited: true },
      { passed: true, audited: false },
    ]);
    expect(criteriaMetScorer(r)).toBe(0.5);
  });

  test("malformed criteria fail the run instead of rejecting", async () => {
    const { client } = makeFakeClient();
    const runner = new SimulationRunner({
      targetCallback: async () => "reply",
      client,
    });

    const r = await runner.run({
      datapoint: {
        ...datapoint,
        scenario: { ...scenario, criteria: "x" as unknown as [] },
      },
    });

    expect(r.terminated_by).toBe("error");
    expect(criteriaMetScorer(r)).toBe(0);
  });
});

describe("SimulationRunner timeout", () => {
  test("reports the timeout rather than the cancellation", async () => {
    const { client } = makeFakeClient();
    const runner = new SimulationRunner({
      targetCallback: async () => {
        await Bun.sleep(30);
        return "late reply";
      },
      client,
      maxTurns: 5,
    });

    const r = await runner.runWithTimeout(datapoint, 5, 5);

    expect(r.terminated_by).toBe("timeout");
    expect(failureReason(r)).toBe("Simulation timed out after 5ms");
    expect(criteriaMetScorer(r)).toBe(0);
  });

  test("fires on a target that never answers", async () => {
    const { client } = makeFakeClient();
    const runner = new SimulationRunner({
      targetCallback: () => new Promise<string>(() => {}),
      client,
      maxTurns: 5,
    });

    const r = await runner.runWithTimeout(datapoint, 5, 5);

    expect(r.terminated_by).toBe("timeout");
    expect(failureReason(r)).toBe("Simulation timed out after 5ms");
  });
});

describe("SimulationRunner judge requests", () => {
  test("forces a tool call with room for a full audit", async () => {
    const { result, requests } = runWith({
      judge: () =>
        finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });
    await result;

    expect(requests.judge[0]?.tool_choice).toBe("required");
    expect(requests.judge[0]?.max_output_tokens).toBe(10000);
    expect(requests.judge[0]?.temperature).toBe(0);
    expect(requests.judge[0]?.tools?.map((tool) => tool.name)).toEqual([
      "continue_conversation",
      "finish_conversation",
    ]);
    expect(
      requests.judge[0]?.tools?.every((tool) => tool.strict === false),
    ).toBe(true);
  });

  test("sends the verdict schema on both judge tools", async () => {
    const { result, requests } = runWith({
      judge: () =>
        finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });
    await result;

    for (const tool of requests.judge[0]?.tools ?? []) {
      expect(tool.parameters?.properties).toHaveProperty("criteria_verdicts");
    }
  });

  test("finds the tool call behind a reasoning item", async () => {
    const { result } = runWith({
      judge: () =>
        finishTurn([occurred("criteria_0"), notOccurred("criteria_1")]),
      judgeResponse: (reply) => ({
        ...reply,
        output: [{ type: "reasoning", summary: [] }, ...reply.output],
      }),
    });

    const r = await result;
    expect(r.terminated_by).toBe("judge");
    expect(criteriaMetScorer(r)).toBe(1);
  });

  test("a failed Responses call fails the run", async () => {
    const { result } = runWith({
      judgeResponse: (reply) => ({
        ...reply,
        status: "failed",
        error: { code: "server_error", message: "provider fell over" },
        output: [],
      }),
    });

    const r = await result;
    expect(r.terminated_by).toBe("error");
    expect(failureReason(r)).toContain("provider fell over");
  });

  test("a truncated Responses call fails the run", async () => {
    const { result } = runWith({
      judgeResponse: (reply) => ({
        ...reply,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      }),
    });

    const r = await result;
    expect(r.terminated_by).toBe("error");
    expect(failureReason(r)).toContain("max_output_tokens");
    expect(r.token_usage?.total_tokens).toBe(5);
  });

  test("a Responses call stopped by a content filter fails the run", async () => {
    const { result } = runWith({
      judgeResponse: (reply) => ({
        ...reply,
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: [],
      }),
    });

    const r = await result;
    expect(r.terminated_by).toBe("error");
    expect(failureReason(r)).toContain("content_filter");
  });

  test("EVALUATORQ_LLM_MAX_TOKENS sets the agent budget", async () => {
    process.env.EVALUATORQ_LLM_MAX_TOKENS = "1234";
    try {
      const { result, requests } = runWith({
        judge: () => finishTurn([notOccurred("criteria_0")]),
      });
      await result;
      expect(requests.judge[0]?.max_output_tokens).toBe(1234);
    } finally {
      delete process.env.EVALUATORQ_LLM_MAX_TOKENS;
    }
  });

  test.each(["lots", "1e4", "0", "-5", "1.5", ""])(
    "EVALUATORQ_LLM_MAX_TOKENS=%j warns and uses the default",
    async (raw) => {
      process.env.EVALUATORQ_LLM_MAX_TOKENS = raw;
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { result, requests } = runWith({
          judge: () => finishTurn([notOccurred("criteria_0")]),
        });
        const r = await result;

        expect(r.terminated_by).toBe("judge");
        expect(requests.judge[0]?.max_output_tokens).toBe(10_000);
        const warnings = warn.mock.calls.filter((call) =>
          String(call[0]).includes("EVALUATORQ_LLM_MAX_TOKENS"),
        );
        expect(warnings).toHaveLength(1);
      } finally {
        warn.mockRestore();
        delete process.env.EVALUATORQ_LLM_MAX_TOKENS;
      }
    },
  );

  test("a bad output budget warns once, however many calls read it", () => {
    process.env.EVALUATORQ_LLM_MAX_TOKENS = "warn-me-once";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveLLMMaxTokens()).toBe(10_000);
      expect(resolveLLMMaxTokens()).toBe(10_000);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      delete process.env.EVALUATORQ_LLM_MAX_TOKENS;
    }
  });

  test("a truncated simulator turn fails the run", async () => {
    const targetSaw: string[] = [];
    const { client } = makeFakeClient({
      judge: () => continueTurn([notOccurred("criteria_0")]),
      userSimulator: () => ({ content: "half a sent", finishReason: "length" }),
    });
    const runner = new SimulationRunner({
      targetCallback: async (messages) => {
        targetSaw.push(messages.at(-1)?.content ?? "");
        return "reply";
      },
      client,
      maxTurns: 3,
    });

    const r = await runner.run({ datapoint });

    expect(r.terminated_by).toBe("error");
    expect(failureReason(r)).toContain("truncated");
    expect(failureReason(r)).toContain("10000");
    expect(targetSaw).toEqual(["I want a refund"]);
  });

  test("counts judge tokens reported by the Responses API", async () => {
    const { result } = runWith({
      judge: () =>
        finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });

    const r = await result;
    expect(r.token_usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  test("lists settled ids in the final message and keeps the system prompt static", async () => {
    const { result, requests } = runWith({
      judge: (call) =>
        call === 0
          ? continueTurn([occurred("criteria_0"), notOccurred("criteria_1")])
          : finishTurn([notOccurred("criteria_1")]),
    });
    await result;

    const [first, second] = requests.judge;
    expect(first?.input.at(-1)?.content).not.toContain("ALREADY CONFIRMED");
    expect(second?.input.at(-1)?.content).toContain(
      "ALREADY CONFIRMED (occurrence is settled, do not re-report these in criteria_verdicts): criteria_0",
    );
    expect(second?.input[0]?.content ?? "").toBe(
      first?.input[0]?.content ?? "",
    );
  });

  test("lists criteria by id with their type", async () => {
    const { result, requests } = runWith({
      judge: () =>
        finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });
    await result;

    const system = requests.judge[0]?.input[0]?.content as string;
    expect(system).toContain(
      "criteria_0: <data>offers a refund</data> (must_happen)",
    );
    expect(system).toContain(
      "criteria_1: <data>insults the user</data> (must_not_happen)",
    );
  });
});

describe("SimulationRunner user simulator requests", () => {
  test("sees the target's reply as a user turn", async () => {
    const { result, requests } = runWith({
      judge: (call) =>
        call === 0
          ? continueTurn([notOccurred("criteria_0"), notOccurred("criteria_1")])
          : finishTurn([notOccurred("criteria_0"), notOccurred("criteria_1")]),
    });
    await result;

    const messages = requests.userSimulator[0]?.messages ?? [];
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "target reply",
    });
    expect(messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "I want a refund",
    });
  });
});
