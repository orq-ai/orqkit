import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildReviewPayload,
  buildSignalDetailPayload,
} from "../../../src/lib/dashboard/insights-review-data.js";
import { reviewTraceKey } from "../../../src/lib/dashboard/insights-review-projection.js";
import { uploadsDir } from "../../../src/lib/dashboard/insights-uploads.js";
import {
  type InsightsRunFields,
  InsightsRunSchema,
} from "../../../src/lib/insights/models.js";
import { FAILURE_TAXONOMY } from "../../../src/lib/insights/presets.js";
import { getInsightsRunsDir } from "../../../src/lib/insights/store.js";
import { SHELL_TOOL_NAMES } from "../../../src/lib/signals/config.js";

type Row = Record<string, unknown>;
const SCRATCH = join(process.env.HOME ?? ".", "insights-review-data-tests");
const previous = process.env.EVALUATORQ_DIR;
let root: string;
let warn: ReturnType<typeof spyOn<Console, "warn">>;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  process.env.EVALUATORQ_DIR = root;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.EVALUATORQ_DIR;
  else process.env.EVALUATORQ_DIR = previous;
});

const frustration = {
  name: "user_frustration",
  kind: "score",
  instructions: "Rate frustration.",
  criteria: ["1 calm", "2 mild", "3 irritated", "4 frustrated", "5 angry"],
};
const failedSpec = {
  name: "failed_question",
  kind: "noul",
  instructions: "Was the question answered?",
};

function trace(spanId: string, update: Row = {}): Row {
  return {
    trace_id: "same-trace",
    span_id: spanId,
    timestamp: "2026-09-01T09:30:00",
    labels: {
      user_frustration: {
        value: 0,
        confidence: null,
        probabilities: null,
        error: null,
      },
      failed_question: {
        value: null,
        confidence: null,
        probabilities: null,
        error: "classifier failed",
      },
    },
    summary: {
      summary: "Short summary",
      request: null,
      task: null,
      topic: "topic",
      assistant_errors: ["None", "A real assistant error."],
      sentiment_explanation: null,
    },
    tool_stats: null,
    assignments: { intent: { top: "intent-t0", base: "intent-b0" } },
    ...update,
  };
}

function run(traces: Row[], update: Row = {}): InsightsRunFields {
  return InsightsRunSchema.parse({
    run_id: "review-test",
    run_name: "Review test",
    created_at: "2026-09-01T12:00:00+00:00",
    status: "completed",
    stage_failures: [],
    population: { mode: "snapshot", limit: traces.length },
    config: { labels: [frustration, failedSpec], dimensions: ["intent"] },
    traces,
    dimensions: {},
    labels: {
      user_frustration: {
        spec: frustration,
        counts: { "1": 1, "5": 1 },
        mean_confidence: null,
        n_low_confidence: 0,
        n_failed: 1,
      },
      failed_question: {
        spec: failedSpec,
        counts: {},
        mean_confidence: null,
        n_low_confidence: 0,
        n_failed: 1,
      },
    },
    priority: null,
    priority_reason: null,
    counts: { n_traces: traces.length },
    warnings: [],
    ...update,
  }) as InsightsRunFields;
}

const rows = async (value: InsightsRunFields) =>
  (await buildReviewPayload(value)).traces as Row[];

test("snapshot runs offer no Orq link and trace links encode the locator", async () => {
  const [row] = await rows(
    run([trace("span ?&", { trace_id: "trace /?&" })], {
      population: { mode: "query" },
    }),
  );
  expect(row?.trace_url).toBe(
    `/insights/review-test/trace?${new URLSearchParams({ trace_id: "trace /?&", span_id: "span ?&", view: "trace" })}`,
  );
  const [snapshot] = await rows(run([trace("s")]));
  expect(snapshot?.orq_url).toBeNull();
});

test("a legacy taxonomy gets a counts warning without changing answers", async () => {
  const criteria = {
    ...(FAILURE_TAXONOMY.criteria as Record<string, unknown>),
  };
  delete criteria["No failure"];
  const legacy = { ...FAILURE_TAXONOMY, criteria };
  const unrelated = {
    name: "other_choice",
    kind: "choice",
    instructions: "Choose.",
    criteria: { yes: null },
  };
  const payloadFor = async (spec: Row, value: string) => {
    const name = String(spec.name);
    const review = await buildReviewPayload(
      run(
        [
          trace("taxonomy-span", {
            labels: {
              [name]: {
                value,
                confidence: 0.9,
                probabilities: null,
                error: null,
              },
            },
          }),
        ],
        {
          config: { labels: [spec], dimensions: ["intent"] },
          labels: {
            [name]: {
              spec,
              counts: { [value]: 1 },
              mean_confidence: 0.9,
              n_low_confidence: 0,
              n_failed: 0,
            },
          },
        },
      ),
    );
    return [(review.labels as Row[])[0], (review.traces as Row[])[0]] as [
      Row,
      Row,
    ];
  };
  const [legacyRow, legacyTrace] = await payloadFor(legacy, "Hallucination");
  expect(legacyRow.counts).toEqual({ Hallucination: 1 });
  expect(String(legacyRow.counts_warning)).toContain(
    "may include clean traces",
  );
  expect(legacyTrace.l).toEqual({ failure_taxonomy: ["Hallucination"] });
  expect(legacyTrace.label_errors).toEqual({});
  for (const [spec, value] of [
    [FAILURE_TAXONOMY as unknown as Row, "No failure"],
    [unrelated, "yes"],
  ] as const) {
    const [labelRow, traceRow] = await payloadFor(spec, value);
    expect(labelRow.counts_warning).toBeNull();
    expect(traceRow.l).toEqual({ [String(spec.name)]: [value] });
  }
});

test("the trace link lands on analysis when the conversation cannot be re-read", async () => {
  const kept = join(root, "kept.json");
  writeFileSync(kept, "{}");
  const upload = join(
    uploadsDir(getInsightsRunsDir()),
    `snapshot-${"0".repeat(32)}.json`,
  );
  const populations: Record<string, Row> = {
    filter: { mode: "filter" },
    "kept snapshot": { mode: "snapshot", snapshot_path: kept },
    "deleted snapshot": {
      mode: "snapshot",
      snapshot_path: join(root, "gone.json"),
    },
    "deleted upload": { mode: "snapshot", snapshot_path: upload },
    dataset: { mode: "dataset" },
  };
  const landings: Record<string, unknown> = {};
  for (const [name, population] of Object.entries(populations))
    landings[name] = (
      await rows(run([trace("s")], { population }))
    )[0]?.trace_url;
  const traceTab =
    "/insights/review-test/trace?trace_id=same-trace&span_id=s&view=trace";
  const analysisTab =
    "/insights/review-test/trace?trace_id=same-trace&span_id=s";
  expect(landings).toEqual({
    filter: traceTab,
    "kept snapshot": traceTab,
    "deleted snapshot": analysisTab,
    "deleted upload": analysisTab,
    dataset: analysisTab,
  });
});

test("rows keep identity, scores, errors and tool stats", async () => {
  const parsed = run([
    trace("span-a", {
      tool_stats: {
        tools: { Bash: 2, Read: 1 },
        skills: { testing: 3 },
        commands: { pytest: 2 },
      },
    }),
    trace("span-b", { tool_stats: {} }),
  ]);
  const payload = await buildReviewPayload(parsed);
  const [first, second] = payload.traces as Row[];
  expect(first?.id).not.toBe(second?.id);
  expect(first?.id).toBe(reviewTraceKey(parsed.traces[0] as never));
  expect(first?.ts).toBe("2026-09-01T09:30:00Z");
  const scores: unknown[] = [];
  for (const index of [0, 1, 2, 3, 4]) {
    const [row] = await rows(
      run([
        trace(`score-${index}`, {
          labels: {
            user_frustration: {
              value: index / 4,
              confidence: null,
              probabilities: null,
              error: null,
            },
          },
        }),
      ]),
    );
    scores.push((row?.l as Record<string, unknown[]>).user_frustration?.[0]);
  }
  expect(scores).toEqual(["1", "2", "3", "4", "5"]);
  expect(first?.label_errors).toEqual({ failed_question: "classifier failed" });
  expect(first?.errors).toEqual(["A real assistant error."]);
  expect((first?.a as Row).intent).toBe("intent-b0");
  expect(first?.tools).toEqual({ Bash: 2, Read: 1 });
  expect(first?.skills).toEqual({ testing: 3 });
  expect(first?.commands).toEqual({ pytest: 2 });
  expect(second?.has_tool_stats).toBe(true);
  expect(second?.tools).toEqual({});
  expect((payload.activity as Row).shell_tools).toEqual(
    [...SHELL_TOOL_NAMES].sort(),
  );
  expect((payload.run as Row).cost).toBeNull();
  expect(payload).not.toHaveProperty("rerun");
  JSON.stringify(payload);
});

test("coding analysis scores are normalized", async () => {
  const [row] = await rows(
    run(
      [
        trace("coding-span", {
          labels: {
            user_corrections: {
              value: 0.5,
              confidence: null,
              probabilities: null,
              error: null,
            },
          },
        }),
      ],
      {
        config: {
          labels: [frustration, failedSpec],
          dimensions: ["intent"],
          coding_analysis: true,
        },
      },
    ),
  );
  expect(row?.l).toEqual({ user_corrections: ["2"] });
});

test("a legacy trace without tool stats or summary is explicitly unmeasured", async () => {
  const legacy = trace("span-old");
  delete legacy.tool_stats;
  const [row] = await rows(run([legacy]));
  expect(row?.has_tool_stats).toBe(false);
  expect(row?.summary).toBe("Short summary");
  expect(row?.request).toBeNull();
  expect(row?.has_summary).toBe(true);
  const [bare] = await rows(
    run([
      {
        trace_id: "missing-summary",
        span_id: "span-summary",
        timestamp: "2026-09-01T00:00:00Z",
      },
    ]),
  );
  expect(bare?.has_summary).toBe(false);
  expect(bare?.summary).toBeNull();
  expect(bare?.errors).toEqual([]);
});

test("signal summaries are compact and the detail payload carries the full report", async () => {
  const report = {
    trajectory_id: "trajectory-1",
    config_version: "signals-v3",
    results: {
      tool_retries: {
        name: "tool_retries",
        group: "B",
        value: 1,
        evidence: [
          {
            step_id: 4,
            agent_path: ["agent-1"],
            call_id: "call-2",
            reason: "retry",
          },
        ],
        approximate: true,
        preconditions: [
          {
            name: "tool_results_present",
            met: "partial",
            detail: "One result omitted",
          },
        ],
      },
      tool_success: {
        name: "tool_success",
        group: "B",
        no_basis: "tool results were not captured",
        preconditions: [
          {
            name: "tool_results_present",
            met: false,
            detail: "No tool results",
          },
        ],
      },
      trajectory_tags: {
        name: "trajectory_tags",
        group: "D",
        value: { coding: true },
      },
    },
  };
  const parsed = run([
    trace("signal-span", {
      signals: report,
      source_coverage: { source: "otel", partial: true },
    }),
  ]);
  const [row] = await rows(parsed);
  expect(row?.has_signals).toBe(true);
  expect(row?.signals).toEqual({
    config_version: "signals-v3",
    results: {
      tool_retries: {
        name: "tool_retries",
        group: "B",
        value: 1,
        approximate: true,
        no_basis: null,
        reason: null,
        rule_version: null,
      },
      tool_success: {
        name: "tool_success",
        group: "B",
        value: null,
        approximate: false,
        no_basis: "tool results were not captured",
        reason: null,
        rule_version: null,
      },
      trajectory_tags: {
        name: "trajectory_tags",
        group: "D",
        value: { coding: true },
        approximate: false,
        no_basis: null,
        reason: null,
        rule_version: null,
      },
    },
  });
  expect(row?.signal_detail_url).toBe(
    "/insights/review-test/trace-signals.json?trace_id=same-trace&span_id=signal-span",
  );
  const serialized = JSON.stringify(row);
  expect(serialized).not.toContain("call-2");
  expect(serialized).not.toContain("tool_results_present");
  const detail = buildSignalDetailPayload(parsed, "same-trace", "signal-span");
  expect((detail?.signals as Row).trajectory_id).toBe("trajectory-1");
  expect(JSON.stringify(detail?.signals)).toContain("call-2");
  expect(detail?.source_coverage).toEqual({ source: "otel", partial: true });
  expect(buildSignalDetailPayload(parsed, "same-trace", "other")).toBeNull();
});

test("a run without signals has no signal detail url", async () => {
  const [row] = await rows(run([trace("legacy-signal-span")]));
  expect(row?.has_signals).toBe(false);
  expect(row?.signals).toBeNull();
  expect(row?.signal_detail_url).toBeNull();
});

test("the source label matches the run form tabs", async () => {
  for (const [mode, label] of [
    ["filter", "Orq traces"],
    ["query", "Orq traces matching a question"],
    ["export", "Trace file (Finder export)"],
    ["snapshot", "Trace file"],
  ])
    expect(
      ((await buildReviewPayload(run([], { population: { mode } }))).run as Row)
        .source_label,
    ).toBe(label);
});

test("null answers are label errors and yes/no answers send label keys", async () => {
  const nullAnswer = trace("span-null");
  (nullAnswer.labels as Row).user_frustration = {
    value: null,
    confidence: null,
    probabilities: null,
    error: null,
  };
  const [row] = await rows(run([nullAnswer]));
  expect(row?.l).not.toHaveProperty("user_frustration");
  expect((row?.label_errors as Row).user_frustration).toBe(
    "The question returned no answer",
  );
  const yes = trace("span-yes");
  (yes.labels as Row).failed_question = {
    value: true,
    confidence: null,
    probabilities: null,
    error: null,
  };
  const no = trace("span-no");
  (no.labels as Row).failed_question = {
    value: false,
    confidence: null,
    probabilities: null,
    error: null,
  };
  expect(
    (await rows(run([yes, no]))).map((item) => (item.l as Row).failed_question),
  ).toEqual([["yes"], ["no"]]);
});
