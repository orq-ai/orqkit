import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateExecutiveSummary } from "../../../../src/lib/common/reports/executive-summary.js";
import { LLMCallConfig, UsageSchema } from "../../../../src/lib/contracts.js";
import {
  SimulationRun,
  simulate,
} from "../../../../src/lib/integrations/simulation/index.js";
import {
  printSimulationSummary,
  renderSimulationSummary,
} from "../../../../src/lib/integrations/simulation/reports/display.js";
import {
  buildSimulationFacts,
  populateSimulationExecutiveSummary,
} from "../../../../src/lib/integrations/simulation/reports/executive-summary.js";
import { exportSimulationMarkdown } from "../../../../src/lib/integrations/simulation/reports/export-md.js";
import {
  buildRecommendationPrompt,
  findSimulationTriggers,
  generateSimulationRecommendations,
  SimulationRecommendationConfig,
} from "../../../../src/lib/integrations/simulation/reports/recommendations.js";
import { buildSimulationReportSections } from "../../../../src/lib/integrations/simulation/reports/sections.js";
import { buildSimulationTokenUsageRows } from "../../../../src/lib/integrations/simulation/reports/token-usage.js";
import {
  canonicalUsage,
  parseSavedDatapoint,
  parseSimulationResult,
} from "../../../../src/lib/integrations/simulation/run-store.js";
import fixture from "../../fixtures/simulation-report-python-goldens.json" with {
  type: "json",
};
import runFixture from "../../fixtures/simulation-run-python-goldens.json" with {
  type: "json",
};
import { finishTurn, makeFakeClient } from "./fake-client.js";

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const entry of fixture.cases) {
  it(`matches pinned Python report data: ${entry.name}`, () => {
    const results = entry.results.map(parseSimulationResult);
    const sections = buildSimulationReportSections(results, {
      ...entry.options,
      runTokenUsageTotal: entry.options.runTokenUsageTotal
        ? canonicalUsage(entry.options.runTokenUsageTotal)
        : null,
    });
    expect(sections as unknown).toEqual(entry.sections);
    expect(buildSimulationFacts(results)).toBe(entry.facts);
    const config = new SimulationRecommendationConfig();
    expect(
      results.map((r) => findSimulationTriggers(r, config)) as unknown,
    ).toEqual(entry.triggers);
    expect(
      results.map((r) =>
        buildRecommendationPrompt(r, findSimulationTriggers(r, config), config),
      ),
    ).toEqual(entry.prompts);
    expect(
      buildSimulationTokenUsageRows(
        sections.find((s) => s.kind === "token_usage")?.data ?? {},
      ),
    ).toEqual(entry.tokenRows);
  });
  it(`matches pinned Python Markdown: ${entry.name}`, async () => {
    const output = await exportSimulationMarkdown(
      entry.results.map(parseSimulationResult),
      {
        ...entry.options,
        target: "test-agent",
        runDate: "2026-11-09T12:30:00Z",
        runTokenUsageTotal: entry.options.runTokenUsageTotal
          ? canonicalUsage(entry.options.runTokenUsageTotal)
          : null,
      },
    );
    expect(output).toBe(entry.markdown);
  });
}

const failedResult = () =>
  parseSimulationResult(
    fixture.cases.find((entry) => entry.name === "fail")?.results[0],
  );
it("classifies invalid criteria consistently before computing every report section", () => {
  const result = failedResult();
  result.metadata.criteria_meta = [{ id: "bad" }];
  const sections = buildSimulationReportSections([result]);
  expect(sections.find((s) => s.kind === "summary")?.data).toMatchObject({
    errors: 1,
    goals_failed: 0,
  });
  expect(
    sections.find((s) => s.kind === "score_distribution")?.data,
  ).toMatchObject({ errored_conversations: 1, measured_scores: [] });
  expect(sections.find((s) => s.kind === "errors")?.data.total_errored).toBe(1);
  expect(findSimulationTriggers(result)).toEqual([]);
});
it("does not recommend fixes for judge or transport errors", async () => {
  const result = failedResult();
  result.metadata.error = "unauthorized";
  const fake = makeFakeClient();
  expect(
    await generateSimulationRecommendations([result], fake.client, "test"),
  ).toEqual([]);
  expect(fake.requests.analysis).toHaveLength(0);
});
it("uses strict recommendation thresholds and reports capped prompt inputs", () => {
  const result = failedResult();
  result.rules_broken = [];
  result.metadata = {};
  result.criteria_results = {};
  result.turn_metrics = [
    {
      turn_number: 1,
      token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      judge_reason: "ok",
      factual_accuracy: 0.5,
      hallucination_risk: 0.5,
      tone_appropriateness: 0.5,
    },
  ];
  expect(findSimulationTriggers(result)).toEqual([]);
  result.messages = [
    {
      role: "user",
      content: "🙂".repeat(60),
      name: null,
      tool_calls: null,
      tool_call_id: null,
    },
  ];
  const prompt = buildRecommendationPrompt(
    result,
    [],
    new SimulationRecommendationConfig({ maxMessageChars: 50 }),
  );
  expect(prompt).toContain(`${"🙂".repeat(50)}...`);
  expect(prompt).not.toContain("�");
  expect(warn).toHaveBeenCalledTimes(1);
});
it("generates capped recommendations using the supplied client, with billed usage", async () => {
  const fake = makeFakeClient({
    analysis: () =>
      JSON.stringify({ suggestions: ["Fix a", "", 0, null, 7, "Fix c"] }),
  });
  let billed: unknown;
  const output = await generateSimulationRecommendations(
    [failedResult(), failedResult()],
    fake.client,
    "test",
    {
      config: { maxSuggestions: 2, maxResults: 1, maxTokens: 2300 },
      temperature: 0.2,
      llmConfig: new LLMCallConfig({ temperature: 0.7, maxTokens: 9999 }),
      onUsage: (usage) => {
        billed = usage;
      },
    },
  );
  expect(output).toHaveLength(1);
  expect(output[0]).toMatchObject({
    resultIndex: 0,
    datapointId: "dp-2",
    suggestions: ["Fix a", "7"],
  });
  expect(fake.requests.analysis).toHaveLength(1);
  expect(fake.requests.analysis[0]).toMatchObject({
    max_tokens: 2300,
    temperature: 0.2,
  });
  expect(billed).toMatchObject({ totalTokens: 2, calls: 1 });
});
it("retains recommendation usage after a billed failure", async () => {
  const usage = UsageSchema.parse({
    totalTokens: 17,
    calls: 1,
    totalCost: 0.01,
    pricedCalls: 1,
  });
  const fake = makeFakeClient({
    analysis: () => {
      throw Object.assign(new Error("provider failed"), { usage });
    },
  });
  let billed: unknown;
  expect(
    await generateSimulationRecommendations(
      [failedResult()],
      fake.client,
      "test",
      {
        onUsage: (value) => {
          billed = value;
        },
      },
    ),
  ).toEqual([]);
  expect(billed).toMatchObject({ totalTokens: 17, totalCost: 0.01 });
});
it("does not include truncated executive-summary text and retains its billed usage", async () => {
  const fake = makeFakeClient({
    analysis: () => ({ content: "incomplete text", finishReason: "length" }),
  });
  const result = await generateExecutiveSummary("Total simulations: 1", {
    llmClient: fake.client,
    model: "test",
    systemPrompt: "summarizing an agent simulation report",
  });
  expect(result.text).toBeNull();
  expect(result.usage).toMatchObject({ totalTokens: 2 });
});
it("does not request an executive summary for empty runs or when disabled", async () => {
  const fake = makeFakeClient();
  const run = new SimulationRun({ ...runFixture.run, results: [] });
  await populateSimulationExecutiveSummary(run, {
    enabled: true,
    model: "test",
    llmConfig: new LLMCallConfig({ client: fake.client }),
  });
  run.results = [failedResult()];
  await populateSimulationExecutiveSummary(run, {
    enabled: false,
    model: "test",
    llmConfig: new LLMCallConfig({ client: fake.client }),
  });
  expect(fake.requests.analysis).toHaveLength(0);
});
it("saves default recommendations and summary before persisting the full run usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "res1863-analysis-"));
  const fake = makeFakeClient({
    judge: () =>
      finishTurn([{ criterion_id: "criteria_0", occurred: false }], {
        goal_achieved: false,
        goal_completion_score: 0,
        rules_broken: ["Guardrail failed"],
      }),
    analysis: (request) =>
      request.response_format
        ? JSON.stringify({ suggestions: ["Add the guardrail."] })
        : "One simulation failed.",
  });
  try {
    const path = join(dir, "run.json");
    const result = await simulate({
      client: fake.client,
      target: () => "mango",
      datapoints: [parseSavedDatapoint(runFixture.run.datapoints?.[0])],
      maxTurns: 1,
      uploadResults: false,
      save: true,
      reportPath: path,
    });
    expect(result).toHaveLength(1);
    expect(fake.requests.analysis).toHaveLength(2);
    const saved = await SimulationRun.load(path);
    expect(saved.executiveSummary).toBe("One simulation failed.");
    expect(saved.recommendations?.[0]?.suggestions).toEqual([
      "Add the guardrail.",
    ]);
    expect(saved.tokenUsageTotal?.totalTokens).toBe(
      (saved.results[0]?.usage?.totalTokens ?? 0) + 4,
    );
    expect(saved.tokenUsageTotal?.calls).toBe(
      (saved.results[0]?.usage?.calls ?? 0) + 2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("prints summary diagnostics and full run tokens to the supplied console", () => {
  const entry = fixture.cases.find((entry) => entry.name === "mixed");
  if (!entry) throw new Error("Missing golden case");
  const results = entry.results.map(parseSimulationResult);
  const output: string[] = [];
  printSimulationSummary(results, {
    executiveSummary: "Observed results.",
    experimentUrl: "https://example.com/experiment",
    runTokenUsageTotal: canonicalUsage(entry.options.runTokenUsageTotal),
    output: { log: (text) => output.push(text) },
  });
  expect(output).toHaveLength(1);
  expect(output[0]).toContain("SIMULATION SUMMARY (4 simulations)");
  for (const text of [
    "Observed results.",
    "Per-Persona Breakdown",
    "Per-Scenario Breakdown",
    "Judge Verdicts",
    "rate limit",
    "Run Total Tokens (incl. generation & summary)",
    "250",
    "View on Orq: https://example.com/experiment",
  ])
    expect(output[0]).toContain(text);
  expect(output[0]).toMatch(/Goals Achieved +1\/4/);
});
it("prints an empty-run explanation and defaults to stderr", () => {
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    printSimulationSummary([]);
    expect(stderr).toHaveBeenCalledWith(renderSimulationSummary([]));
    expect(stderr.mock.calls[0]?.[0]).toContain(
      "No results (run aborted or produced nothing).",
    );
  } finally {
    stderr.mockRestore();
  }
});
