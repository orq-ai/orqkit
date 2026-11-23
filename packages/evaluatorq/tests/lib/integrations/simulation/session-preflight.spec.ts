import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listManifests } from "../../../../src/lib/common/run-manifest.js";
import { LLMCallConfig } from "../../../../src/lib/contracts.js";
import { OrqResponsesTarget } from "../../../../src/lib/integrations/openresponses/target.js";
import {
  generateAndSimulate,
  simulate,
} from "../../../../src/lib/integrations/simulation/simulation/index.js";
import { makeFakeClient } from "./fake-client.js";

const persona = {
  name: "Fixture",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual" as const,
  background: "fixture",
};
const scenario = { name: "Fixture", goal: "Say hello", criteria: [] };
const datapoint = {
  id: "fixture",
  persona,
  scenario,
  first_message: "Hello",
  user_system_prompt: "fixture",
};
const usage = () => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});
const userSimulator = {
  updateContext() {},
  resetUsage() {},
  getUsage: usage,
  generateFirstMessage: async () => "Hello",
  respondAsync: async () => "Again",
};
const judge = {
  resetUsage() {},
  getUsage: usage,
  evaluate: async () => ({
    should_terminate: true,
    reason: "done",
    goal_achieved: true,
    goal_completion_score: 1,
    rules_broken: [],
    criteria_verdicts: [],
  }),
};

test("missing credentials create no run manifests while post-start failures remain recorded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eq-sim-preflight-"));
  const names = ["ORQ_API_KEY", "OPENAI_API_KEY", "EVALUATORQ_DIR"] as const;
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  delete process.env.ORQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.EVALUATORQ_DIR = directory;
  const common = { save: true, uploadResults: false, hooks: [] };
  try {
    await expect(
      simulate({
        ...common,
        datapoints: [datapoint],
        targetCallback: async () => "reply",
      }),
    ).rejects.toThrow("Set ORQ_API_KEY or OPENAI_API_KEY");
    await expect(
      generateAndSimulate({
        ...common,
        agentDescription: "fixture",
        targetCallback: async () => "reply",
      }),
    ).rejects.toThrow("Set ORQ_API_KEY or OPENAI_API_KEY");
    for (const key of [undefined, "openai-fixture-key"]) {
      if (key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = key;
      for (const target of ["agent:fixture", "fixture"])
        await expect(
          simulate({
            ...common,
            userSimulator,
            judge,
            target,
            datapoints: [datapoint],
          }),
        ).rejects.toThrow("ORQ routing is required");
    }
    delete process.env.OPENAI_API_KEY;
    for (const target of ["", "agent: ", "unknown:fixture"]) {
      await expect(
        simulate({
          ...common,
          target,
          userSimulator,
          judge,
          datapoints: [datapoint],
        }),
      ).rejects.toThrow(
        target.startsWith("unknown:")
          ? "Unsupported simulation target kind"
          : "agentKey must be a non-empty string",
      );
    }
    expect(existsSync(join(directory, "sim-runs", ".manifests"))).toBe(false);

    const { client } = makeFakeClient();
    await expect(
      simulate({
        ...common,
        client,
        datapoints: [datapoint],
        maxTargetRetries: 0,
        targetCallback: async () => {
          throw new Error("post-start target failure");
        },
      }),
    ).rejects.toThrow();
    const manifests = await listManifests(join(directory, "sim-runs"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.status).toBe("error");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a prepared Orq target keeps its supplied client without requiring environment credentials", async () => {
  const saved = [process.env.ORQ_API_KEY, process.env.OPENAI_API_KEY];
  delete process.env.ORQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { client } = makeFakeClient();
  const target = new OrqResponsesTarget(
    new LLMCallConfig({ model: "agent/fixture" }),
    {
      client,
      requireOrq: true,
    },
  );
  try {
    const results = await simulate({
      target,
      userSimulator,
      judge,
      datapoints: [datapoint],
      hooks: [],
      uploadResults: false,
      save: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.terminated_by).toBe("judge");
    expect(results[0]?.goal_achieved).toBe(true);
  } finally {
    for (const [index, key] of ["ORQ_API_KEY", "OPENAI_API_KEY"].entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
