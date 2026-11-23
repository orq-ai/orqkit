import { expect, test } from "bun:test";

import {
  clusterDetail,
  crosstab,
  dimensions,
  failures,
  header,
  labels,
  mapPayload,
  mapTab,
  priorityMatrix,
  progress,
  traceDetailPage,
  traces,
} from "../../../src/lib/dashboard/insights-views.js";
import {
  type InsightsRunFields,
  InsightsRunSchema,
} from "../../../src/lib/insights/models.js";
import {
  FAILURE_TAXONOMY,
  SENTIMENT,
} from "../../../src/lib/insights/presets.js";

const cluster = (id: string, level: string, parent: string | null) => ({
  id,
  parent_id: parent,
  level,
  name: "General requests",
  description: "Traces about general requests.",
  size: 2,
  trace_ids: ["trace-1", "trace-2"],
  example_trace_ids: ["trace-1"],
});

const traceRow = (
  n: 1 | 2,
  value: string,
  summary: string,
  coords: number[],
) => ({
  trace_id: `trace-${n}`,
  span_id: `span-${n}`,
  timestamp: `2026-09-0${n}T00:00:00+00:00`,
  agent_name: "support-bot",
  project: "default",
  labels: {
    sentiment: { value, confidence: 0.9, probabilities: null, error: null },
  },
  summary: {
    summary,
    request: "What is the refund policy?",
    task: "answer question",
    topic: "refunds",
    sentiment_explanation: "calm",
  },
  assignments: { intent: { top: "top-1", base: "base-1" } },
  coords: { intent: coords },
});

function raw(): Record<string, unknown> {
  return {
    run_id: "run-1",
    run_name: "minimal run",
    created_at: "2026-09-01T00:00:00+00:00",
    status: "completed",
    stage_failures: [],
    population: {
      request: null,
      query: null,
      n_scanned: 2,
      n_matched: 2,
      n_failed_match: 0,
    },
    config: { labels: [SENTIMENT], dimensions: ["intent"] },
    traces: [
      traceRow(1, "positive", "A user asked a question.", [0.1, 0.2, 0.3]),
      traceRow(2, "neutral", "A user reported an issue.", [0.4, 0.5, 0.6]),
    ],
    dimensions: {
      intent: {
        name: "intent",
        source_field: "request",
        clusters: [
          cluster("top-1", "top", null),
          cluster("base-1", "base", "top-1"),
        ],
        n_noise: 0,
        n_no_signal: 0,
        n_failed: 0,
        warnings: [],
      },
    },
    labels: {
      sentiment: {
        spec: SENTIMENT,
        counts: { positive: 1, neutral: 1 },
        mean_confidence: 0.8,
        n_low_confidence: 0,
        n_failed: 0,
      },
    },
    priority: null,
    priority_reason: "customer_satisfaction label not requested",
    counts: { n_traces: 2 },
    warnings: [],
    cost_by_stage: {},
  };
}

const run = (update: Record<string, unknown> = {}): InsightsRunFields =>
  InsightsRunSchema.parse({ ...raw(), ...update }) as InsightsRunFields;

test("header shows partial cost and the trace-selection caveat", () => {
  const html = header(
    run({
      cost_by_stage: {
        summary: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          total_cost: 0.01,
          calls: 2,
          priced_calls: 1,
        },
      },
    }),
  );
  expect(html).toContain("priced for 1 of 2 calls");
  expect(html).toContain("excludes trace selection");
});

test("header hides untracked cost and marks unknown cost", () => {
  expect(header(run())).not.toContain("$");
  expect(header(run({ cost_by_stage: { summary: null } }))).toContain(
    "cost unknown",
  );
});

test("a local snapshot run offers no Orq links", async () => {
  const snapshot = run({ population: { mode: "snapshot", limit: 2 } });
  expect(header(snapshot)).toContain("trace file");
  expect(await clusterDetail(snapshot, "base-1")).not.toContain("Open in Orq");
  const table = await traces(snapshot);
  expect(table).not.toContain("<th>Orq</th>");
  expect(table).not.toContain("↗ Orq");
  expect(table).toContain(
    'href="/insights/run-1/trace?trace_id=trace-1&amp;span_id=span-1"',
  );
  const detail = await traceDetailPage(snapshot, snapshot.traces[0] as never);
  expect(detail).toContain("A user asked a question.");
  expect(detail).toContain("General requests");
  expect(detail).not.toContain("Open full trace in Orq");
});

test("character input coverage is shown for loaded traces", async () => {
  const notice = await failures(
    run({
      population: {
        mode: "filter",
        n_traces: 2,
        n_projection_truncated: 1,
        n_source_messages: 10,
        n_omitted_messages: 3,
        source_chars: 120_000,
        classifier_state_chars: 65_000,
        summary_input_chars: 100_000,
        classifier_state_format: "jev",
        classifier_question_reserve: "applied",
        trace_input_chars: 500_000,
      },
    }),
  );
  expect(notice).toContain(
    "1 of 2 traces hit a summary or classifier input cap of 500,000 characters.",
  );
  expect(notice).toContain(
    "3 of 10 source messages were omitted from the Jev classifier state.",
  );
});

test("projection warnings are not repeated below coverage", async () => {
  const population = {
    n_traces: 1,
    n_projection_truncated: 1,
    n_source_messages: 2,
    n_omitted_messages: 1,
    source_chars: 60_000,
    classifier_state_chars: 30_000,
    summary_input_chars: 30_000,
    classifier_state_format: "jev",
    classifier_question_reserve: "applied",
    trace_input_chars: 500_000,
  };
  const notice = await failures(
    run({
      population,
      warnings: [
        "Projection budget: 1 of 1 traces exceeded the model projection budget; 1 of 2 whole messages were omitted.",
      ],
    }),
  );
  expect(notice.split("Model input coverage").length - 1).toBe(1);
  expect(notice).not.toContain("Run warnings");
  const earlier = await failures(
    run({
      population,
      warnings: [
        "1 of 1 traces exceeded the model projection budget; 1 of 2 whole messages were omitted from classification and summaries.",
      ],
    }),
  );
  expect(earlier).not.toContain("Run warnings");
});

test("an earlier run does not invent character coverage", async () => {
  const notice = await failures(
    run({
      population: { mode: "snapshot", n_scanned: 2, n_projection_truncated: 1 },
    }),
  );
  expect(notice).toContain(
    "Input character coverage was not recorded for this earlier run.",
  );
});

test("one failed trace uses singular wording", async () => {
  expect(await failures(run({ counts: { n_failed_traces: 1 } }))).toContain(
    "1 trace had a label",
  );
});

test("failure taxonomy clean answers stay filterable", async () => {
  const base = raw();
  const rows = (base.traces as ReturnType<typeof traceRow>[]).map(
    (row, index) => ({
      ...row,
      labels: {
        failure_taxonomy: {
          value: ["No failure", "Hallucination"][index],
          confidence: 0.9,
          probabilities: null,
          error: null,
        },
      },
    }),
  );
  const taxonomy = run({
    config: { labels: [FAILURE_TAXONOMY], dimensions: ["intent"] },
    traces: rows,
    labels: {
      failure_taxonomy: {
        spec: FAILURE_TAXONOMY,
        counts: { "No failure": 1, Hallucination: 1 },
        mean_confidence: 0.9,
        n_low_confidence: 0,
        n_failed: 0,
      },
    },
  });
  const filtered = await traces(taxonomy, {
    label: "failure_taxonomy",
    value: "No failure",
  });
  expect(filtered).toContain("trace-1");
  expect(filtered).not.toContain("trace-2");
});

test("score labels use criterion names and ignore failed answers", async () => {
  const score = {
    name: "customer_satisfaction",
    kind: "score",
    instructions: "Rate satisfaction.",
    criteria: ["low", "mid", "high"],
  };
  const base = raw();
  const rows = base.traces as ReturnType<typeof traceRow>[];
  const scored = run({
    config: { labels: [SENTIMENT, score], dimensions: ["intent"] },
    traces: [
      {
        ...rows[0],
        labels: {
          ...rows[0]?.labels,
          customer_satisfaction: {
            value: 0.5,
            confidence: 0.9,
            probabilities: null,
            error: null,
          },
        },
      },
      {
        ...rows[1],
        labels: {
          ...rows[1]?.labels,
          customer_satisfaction: {
            value: 0.75,
            confidence: null,
            probabilities: null,
            error: "invalid score",
          },
        },
      },
    ],
    labels: {
      ...(base.labels as object),
      customer_satisfaction: {
        spec: score,
        counts: { "2": 1, "1": 1 },
        mean_confidence: 0.9,
        n_low_confidence: 0,
        n_failed: 1,
      },
    },
  });
  const html = labels(scored);
  expect(html).toContain(">mid</span>");
  expect(html.indexOf(">mid</span>")).toBeLessThan(
    html.indexOf(">high</span>"),
  );
  expect(await clusterDetail(scored, "base-1")).toContain("mid 1/2");
  const filtered = await traces(scored, {
    label: "customer_satisfaction",
    value: "1",
  });
  expect(filtered).toContain("trace-1");
  expect(filtered).not.toContain("trace-2");
  expect(
    await traces(scored, { label: "customer_satisfaction", value: "2" }),
  ).toContain("No traces match these filters");
});

test("progress renders completed and total for a running stage", () => {
  const html = progress({
    stage: "label",
    stages: [
      {
        name: "label",
        status: "running",
        startedAt: new Date(),
        completed: 40,
        total: 100,
      },
    ],
    plannedStages: ["label"],
    stageLabels: { label: "Classify traces" },
    status: "running",
    error: null,
    startedAt: new Date(),
  } as never);
  expect(html).toContain("<small>40/100</small>");
  expect(html).toContain("Classify");
  expect(html).toContain("Running");
});

test("crosstab links cells to filtered traces", () => {
  const html = crosstab(run(), {});
  expect(html).toContain("tab/traces?row=dimension%3Aintent");
  expect(html).toContain('<option value="label:sentiment" selected>');
});

test("priority chart has an empty state", () => {
  expect(priorityMatrix(run())).toContain(
    "customer_satisfaction label not requested",
  );
});

test("dimensions has no map and the map tab shows missing coordinates", () => {
  const html = dimensions(run());
  expect(html).not.toContain("insights-map-chart");
  const missing = run({
    traces: (raw().traces as ReturnType<typeof traceRow>[]).map((row) => ({
      ...row,
      coords: {},
    })),
  });
  expect(mapTab(missing)).toContain(
    "Map unavailable: UMAP coordinates were not produced for this dimension.",
  );
});

test("map payload colours by cluster with snake keys and reports unknown labels", () => {
  const payload = mapPayload(run(), "intent") as {
    points: Record<string, unknown>[];
    color_mode: string;
  };
  expect(payload.color_mode).toBe("cluster");
  expect(payload.points[0]).toMatchObject({
    trace_id: "trace-1",
    cluster_id: "base-1",
    symbol: "circle",
    x: 0.1,
  });
  expect(mapPayload(run(), "intent", "label:nope")).toEqual({
    error: "Unknown or unsupported colour label: nope",
    points: [],
  });
  const byLabel = mapPayload(run(), "intent", "label:sentiment") as {
    color_mode: string;
    legend: unknown[];
  };
  expect(byLabel.color_mode).toBe("category");
  expect(byLabel.legend).toHaveLength(2);
});
