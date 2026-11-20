import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { RunManifestSchema } from "../../../src/lib/contracts.js";
import {
  type DimensionName,
  InsightsPopulation,
  InsightsRunSchema,
  LabelSpec,
} from "../../../src/lib/insights/models.js";
import {
  runManifestFor,
  stageHistoryForSave,
  stagePlan,
} from "../../../src/lib/insights/progress.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-progress-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  plans: {
    population: unknown;
    labels: unknown[];
    dimensions: DimensionName[];
    plan: [string, string][];
  }[];
  runs: {
    input: unknown;
    status: string;
    stage: string;
    stages: [string, string][];
    planned: string[];
    labels: Record<string, string>;
    error: string | null;
  }[];
};
for (const [i, c] of gold.plans.entries())
  test(`Insights stage plan ${i}`, () => {
    expect(
      stagePlan(
        new InsightsPopulation(c.population),
        c.labels.map((label) => new LabelSpec(label)),
        c.dimensions,
      ),
    ).toEqual(c.plan);
  });
for (const [i, c] of gold.runs.entries())
  test(`saved Insights manifest ${i}`, () => {
    const manifest = runManifestFor(InsightsRunSchema.parse(c.input));
    expect<string>(manifest.status).toBe(c.status);
    expect(manifest.stage).toBe(c.stage);
    expect(manifest.stages.map((s) => [s.name, s.status])).toEqual(c.stages);
    expect(manifest.plannedStages).toEqual(c.planned);
    expect(manifest.stageLabels).toEqual(c.labels);
    expect(manifest.error).toBe(c.error);
  });
test("stage history closes open work without hiding a failed write", () => {
  const now = new Date("2026-11-10T12:00:00Z"),
    manifest = RunManifestSchema.parse({
      runId: "r",
      runName: "run",
      surface: "insights",
      startedAt: now,
      updatedAt: now,
      plannedStages: ["summary", "write"],
      stageLabels: { summary: "Summarize" },
      stages: [
        { name: "summary", startedAt: now },
        { name: "write", startedAt: now },
      ],
    });
  expect(
    stageHistoryForSave(manifest, { failedStage: "summary", now }).stages.map(
      (s) => [s.name, s.status],
    ),
  ).toEqual([
    ["summary", "error"],
    ["write", "completed"],
  ]);
  expect(
    stageHistoryForSave(manifest, { failedStage: "write", now }).stages.map(
      (s) => s.status,
    ),
  ).toEqual(["error", "error"]);
  expect(manifest.stages.map((s) => s.status)).toEqual(["running", "running"]);
});
