import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { z } from "zod/v4";

import { cliDebug, enabled } from "../../../src/lib/trace-finder/debug.js";
import * as exports from "../../../src/lib/trace-finder/export.js";
import {
  CompiledQuerySchema,
  FacetSelection,
  NumericFilters,
  RunRequestSchema,
  RunSnapshot,
  TraceClassificationSchema,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import {
  reportLoadProgress,
  setLoadReporter,
} from "../../../src/lib/trace-finder/progress.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-export-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  models: { model: string; input: unknown; ok: boolean; expected: unknown }[];
  runs: {
    input: Record<string, unknown>;
    matchedOnly: boolean;
    expected: unknown;
    filename: string;
  }[];
};
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        [
          "criteria",
          "state",
          "probabilities",
          "payload",
          "messages",
          "capture_metadata",
          "raw_result",
        ].includes(key)
          ? item
          : native(item),
      ]),
    );
  return value;
}
function run(input: Record<string, unknown>): RunSnapshot {
  const data = native(input) as Record<string, unknown>;
  return new RunSnapshot({
    ...data,
    request: RunRequestSchema.parse(input.request),
    dimensions: (input.dimensions as unknown[]).map((value) =>
      CompiledQuerySchema.parse(value),
    ),
    traces: (input.traces as unknown[]).map((value) => new TraceRecord(value)),
    results: Object.fromEntries(
      Object.entries(input.results as Record<string, unknown>).map(
        ([id, value]) => [id, TraceClassificationSchema.parse(value)],
      ),
    ),
    generatedFilters: new FacetSelection(input.generated_filters),
    generatedNumeric: new NumericFilters(input.generated_numeric),
  });
}
for (const [i, row] of goldens.models.entries())
  test(`Python trace export model ${i} ${row.model}`, () => {
    const schema = (exports as unknown as Record<string, z.ZodType>)[
      `${row.model}Schema`
    ];
    if (!schema) throw new Error(`Missing export schema ${row.model}`);
    let actual: unknown,
      ok = false;
    try {
      actual = schema.parse(row.input);
      ok = true;
    } catch {}
    expect(ok).toBe(row.ok);
    if (ok) expect<unknown>(actual).toEqual(native(row.expected));
  });
for (const [i, row] of goldens.runs.entries())
  test(`Python trace export ${i}`, () => {
    const source = run(row.input),
      result = exports.buildExport(source, { matchedOnly: row.matchedOnly }),
      json = exports.exportJson(source, { matchedOnly: row.matchedOnly });
    expect<unknown>(result).toEqual(native(row.expected));
    expect<unknown>(JSON.parse(json)).toEqual(native(row.expected));
    expect(exports.exportFilename(source)).toBe(row.filename);
    for (const privateText of [
      "PRIVATE_CONVERSATION",
      "PRIVATE_SUMMARY",
      "PRIVATE_RAW",
    ])
      expect(json).not.toContain(privateText);
    expect(Object.isFrozen(result)).toBe(true);
  });
test("export requires a completed selection and selected traces", () => {
  expect(() => exports.buildExport(new RunSnapshot())).toThrow("no request");
  expect(() => exports.exportFilename(new RunSnapshot())).toThrow(
    "completed run timestamps",
  );
  const source = run(goldens.runs[0]?.input as Record<string, unknown>);
  expect(() =>
    exports.buildExport(new RunSnapshot({ ...source, traceIds: ["missing"] })),
  ).toThrow("missing from the run snapshot");
});
test("debug contexts and loading reporters remain isolated across async tasks", async () => {
  const old = process.env.EVALUATORQ_LOG_LEVEL;
  delete process.env.EVALUATORQ_LOG_LEVEL;
  try {
    expect(enabled()).toBe(false);
    await Promise.all([
      cliDebug({ active: true }, async () => {
        expect(enabled()).toBe(true);
        await Promise.resolve();
        expect(enabled()).toBe(true);
        await cliDebug({ active: false }, async () =>
          expect(enabled()).toBe(false),
        );
        expect(enabled()).toBe(true);
      }),
      cliDebug({ active: false }, async () => {
        await Promise.resolve();
        expect(enabled()).toBe(false);
      }),
    ]);
    expect(enabled()).toBe(false);
    process.env.EVALUATORQ_LOG_LEVEL = "debug";
    expect(cliDebug({ active: false }, enabled)).toBe(true);
  } finally {
    if (old === undefined) delete process.env.EVALUATORQ_LOG_LEVEL;
    else process.env.EVALUATORQ_LOG_LEVEL = old;
  }
  const a: [number, number][] = [],
    b: [number, number][] = [];
  await Promise.all([
    Promise.resolve().then(async () => {
      setLoadReporter((done, total) => a.push([done, total]));
      await Promise.resolve();
      reportLoadProgress(1, 2);
    }),
    Promise.resolve().then(async () => {
      setLoadReporter((done, total) => b.push([done, total]));
      await Promise.resolve();
      reportLoadProgress(3, 4);
    }),
  ]);
  expect(a).toEqual([[1, 2]]);
  expect(b).toEqual([[3, 4]]);
  setLoadReporter(null);
  expect(() => reportLoadProgress(5, 6)).not.toThrow();
});
