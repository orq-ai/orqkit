import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { clusterTwoLevel } from "../../../src/lib/insights/cluster.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-tree-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: number[][];
  options: {
    maxClusters: number;
    maxSubclusters: number;
    minClusterSize: number;
    outlierZscore: number | null;
  };
  expected: unknown;
}[];
for (const [i, c] of gold.entries())
  test(`two-level clustering ${i}`, () => {
    expect<unknown>(clusterTwoLevel(c.vectors, c.options)).toEqual(c.expected);
  });

test("clustering rejects invalid settings and excessive populations", () => {
  expect(() => clusterTwoLevel([[1]], { maxClusters: 0 })).toThrow(
    "max_clusters must be positive",
  );
  expect(() => clusterTwoLevel([[1]], { outlierZscore: -1 })).toThrow(
    "outlier_zscore",
  );
  expect(() => clusterTwoLevel([[Number.NaN]])).toThrow("finite");
  expect(() =>
    clusterTwoLevel(
      Array.from({ length: 5001 }, () => [1]),
      { minClusterSize: 1 },
    ),
  ).toThrow("at most 5000");
});
