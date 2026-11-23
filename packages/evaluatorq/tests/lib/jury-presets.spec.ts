import { describe, expect, test } from "bun:test";

import {
  allRouterIds,
  capturedAt,
  EU_REGION,
  getPreset,
  JuryPreset,
  judgeFamily,
  judgeRates,
  modelIdentity,
  PRESETS,
  SINGLE_PROVIDER_TRIO,
} from "../../src/lib/jury-presets.js";

const base = {
  name: "t",
  reserveJudges: [] as string[],
  useWhen: "x",
  estimatedCostPer1k: 0,
};

describe("presets", () => {
  test("five presets with published costs matching the captured rates", () => {
    expect(PRESETS.size).toBe(5);
    for (const preset of PRESETS.values()) {
      expect(preset.costPer1k()).toBe(preset.estimatedCostPer1k);
    }
  });

  test("every seat has rates and a lineage", () => {
    for (const id of allRouterIds()) {
      expect(judgeRates(id)).toBeDefined();
      expect(() => judgeFamily(id)).not.toThrow();
    }
    expect(capturedAt()).toContain("2026");
  });

  test("validation", () => {
    expect(
      () => new JuryPreset({ ...base, judges: ["gpt-1", "claude-3"] }),
    ).toThrow("even");
    expect(() => new JuryPreset({ ...base, judges: ["a", "a", "b"] })).toThrow(
      "duplicate",
    );
    expect(
      () =>
        new JuryPreset({
          ...base,
          judges: ["gpt-1"],
          reserveJudges: ["gpt-1"],
        }),
    ).toThrow("already on the panel");
    expect(
      () =>
        new JuryPreset({
          ...base,
          judges: ["gpt-1"],
          reserveJudges: ["claude-3", "claude-4"],
        }),
    ).toThrow("lineage");
  });

  test("lineage views", () => {
    expect(Object.keys(SINGLE_PROVIDER_TRIO.duplicatedLineages())).toEqual([
      "openai",
    ]);
    expect(EU_REGION.duplicatedLineages()).toEqual({});
    expect(EU_REGION.seatedEfforts()["azure/eu.gpt-5.6-luna"]).toBe("medium");
  });

  test("getPreset explains retired, withheld and unknown names", () => {
    expect(getPreset(" Balanced Trio ").name).toBe("Balanced Trio");
    expect(() => getPreset("Value Trio")).toThrow("retired");
    expect(() => getPreset("Cheap Aggregate")).toThrow("not shipped");
    expect(() => getPreset("Nope")).toThrow("available");
  });

  test("modelIdentity strips host, region, vendor and version", () => {
    expect(
      modelIdentity("aws/eu.anthropic.claude-haiku-4-5-20251001-v1:0"),
    ).toBe(modelIdentity("anthropic/claude-haiku-4-5-20251001"));
    expect(modelIdentity("azure/global.gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });
});
