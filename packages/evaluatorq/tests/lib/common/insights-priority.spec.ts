import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DimensionResultSchema,
  LabelSpec,
  TraceInsightSchema,
} from "../../../src/lib/insights/models.js";
import { priorityPoints } from "../../../src/lib/insights/priority.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-priority-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  spec: unknown;
  dimension: unknown;
  cases: {
    traces: unknown[];
    points:
      | {
          cluster_id: string;
          name: string;
          volume: number;
          mean_satisfaction: number;
          error_share: number;
        }[]
      | null;
    reason: string | null;
  }[];
};
const spec = new LabelSpec(gold.spec),
  dimension = DimensionResultSchema.parse(gold.dimension);
for (const [i, c] of gold.cases.entries())
  test(`priority Python case ${i}`, () => {
    const [points, reason] = priorityPoints(
      c.traces.map((t) => TraceInsightSchema.parse(t)),
      dimension,
      { satisfactionSpec: spec },
    );
    expect(
      points?.map((p) => ({
        cluster_id: p.clusterId,
        name: p.name,
        volume: p.volume,
        mean_satisfaction: p.meanSatisfaction,
        error_share: p.errorShare,
      })) ?? null,
    ).toEqual(c.points);
    expect(reason).toBe(c.reason);
  });
test("priority requires a score satisfaction label", () => {
  const wrong = new LabelSpec({ name: "s", kind: "noul", instructions: "Q" });
  expect(priorityPoints([], dimension, { satisfactionSpec: wrong })).toEqual([
    null,
    "the 'customer_satisfaction' label must be a score label for the priority matrix",
  ]);
});
