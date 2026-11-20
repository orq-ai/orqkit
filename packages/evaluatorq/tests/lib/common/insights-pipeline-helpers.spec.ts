import { expect, test } from "bun:test";

import {
  LabelSpec,
  TraceInsightSchema,
} from "../../../src/lib/insights/models.js";
import {
  aggregateLabelResults,
  dimensionSource,
  discardDimension,
  resolveLabelSpecs,
} from "../../../src/lib/insights/pipeline.js";

test("label presets add sentiment and reject collisions", () => {
  expect(resolveLabelSpecs([], ["sentiment"]).map((spec) => spec.name)).toEqual(
    ["sentiment"],
  );
  expect(() => resolveLabelSpecs(["unknown"], [])).toThrow(
    "unknown Insights label preset",
  );
  expect(() => resolveLabelSpecs(["sentiment", "sentiment"], [])).toThrow(
    "unique",
  );
  expect(() =>
    resolveLabelSpecs(
      [
        new LabelSpec({
          name: "verified",
          kind: "choice",
          instructions: "Check",
          criteria: { yes: null },
        }),
      ],
      [],
    ),
  ).toThrow("reserved");
});
test("label aggregation separates failed, missing and low-confidence answers", () => {
  const spec = new LabelSpec({
    name: "done",
    kind: "noul",
    instructions: "Done?",
  });
  const traces = [
    TraceInsightSchema.parse({
      traceId: "1",
      labels: {
        done: {
          value: true,
          confidence: 0.5,
          probabilities: null,
          error: null,
        },
      },
    }),
    TraceInsightSchema.parse({
      traceId: "2",
      labels: {
        done: {
          value: false,
          confidence: 0.9,
          probabilities: null,
          error: null,
        },
      },
    }),
    TraceInsightSchema.parse({
      traceId: "3",
      labels: {
        done: {
          value: null,
          confidence: null,
          probabilities: null,
          error: "failed",
        },
      },
    }),
    TraceInsightSchema.parse({ traceId: "4" }),
  ];
  expect(aggregateLabelResults(traces, [spec]).done).toMatchObject({
    counts: { yes: 1, no: 1 },
    meanConfidence: 0.7,
    nLowConfidence: 1,
    nFailed: 1,
    nNotAsked: 1,
  });
});
test("dimension source and cleanup preserve unrelated results", () => {
  const trace = TraceInsightSchema.parse({
    traceId: "1",
    summary: {
      summary: "summary",
      request: "fix tests",
      task: null,
      topic: null,
      assistant_errors: ["none", "bad output"],
      sentiment_explanation: "frustrated",
      languages: [],
    },
    assignments: { intent: { top: "t", base: "b" } },
    coords: { intent: [1, 2, 3] },
    coords2d: { intent: [1, 2] },
    errors: { "dimension:intent": "fail", summary: "other" },
  });
  expect(dimensionSource(trace, "intent")).toBe("fix tests");
  expect(dimensionSource(trace, "failure")).toBe("bad output");
  discardDimension([trace], "intent");
  expect(trace.assignments).toEqual({});
  expect(trace.coords).toEqual({});
  expect(trace.coords2d).toEqual({});
  expect(trace.errors).toEqual({ summary: "other" });
});

test("match filtering excludes false and unknown matches without losing failures", async () => {
  const { applyLabelOutcomes } = await import(
    "../../../src/lib/insights/pipeline.js"
  );
  const { TraceRecord } = await import(
    "../../../src/lib/trace-finder/models.js"
  );
  const records = ["a", "b", "c"].map(
    (id) =>
      new TraceRecord({
        schemaVersion: 1,
        traceId: id,
        spanId: "s",
        timestamp: "2026-11-10T00:00:00Z",
        project: "p",
        model: "m",
        provider: "p",
        status: "ok",
        product: "agents",
        traceType: "agent",
        messages: [{ role: "user", content: "test" }],
      }),
  );
  const traces = records.map((record) =>
    TraceInsightSchema.parse({ traceId: record.traceId }),
  );
  const outcomes = [
    {
      trace: records[0] as InstanceType<typeof TraceRecord>,
      answers: {},
      matched: true,
      error: null,
    },
    {
      trace: records[1] as InstanceType<typeof TraceRecord>,
      answers: {},
      matched: false,
      error: null,
    },
    {
      trace: records[2] as InstanceType<typeof TraceRecord>,
      answers: {},
      matched: null,
      error: "unreadable",
    },
  ];
  const result = applyLabelOutcomes(traces, outcomes, true);
  expect(result.traces.map((trace) => trace.traceId)).toEqual(["a"]);
  expect(result.nMatched).toBe(1);
  expect(result.nFailedMatch).toBe(1);
  expect(result.warnings[0]).toContain("unreadable");
  expect(result.allFailed).toBe(false);
});

test("run configuration resolves coding labels and rejects invalid selections", async () => {
  const { prepareInsightsConfig } = await import(
    "../../../src/lib/insights/pipeline.js"
  );
  const configured = await prepareInsightsConfig({
    dimensions: ["intent"],
    codingLabels: ["verified"],
    classifierModel: "test/classifier",
    traceInputChars: 4096,
  });
  expect(configured.codingEnabled).toBe(true);
  expect(configured.config.codingLabels.map((spec) => spec.name)).toEqual([
    "verified",
  ]);
  expect(configured.finderClassifierModel).toBe("test/classifier");
  expect(configured.config.traceInputChars).toBe(4096);
  await expect(
    prepareInsightsConfig({ codingLabels: ["unknown"] }),
  ).rejects.toThrow("unknown Insights coding label");
  await expect(
    prepareInsightsConfig({ codingLabels: ["verified", "verified"] }),
  ).rejects.toThrow("unique");
});
