import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  activeTreeMetadata,
  centroids,
  flagOutliers,
  gapOptimalK,
  nearestNeighbours,
} from "../../../src/lib/insights/cluster.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-cluster-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: {
    vectors: number[][];
    labels: number[];
    centroids: Record<string, number[]>;
    neighbours: Record<string, number[]>;
    outliers: number[];
  }[];
  gaps: {
    distances: number[];
    n: number;
    min: number;
    max: number;
    expected: number;
  }[];
  metadata: {
    labels: number[];
    mapping: Record<number, number>;
    expected: [number[], Record<number, number>, number, number];
  }[];
};
for (const [i, c] of gold.cases.entries())
  test(`cluster helpers ${i}`, () => {
    const centers = centroids(c.vectors, c.labels);
    expect(Object.keys(centers)).toEqual(Object.keys(c.centroids));
    for (const [id, expected] of Object.entries(c.centroids)) {
      const actual = centers[Number(id)] ?? [];
      for (const [j, value] of expected.entries())
        expect(actual[j]).toBeCloseTo(value, 12);
    }
    expect(nearestNeighbours(centers, 2)).toEqual(c.neighbours);
    expect(flagOutliers(c.vectors, c.labels, 1)).toEqual(c.outliers);
  });
for (const [i, c] of gold.gaps.entries())
  test(`cluster gap ${i}`, () => {
    expect(
      gapOptimalK(
        c.distances.map((d) => [0, 1, d, 2]),
        c.n,
        { kMin: c.min, kMax: c.max },
      ),
    ).toBe(c.expected);
  });
for (const [i, c] of gold.metadata.entries())
  test(`cluster metadata ${i}`, () => {
    expect(activeTreeMetadata(c.labels, c.mapping)).toEqual(c.expected);
  });
