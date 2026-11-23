import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { pythonString } from "../../../src/lib/common/sanitize.js";
import {
  normaliseUsage,
  parseSummaryTime,
  rowFromSummary,
  TraceRow,
} from "../../../src/lib/trace-finder/rows.js";
import {
  isErrorSpan,
  spanStatusText,
} from "../../../src/lib/trace-finder/span-status.js";
import {
  KIND_LABELS,
  preview,
  segments,
} from "../../../src/lib/trace-finder/trajectory.js";

const goldens = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-foundations-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  rowModels: {
    input: unknown;
    expected: Record<string, unknown> | null;
    ok: boolean;
  }[];
  usageValues: unknown[];
  usage: unknown[][];
  statuses: { input: unknown; expected: string | null; isError: boolean }[];
  times: { input: unknown; expected: string | null }[];
  rows: {
    summary: unknown;
    raw: Record<string, unknown> | null;
    expected: Record<string, unknown> | null;
    displayModels: string[] | null;
    displayProviders: string[] | null;
    cachePct: number | null;
    isError: boolean | null;
  }[];
  segments: { input: Record<string, unknown>[]; expected: unknown }[];
  previews: { input: string; expected: string }[];
};
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
for (const [i, expected] of goldens.usage.entries())
  test(`Python trace summary usage ${i}`, () => {
    let n = i;
    const indices: number[] = [];
    for (let j = 0; j < 5; j++) {
      indices.unshift(n % goldens.usageValues.length);
      n = Math.floor(n / goldens.usageValues.length);
    }
    const input = Object.fromEntries(
      [
        "prompt_tokens",
        "completion_tokens",
        "prompt_cached_tokens",
        "prompt_cache_creation_tokens",
        "completion_reasoning_tokens",
      ].map((key, j) => [key, goldens.usageValues[indices[j] as number]]),
    );
    expect(Object.values(normaliseUsage(input))).toEqual(expected);
  });
for (const [i, row] of goldens.statuses.entries())
  test(`Python span status ${i}`, () => {
    expect(spanStatusText(row.input)).toBe(row.expected);
    expect(isErrorSpan(row.input)).toBe(row.isError);
  });
for (const [i, row] of goldens.times.entries())
  test(`Python trace summary timestamp ${i}`, () =>
    expect(parseSummaryTime(row.input)).toBe(row.expected));
for (const [i, row] of goldens.rows.entries())
  test(`Python trace summary row ${i}`, () => {
    const result = rowFromSummary(row.summary, row.raw);
    if (row.expected === null) {
      expect(result).toBeNull();
      return;
    }
    expect<unknown>(result).toEqual(
      Object.fromEntries(
        Object.entries(row.expected).map(([key, value]) => [camel(key), value]),
      ),
    );
    expect<unknown>(result?.displayModels).toEqual(row.displayModels);
    expect<unknown>(result?.displayProviders).toEqual(row.displayProviders);
    expect(result?.cachePct).toBe(row.cachePct);
    expect<unknown>(result?.isError).toBe(row.isError);
    expect(Object.isFrozen(result)).toBe(true);
  });
for (const [i, row] of goldens.segments.entries())
  test(`Python trajectory segments ${i}`, () =>
    expect<unknown>(segments(row.input)).toEqual(row.expected));
for (const [i, row] of goldens.previews.entries())
  test(`Python trajectory preview ${i}`, () =>
    expect(preview(row.input)).toBe(row.expected));
test("native row aliases preserve raw protocol keys and arrays are immutable", () => {
  const input = {
    trace_id: "t",
    models: ["requested"],
    response_models: ["p/requested", "q/served"],
    raw: { tool_name: "keep_wire", __proto__: null },
  };
  const row = new TraceRow(input);
  expect(row.traceId).toBe("t");
  expect(row.raw.tool_name).toBe("keep_wire");
  expect(row.displayModels).toEqual(["p/requested", "q/served"]);
  expect(row.displayProviders).toEqual(["p", "q"]);
  expect(Object.isFrozen(row.models)).toBe(true);
  expect(() => new TraceRow({ ...input, traceId: "different" })).toThrow(
    "Conflicting",
  );
  expect(() => new TraceRow({})).toThrow();
});
test("token normalization retains unknowns and rejects non-finite integer rollups", () => {
  expect(normaliseUsage(null)).toEqual({
    tokensIn: null,
    tokensOut: null,
    cached: null,
    cacheWrite: null,
    reasoning: null,
    exclusive: false,
  });
  for (const n of [NaN, Infinity, -Infinity])
    expect(() => normaliseUsage({ prompt_tokens: n })).toThrow();
  expect(pythonString(NaN)).toBe("nan");
  expect(pythonString(Infinity)).toBe("inf");
  expect(pythonString(-Infinity)).toBe("-inf");
});
test("segment kinds are explicit and JSON preview clips only display text", () => {
  expect(Object.keys(KIND_LABELS)).toEqual([
    "system",
    "user",
    "assistant",
    "reasoning",
    "call",
    "result",
    "other",
  ]);
  const messages = [{ role: "user", content: "😀".repeat(1000) }],
    out = segments(messages);
  expect(out[0]?.tokens).toBe(250);
  expect([...(out[0]?.preview ?? "")].length).toBe(241);
  expect(messages[0]?.content.length).toBe(2000);
});

for (const [i, row] of goldens.rowModels.entries())
  test(`Python trace row model ${i}`, () => {
    let result: TraceRow | null = null;
    try {
      result = new TraceRow(row.input);
    } catch {}
    expect(result !== null).toBe(row.ok);
    if (result && row.expected)
      expect<unknown>(result).toEqual(
        Object.fromEntries(
          Object.entries(row.expected).map(([key, value]) => [
            camel(key),
            value,
          ]),
        ),
      );
  });
test("summary raw payload keeps special dictionary keys", () => {
  const raw = JSON.parse(
    '{"trace_id":"t","__proto__":{"x":1},"constructor":"keep"}',
  );
  const row = rowFromSummary(raw, raw);
  expect(Object.hasOwn(row?.raw ?? {}, "__proto__")).toBe(true);
  expect(row?.raw.constructor as unknown).toBe("keep");
});
