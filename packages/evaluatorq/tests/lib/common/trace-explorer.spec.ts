import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CONVERSATION_METRICS,
  ExplorerView,
  matchesFirstView,
  nearestRank,
  type QuickView,
  TOP_METRICS,
  topConversations,
  topShare,
  totals,
} from "../../../src/lib/trace-finder/explorer.js";
import {
  type CompiledQuery,
  RunSnapshot,
  type RunState,
  TraceClassificationSchema,
} from "../../../src/lib/trace-finder/models.js";
import { TraceRow } from "../../../src/lib/trace-finder/rows.js";

type Case = {
  dataset: number;
  op: string;
  metric?: string;
  quick?: QuickView;
  sort?: string | null;
  descending?: boolean;
  matched_only?: boolean;
  page?: number;
  has_results?: boolean;
  within?: boolean;
  state?: RunState;
  has_dimensions?: boolean;
  expected: unknown;
};
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-explorer-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  datasets: {
    rows: unknown[];
    results: Record<string, unknown>;
    counts: Record<string, number>;
  }[];
  cases: Case[];
};
const datasets = fixture.datasets.map((doc) => ({
  rows: doc.rows.map((row) => new TraceRow(row)),
  results: Object.fromEntries(
    Object.entries(doc.results).map(([key, value]) => [
      key,
      TraceClassificationSchema.parse(value),
    ]),
  ),
  counts: doc.counts,
}));
const ids = (rows: readonly TraceRow[]) => rows.map((row) => row.traceId);
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        wire(item),
      ]),
    );
  return value;
}
for (const [index, row] of fixture.cases.entries())
  test(`Python explorer view ${index}`, () => {
    const dataset = datasets[row.dataset] as (typeof datasets)[number],
      results = row.has_results ? dataset.results : null;
    let result: unknown;
    if (row.op === "totals") result = wire(totals(dataset.rows));
    else if (row.op === "top")
      result = ids(
        topShare(
          dataset.rows,
          (
            TOP_METRICS[row.metric as string] as NonNullable<
              (typeof TOP_METRICS)[string]
            >
          )[1],
        ),
      );
    else if (row.op === "conversations")
      result = ids(
        topConversations(
          dataset.rows,
          (
            CONVERSATION_METRICS[row.metric as string] as NonNullable<
              (typeof CONVERSATION_METRICS)[string]
            >
          )[1],
          dataset.counts,
        ),
      );
    else if (row.op === "view") {
      const view = new ExplorerView({
        rows: dataset.rows,
        messageCounts: dataset.counts,
        quickView: row.quick,
        sort: row.sort,
        descending: row.descending,
        matchedOnly: row.matched_only,
        page: row.page,
      });
      result = {
        visible: ids(view.visibleRows(results)),
        pages: view.pageCount(results),
        page_rows: ids(view.pageRows(results)),
      };
    } else if (row.op === "matches_first") {
      const view = new ExplorerView({
          rows: dataset.rows,
          quickView: row.quick,
          sort: row.sort,
        }),
        snapshot = new RunSnapshot({
          withinResults: row.within,
          state: row.state,
          dimensions: row.has_dimensions ? ([{}] as CompiledQuery[]) : [],
          results: dataset.results,
        });
      result = ids(matchesFirstView(view, snapshot).rows);
    } else throw new Error(row.op);
    expect<unknown>(result).toEqual(row.expected);
  });
test("nearest rank handles empty and out-of-range inputs", () => {
  expect(nearestRank([], 4)).toBeNull();
  expect(nearestRank([10, 20, 30], -0.1)).toBe(10);
  expect(nearestRank([10, 20, 30], 1)).toBe(30);
  expect(() => nearestRank([10, 20, 30], 1.01)).toThrow();
});
