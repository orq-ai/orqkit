import { expect, test } from "bun:test";

import { ModelInfo } from "../../../src/lib/common/model-catalogue.js";
import { estimateRun, traceBound } from "../../../src/lib/insights/estimate.js";
import {
  FacetCatalogueSchema,
  FacetSelection,
} from "../../../src/lib/trace-finder/models.js";

test("estimate matches Python reference for query and coding stages", async () => {
  const price = new ModelInfo({
    provider: "test",
    supportsResponses: false,
    inputCostPer1k: 0.1,
    outputCostPer1k: 0.2,
  });
  const result = await estimateRun({
    bound: { n: 10, exact: true, basis: "fixture" },
    dimensions: ["intent", "sentiment"],
    questionCount: 1,
    coding: true,
    models: { summary: "s", classifier: "typesafe/jev-test", embedding: "e" },
    prices: { s: price, "typesafe/jev-test": price, e: price },
    seconds: {
      label: { seconds: 2, parallelism: 1, runs: 3 },
      summary: { seconds: 4, parallelism: 1, runs: 3 },
    },
    parallelism: 10,
    query: true,
    traceInputChars: 4096,
  });
  expect(
    result.rows.map((row) => [
      row.name,
      row.tracesLow,
      row.tracesHigh,
      row.tokensIn,
      row.tokensOut,
    ]),
  ).toEqual([
    ["label", 10, 10, 1024, 12],
    ["label_coding", 10, 10, 1024, 4],
    ["summary", 0, 10, 1024, 4096],
    ["dimension:intent", 0, 10, 4096, 0],
    ["dimension:sentiment", 0, 10, 4096, 0],
  ]);
  expect(result.costLow).toBeCloseTo(2.08);
  expect(result.costHigh).toBeCloseTo(19.488);
  expect(result.secondsLow).toBe(4);
  expect(result.secondsHigh).toBe(8);
  expect(result.timePartial).toBe(true);
  expect(result.unknowns).toEqual([
    "cost: coding tool activity may require additional classifier chunks",
    "time: dimension:intent has no earlier timing",
    "time: dimension:sentiment has no earlier timing",
  ]);
  expect(result.excluded).toContain("cluster naming and merging");
});
test("trace bounds retain unknown and incomplete counts", () => {
  const catalogue = FacetCatalogueSchema.parse({
    value_counts: { status: { ok: 7, error: 3 } },
  });
  const facets = new FacetSelection();
  expect(
    traceBound("recent", {
      catalogue,
      facets,
      limit: 50,
      finderCount: null,
      snapshotCount: null,
    }),
  ).toEqual({
    n: 10,
    exact: false,
    basis: "status counts, up to the trace limit of 50",
  });
  expect(
    traceBound("finder", {
      catalogue,
      facets,
      limit: 50,
      finderCount: null,
      snapshotCount: null,
    }),
  ).toEqual({
    n: null,
    exact: false,
    basis: "matched traces in the export unknown",
  });
});
