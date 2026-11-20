import { expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import { AgentContextSchema } from "../../../src/lib/contracts.js";
import { AgentCapabilities } from "../../../src/lib/redteam/adaptive/capability-classifier.js";
import { LLMConfig } from "../../../src/lib/redteam/config.js";
import type { Vulnerability } from "../../../src/lib/redteam/contracts.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import {
  applyCoveragePolicy,
  estimateDynamicDatapoints,
  sendCleanedRedteamResults,
} from "../../../src/lib/redteam/runner-support.js";
import { resolveFilterSets } from "../../../src/lib/redteam/runner-validation.js";
import * as sender from "../../../src/lib/send-results.js";
import type { DataPointResult } from "../../../src/lib/types.js";
import goldens from "../fixtures/redteam-runner-plan-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.cases.entries())
  it(`matches pinned runner estimate ${index}`, () => {
    expect(
      estimateDynamicDatapoints({
        ...row,
        vulnerabilities: row.vulnerabilities as Vulnerability[] | null,
        replayDatapoints: null,
        traceDatapoints: null,
        context: AgentContextSchema.parse(row.context),
        capabilities: new AgentCapabilities(),
        filters: resolveFilterSets({ attackTechniques: row.attackTechniques }),
      }),
    ).toEqual(
      row.expected as unknown as ReturnType<typeof estimateDynamicDatapoints>,
    );
  });
it("distinguishes no verdict and partial coverage from a full resistant run", () => {
  const report = new RedTeamReport({
    createdAt: new Date(),
    pipeline: "dynamic",
    totalResults: 2,
    categoriesTested: [],
    results: [],
    summary: { totalAttacks: 2, evaluatedAttacks: 0, evaluationCoverage: 0 },
  });
  applyCoveragePolicy(report, new LLMConfig());
  expect(report.pipelineWarnings[0]).toContain("NO VERDICT");
  expect(report.summary.minEvaluationCoverage).toBe(0.8);
  report.pipelineWarnings = [];
  report.summary.evaluatedAttacks = 1;
  report.summary.evaluationCoverage = 0.5;
  applyCoveragePolicy(report, new LLMConfig());
  expect(report.pipelineWarnings[0]).toContain("evaluated subset");
});
it("uploads only real outputs without mutating report rows and retains server diagnostics", async () => {
  const key = process.env.ORQ_API_KEY;
  process.env.ORQ_API_KEY = "synthetic";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const report = new RedTeamReport({
    createdAt: new Date(),
    pipeline: "dynamic",
    totalResults: 0,
    categoriesTested: [],
    results: [],
    summary: {},
  });
  const rows: DataPointResult[] = [
    {
      dataPoint: { inputs: { id: 1 } },
      jobResults: [
        { jobName: "one", output: null },
        { jobName: "two", output: "" },
      ],
    },
    {
      dataPoint: { inputs: { id: 2 } },
      jobResults: [{ jobName: "one", output: null }],
    },
  ];
  const send = spyOn(sender, "sendResultsToOrq").mockImplementation(
    async (options) => {
      expect(options.results).toHaveLength(1);
      expect(options.results[0]?.jobResults).toEqual([
        { jobName: "two", output: "" },
      ]);
      expect(options.baseUrl).toBe("https://staging.orq.ai");
      expect(report.uploadedCount).toBe(1);
      return {
        sheet_id: "s",
        manifest_id: "m",
        experiment_name: "test",
        rows_created: 1,
        experiment_url: "https://staging.orq.ai/experiment",
      };
    },
  );
  try {
    await sendCleanedRedteamResults(
      rows,
      "name",
      "description",
      new Date(),
      report,
      { baseURL: "https://staging.orq.ai/v3/router" } as OpenAI,
    );
    expect(rows[0]?.jobResults).toHaveLength(2);
    expect(report.rowsCreated).toBe(1);
    expect(report.experimentUrl).toContain("staging.orq.ai");
  } finally {
    send.mockRestore();
    warn.mockRestore();
    if (key === undefined) delete process.env.ORQ_API_KEY;
    else process.env.ORQ_API_KEY = key;
  }
});
