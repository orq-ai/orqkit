import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import { setCliModels } from "../../../src/lib/common/model-roles.js";
import {
  LLMCallConfig,
  LLMCallConfigSchema,
} from "../../../src/lib/contracts.js";
import {
  attackerModelFor,
  EvaluatorConfig,
  type EvaluatorConfigInput,
  evaluatorModelFor,
  LLMConfig,
  type LLMConfigInput,
  RedTeamRecommendationConfig,
} from "../../../src/lib/redteam/index.js";
import fixtures from "../fixtures/redteam-config-python-goldens.json" with {
  type: "json",
};

let saved: Record<string, string | undefined>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  saved = {};
  for (const key of [
    "EVALUATORQ_FAST_MODEL",
    "EVALUATORQ_SMART_MODEL",
    "EVALUATORQ_MODEL_OVERRIDES",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  setCliModels();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setCliModels();
  warn.mockRestore();
});
function callJSON(config: LLMCallConfig) {
  const value = Object.fromEntries(
    Object.keys(LLMCallConfigSchema.shape).map((key) => [
      key,
      config[key as keyof LLMCallConfig],
    ]),
  );
  delete value.client;
  return value;
}
for (const [index, entry] of fixtures.evaluators.entries())
  it(`matches Python evaluator config case ${index}`, () => {
    if (entry.error)
      expect(
        () => new EvaluatorConfig(entry.value as EvaluatorConfigInput),
      ).toThrow();
    else {
      const config = new EvaluatorConfig(entry.value as EvaluatorConfigInput);
      expect(config.toJSON() as unknown).toEqual(entry.expected);
      expect(config.model).toBe(entry.model as string);
      expect([...config.fieldsSet].sort()).toEqual(entry.fieldsSet as string[]);
      expect(callJSON(config.asCallConfig()) as unknown).toEqual(entry.call);
    }
  });
for (const [index, entry] of fixtures.pipelines.entries())
  it(`matches Python pipeline config case ${index}`, () => {
    if (entry.error)
      expect(() => new LLMConfig(entry.value as LLMConfigInput)).toThrow();
    else {
      const config = new LLMConfig(entry.value as LLMConfigInput);
      expect(config.toJSON() as unknown).toEqual(entry.expected);
      expect([...config.attacker.fieldsSet].sort()).toEqual(
        entry.attackerFieldsSet as string[],
      );
      expect(config.retryAttempts).toBe(entry.retryAttempts as number);
    }
  });
it("matches recommendation limits and rejects unknown keys and invalid caps", () => {
  expect(new RedTeamRecommendationConfig() as unknown).toEqual(
    fixtures.recommendations,
  );
  expect(() => new RedTeamRecommendationConfig({ maxAreas: 0 })).toThrow();
  expect(
    () => new RedTeamRecommendationConfig({ condenseMaxTokens: 0 }),
  ).toThrow();
  expect(
    () => new RedTeamRecommendationConfig({ maxAreaPromptChars: 999 }),
  ).toThrow();
});
it("uses current task roles and preserves caller-set models and other fields", () => {
  setCliModels(
    { smart: "smart-new" },
    { "redteam.attacker": "attack-new", "redteam.evaluator": "judge-new" },
  );
  const base = new LLMCallConfig({ temperature: 0.7 });
  const config = new LLMConfig({ attacker: base });
  expect(config.attacker.model).toBe("attack-new");
  expect(config.attacker.temperature).toBe(0.7);
  expect(base.fieldsSet.has("model")).toBe(false);
  expect(config.evaluator.primaryModel).toBe("judge-new");
  expect(evaluatorModelFor(undefined, base)).toBe("judge-new");
  expect(evaluatorModelFor("explicit", config.evaluator)).toBe("explicit");
  expect(attackerModelFor()).toBe("attack-new");
  expect(
    attackerModelFor(
      undefined,
      new LLMConfig({ attacker: { model: "caller" } }),
    ),
  ).toBe("caller");
});
it("projects every shared call field and retains injected clients without serializing them", () => {
  const client = { apiKey: "synthetic-secret" };
  const config = new EvaluatorConfig({
    model: "judge",
    client,
    maxTokens: 4000,
    reasoningEffort: "low",
  });
  const call = config.asCallConfig();
  expect(call.client).toBe(client);
  expect(Object.keys(callJSON(call)).sort()).toEqual(
    Object.keys(LLMCallConfigSchema.shape)
      .filter((key) => key !== "client")
      .sort(),
  );
  expect(
    JSON.stringify(
      new LLMConfig({
        attacker: new LLMCallConfig({ client }),
        evaluator: config,
      }),
    ),
  ).not.toContain("synthetic-secret");
});
it("gates router retry hints on the actual client URL", () => {
  const config = new LLMConfig({ retryCount: 2, retryOnCodes: [429, 503] });
  expect(
    config.retryExtraBody({ baseURL: "https://my.orq.ai/v3/router/" }),
  ).toEqual({ retry: { count: 2, on_codes: [429, 503] } });
  expect(
    config.retryExtraBody({ baseURL: "https://api.openai.com/v1" }),
  ).toEqual({});
  expect(config.retryExtraBody(null)).toEqual({});
});

it("preserves an explicitly configured empty attacker model in precedence resolution", () => {
  expect(
    attackerModelFor(undefined, new LLMConfig({ attacker: { model: "" } })),
  ).toBe("");
});
