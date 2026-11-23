import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  COLUMNS,
  DEFAULT_COLUMNS,
  fmtCost,
  fmtDuration,
  fmtTime,
  fmtTokens,
  resolveColumns,
  sortRows,
} from "../../../src/lib/trace-finder/columns.js";
import { TraceClassificationSchema } from "../../../src/lib/trace-finder/models.js";
import {
  parseSummaryTime,
  rowFromSummary,
  type TraceRow,
} from "../../../src/lib/trace-finder/rows.js";
import { EXPLORER_COLUMN_KEYS } from "../../../src/lib/trace-finder/settings.js";
import { exportTableCsv } from "../../../src/lib/trace-finder/table-csv.js";

const read = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/${name}-python-goldens.json`, import.meta.url),
      "utf8",
    ),
  );
const source = read("trace-foundations") as {
  rows: { summary: unknown; raw: Record<string, unknown> | null }[];
};
const goldens = read("trace-columns") as {
  keys: string[];
  defaults: string[];
  render: {
    rowIndex: number;
    expected: Record<string, { value: unknown; html: string }>;
  }[];
  formats: {
    tokens: { input: number | null; expected: string }[];
    duration: { input: number | null; expected: string }[];
    cost: { input: number | null; currency: string | null; expected: string }[];
    time: { input: unknown; expected: string }[];
  };
  sortRows: number[];
  results: Record<string, unknown>;
  sorts: { key: string; descending: boolean; expected: number[] }[];
  csv: { columns: string[] | null; dimensions: string[]; expected: string }[];
  special: { input: unknown; result: unknown; expected: string }[];
};
const rows = source.rows.map((row) => rowFromSummary(row.summary, row.raw)),
  selected = goldens.sortRows.map((index) => rows[index] as TraceRow),
  results = Object.fromEntries(
    Object.entries(goldens.results).map(([key, value]) => [
      key,
      TraceClassificationSchema.parse(value),
    ]),
  );
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const row of goldens.render)
  test(`Python explorer table render ${row.rowIndex}`, () => {
    const actual = rows[row.rowIndex] as TraceRow;
    for (const [key, expected] of Object.entries(row.expected)) {
      expect<unknown>(COLUMNS[key]?.value(actual)).toEqual(expected.value);
      expect(COLUMNS[key]?.render(actual)).toBe(expected.html);
    }
  });
for (const [i, row] of goldens.formats.tokens.entries())
  test(`Python explorer tokens ${i}`, () =>
    expect(fmtTokens(row.input)).toBe(row.expected));
for (const [i, row] of goldens.formats.duration.entries())
  test(`Python explorer duration ${i}`, () =>
    expect(fmtDuration(row.input)).toBe(row.expected));
for (const [i, row] of goldens.formats.cost.entries())
  test(`Python explorer cost ${i}`, () =>
    expect(fmtCost(row.input, row.currency)).toBe(row.expected));
for (const [i, row] of goldens.formats.time.entries())
  test(`Python explorer time ${i}`, () =>
    expect(fmtTime(parseSummaryTime(row.input))).toBe(row.expected));
for (const [i, row] of goldens.sorts.entries())
  test(`Python explorer sort ${i}`, () =>
    expect(
      sortRows(selected, row.key, { descending: row.descending, results }).map(
        (row) => selected.indexOf(row),
      ),
    ).toEqual(row.expected));
for (const [i, row] of goldens.csv.entries())
  test(`Python explorer CSV ${i}`, () =>
    expect(
      exportTableCsv(selected, row.columns, {
        dimensions: row.dimensions,
        results,
      }),
    ).toBe(row.expected));
for (const [i, row] of goldens.special.entries())
  test(`Python explorer CSV safety ${i}`, () => {
    const actual = rowFromSummary(row.input) as TraceRow;
    expect(
      exportTableCsv(
        [actual],
        ["trace", "started", "cost", "cache_pct", "match"],
        {
          dimensions: ["Text", "Number", "Bool"],
          results: { t: TraceClassificationSchema.parse(row.result) },
        },
      ),
    ).toBe(row.expected);
  });
test("column registry remains aligned with settings and preserves explicit ordering", () => {
  expect(Object.keys(COLUMNS)).toEqual(goldens.keys);
  expect(DEFAULT_COLUMNS).toEqual(goldens.defaults);
  expect([...EXPLORER_COLUMN_KEYS]).toEqual(goldens.keys);
  expect(resolveColumns(["name", "missing", "name"]).map((c) => c.key)).toEqual(
    ["name", "name"],
  );
  expect(warn).toHaveBeenCalledTimes(1);
  expect(resolveColumns([])).toEqual([]);
  expect(resolveColumns().map((c) => c.key)).toEqual(goldens.defaults);
  expect(Object.isFrozen(COLUMNS)).toBe(true);
});
