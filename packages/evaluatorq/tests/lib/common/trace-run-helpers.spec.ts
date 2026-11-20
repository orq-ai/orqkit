import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  FacetSelection,
  NumericFilters,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import {
  mergeRunFacets,
  nothingKeptMessage,
  uncoveredWordsWarning,
  unsupportedWarning,
  withinFacets,
  withinNumeric,
} from "../../../src/lib/trace-finder/run-store.js";

const cases = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-run-helpers-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  status: string | null;
  tool: string | null;
  low: number | null;
  high: number | null;
  within_facets: boolean;
  within_numeric: boolean;
  reason: string;
}[];
const trace = new TraceRecord({
  schemaVersion: 1,
  traceId: "x",
  spanId: "s",
  timestamp: "2026-11-10T00:00:00Z",
  project: "p",
  model: "unknown",
  provider: "p",
  status: "ok",
  product: "agents",
  traceType: "agent",
  messages: [{ role: "user", content: "0" }],
  toolNames: ["search"],
  totalTokens: 10,
  durationMs: 20,
});
for (const c of cases)
  test(`run filter ${JSON.stringify([c.status, c.tool, c.low, c.high])}`, () => {
    const facets = new FacetSelection({
        status: c.status ? [c.status] : [],
        toolName: c.tool ? [c.tool] : [],
      }),
      numeric = new NumericFilters({ tokensMin: c.low, tokensMax: c.high });
    expect(withinFacets(trace, facets)).toBe(c.within_facets);
    expect(withinNumeric(trace, numeric)).toBe(c.within_numeric);
    expect(nothingKeptMessage([trace], facets, numeric)).toBe(c.reason);
  });

test("run facets preserve the caller project scope", () => {
  const caller = new FacetSelection({ projectId: null, status: ["ok"] });
  const generated = new FacetSelection({
    projectId: "generated",
    status: ["error"],
    model: ["m"],
  });
  const merged = mergeRunFacets(caller, generated);
  expect(merged.projectId).toBeNull();
  expect([...merged.status]).toEqual(["ok"]);
  expect([...merged.model]).toEqual(["m"]);
});

test("bounded missing values are excluded and duration bounds are inclusive", () => {
  expect(
    withinNumeric(
      trace,
      new NumericFilters({ durationMsMin: 20, durationMsMax: 20 }),
    ),
  ).toBe(true);
  const missing = new TraceRecord({ ...trace, durationMs: null });
  expect(withinNumeric(missing, new NumericFilters({ durationMsMin: 0 }))).toBe(
    false,
  );
  expect(
    nothingKeptMessage(
      [missing],
      new FacetSelection(),
      new NumericFilters({ durationMsMin: 0 }),
    ),
  ).toBe(
    "None of the 1 loaded traces have a duration of at least 0 ms. Try New search to look beyond the loaded rows.",
  );
});

test("planning warnings match Python", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/trace-run-warnings-python-goldens.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { query: string; filtered: boolean; result: string | null }[];
  for (const c of cases)
    expect(
      uncoveredWordsWarning(
        c.query,
        [],
        new FacetSelection({ status: c.filtered ? ["error"] : [] }),
      ),
    ).toBe(c.result);
  expect(
    uncoveredWordsWarning("payment", [{}], new FacetSelection()),
  ).toBeNull();
  expect(unsupportedWarning(null)).toBeNull();
  expect(unsupportedWarning("Try a count.")).toBe(
    "Ask AI finds traces; it can't compute totals, averages or rankings. Try a count.",
  );
});
