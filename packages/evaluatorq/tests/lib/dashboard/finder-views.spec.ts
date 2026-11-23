import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  drawer,
  fragment,
  missingTraceDrawer,
  spanTree,
} from "../../../src/lib/dashboard/trace-finder/views.js";
import {
  RunSnapshot,
  TraceClassificationSchema,
  TraceDetail,
  TraceProjectionSchema,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import { TraceRow } from "../../../src/lib/trace-finder/rows.js";
import { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

type Json = Record<string, unknown>;
const g = JSON.parse(
  readFileSync(
    new URL("../fixtures/finder-views-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  trace: Json;
  empty: Json;
  projection: Json;
  classifications: Record<string, Json>;
  row: Json;
  drawers: {
    trace: "trace" | "empty";
    cls: string | null;
    layout: boolean;
    row: boolean;
    msg: number | null;
    html: string;
  }[];
  missing: { reason: string | null; layout: boolean; html: string }[];
  spans: { spans: unknown[]; msg: string | null; html: string }[];
  fragments: {
    state: string;
    phase: string | null;
    error_field: string | null;
    error: string | null;
    html: string;
  }[];
};

const EXP = "https://my.orq.ai/acme/experiments/e1";
const traces = {
  trace: new TraceRecord(g.trace),
  empty: new TraceRecord(g.empty),
};
const projection = TraceProjectionSchema.parse(g.projection);
const row = new TraceRow(g.row);

for (const [i, c] of g.drawers.entries())
  test(`drawer matches Python: case ${i}`, async () => {
    const cls = c.cls
      ? TraceClassificationSchema.parse(g.classifications[c.cls])
      : null;
    const detail = new TraceDetail(
      traces[c.trace],
      c.cls ? projection : null,
      cls,
    );
    expect(
      await drawer(detail, {
        experimentUrl: EXP,
        msg: c.msg,
        row: c.row ? row : null,
        tracesLayout: c.layout,
      }),
    ).toBe(c.html);
  });

for (const [i, c] of g.missing.entries())
  test(`missing trace drawer matches Python: case ${i}`, async () => {
    expect(
      await missingTraceDrawer("t 1", {
        reason: c.reason,
        tracesLayout: c.layout,
      }),
    ).toBe(c.html);
  });

for (const [i, c] of g.spans.entries())
  test(`span tree matches Python: case ${i}`, async () => {
    expect(
      await spanTree("trace 1", c.spans, EXP, { firstErrorMessage: c.msg }),
    ).toBe(c.html);
  });

for (const [i, c] of g.fragments.entries())
  test(`fragment matches Python: case ${i}`, () => {
    const snapshot = new RunSnapshot({
      state: c.state as never,
      phase: c.phase as never,
      error: c.error_field,
    });
    const csrf = (html: string) =>
      html.replace(/name="csrf" value="[^"]*"/g, 'name="csrf" value=""');
    expect(
      csrf(fragment(snapshot, new DashboardSettings(), { error: c.error })),
    ).toBe(csrf(c.html));
  });
