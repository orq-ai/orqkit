import type OpenAI from "openai";

import { envRaw } from "../common/env-config.js";
import { resolveResultsBaseUrl } from "../common/llm-client.js";
import { pct } from "../common/reports/html-helpers.js";
import type { AgentContext } from "../contracts.js";
import { sendResultsToOrq } from "../send-results.js";
import type { DataPoint, DataPointResult, Evaluator } from "../types.js";
import type { AgentCapabilities } from "./adaptive/capability-classifier.js";
import {
  createDynamicEvaluator,
  type DynamicDatapointMetadata,
} from "./adaptive/pipeline.js";
import {
  filterStrategiesByMethod,
  getStrategiesForCategory,
  getStrategiesForVulnerability,
  selectApplicableStrategies,
  selectApplicableStrategiesForVulnerability,
} from "./adaptive/strategy-registry.js";
import type { LLMConfig } from "./config.js";
import type { Vulnerability } from "./contracts.js";
import { createOwaspEvaluator } from "./frameworks/owasp/evaluatorq-bridge.js";
import type { RedTeamReport } from "./reports/models.js";
import type { ResolvedFilters } from "./runner-validation.js";
import { AttackStrategySchema } from "./strategy.js";

export const hybridSource = (data: DataPoint): unknown =>
  Object.hasOwn(data.inputs, "hybridSource")
    ? data.inputs.hybridSource
    : data.inputs.hybrid_source;
export function estimateDynamicDatapoints(options: {
  replayDatapoints: readonly DataPoint[] | null;
  traceDatapoints: readonly DataPoint[] | null;
  vulnerabilities: Vulnerability[] | null;
  categories: string[];
  context: AgentContext;
  capabilities?: AgentCapabilities | null;
  generatedStrategyCount: number;
  generateStrategies: boolean;
  maxPerCategory: number | null;
  maxDynamicDatapoints: number | null;
  filters: ResolvedFilters;
}): { count: number; breakdown: Record<string, Record<string, number>> } {
  if (options.replayDatapoints != null)
    return {
      count: options.replayDatapoints.filter(
        (row) => hybridSource(row) !== "static",
      ).length,
      breakdown: {},
    };
  const breakdown: Record<string, Record<string, number>> = {};
  const capabilities =
    options.capabilities &&
    Object.keys(options.capabilities.capabilities).length
      ? options.capabilities
      : null;
  for (const key of options.vulnerabilities ?? options.categories) {
    const all = options.vulnerabilities
      ? getStrategiesForVulnerability(key as Vulnerability)
      : getStrategiesForCategory(key);
    const applicable = options.vulnerabilities
      ? selectApplicableStrategiesForVulnerability(
          key as Vulnerability,
          options.context,
          capabilities,
        )
      : selectApplicableStrategies(key, options.context, capabilities);
    const filtered = filterStrategiesByMethod(applicable, {
      attackTechniques: options.filters.attackTechniques,
    });
    const generated = options.generateStrategies
      ? options.generatedStrategyCount
      : 0;
    const count = filtered.length + generated;
    breakdown[key] = {
      totalHardcoded: all.length,
      applicable: filtered.length,
      filtered: all.length - filtered.length,
      generated,
      selected:
        options.maxPerCategory == null
          ? count
          : Math.min(count, options.maxPerCategory),
    };
  }
  const multiplier = options.traceDatapoints?.length ?? 1;
  let count =
    Object.values(breakdown).reduce(
      (sum, row) => sum + (row.selected ?? 0),
      0,
    ) * multiplier;
  const cap = options.maxDynamicDatapoints;
  if (cap != null && cap > 0 && count > cap) {
    count = cap;
    let remaining = cap;
    for (const row of Object.values(breakdown)) row.capped = 0;
    while (remaining > 0) {
      let added = false;
      for (const row of Object.values(breakdown))
        if (
          remaining > 0 &&
          (row.capped ?? 0) < (row.selected ?? 0) * multiplier
        ) {
          row.capped = (row.capped ?? 0) + 1;
          remaining--;
          added = true;
        }
      if (!added) break;
    }
  }
  return { count, breakdown };
}
export function buildRedteamEvaluator(
  mode: string,
  config: LLMConfig,
  contexts: AgentContext[],
  llmClient?: OpenAI | null,
  hasStatic = false,
): Evaluator {
  const cfg = config.evaluator;
  const options = {
    evaluatorModel: cfg.model || cfg.judges[0],
    llmClient: (cfg.client as OpenAI | undefined) ?? llmClient,
    cfg,
    judges: cfg.judges.slice(1),
    judgeRepetitions: cfg.repetitions,
    replacementJudges: cfg.replacementJudges,
    minSuccessfulJudges: cfg.minSuccessfulJudges,
    targetModels: [
      ...new Set(
        contexts
          .map((context) => context.model)
          .filter((model): model is string => !!model),
      ),
    ],
    strictPanel: cfg.strictPanel,
  };
  if (mode === "static") return createOwaspEvaluator(options);
  const dynamic = createDynamicEvaluator(options);
  if (mode !== "hybrid" || !hasStatic) return dynamic;
  const staticEvaluator = createOwaspEvaluator({
    ...options,
    logPanelWarnings: false,
  });
  return {
    name: "hybrid-owasp-security",
    evaluatorType: "llm_eval",
    scorer: async (params) => {
      if (hybridSource(params.data) !== "dynamic")
        return staticEvaluator.scorer(params);
      let output = params.output;
      if (typeof output === "string")
        try {
          output = JSON.parse(output);
        } catch (error) {
          console.warn("Failed to deserialize dynamic output as JSON", error);
        }
      return dynamic.scorer({ ...params, output });
    },
  };
}
export function datapointBreakdown(
  data: readonly DataPoint[],
): Record<string, number> {
  const counts = { static: 0, generated_dynamic: 0, template_dynamic: 0 };
  for (const row of data) {
    if (hybridSource(row) === "static") counts.static++;
    else {
      const parsed = AttackStrategySchema.safeParse(row.inputs.strategy);
      if (parsed.success && parsed.data.isGenerated) counts.generated_dynamic++;
      else counts.template_dynamic++;
    }
  }
  return counts;
}
export function collectFilterWarnings(
  metadata: DynamicDatapointMetadata,
): string[] {
  const warnings: string[] = [];
  for (const [category, value] of Object.entries(metadata)) {
    if (category.startsWith("_")) {
      if (category === "_unresolved_categories" && Array.isArray(value))
        for (const missing of value)
          warnings.push(
            `Category '${missing}': zero strategies selected - category could not be resolved. Check for typos or unsupported category names.`,
          );
      continue;
    }
    if (Array.isArray(value) || !("totalSelected" in value)) continue;
    const count = value.totalSelected,
      error = value.generationError;
    if (!count)
      warnings.push(
        `Category '${category}': zero strategies selected${error ? ` (generation error: ${error})` : " - no applicable strategies found for this agent."}`,
      );
    else if (error)
      warnings.push(
        `Category '${category}': strategy generation failed (${error}); ran ${count} hardcoded ${count === 1 ? "strategy" : "strategies"} only`,
      );
  }
  return warnings;
}
export function applyCoveragePolicy(
  report: RedTeamReport,
  config: LLMConfig,
): void {
  report.summary.minEvaluationCoverage = config.evaluator.minEvaluationCoverage;
  if (report.summary.noVerdict)
    report.pipelineWarnings.push(
      `NO VERDICT: 0/${report.summary.totalAttacks} attacks could be evaluated. The target was not tested.`,
    );
  else if (report.summary.coverageBelowMinimum)
    report.pipelineWarnings.push(
      `Evaluation coverage ${pct(report.summary.evaluationCoverage)} is below the configured minimum ${pct(config.evaluator.minEvaluationCoverage)}. Rates describe only the evaluated subset.`,
    );
}
export async function sendCleanedRedteamResults(
  results: readonly DataPointResult[],
  name: string,
  description: string,
  startTime: Date,
  report: RedTeamReport,
  inferenceClient?: OpenAI | null,
): Promise<void> {
  const key = envRaw("ORQ_API_KEY");
  if (!key) return;
  const cleaned = results.flatMap((row) => {
    const jobs = row.jobResults?.filter((job) => job.output != null);
    return jobs?.length ? [{ ...row, jobResults: jobs }] : [];
  });
  report.uploadedCount = cleaned.length;
  if (!cleaned.length) {
    if (results.length)
      console.warn(
        `All ${results.length} result row(s) had no real output - nothing uploaded to Orq; the experiment will not exist in the Explorer.`,
      );
    return;
  }
  if (cleaned.length < results.length)
    console.warn(
      `${results.length - cleaned.length} of ${results.length} result row(s) had no real output and were dropped before upload; ${cleaned.length} will be uploaded.`,
    );
  const baseUrl = resolveResultsBaseUrl(inferenceClient);
  const response = await sendResultsToOrq({
    apiKey: key,
    evaluationName: name,
    evaluationDescription: description,
    results: cleaned,
    startTime,
    endTime: new Date(),
    baseUrl,
  });
  if (!response) {
    report.pipelineWarnings.push(
      "Result upload did not return a confirmation. Check the platform before retrying.",
    );
    return;
  }
  report.experimentUrl = response.experiment_url ?? null;
  report.rowsCreated = response.rows_created;
}
