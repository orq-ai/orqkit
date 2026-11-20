import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentResponse,
  AgentTarget,
  LLMCallConfig,
} from "../../../src/lib/contracts.js";
import { LLMConfig } from "../../../src/lib/redteam/config.js";
import {
  loadRedteamReplay,
  type RedTeamReplay,
} from "../../../src/lib/redteam/replay.js";
import {
  capDatapointsBalanced,
  checkFilterResults,
  type DataSelectionOptions,
  deduplicateTargetLabels,
  matchedFilterDimensions,
  rejectUnsupportedTargets,
  resolveFilterSets,
  resolveOutputDirs,
  resolveRedteamReplay,
  resolveSaveMode,
  resolveVulnsAndCategories,
  restoreReplayedBacktracks,
  splitAndDedupeTargets,
  validateBacktrackingTargets,
  validateCredentialsAndDeps,
  validateTraceDatapoints,
  validateTraceReplayTargets,
} from "../../../src/lib/redteam/runner-validation.js";
import goldens from "../fixtures/preflight-python-goldens.json" with {
  type: "json",
};

let warnings: ReturnType<typeof spyOn<typeof console, "warn">>,
  info: ReturnType<typeof spyOn<typeof console, "info">>;
beforeEach(() => {
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  warnings.mockRestore();
  info.mockRestore();
});
function optionsOf(
  raw: (typeof goldens.filters)[number]["raw"],
): DataSelectionOptions {
  return {
    strategies: raw.strategies,
    attackTechniques: raw.attack_techniques,
    deliveryMethods: raw.delivery_methods,
    categories: raw.categories,
    vulnerabilities: raw.vulnerabilities,
  };
}
for (const [index, fixture] of goldens.filters.entries())
  it(`matches pinned filter resolution ${index}`, () => {
    if ("error" in fixture)
      expect(() => resolveFilterSets(optionsOf(fixture.raw))).toThrow();
    else {
      const actual = resolveFilterSets(optionsOf(fixture.raw));
      expect({
        strategyNames:
          actual.strategyNames === null
            ? null
            : [...actual.strategyNames].sort(),
        attackTechniques:
          actual.attackTechniques === null
            ? null
            : [...actual.attackTechniques].sort(),
        deliveryMethods:
          actual.deliveryMethods === null
            ? null
            : [...actual.deliveryMethods].sort(),
        filterSelection: actual.filterSelection,
      } as unknown).toEqual(fixture.expected);
    }
  });
for (const [index, fixture] of goldens.selections.entries())
  it(`matches pinned category/vulnerability resolution ${index}`, () => {
    if ("error" in fixture)
      expect(() => resolveVulnsAndCategories(fixture, null)).toThrow();
    else
      expect(resolveVulnsAndCategories(fixture, null) as unknown).toEqual(
        fixture.expected,
      );
  });
for (const [index, fixture] of goldens.caps.entries())
  it(`matches pinned balanced cap ${index}`, () => {
    expect(
      capDatapointsBalanced(
        fixture.rows.map((inputs) => ({ inputs })),
        fixture.cap,
      ).map((row) => row.inputs.id),
    ).toEqual(fixture.expected);
  });
it("matches pinned dynamic/static filter dimension extraction", () => {
  const actual = matchedFilterDimensions(
    goldens.matched.rows.map((inputs) => ({ inputs })),
  );
  expect({
    names: [...actual.names].sort(),
    methods: [...actual.methods].sort(),
    techniques: [...actual.techniques].sort(),
  }).toEqual(goldens.matched.expected);
});
for (const fixture of goldens.checks)
  it(`matches pinned empty selection policy ${fixture.filterIndex}/${fixture.empty}`, () => {
    const source = goldens.filters[fixture.filterIndex];
    if (!source) throw new Error("Missing fixture");
    const filters = resolveFilterSets(optionsOf(source.raw)),
      rows = fixture.empty
        ? []
        : goldens.matched.rows.map((inputs) => ({ inputs }));
    if (fixture.error)
      expect(() => checkFilterResults(rows, filters)).toThrow(
        "zero datapoints",
      );
    else expect(() => checkFilterResults(rows, filters)).not.toThrow();
  });
class Target extends AgentTarget {
  override readonly historyMode: "caller" | "target";
  constructor(
    readonly name?: string,
    history: "caller" | "target" = "caller",
  ) {
    super();
    this.historyMode = history;
  }
  override async respond() {
    return new AgentResponse();
  }
  override newInstance() {
    return new Target(this.name, this.historyMode);
  }
}
it("deduplicates strings while retaining distinct direct targets and their labels", () => {
  const one = new Target("same"),
    two = new Target("same"),
    collision = new Target("agent:a"),
    unnamed = new Target();
  const result = splitAndDedupeTargets([
    one,
    "agent:a",
    two,
    "agent:a",
    collision,
    unnamed,
  ]);
  expect(result.strings).toEqual(["agent:a"]);
  expect(result.agents).toEqual([one, two, collision, unnamed]);
  expect(deduplicateTargetLabels(result.strings, result.agents).labels).toEqual(
    ["agent:a", "same", "same-1", "agent:a-1", "Target"],
  );
  expect(() => splitAndDedupeTargets([])).toThrow("at least one target");
  expect(() =>
    splitAndDedupeTargets({ clone() {} } as unknown as Target),
  ).toThrow("removed");
});
it("rejects trace and static-only selector conflicts before target execution", () => {
  const seed = {
    inputs: {
      traceSeedMessages: [{ role: "user", content: "seed" }],
      traceStartFrom: "first_user",
    },
  };
  expect(validateTraceDatapoints({ datapoints: [seed] })).toEqual([seed]);
  expect(() => validateTraceDatapoints({ datapoints: [] })).toThrow(
    "no trace seeds",
  );
  expect(() =>
    validateTraceDatapoints({ datapoints: [seed], dataset: "data.json" }),
  ).toThrow("combined");
  expect(() =>
    validateTraceDatapoints({ datapoints: [seed], mode: "hybrid" }),
  ).toThrow("dynamic");
  expect(() =>
    validateTraceDatapoints({ mode: "static", attackTechniques: [] }),
  ).toThrow("static mode");
  expect(() =>
    validateTraceDatapoints({
      datapoints: [
        { inputs: { traceSeedMessages: [{ role: "user", content: "seed" }] } },
      ],
    }),
  ).toThrow("traceStartFrom");
});
it("enforces history ownership for both native and Python trace metadata", () => {
  for (const inputs of [
    { traceStartFrom: "last_assistant" },
    { trace_start_from: "last_assistant" },
  ]) {
    const seed = [{ inputs }];
    expect(() =>
      validateTraceReplayTargets([new Target("caller")], seed),
    ).not.toThrow();
    expect(() =>
      validateTraceReplayTargets([new Target("owned", "target")], seed),
    ).toThrow("caller-owned");
    expect(() => validateTraceReplayTargets(["agent:hosted"], seed)).toThrow(
      "caller-owned",
    );
  }
  expect(() => rejectUnsupportedTargets(["deployment:key"], "dynamic")).toThrow(
    "static",
  );
  expect(() =>
    rejectUnsupportedTargets(["deployment:key"], "static"),
  ).not.toThrow();
  expect(() =>
    validateBacktrackingTargets(
      [new Target("owned", "target")],
      new LLMConfig({ maxBacktracks: 1 }),
      "dynamic",
    ),
  ).toThrow("caller-owned");
  expect(() =>
    validateBacktrackingTargets(
      [new Target("owned", "target")],
      new LLMConfig({ maxBacktracks: 1 }),
      "static",
    ),
  ).not.toThrow();
});
it("restores replay knobs without overriding explicit zeroes or losing supplied clients", () => {
  const client = {},
    replay = { maxBacktracks: 2 } as RedTeamReplay;
  const config = new LLMConfig({
    attacker: new LLMCallConfig({ client }),
    evaluator: new LLMCallConfig({ client }),
  });
  const restored = restoreReplayedBacktracks(config, replay);
  expect(restored?.maxBacktracks).toBe(2);
  expect(restored?.attacker.client).toBe(client);
  expect(restored?.evaluator.client).toBe(client);
  expect(config.maxBacktracks).toBe(0);
  const explicit = new LLMConfig({ maxBacktracks: 0 });
  expect(restoreReplayedBacktracks(explicit, replay)).toBe(explicit);
  expect(config.fieldsSet.has("maxBacktracks")).toBe(false);
  expect(explicit.fieldsSet.has("maxBacktracks")).toBe(true);
  expect(Object.keys(config)).not.toContain("fieldsSet");
  expect(() => new LLMConfig({ ...config, maxBacktracks: 1 })).not.toThrow();
});
it("rejects replay selectors and restores the original case scope, steering and budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "res1863-preflight-")),
    path = join(directory, "run.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        datapoints: [{ category: "ASI01", strategy: {} }],
        pipeline: "dynamic",
        runConfig: { maxTurns: 7, attackerInstructions: "Recorded" },
      }),
    );
    const options = { previousRun: path };
    const resolved = await resolveRedteamReplay(options, directory);
    expect(resolved.maxTurns).toBe(7);
    expect(resolved.attackerInstructions).toBe("Recorded");
    const overridden = await resolveRedteamReplay(
      { ...options, maxTurns: 0, attackerInstructions: "" },
      directory,
    );
    expect(overridden.maxTurns).toBe(0);
    expect(overridden.attackerInstructions).toBe("");
    for (const key of [
      "mode",
      "dataset",
      "categories",
      "vulnerabilities",
      "strategies",
      "datapoints",
      "attackTechniques",
      "deliveryMethods",
      "maxPerCategory",
      "maxDynamicDatapoints",
      "maxStaticDatapoints",
    ])
      await expect(
        resolveRedteamReplay(
          { ...options, [key]: [] } as unknown as DataSelectionOptions,
          directory,
        ),
      ).rejects.toThrow("data-selection");
    const replay = await loadRedteamReplay(path, directory);
    expect(
      resolveVulnsAndCategories({ categories: [] }, replay).categories,
    ).toEqual(["ASI01"]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
it("requires credentials unless a shared or per-role client is supplied", () => {
  const previous = [process.env.OPENAI_API_KEY, process.env.ORQ_API_KEY];
  delete process.env.OPENAI_API_KEY;
  delete process.env.ORQ_API_KEY;
  try {
    expect(() =>
      validateCredentialsAndDeps({
        config: new LLMConfig(),
        replay: null,
        mode: "dynamic",
      }),
    ).toThrow("Missing LLM credentials");
    expect(() =>
      validateCredentialsAndDeps({
        config: new LLMConfig({ evaluator: new LLMCallConfig({ client: {} }) }),
        replay: null,
        mode: "dynamic",
      }),
    ).not.toThrow();
  } finally {
    for (const [index, name] of ["OPENAI_API_KEY", "ORQ_API_KEY"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
it("requires an explicit detail directory and preserves the deprecated boolean save mapping", () => {
  expect(resolveSaveMode(true)).toBe("final");
  expect(resolveSaveMode(false)).toBe("none");
  expect(() => resolveSaveMode("other" as "final")).toThrow();
  expect(() => resolveOutputDirs("detail")).toThrow("requires artifactsDir");
  expect(resolveOutputDirs("final", "artifacts")).toEqual({
    userOutputDir: "artifacts",
    pipelineOutputDir: null,
  });
  expect(resolveOutputDirs("detail", "artifacts")).toEqual({
    userOutputDir: "artifacts",
    pipelineOutputDir: "artifacts",
  });
});
