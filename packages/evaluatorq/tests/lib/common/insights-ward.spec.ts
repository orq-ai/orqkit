import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  flatClusters,
  wardLinkage,
} from "../../../src/lib/insights/cluster.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-ward-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: number[][];
  linkage: number[][];
  cuts: Record<string, number[]>;
}[];
for (const [i, c] of gold.entries())
  test(`Ward linkage and cuts ${i}`, () => {
    const rows = wardLinkage(c.vectors);
    expect(rows).toHaveLength(c.linkage.length);
    for (const [j, row] of rows.entries()) {
      const expected = c.linkage[j] ?? [];
      expect(row[0]).toBe(expected[0]);
      expect(row[1]).toBe(expected[1]);
      expect(row[2]).toBeCloseTo(expected[2] ?? 0, 11);
      expect(row[3]).toBe(expected[3]);
    }
    for (const [k, labels] of Object.entries(c.cuts))
      expect(flatClusters(rows, Number(k))).toEqual(labels);
  });
