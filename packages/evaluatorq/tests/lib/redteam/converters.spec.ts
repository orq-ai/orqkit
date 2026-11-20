import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type { ZodType } from "zod/v4";

import {
  AgentContextSchema,
  AgentResponse,
} from "../../../src/lib/contracts.js";
import {
  coerceJobOutputPayload,
  coerceJobOutputText,
  dynamicEvaluatorqResultsToReport,
  staticEvaluatorqResultsToReports,
  staticResultsToReport,
  staticSampleToResult,
} from "../../../src/lib/redteam/reports/converters.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import * as staged from "../../../src/lib/redteam/reports/staged.js";
import goldens from "../fixtures/redteam-converter-python-goldens.json" with {
  type: "json",
};

const schemas: Record<string, ZodType> = {
  EvaluatedRow: staged.EvaluatedRowSchema,
  AttackEvaluationRow: staged.AttackEvaluationRowSchema,
  DynamicAttackResultRow: staged.DynamicAttackResultRowSchema,
  DynamicCategorySummaryRow: staged.DynamicCategorySummaryRowSchema,
  ErrorTypeDetails: staged.ErrorTypeDetailsSchema,
  DynamicErrorAnalysisRow: staged.DynamicErrorAnalysisRowSchema,
  DynamicRunMetadata: staged.DynamicRunMetadataSchema,
  StrategySelectionRow: staged.StrategySelectionRowSchema,
  GeneratedPromptRow: staged.GeneratedPromptRowSchema,
  DynamicSummaryReportRow: staged.DynamicSummaryReportRowSchema,
  DatasetInferenceRow: staged.DatasetInferenceRowSchema,
  ReportSnapshot: staged.ReportSnapshotSchema,
};
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
function expectedReport(value: unknown): unknown {
  const expected = JSON.parse(JSON.stringify(value));
  for (const row of expected.results ?? []) {
    if (
      typeof row.response === "string" &&
      row.response.startsWith(
        "conversation=[] final_response=None response=None output=None turns=None",
      )
    )
      row.response = "";
  }
  return expected;
}
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function sortedStrategies(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedStrategies);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        key === "strategiesUsed" && Array.isArray(value)
          ? [...value].sort()
          : sortedStrategies(value),
      ]),
    );
  return value;
}
function decode(value: unknown): unknown {
  if (value && typeof value === "object" && "__agent_response__" in value)
    return AgentResponse.fromJSON(value.__agent_response__);
  return value;
}
function results(rows: readonly unknown[]): unknown[] {
  return rows.map((value) => {
    const raw = value as Record<string, unknown>,
      jobs = raw.job_results as Record<string, unknown>[];
    return {
      ...raw,
      job_results: jobs.map((job) => ({ ...job, output: decode(job.output) })),
    };
  });
}
for (const fixture of goldens.helpers)
  it(`matches pinned job output normalization ${fixture.label}`, () => {
    const raw = decode(fixture.raw);
    expect(plain(coerceJobOutputPayload(raw))).toEqual(fixture.expected);
    if (fixture.compareText)
      expect(coerceJobOutputText(raw)).toBe(fixture.text);
  });
for (const fixture of goldens.static)
  it(`matches pinned static sample conversion ${fixture.label}`, () => {
    const result = staticSampleToResult(fixture.sample, {
      agentModel: "model",
      agentKey: "key",
    });
    expect(plain(result)).toEqual(fixture.expected);
  });
for (const fixture of goldens.dynamic)
  it(`matches pinned evaluatorq dynamic report ${fixture.label}`, () => {
    const report = dynamicEvaluatorqResultsToReport({
      agentContext: AgentContextSchema.parse(goldens.agent),
      results: results(fixture.results),
      durationSeconds: 1.25,
      description: "dynamic test",
      categoriesTested: ["OWASP-ASI02", "ASI01"],
      runId: "run",
    });
    report.createdAt = fixture.expected.createdAt;
    expect(sortedStrategies(plain(report))).toEqual(
      sortedStrategies(expectedReport(fixture.expected)),
    );
    expect(new RedTeamReport(plain(report)).manifestSummary()).toEqual(
      report.manifestSummary(),
    );
  });
it("matches per-job static conversion including pre-execution errors", () => {
  const reports = staticEvaluatorqResultsToReports({
    results: results(goldens.staticReports.results),
    agentModel: "model",
    agentKey: "key",
    description: "static test",
  });
  for (const [key, expected] of Object.entries(
    goldens.staticReports.expected,
  )) {
    const report = reports[key];
    if (!report) throw new Error(`Missing report ${key}`);
    report.createdAt = expected.createdAt;
  }
  expect(sortedStrategies(plain(reports))).toEqual(
    sortedStrategies(goldens.staticReports.expected),
  );
});
for (const fixture of goldens.staged)
  it(`reads pinned staged report row ${fixture.kind}`, () => {
    const schema = schemas[fixture.kind];
    if (!schema) throw new Error(fixture.kind);
    expect(plain(schema.parse(fixture.input))).toEqual(fixture.expected);
  });
it("accepts native TypeScript evaluatorq Errors and camelCase runtime fields", () => {
  const example = goldens.dynamic[0]?.results[0];
  if (!example) throw new Error("Missing fixture");
  const raw = JSON.parse(JSON.stringify(example)) as Record<string, unknown>;
  const jobs = raw.job_results as Record<string, unknown>[],
    job = jobs[0];
  if (!job) throw new Error("Missing job");
  const score = { value: "error", explanation: "", rawOutput: null };
  const report = dynamicEvaluatorqResultsToReport({
    agentContext: AgentContextSchema.parse({ key: "key" }),
    results: [
      {
        dataPoint: raw.data_point,
        jobResults: [
          {
            jobName: "attack",
            output: job.output,
            error: new Error("target timeout"),
            evaluatorScores: [
              {
                evaluatorName: "judge",
                score,
                error: new Error("judge blocked"),
              },
            ],
          },
        ],
      },
    ],
  });
  expect(report.results[0]?.error).toBe("target timeout");
  expect(report.results[0]?.evaluationError?.message).toBe("judge blocked");
  expect(report.summary.errorsByType).toEqual({
    timeout: 1,
    "evaluation/scorer_exception": 1,
  });
});
it("retains every canonical cached/reasoning counter on typed target responses", () => {
  const response = new AgentResponse({
    text: "answer",
    usage: {
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      cachedTokens: 3,
      cacheCreationTokens: 1,
      cacheCreation1hTokens: 1,
      cacheCreation5mTokens: 0,
      reasoningTokens: 1,
      inputCost: 0.01,
      outputCost: 0.02,
      totalCost: 0.03,
      calls: 1,
      pricedCalls: 1,
    },
  });
  const example = goldens.dynamic[0]?.results[0];
  if (!example) throw new Error("Missing fixture");
  const report = staticEvaluatorqResultsToReports({
    results: [
      {
        dataPoint: example.data_point,
        jobResults: [{ jobName: "target", output: response }],
      },
    ],
  }).target;
  expect(report?.results[0]?.execution?.tokenUsage).toEqual(response.usage);
  expect(report?.summary.tokenUsageTotal).toEqual(response.usage);
});
it("keeps an empty static report unevaluated with a null rate", () => {
  const report = staticResultsToReport([]);
  expect(report.pipeline).toBe("static");
  expect(report.framework).toBeNull();
  expect(report.summary.resistanceRate).toBeNull();
});

it("leaves a missing job's response empty instead of treating a payload representation as target evidence", () => {
  const example = goldens.dynamic[0]?.results[0];
  const report = dynamicEvaluatorqResultsToReport({
    agentContext: AgentContextSchema.parse({ key: "key" }),
    results: [{ dataPoint: example?.data_point, jobResults: [] }],
  });
  expect(report.results[0]?.response).toBe("");
  expect(report.results[0]?.messages).toEqual([]);
  expect(report.summary.resistanceRate).toBeNull();
});
