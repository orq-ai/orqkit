import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  reviewXy,
  reviewXyState,
} from "../../../src/lib/dashboard/insights-review-projection.js";
import {
  type InsightsRunFields,
  InsightsRunSchema,
} from "../../../src/lib/insights/models.js";

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
const logged = () => warn.mock.calls.map((call) => String(call[0])).join("\n");

function run(
  count = 7,
  coords2d: (index: number) => unknown = (index) => ({
    intent: [index + 10, index + 20],
  }),
): InsightsRunFields {
  return InsightsRunSchema.parse({
    run_id: "projection-test",
    run_name: "Projection test",
    created_at: "2026-09-01T00:00:00+00:00",
    status: "completed",
    stage_failures: [],
    population: {},
    config: { labels: [], dimensions: ["intent"] },
    traces: Array.from({ length: count }, (_, index) => ({
      trace_id: index < 2 ? "same" : `trace-${index}`,
      span_id: `span-${index}`,
      timestamp: "2026-09-01T00:00:00+00:00",
      coords: { intent: [index, index + 1, index + 2] },
      coords_2d: coords2d(index),
    })),
    dimensions: {
      intent: { name: "intent", source_field: "request", clusters: [] },
    },
    labels: {},
    priority: null,
    priority_reason: null,
    counts: { n_traces: count },
    warnings: [],
  }) as InsightsRunFields;
}

test("saved points are keyed by the full trace key", () => {
  const points = reviewXy(run(), "intent");
  expect(points.get("same:span-0")).toEqual([10, 20]);
  expect(points.get("same:span-1")).toEqual([11, 21]);
  expect(points.get("trace-6:span-6")).toEqual([16, 26]);
});

test("the 3D XY fallback runs only for a legacy report", () => {
  const points = reviewXy(
    run(7, () => null),
    "intent",
  );
  expect(points.get("same:span-0")).toEqual([0, 1]);
  expect(points.size).toBe(7);
  expect(logged()).toContain("legacy report");
  expect(logged()).toContain("fallback");
});

test("a new report missing the dimension does not fall back", () => {
  const empty = run(7, () => ({}));
  expect(reviewXy(empty, "intent").size).toBe(0);
  expect(reviewXyState(empty, "intent").reason).toBe(
    "Saved 2D coordinates are unavailable for this dimension.",
  );
});

test("invalid saved coordinates are skipped", () => {
  const invalid = [{ intent: [Number.NaN, 2] }, { intent: [1] }];
  const parsed = {
    traces: run().traces.map((trace, index) =>
      index < 2 ? { ...trace, coords2d: invalid[index] } : trace,
    ),
  } as never;
  const points = reviewXy(parsed, "intent");
  expect(points.has("same:span-0")).toBe(false);
  expect(points.has("same:span-1")).toBe(false);
  expect(points.size).toBe(5);
  expect(logged()).toContain("skipped invalid coordinates");
});

test("fewer than five points gives an explicit no-map state", () => {
  expect(reviewXy(run(4), "intent").size).toBe(0);
  expect(reviewXyState(run(4), "intent")).toEqual({
    available: false,
    reason: "Only 4 valid points are available; at least 5 are needed.",
    n_points: 4,
  });
});
