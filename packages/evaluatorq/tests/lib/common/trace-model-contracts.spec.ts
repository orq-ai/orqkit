import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { z } from "zod/v4";

import * as models from "../../../src/lib/trace-finder/models.js";

const goldens = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-model-contracts-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  models: { model: string; input: unknown; expected: unknown; ok: boolean }[];
  populations: { input: unknown; time: string; expected: boolean }[];
  selections: { input: unknown; expected: string[] }[];
  snapshot: unknown;
};
const free = new Set([
  "payload",
  "messages",
  "capture_metadata",
  "raw_result",
  "probabilities",
  "value_counts",
  "results",
  "projections",
  "provenance",
  "state",
  "criteria",
]);
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key === "unknown_field"
          ? key
          : key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        free.has(key) ? item : native(item),
      ]),
    );
  return value;
}
function serialized(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(serialized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialized(item)]),
    );
  return value;
}
for (const [i, row] of goldens.models.entries())
  test(`Python trace-finder model ${i} ${row.model}`, () => {
    const schema = (models as unknown as Record<string, z.ZodType>)[
      `${row.model}Schema`
    ];
    if (!schema) throw new Error(`Missing model schema: ${row.model}`);
    let actual: unknown,
      ok = false;
    try {
      actual = schema.parse(row.input);
      ok = true;
    } catch {}
    expect(ok).toBe(row.ok);
    if (ok) expect<unknown>(serialized(actual)).toEqual(native(row.expected));
  });
for (const [i, row] of goldens.populations.entries())
  test(`Python trace population bound ${i}`, () =>
    expect(new models.PopulationRequest(row.input).containsTime(row.time)).toBe(
      row.expected,
    ));
for (const [i, row] of goldens.selections.entries())
  test(`Python trace selection label ${i}`, () =>
    expect<unknown>(
      models.selectionRuleText(models.CompiledQuerySchema.parse(row.input)),
    ).toEqual(row.expected));
test("run snapshot defaults match Python and maps detach from caller mutation", () => {
  const snapshot = new models.RunSnapshot();
  expect<unknown>(serialized(snapshot)).toEqual(native(goldens.snapshot));
  const results = {
      t: models.TraceClassificationSchema.parse({ traceId: "t", spanId: "s" }),
    },
    provenance = { source: "before" };
  const changed = new models.RunSnapshot({ results, provenance });
  provenance.source = "after";
  delete (results as Partial<typeof results>).t;
  expect(changed.results.t?.traceId).toBe("t");
  expect(changed.provenance.source).toBe("before");
  expect(Object.isFrozen(changed.results)).toBe(true);
  expect(Object.isFrozen(changed.provenance)).toBe(true);
  expect(Object.isFrozen(changed)).toBe(true);
});
test("facet selections expose immutable sets and population defaults are independent", () => {
  const selection = new models.FacetSelection({ model: ["a", "b", "a"] });
  expect([...selection.model]).toEqual(["a", "b"]);
  expect(() => (selection.model as Set<string>).add("c")).toThrow("frozen");
  expect(() => (selection.model as Set<string>).delete("a")).toThrow("frozen");
  expect(() => (selection.model as Set<string>).clear()).toThrow("frozen");
  expect(JSON.parse(JSON.stringify(selection)).model).toEqual(["a", "b"]);
  const first = new models.PopulationRequest(),
    second = new models.PopulationRequest();
  expect(first.facets).not.toBe(second.facets);
  expect(first.numeric).not.toBe(second.numeric);
});
test("compiled query direct validation uses the same rules as the schema", () => {
  const compiled = models.CompiledQuerySchema.parse({
    task: { kind: "noul", instructions: "?", state: {} },
    selection: { kind: "values", values: [true] },
  });
  models.validateCompiledQuery(compiled.task, compiled.selection);
  expect(() =>
    models.validateCompiledQuery(
      { ...compiled.task, state: { extra: 1 } },
      compiled.selection,
    ),
  ).toThrow("state must be exactly");
  expect(() =>
    models.validateCompiledQuery(compiled.task, {
      kind: "threshold",
      operator: "gte",
      value: 0.5,
    }),
  ).toThrow("noul tasks");
});
test("snapshot emptiness and trace detail preserve typed models", () => {
  expect(new models.Snapshot({ traces: [] }).isEmpty).toBe(true);
  const trace = new models.TraceRecord({
    schemaVersion: 1,
    traceId: "t",
    spanId: "s",
    timestamp: "2026-11-10T10:00:00Z",
    project: "p",
    model: "m",
    provider: "p",
    status: "ok",
    product: "agents",
    traceType: "agent",
    messages: [{ role: "user", content: "u" }],
  });
  expect(new models.Snapshot({ traces: [trace] }).isEmpty).toBe(false);
  expect(new models.TraceDetail(trace, null, null).trace).toBe(trace);
  expect(models.FACET_NAMES).toContain("trace_type");
  expect(models.MAX_DIMENSIONS).toBe(3);
  expect(models.FILTER_OR_JUDGMENT_RULE).toContain('"tool errors" -> judgment');
});
