import { expect, it } from "bun:test";

import {
  RedTeamCliConfig,
  RedTeamRunConfig,
  type RedTeamRunConfigInput,
  RedTeamRunConfigSchema,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/redteam-run-config-python-goldens.json" with {
  type: "json",
};

for (const [index, entry] of goldens.cases.entries())
  it(`matches pinned JSON run config case ${index}`, () => {
    if (entry.error)
      expect(
        () => new RedTeamRunConfig(entry.value as RedTeamRunConfigInput),
      ).toThrow();
    else {
      const config = new RedTeamRunConfig(entry.value as RedTeamRunConfigInput);
      expect(config.toJSON() as unknown).toEqual(entry.expected);
      expect([...config.fieldsSet].sort()).toEqual(entry.fieldsSet as string[]);
    }
  });
it("keeps explicit zero/false/default-valued fields distinct from omissions", () => {
  const config = new RedTeamRunConfig({
    verbosity: 0,
    generateStrategies: true,
    cleanupMemory: false,
    maxTurns: 0,
  });
  expect([...config.fieldsSet].sort()).toEqual([
    "cleanupMemory",
    "generateStrategies",
    "maxTurns",
    "verbosity",
  ]);
  expect(config.toJSON()).not.toHaveProperty("fieldsSet");
  expect(new RedTeamRunConfig().fieldsSet.size).toBe(0);
});
it("changes only the CLI default verbosity without marking it explicitly set", () => {
  const config = new RedTeamCliConfig();
  expect(config.verbosity).toBe(goldens.cliDefaultVerbosity);
  expect(config.fieldsSet.size).toBe(0);
  expect({ ...config.toJSON(), verbosity: 0 } as unknown).toEqual(
    new RedTeamRunConfig().toJSON(),
  );
  expect(new RedTeamCliConfig({ verbosity: 0 }).verbosity).toBe(0);
  expect(
    new RedTeamCliConfig({ verbosity: 0 }).fieldsSet.has("verbosity"),
  ).toBe(true);
});
it("accepts camelCase serialized configs and preserves free dataset inputs", () => {
  const config = new RedTeamRunConfig({
    target: ["agent:a"],
    llmParallelism: -1,
    llmConfig: { attacker: { model: "attack" } },
    datapoints: [
      { inputs: { under_score: { raw_key: true } }, expectedOutput: "value" },
    ],
  });
  const roundtrip = new RedTeamRunConfig(
    config.toJSON() as RedTeamRunConfigInput,
  );
  expect(roundtrip.toJSON()).toEqual(config.toJSON());
  expect(roundtrip.datapoints?.[0]?.inputs).toEqual({
    under_score: { raw_key: true },
  });
});
it("reports invalid nested config keys under their owner", () => {
  const parsed = RedTeamRunConfigSchema.safeParse({
    llmConfig: { backend: {} },
  });
  expect(parsed.success).toBe(false);
  if (!parsed.success)
    expect(parsed.error.issues[0]?.path).toEqual(["llmConfig"]);
});
