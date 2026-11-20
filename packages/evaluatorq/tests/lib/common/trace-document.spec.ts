import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  checkTraceDocument,
  DatasetRefSchema,
  ensureTraceDocument,
  OutcomeSchema,
  TraceDocument,
  TraceMetadataSchema,
  TrajectoryCountsSchema,
  toChatMessages,
  traceDocumentWithSignals,
  trajectoryCounts,
} from "../../../src/lib/common/trace-document.js";
import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { SignalReport } from "../../../src/lib/signals/models.js";
import { computeSignals } from "../../../src/lib/signals/registry.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/trace-document-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  models: {
    model: "DatasetRef" | "Outcome" | "TraceMetadata" | "TrajectoryCounts";
    input: unknown;
    expected: unknown;
    ok: boolean;
  }[];
  rows: {
    input: Record<string, unknown>;
    expected: {
      document: { metadata: Record<string, unknown>; trajectory: unknown };
      messages: unknown;
      coverage: unknown;
      counts: unknown;
      datapoint: { inputs: Record<string, unknown>; expected_output: unknown };
    };
  }[];
};
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function native(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      camel(key),
      ["dataset", "signals"].includes(key) ? native(item) : item,
    ]),
  );
}
const schemas = {
  DatasetRef: DatasetRefSchema,
  Outcome: OutcomeSchema,
  TraceMetadata: TraceMetadataSchema,
  TrajectoryCounts: TrajectoryCountsSchema,
};
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.models.entries())
  test(`Python trace document model ${i} ${row.model}`, () => {
    const result = schemas[row.model].safeParse(row.input);
    expect(result.success).toBe(row.ok);
    if (result.success)
      expect<unknown>(result.data).toEqual(native(row.expected));
  });
for (const [i, row] of goldens.rows.entries())
  test(`Python trace document conversion ${i}`, () => {
    const doc = ensureTraceDocument(row.input),
      expected = row.expected;
    expect<unknown>(doc.metadata).toEqual(native(expected.document.metadata));
    expect<unknown>(doc.trajectory.toModelDict()).toEqual(
      expected.document.trajectory,
    );
    expect<unknown>(doc.messages).toEqual(expected.messages);
    expect<unknown>(toChatMessages(doc)).toEqual(expected.messages);
    expect<unknown>(doc.sourceCoverage).toEqual(expected.coverage);
    expect<unknown>(trajectoryCounts(doc.trajectory)).toEqual(
      native(expected.counts),
    );
    expect<unknown>(doc.toDatapoint()).toEqual({
      inputs: expected.datapoint.inputs,
      expectedOutput: expected.datapoint.expected_output,
    });
    expect(ensureTraceDocument(doc)).toBe(doc);
    expect(doc.traceId).toBe(doc.metadata.traceId);
    const restored = new TraceDocument(JSON.parse(JSON.stringify(doc)));
    expect(restored).toEqual(doc);
  });
test("dataset outcomes, round-trip counts and attached signals retain the canonical trajectory", () => {
  const trajectory = new AtifTrajectory({
      trajectoryId: "test",
      agent: { name: "a", version: "v" },
      steps: [
        { stepId: 1, source: "user", message: "question" },
        {
          stepId: 2,
          source: "agent",
          message: "answer",
          reasoningContent: "thought",
        },
      ],
    }),
    outcome = OutcomeSchema.parse({
      passed: null,
      source: "none",
      definition: "unlabelled",
    }),
    doc = new TraceDocument({
      metadata: {
        traceId: "dataset-row",
        dataset: { name: "set", revision: "v1", rowId: "row" },
        outcome,
      },
      trajectory,
    });
  const counts = trajectoryCounts(trajectory);
  expect(counts.reasoningSteps).toBe(1);
  checkTraceDocument(doc, { expectedCounts: counts, expectedOutcome: outcome });
  expect(doc.toDatapoint().inputs.dataset).toEqual({
    name: "set",
    revision: "v1",
    row_id: "row",
    split: null,
  });
  const report = computeSignals(trajectory),
    attached = traceDocumentWithSignals(doc, report);
  expect(attached.trajectory).toBe(trajectory);
  expect(attached.metadata.signals?.values()).toEqual(report.values());
  expect(doc.metadata.signals).toBeNull();
  expect(() =>
    traceDocumentWithSignals(
      doc,
      new SignalReport({
        trajectoryId: "other",
        results: {},
        configVersion: "v",
      }),
    ),
  ).toThrow("does not match");
  expect(() =>
    checkTraceDocument(doc, {
      expectedCounts: { ...counts, toolCalls: 1 },
      expectedOutcome: outcome,
    }),
  ).toThrow("counts differ");
  expect(() =>
    checkTraceDocument(doc, {
      expectedCounts: counts,
      expectedOutcome: { ...outcome, definition: "changed" },
    }),
  ).toThrow("outcome differs");
});
test("native reasoning and subagent counts remain visible", () => {
  const trajectory = new AtifTrajectory({
    agent: { name: "a", version: "v" },
    steps: [
      {
        stepId: 1,
        source: "agent",
        message: "answer",
        reasoningContent: "think",
      },
    ],
    subagentTrajectories: [
      {
        trajectoryId: "child",
        agent: { name: "child", version: "v" },
        steps: [
          {
            stepId: 1,
            source: "agent",
            message: "",
            toolCalls: [{ toolCallId: "c", functionName: "f", arguments: {} }],
            observation: { results: [{ sourceCallId: "c", content: "done" }] },
            reasoningContent: "think",
          },
        ],
      },
    ],
  });
  const doc = new TraceDocument({
    metadata: { traceId: "t", spanId: "s", timestamp: "2026-11-10T10:00:00Z" },
    trajectory,
  });
  expect(doc.messages).toEqual([
    { role: "assistant", content: "answer", reasoning_content: "think" },
  ]);
  expect(trajectoryCounts(trajectory)).toEqual({
    toolCalls: 1,
    toolResults: 1,
    reasoningSteps: 2,
  });
});
