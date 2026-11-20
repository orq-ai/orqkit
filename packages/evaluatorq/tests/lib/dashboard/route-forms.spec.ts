import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  compiledFromForm,
  parseRange,
  runRequest,
  utcIso,
} from "../../../src/lib/dashboard/trace-finder/route-forms.js";
import {
  CompiledQuerySchema,
  PopulationRequest,
  RunRequestSchema,
} from "../../../src/lib/trace-finder/models.js";

type Result = { ok?: unknown; error?: string };
const g = JSON.parse(
  readFileSync(
    new URL("../fixtures/route-forms-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  ranges: ({ args: (string | null)[] } & Result)[];
  requests: ({
    form: [string, string][];
    anchor: string;
    fallback: string | null;
  } & Result)[];
  compiled: ({ current: string; form: [string, string][] } & Result)[];
  anchors: Record<string, unknown>;
  current: Record<string, unknown>;
};

const SETTINGS = {
  orqProjectId: "p9",
  windowDays: 5,
  limit: 40,
  parallelism: 8,
};

for (const [i, c] of g.ranges.entries())
  test(`parse_range matches Python (${i})`, () => {
    const [from, to, tz, fromTz, toTz] = c.args as [
      string,
      string,
      string,
      string | null,
      string | null,
    ];
    const call = () => parseRange(from, to, tz, fromTz, toTz).map(utcIso);
    if (c.error) expect(call).toThrow();
    else expect(call()).toEqual(c.ok as string[]);
  });

for (const [i, c] of g.requests.entries())
  test(`run request matches Python: anchor=${c.anchor} (${i})`, () => {
    const anchor =
      c.anchor === "none" ? null : new PopulationRequest(g.anchors[c.anchor]);
    const call = () =>
      runRequest(new URLSearchParams(c.form), SETTINGS, {
        anchor,
        queryFallback: c.fallback,
      });
    if (c.error) expect(call).toThrow();
    else expect(call()).toEqual(RunRequestSchema.parse(c.ok));
  });

test("default range spans the window ending now", () => {
  const before = Date.now();
  const request = runRequest(
    new URLSearchParams([
      ["query", "q"],
      ["window_days", "3"],
    ]),
    SETTINGS,
  );
  const { start, end, timeOrigin } = request.population;
  expect(timeOrigin).toBe("default");
  const endMs = new Date(end as string).getTime();
  expect(endMs).toBeGreaterThanOrEqual(before - 1);
  expect(endMs - new Date(start as string).getTime()).toBe(3 * 86_400_000);
});

for (const [i, c] of g.compiled.entries())
  test(`reviewed dimension edit matches Python: ${c.current} (${i})`, () => {
    const current = CompiledQuerySchema.parse(g.current[c.current]);
    const call = () =>
      compiledFromForm(current, new URLSearchParams(c.form), "d0_");
    if (c.error) expect(call).toThrow();
    else expect(call()).toEqual(CompiledQuerySchema.parse(c.ok));
  });
