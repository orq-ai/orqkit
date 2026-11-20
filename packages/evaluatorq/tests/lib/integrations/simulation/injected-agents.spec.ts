import { expect, test } from "bun:test";

import { DefaultHooks } from "../../../../src/lib/integrations/simulation/hooks.js";
import {
  type SimulationJudge,
  SimulationRunner,
  type SimulationUserSimulator,
} from "../../../../src/lib/integrations/simulation/runner/simulation.js";
import type {
  Datapoint,
  Judgment,
  TokenUsage,
} from "../../../../src/lib/integrations/simulation/types.js";

const usage = (): TokenUsage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});
const finished = (): Judgment => ({
  should_terminate: true,
  reason: "done",
  goal_achieved: true,
  goal_completion_score: 1,
  rules_broken: [],
  criteria_verdicts: [],
});
const datapoint: Datapoint = {
  id: "injected",
  persona: {
    name: "P",
    patience: 0.5,
    assertiveness: 0.5,
    politeness: 0.5,
    technical_level: 0.5,
    communication_style: "casual",
    background: "test",
  },
  scenario: { name: "S", goal: "test", criteria: [] },
  first_message: "hello",
  user_system_prompt: "test",
};

class PrivateUser implements SimulationUserSimulator {
  #calls = 0;
  resetUsage() {
    this.#calls = 0;
  }
  getUsage() {
    return { ...usage(), total_tokens: this.#calls };
  }
  updateContext() {
    this.#calls++;
  }
  async generateFirstMessage() {
    this.#calls++;
    return "hello";
  }
  async respondAsync() {
    this.#calls++;
    return "again";
  }
}
class PrivateJudge implements SimulationJudge {
  #calls = 0;
  resetUsage() {
    this.#calls = 0;
  }
  getUsage() {
    return usage();
  }
  async evaluate() {
    await Bun.sleep(2);
    expect(++this.#calls).toBe(1);
    return finished();
  }
}

test("runs shared injected agents with native private state without overlapping resets", async () => {
  const userSimulator = new PrivateUser(),
    judge = new PrivateJudge();
  const runners = [1, 2].map(
    () =>
      new SimulationRunner({
        userSimulator,
        judge,
        targetCallback: async () => "reply",
      }),
  );
  const results = await Promise.all(
    runners.map((runner) => runner.runWithTimeout(datapoint, 1, 500)),
  );
  expect(results.map((r) => r.terminated_by)).toEqual(["judge", "judge"]);
});

test("times out a hanging judge, preserves the transcript, and keeps its shared instance reserved", async () => {
  let finish!: (value: Judgment) => void;
  const pending = new Promise<Judgment>((resolve) => {
    finish = resolve;
  });
  let resets = 0;
  const judge: SimulationJudge = {
    resetUsage() {
      resets++;
    },
    getUsage: usage,
    evaluate: () => pending,
  };
  const runner = new SimulationRunner({
    userSimulator: new PrivateUser(),
    judge,
    targetCallback: async () => "reply",
  });
  try {
    const result = await Promise.race([
      runner.runWithTimeout(datapoint, 1, 10),
      Bun.sleep(250).then(() => null),
    ]);
    expect(result?.terminated_by).toBe("timeout");
    expect(result?.messages.map((m) => m.content)).toEqual(["hello", "reply"]);
    const waiting = await Promise.race([
      runner.runWithTimeout(datapoint, 1, 10),
      Bun.sleep(250).then(() => null),
    ]);
    expect(waiting?.terminated_by).toBe("timeout");
    expect(resets).toBe(1);
  } finally {
    finish(finished());
  }
  await Bun.sleep(1);
  expect((await runner.runWithTimeout(datapoint, 1, 100)).terminated_by).toBe(
    "judge",
  );
});

test("returns the deadline when an injected simulator or an async hook never settles", async () => {
  for (const kind of ["simulator", "hook"] as const) {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const userSimulator = new PrivateUser();
    if (kind === "simulator")
      userSimulator.respondAsync = async () => {
        await pending;
        return "late";
      };
    class Hooks extends DefaultHooks {
      override async onTurnComplete() {
        if (kind === "hook") await pending;
      }
    }
    const judge: SimulationJudge = {
      resetUsage() {},
      getUsage: usage,
      evaluate: async () => ({ ...finished(), should_terminate: false }),
    };
    const runner = new SimulationRunner({
      userSimulator,
      judge,
      hooks: new Hooks(),
      targetCallback: async () => "reply",
    });
    try {
      const result = await Promise.race([
        runner.runWithTimeout(datapoint, 2, 10),
        Bun.sleep(250).then(() => null),
      ]);
      expect(result?.terminated_by).toBe("timeout");
      expect(result?.messages).toHaveLength(2);
    } finally {
      release();
    }
  }
});

test("a hanging completion hook cannot erase a completed criterion audit", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Hooks extends DefaultHooks {
    override async onTurnComplete() {
      await pending;
    }
  }
  const judge: SimulationJudge = {
    resetUsage() {},
    getUsage: usage,
    evaluate: async () => ({
      ...finished(),
      criteria_verdicts: [
        { criterion_id: "criteria_0", occurred: true, evidence: "reply" },
      ],
    }),
  };
  const runner = new SimulationRunner({
    userSimulator: new PrivateUser(),
    judge,
    hooks: new Hooks(),
    targetCallback: async () => "reply",
  });
  try {
    const result = await runner.runWithTimeout(
      {
        ...datapoint,
        scenario: {
          ...datapoint.scenario,
          criteria: [{ description: "No reply", type: "must_not_happen" }],
        },
      },
      1,
      10,
    );
    expect(result.terminated_by).toBe("timeout");
    expect(result.rules_broken).toEqual(["criteria_0"]);
    expect(result.criteria_verified).toBe(true);
  } finally {
    release();
  }
});
