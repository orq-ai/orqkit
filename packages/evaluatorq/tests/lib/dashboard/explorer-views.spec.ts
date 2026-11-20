import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  rangeInputs,
  results,
  splitToolbar,
  table,
  trajectories,
} from "../../../src/lib/dashboard/trace-finder/explorer-views.js";
import { COLUMNS } from "../../../src/lib/trace-finder/columns.js";
import { ExplorerView } from "../../../src/lib/trace-finder/explorer.js";
import {
  CompiledQuerySchema,
  FacetSelection,
  NumericFilters,
  RunSnapshot,
  TraceClassificationSchema,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import { TraceRow } from "../../../src/lib/trace-finder/rows.js";

type Json = Record<string, unknown>;
const g = JSON.parse(
  readFileSync(
    new URL("../fixtures/explorer-views-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  records: Record<string, Json | null>;
  snapshots: Record<string, Json | null>;
  views: Record<string, Json>;
  colsets: Record<string, string[]>;
  results: {
    view: string;
    snap: string;
    layout: boolean;
    cols: string;
    extra: Json;
    html: string;
  }[];
  tables: { view: string; snap: string; cols: string; html: string }[];
  trajectories: { view: string; loading: boolean; html: string }[];
  ranges: {
    start: string | null;
    end: string;
    window_days: number;
    kw: Json;
    html: string;
  }[];
};

const csrf = (html: string) =>
  html.replace(/name="csrf" value="[^"]*"/g, 'name="csrf" value=""');
// The render key hashes markup that carries the per-process CSRF token, so compare it only where no form is inside.
const normalize = (html: string) =>
  csrf(html).replace(/data-render-key="[0-9a-f]{8}"/g, 'data-render-key=""');

const records = Object.fromEntries(
  Object.entries(g.records).map(([key, value]) => [
    key,
    value ? new TraceRecord(value) : null,
  ]),
);

function snapshot(name: string): RunSnapshot | null {
  const s = g.snapshots[name];
  if (!s) return null;
  return new RunSnapshot({
    state: s.state as never,
    withinResults: s.within_results as boolean,
    loaded: s.loaded as number,
    dimensions: s.dimensions
      ? (s.dimensions as Json[]).map((d) => CompiledQuerySchema.parse(d))
      : null,
    results: Object.fromEntries(
      Object.entries(s.results as Record<string, Json>).map(([k, v]) => [
        k,
        TraceClassificationSchema.parse(v),
      ]),
    ),
    request: s.query === null ? null : ({ query: s.query } as never),
  });
}

function view(name: string): ExplorerView {
  const v = g.views[name] as Json;
  return new ExplorerView({
    generation: v.generation as number,
    version: v.version as number,
    state: v.state as never,
    initialLoad: v.initial_load as boolean,
    trajectoryWarming: v.trajectory_warming as boolean,
    rows: (v.rows as Json[]).map((row) => new TraceRow(row)),
    limit: v.limit as number,
    start: v.start as string | null,
    end: v.end as string | null,
    facets: new FacetSelection(v.facets),
    numeric: new NumericFilters(v.numeric),
    messageCounts: v.message_counts as Record<string, number>,
    messageCounting: v.message_counting as boolean,
    messageCountError: v.message_count_error as string | null,
    error: v.error as string | null,
    sort: v.sort as string | null,
    descending: v.descending as boolean,
    page: v.page as number,
    view: v.view as never,
    showToolDefinitions: v.show_tool_definitions as boolean,
    matchedOnly: v.matched_only as boolean,
    quickView: v.quick_view as never,
    narrowedFrom: v.narrowed_from as number | null,
  });
}

const columns = (set: string) =>
  (g.colsets[set] as string[]).map((key) => COLUMNS[key] as never);

for (const [i, c] of g.results.entries())
  test(`results match Python: ${c.view} / ${c.snap}${c.layout ? " / traces" : ""} (${i})`, () => {
    const e = c.extra;
    const html = results(view(c.view), columns(c.cols), {
      records,
      snapshot: snapshot(c.snap),
      tracesLayout: c.layout,
      oob: (e.oob as boolean | undefined) ?? false,
      error: (e.error as string | undefined) ?? null,
      poll: (e.poll as boolean | undefined) ?? false,
      pollSequence: (e.poll_sequence as number | undefined) ?? null,
      windowDays: (e.window_days as number | undefined) ?? 7,
    });
    expect(normalize(html)).toBe(normalize(c.html));
    const [toolbar, section] = splitToolbar(html);
    expect(section.startsWith('<section id="explorer-results"')).toBe(true);
    expect(
      toolbar.startsWith('<div id="explorer-toolbar" data-view-version'),
    ).toBe(true);
  });

test("render key matches Python crc32 where the section has no CSRF form", () => {
  const keyed = g.results.filter(
    (c) => !c.html.split("</section>")[0]?.includes('name="csrf"'),
  );
  expect(keyed.length).toBeGreaterThan(0);
  for (const c of keyed) {
    const html = results(view(c.view), columns(c.cols), {
      records,
      snapshot: snapshot(c.snap),
      tracesLayout: c.layout,
      oob: (c.extra.oob as boolean | undefined) ?? false,
      error: (c.extra.error as string | undefined) ?? null,
      poll: (c.extra.poll as boolean | undefined) ?? false,
      pollSequence: (c.extra.poll_sequence as number | undefined) ?? null,
      windowDays: (c.extra.window_days as number | undefined) ?? 7,
    });
    expect(html.split("</section>")[0]).toBe(
      c.html.split("</section>")[0] as string,
    );
  }
});

for (const [i, c] of g.tables.entries())
  test(`table matches Python: ${c.cols} / ${c.snap} (${i})`, () => {
    expect(
      table(view(c.view), columns(c.cols), snapshot(c.snap), {
        tracesLayout: true,
      }),
    ).toBe(c.html);
  });

for (const [i, c] of g.trajectories.entries())
  test(`trajectories without records match Python (${i})`, () => {
    expect(
      trajectories(view(c.view), {}, snapshot("choice"), {
        loading: c.loading,
      }),
    ).toBe(c.html);
  });

for (const [i, c] of g.ranges.entries())
  test(`range inputs match Python (${i})`, () => {
    expect(
      csrf(
        rangeInputs(c.start, c.end, c.window_days, {
          includeLoad: c.kw.include_load as boolean | undefined,
          rowLimit: c.kw.row_limit as number | undefined,
          timeOrigin: c.kw.time_origin as string | undefined,
        }),
      ),
    ).toBe(csrf(c.html));
  });

test("column widths for one load only grow as rows change", () => {
  const base = view("base");
  const loaded = new ExplorerView({ ...base, generation: 9001 });
  const first = table(loaded, columns("default"), null);
  const fewer = new ExplorerView({
    ...base,
    generation: 9001,
    rows: base.rows.slice(3, 4),
  });
  const colgroup = (html: string) =>
    html.match(/<colgroup>.*<\/colgroup>/)?.[0] ?? "";
  expect(colgroup(table(fewer, columns("default"), null))).toBe(
    colgroup(first),
  );
  const fresh = new ExplorerView({ ...base, rows: base.rows.slice(3, 4) });
  expect(colgroup(table(fresh, columns("default"), null))).not.toBe(
    colgroup(first),
  );
});
