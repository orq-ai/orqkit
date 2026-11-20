import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OpenAI from "openai";

import * as structured from "../../../src/lib/common/structured-output.js";
import { parseUsage } from "../../../src/lib/contracts.js";
import { RedTeamRecommendationConfig } from "../../../src/lib/redteam/config.js";
import { loadRedteamReplay } from "../../../src/lib/redteam/replay.js";
import { buildRedteamFacts } from "../../../src/lib/redteam/reports/executive-summary.js";
import {
  RedTeamReport,
  RedTeamResult,
} from "../../../src/lib/redteam/reports/models.js";
import {
  buildRecommendationPrompt,
  computeTopRiskAreas,
  formatRecommendationTrace,
  formatRecommendationTraceToBudget,
  generateFocusAreaRecommendations,
  truncatePromptAtTraceBoundary,
} from "../../../src/lib/redteam/reports/recommendations.js";
import {
  autoSaveRedteamRun,
  persistAndIndexRedteamRun,
  saveRedteamStage,
} from "../../../src/lib/redteam/run-store.js";
import goldens from "../fixtures/redteam-postprocess-python-goldens.json" with {
  type: "json",
};

const limits = new RedTeamRecommendationConfig({
  maxAttackChars: 110,
  maxExplanationChars: 50,
});
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
let debug: ReturnType<typeof spyOn<typeof console, "debug">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  debug = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  debug.mockRestore();
});
for (const [index, row] of goldens.rows.entries())
  it(`formats pinned multi-turn trace and budgets ${index}`, () => {
    const result = new RedTeamResult(row.input);
    expect(formatRecommendationTrace(result, limits)).toBe(row.trace);
    for (const budget of row.budgets)
      expect(
        formatRecommendationTraceToBudget(result, limits, budget.limit),
      ).toBe(budget.expected);
  });
for (const [index, row] of goldens.reports.entries())
  it(`matches pinned risk selection and narrative facts ${index}`, () => {
    const report = new RedTeamReport(row.input);
    expect(buildRedteamFacts(report)).toBe(row.facts);
    expect(
      computeTopRiskAreas(report, 3).map((area) => ({
        category: area.category,
        riskScore: area.riskScore,
        vulnerableIds: area.vulnerableResults.map((result) => result.attack.id),
      })),
    ).toEqual(row.areas);
  });
for (const [index, row] of goldens.boundaries.entries())
  it(`keeps XML trace boundaries ${index}`, () =>
    expect(truncatePromptAtTraceBoundary(row.text, row.limit)).toBe(
      row.expected,
    ));
for (const row of goldens.prompts)
  it(`uses Python percentage rounding for ${row.rate}`, () =>
    expect(
      buildRecommendationPrompt("ASI01", "Goal hijack", row.rate, [
        "<trace>one</trace>",
        "<trace>two</trace>",
      ]),
    ).toBe(row.expected));
it("includes condense and recommendation spend and applies suggestion cap", async () => {
  const report = new RedTeamReport(goldens.reports[0]?.input);
  let calls = 0;
  const usage = parseUsage({
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    calls: 1,
  });
  const mock = spyOn(structured, "generateStructured").mockImplementation(
    async (_client, options) => {
      calls++;
      if (options.label.endsWith("_condense"))
        return {
          parsed: options.responseFormat.schema.parse({
            analysis: "Agent printed final <answer> after escalation",
          }),
          raw: "",
          usage,
        };
      const prompt = JSON.stringify(options.messages[1]);
      expect(prompt).toContain("<analysis>");
      expect(prompt).toContain("&lt;answer&gt;");
      return {
        parsed: options.responseFormat.schema.parse({
          recommendations: [
            "Validate tool access",
            "Block unsafe scope",
            "Limit privileges",
          ],
          patterns_observed: "Two-turn scope escalation.",
        }),
        raw: "",
        usage,
      };
    },
  );
  try {
    const [recommendations, total] = await generateFocusAreaRecommendations(
      report,
      {} as OpenAI,
      "fake",
      {
        recommendations: new RedTeamRecommendationConfig({
          condenseAboveChars: 100,
          maxSuggestions: 2,
        }),
      },
    );
    expect(calls).toBe(2);
    expect(total?.totalTokens).toBe(36);
    expect(total?.calls).toBe(2);
    expect(recommendations[0]?.recommendations).toHaveLength(2);
    expect(recommendations[0]?.tracesAnalyzed).toBe(1);
  } finally {
    mock.mockRestore();
  }
});
it("retains billed condense and area failures without dropping other report data", async () => {
  const report = new RedTeamReport(goldens.reports[0]?.input);
  const usage = parseUsage({
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    calls: 1,
  });
  let calls = 0;
  const mock = spyOn(structured, "generateStructured").mockImplementation(
    async (_client, options) => {
      calls++;
      if (!options.label.endsWith("_condense")) {
        const prompt = JSON.stringify(options.messages[1]);
        expect(prompt).not.toContain("<turn");
        expect(prompt).toContain("Category: ASI01");
      }
      throw new structured.StructuredGenerationError("provider failure", {
        usage,
      });
    },
  );
  try {
    const [recommendations, total] = await generateFocusAreaRecommendations(
      report,
      {} as OpenAI,
      "fake",
      {
        recommendations: new RedTeamRecommendationConfig({
          condenseAboveChars: 100,
        }),
      },
    );
    expect(recommendations).toEqual([]);
    expect(calls).toBe(2);
    expect(total?.totalTokens).toBe(10);
    expect(report.results).toHaveLength(1);
  } finally {
    mock.mockRestore();
  }
});
it("makes no model calls without vulnerable areas", async () => {
  const report = new RedTeamReport({
    createdAt: new Date(),
    pipeline: "dynamic",
    categoriesTested: [],
    totalResults: 0,
    results: [],
    summary: {},
  });
  const mock = spyOn(structured, "generateStructured");
  try {
    expect(
      await generateFocusAreaRecommendations(report, {} as OpenAI, "fake"),
    ).toEqual([[], null]);
    expect(mock).not.toHaveBeenCalled();
  } finally {
    mock.mockRestore();
  }
});
it("saves concurrent same-second runs without overwriting and restores all replay settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eq-redteam-store-"));
  try {
    const report = new RedTeamReport(goldens.reports[0]?.input),
      inputs = [
        { objective: "one", strategy: { name: "fixed" }, free_key: [1, 2] },
      ];
    const options = {
      runsDir: directory,
      name: "//same name//",
      datapoints: inputs,
      runConfig: {
        maxTurns: 7,
        attackerInstructions: "steer",
        maxBacktracks: 2,
      },
    };
    const paths = await Promise.all([
      autoSaveRedteamRun(report, options),
      autoSaveRedteamRun(report, options),
    ]);
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) {
      expect(path).not.toBeNull();
      const replay = await loadRedteamReplay(path as string, directory);
      expect(replay.datapoints[0]?.inputs).toEqual(inputs[0]);
      expect(replay.maxTurns).toBe(7);
      expect(replay.attackerInstructions).toBe("steer");
      expect(replay.maxBacktracks).toBe(2);
      expect((await stat(path as string)).mode & 0o777).toBe(0o600);
      const payload = JSON.parse(await readFile(path as string, "utf8"));
      expect(payload.runConfig.maxTurns).toBe(7);
      expect(payload.run_config).toBeUndefined();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("keeps stage envelopes separate from flat summaries and final index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eq-redteam-artifacts-"));
  try {
    const report = new RedTeamReport(goldens.reports[0]?.input);
    await saveRedteamStage(directory, "01.json", [{ id: 1 }]);
    const stage = JSON.parse(
      await readFile(join(directory, "01.json"), "utf8"),
    );
    expect(stage.data).toEqual([{ id: 1 }]);
    expect(stage.savedAt).toBeString();
    const saved = await persistAndIndexRedteamRun({
      report,
      save: "final",
      userOutputDir: directory,
      pipelineOutputDir: null,
      name: "run",
      datapointInputs: [{ objective: "one" }],
      runConfig: { maxTurns: 1, attackerInstructions: null, maxBacktracks: 0 },
      runsDir: join(directory, "runs"),
    });
    expect(saved.autoSavePath).toBe(join(directory, "03_summary_report.json"));
    expect(saved.runPath).not.toBeNull();
    const final = JSON.parse(
      await readFile(saved.autoSavePath as string, "utf8"),
    );
    expect(final.pipeline).toBe("dynamic");
    expect(final.data).toBeUndefined();
    expect(final.savedAt).toBeString();
    const none = await persistAndIndexRedteamRun({
      report,
      save: "none",
      userOutputDir: directory,
      pipelineOutputDir: null,
      datapointInputs: [],
      runConfig: { maxTurns: 1, attackerInstructions: null, maxBacktracks: 0 },
      runsDir: join(directory, "other"),
    });
    expect(none).toEqual({ autoSavePath: null, runPath: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
