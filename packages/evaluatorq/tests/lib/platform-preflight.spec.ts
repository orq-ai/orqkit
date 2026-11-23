import { afterEach, beforeEach, expect, test } from "bun:test";

import { Effect } from "effect";

import { evaluatorq, evaluatorqEffect } from "../../src/lib/evaluatorq.js";
import {
  generateAndSimulate,
  simulate,
} from "../../src/lib/integrations/simulation/simulation/index.js";

const names = ["ORQ_API_KEY", "ORQ_BASE_URL", "ROUTER_BASE_URL"];
let saved: Map<string, string | undefined>;
beforeEach(() => {
  saved = new Map(names.map((name) => [name, process.env[name]]));
  process.env.ORQ_API_KEY = "fixture-only";
  delete process.env.ORQ_BASE_URL;
  process.env.ROUTER_BASE_URL = "https://proxy.example/custom";
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
test("platform upload configuration is checked before evaluation or generation", async () => {
  let calls = 0;
  await expect(
    evaluatorq("preflight", {
      data: [{ inputs: {} }],
      jobs: [
        async () => {
          calls++;
          return { name: "fixture", output: "done" };
        },
      ],
      print: false,
      manageTracing: false,
    }),
  ).rejects.toThrow("set ORQ_BASE_URL explicitly");
  await expect(
    Effect.runPromise(
      evaluatorqEffect("preflight-effect", {
        data: [{ inputs: {} }],
        jobs: [
          async () => {
            calls++;
            return { name: "fixture", output: "done" };
          },
        ],
        print: false,
      }),
    ),
  ).rejects.toThrow("set ORQ_BASE_URL explicitly");
  const targetCallback = async () => {
    calls++;
    return "done";
  };
  await expect(
    simulate({ evaluationName: "preflight", datapoints: [], targetCallback }),
  ).rejects.toThrow("set ORQ_BASE_URL explicitly");
  await expect(
    generateAndSimulate({
      evaluationName: "preflight",
      agentDescription: "Fixture",
      targetCallback,
    }),
  ).rejects.toThrow("set ORQ_BASE_URL explicitly");
  expect(calls).toBe(0);
});
