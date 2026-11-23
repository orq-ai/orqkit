import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type { ZodType } from "zod/v4";

import { parseJuryResult } from "../../../src/lib/contracts.js";
import * as models from "../../../src/lib/redteam/reports/models.js";
import {
  computeReportSummary,
  mergeReports,
  rebuildFilteredReport,
} from "../../../src/lib/redteam/reports/summary.js";
import { RunErrorSchema } from "../../../src/lib/redteam/strategy.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import goldens from "../fixtures/redteam-report-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
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
const schemas: Record<string, ZodType> = {
  AttackInfo: models.AttackInfoSchema,
  UnifiedEvaluationResult: models.UnifiedEvaluationResultSchema,
  EvaluationPayload: models.EvaluationPayloadSchema,
  ExecutionDetails: models.ExecutionDetailsSchema,
  AgentInfo: models.AgentInfoSchema,
  DimensionSummary: models.DimensionSummarySchema,
  TurnTypeSummary: models.TurnTypeSummarySchema,
  JuryReliability: models.JuryReliabilitySchema,
  JuryHealth: models.JuryHealthSchema,
  ReportSummary: models.ReportSummarySchema,
  CategorySummary: models.CategorySummarySchema,
};
const classes = {
  JobOutputPayload: models.JobOutputPayload,
  RedTeamResult: models.RedTeamResult,
  JuryHealth: models.JuryHealth,
  ReportSummary: models.ReportSummary,
  RedTeamReport: models.RedTeamReport,
};
it("keeps default report collections independent", () => {
  const fixture = goldens.models.find((row) => row.kind === "RedTeamReport");
  if (!fixture) throw new Error("Missing report fixture");
  const first = new models.RedTeamReport(fixture.input);
  const second = new models.RedTeamReport(fixture.input);
  first.pipelineWarnings.push("NO VERDICT: first report only");
  first.testedAgents.push("first report only");
  first.appliedRecommendations.push("first report only");
  const third = new models.RedTeamReport(fixture.input);
  expect(second.pipelineWarnings).toEqual([]);
  expect(third.pipelineWarnings).toEqual([]);
  expect(second.testedAgents).toEqual([]);
  expect(third.appliedRecommendations).toEqual([]);
  expect(first.errors).not.toBe(second.errors);
  expect(first.agentContexts).not.toBe(second.agentContexts);
});
it("keeps default report error counts independent", () => {
  const first = models.ReportSummarySchema.parse({});
  const second = models.ReportSummarySchema.parse({});
  first.errorsByType.first = 1;
  expect(second.errorsByType).toEqual({});
  expect(models.ReportSummarySchema.parse({}).errorsByType).toEqual({});
});
it("keeps default signal patterns independent", () => {
  const first = new SignalsConfig();
  const second = new SignalsConfig();
  const expected = [...second.errorPatterns];
  first.errorPatterns.push("first config only");
  expect(second.errorPatterns).toEqual(expected);
  expect(new SignalsConfig().errorPatterns).toEqual(expected);
});
for (const fixture of goldens.models)
  it(`reads pinned Python report model: ${fixture.kind} ${fixture.label}`, () => {
    const ctor = classes[fixture.kind as keyof typeof classes];
    const parsed = ctor
      ? new ctor(fixture.input)
      : (schemas[fixture.kind] as ZodType).parse(fixture.input);
    expect(plain(parsed)).toEqual(fixture.expected);
    const computed = Object.fromEntries(
      Object.keys(fixture.computed).map((key) => {
        const value = (parsed as Record<string, unknown>)[key];
        return [key, typeof value === "function" ? value.call(parsed) : value];
      }),
    );
    expect(plain(computed)).toEqual(fixture.computed);
  });
for (const fixture of goldens.invalid)
  it(`rejects inconsistent report model ${fixture.kind} ${JSON.stringify(fixture.input)}`, () => {
    expect(
      (schemas[fixture.kind] as ZodType).safeParse(fixture.input).success,
    ).toBe(false);
  });
for (const fixture of goldens.summaries)
  it(`matches pinned report aggregation ${fixture.label}`, () => {
    const summary = computeReportSummary(
      fixture.results.map((row) => new models.RedTeamResult(row)),
      {
        minEvaluationCoverage: fixture.minEvaluationCoverage,
        runErrors: fixture.runErrors.map((row) => RunErrorSchema.parse(row)),
      },
    );
    expect(sortedStrategies(plain(summary))).toEqual(
      sortedStrategies(fixture.expected),
    );
  });
it("preserves filtered report metadata, run errors and coverage policy", () => {
  const report = new models.RedTeamReport(goldens.filter.input);
  const selected = goldens.filter.indices
    .map((index) => report.results[index])
    .filter((row): row is models.RedTeamResult => !!row);
  const filtered = rebuildFilteredReport(report, selected);
  expect(sortedStrategies(plain(filtered))).toEqual(
    sortedStrategies(goldens.filter.expected),
  );
  expect(filtered.summary).toBeInstanceOf(models.ReportSummary);
  expect(filtered.results[0]).toBeInstanceOf(models.RedTeamResult);
  expect(report.results.length).toBeGreaterThan(filtered.results.length);
});
it("merges reports without inheriting stale postprocessing", () => {
  const reports = goldens.merge.inputs.map(
    (value) => new models.RedTeamReport(value),
  );
  const merged = mergeReports(reports, { description: "Combined" });
  merged.createdAt = goldens.merge.expected.createdAt;
  expect(sortedStrategies(plain(merged))).toEqual(
    sortedStrategies(goldens.merge.expected),
  );
  expect(mergeReports([reports[0] as models.RedTeamReport])).toBe(reports[0]);
  expect(() => mergeReports([])).toThrow("at least one report");
});
for (const fixture of goldens.alpha)
  it(`uses nominal coincidence weighting for ${JSON.stringify(fixture.units)}`, () => {
    const results = fixture.units.map(
      (ratings, i) =>
        new models.RedTeamResult({
          attack:
            goldens.filter.input.results[0]?.attack ?? goldens.models[0]?.input,
          agent: {},
          messages: [],
          evaluation: {
            jury: parseJuryResult({
              value: true,
              explanation: "Synthetic",
              success: true,
              judgesConfigured: Math.max(ratings.length, 1),
              judgesSucceeded: ratings.length,
              judgesFailed: 0,
              votes: ratings.map((value, j) => ({
                model: `judge${j}`,
                value,
                success: true,
                explanation: "",
              })),
            }),
          },
          response: String(i),
        }),
    );
    const reliability = computeReportSummary(results).juryReliability;
    if (fixture.samples === 0) expect(reliability).toBeNull();
    else {
      expect(reliability?.samples).toBe(fixture.samples);
      if (fixture.alpha === null)
        expect(reliability?.krippendorffAlpha).toBeNull();
      else
        expect(reliability?.krippendorffAlpha).toBeCloseTo(fixture.alpha, 14);
    }
  });
it("does not turn absent verdicts into resistance or trust a saved vulnerable flag", () => {
  const row = new models.RedTeamResult({
    ...goldens.filter.input.results[0],
    evaluation: { passed: null },
    vulnerable: true,
  });
  const summary = computeReportSummary([row]);
  expect(summary.noVerdict).toBe(true);
  expect(summary.resistanceRate).toBeNull();
  expect(summary.vulnerabilitiesFound).toBe(0);
});
it("writes known fields in camelCase and leaves provider metadata and message wire keys intact", () => {
  const payload = new models.JobOutputPayload({
    token_usage: { input_tokens: 2 },
    max_turns: 4,
    extra_wire_key: { provider_name: "raw" },
    conversation: [{ role: "tool", content: "ok", tool_call_id: "call" }],
  });
  const saved = plain(payload) as Record<string, unknown>;
  expect(saved).not.toHaveProperty("token_usage");
  expect(saved).not.toHaveProperty("max_turns");
  expect(saved).toHaveProperty("extra_wire_key.provider_name", "raw");
  expect(payload.conversation[0]?.tool_call_id).toBe("call");
  expect(new models.JobOutputPayload(saved).responseText).toBe(
    payload.responseText,
  );
});
it("freezes health records and sorts secret-scrubbed reasons by Unicode codepoint", () => {
  const health = new models.JuryHealth({
    samples: 1,
    judgeFailureReasons: ["😀", "\ue000", "\u001c A \u001c", "A"],
  });
  expect(health.judgeFailureReasons).toEqual(["A", "\ue000", "😀"]);
  expect(Object.isFrozen(health)).toBe(true);
});
