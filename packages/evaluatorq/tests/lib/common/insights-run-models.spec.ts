import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  InsightsConfig,
  InsightsRunSchema,
  LabelResult,
  TraceInsightSchema,
} from "../../../src/lib/insights/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-run-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  runs: {
    input: unknown;
    valid: boolean;
    version?: number;
    trace_ids?: string[];
    coords_2d?: unknown[];
    cost?: number | null;
  }[];
};
for (const [i, c] of gold.runs.entries())
  test(`saved Insights run ${i}`, () => {
    const result = InsightsRunSchema.safeParse(c.input);
    expect(result.success).toBe(c.valid);
    if (!result.success || !c.valid) return;
    expect<number | undefined>(result.data.schemaVersion).toBe(c.version);
    expect(result.data.traces.map((t) => t.traceId)).toEqual(c.trace_ids ?? []);
    expect<unknown[]>(result.data.traces.map((t) => t.coords2d)).toEqual(
      c.coords_2d ?? [],
    );
    expect(result.data.costByStage.summary?.inputTokens ?? null).toBe(
      c.cost ?? null,
    );
  });

test("configuration supports native and legacy names and rejects duplicate labels", () => {
  const config = new InsightsConfig({
    labels: [],
    dimensions: ["intent"],
    summary_model: "s",
    classifier_model: "c",
    embedding_model: "e",
    trace_input_chars: 4096,
  });
  expect(config.traceInputChars).toBe(4096);
  expect(config.maxClusters).toBe(15);
  expect(
    () => new InsightsConfig({ labels: [], dimensions: ["intent", "intent"] }),
  ).toThrow();
});

test("failure taxonomy warns only when no clean category was offered", () => {
  const base = {
    counts: {},
    meanConfidence: null,
    nLowConfidence: 0,
    nFailed: 0,
  };
  const old = new LabelResult({
    ...base,
    spec: {
      name: "failure_taxonomy",
      kind: "choice",
      instructions: "Q",
      criteria: { Failure: null },
    },
  });
  const updated = new LabelResult({
    ...base,
    spec: {
      name: "failure_taxonomy",
      kind: "choice",
      instructions: "Q",
      criteria: { "No failure": null, Failure: null },
    },
  });
  expect(old.countsWarning).toContain("No failure");
  expect(updated.countsWarning).toBeNull();
});

test("trace models read legacy and native 2D coordinates", () => {
  expect(
    TraceInsightSchema.parse({ trace_id: "t", coords_2d: { intent: [1, 2] } })
      .coords2d,
  ).toEqual({ intent: [1, 2] });
  expect(
    TraceInsightSchema.parse({ traceId: "t", coords2d: { intent: [1, 2] } })
      .coords2d,
  ).toEqual({ intent: [1, 2] });
  expect(() =>
    TraceInsightSchema.parse({
      traceId: "t",
      coords2d: { intent: [1, 2] },
      coords_2d: { intent: [2, 3] },
    }),
  ).toThrow();
});

test("legacy cache creation usage fields remain visible in saved runs", () => {
  const first = gold.runs[0];
  if (!first || !first.input || typeof first.input !== "object")
    throw new Error("missing fixture");
  const input = {
    ...first.input,
    cost_by_stage: {
      summary: {
        input_tokens: 10,
        total_tokens: 10,
        cache_creation_1h_tokens: 3,
        cache_creation_5m_tokens: 2,
      },
    },
  };
  const parsed = InsightsRunSchema.parse(input);
  expect(parsed.costByStage.summary?.cacheCreation1hTokens).toBe(3);
  expect(parsed.costByStage.summary?.cacheCreation5mTokens).toBe(2);
});

test("separately parsed traces do not share mutable default maps", () => {
  const first = TraceInsightSchema.parse({ traceId: "first" });
  const second = TraceInsightSchema.parse({ traceId: "second" });
  first.assignments.intent = { top: "top", base: "base" };
  first.errors.summary = "failed";
  first.coords.intent = [1, 2, 3];
  expect(second.assignments).toEqual({});
  expect(second.errors).toEqual({});
  expect(second.coords).toEqual({});
});
