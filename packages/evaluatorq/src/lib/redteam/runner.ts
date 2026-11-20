import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type OpenAI from "openai";

import { llmConcurrencyLimit } from "../common/llm-limit.js";
import { validateReasoningEffort } from "../common/model-catalogue.js";
import { resolveDatapointParallelism } from "../common/parallelism.js";
import { resolveRecommendations } from "../common/recommendations.js";
import { generateExecutiveSummary } from "../common/reports/executive-summary.js";
import { startManifest } from "../common/run-manifest.js";
import { sumStructuredUsage } from "../common/structured-output.js";
import {
  evaluatorqPipeline,
  evaluatorqRunScope,
} from "../common/thread-context.js";
import { setSpanAttrs } from "../common/tracing.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentTarget,
  LLMCallConfig,
  type Usage,
} from "../contracts.js";
import { evaluatorq } from "../evaluatorq.js";
import {
  captureParentContext,
  flushTracing,
  initTracingIfNeeded,
} from "../tracing/index.js";
import type { DataPoint, DataPointResult, Job } from "../types.js";
import {
  AgentCapabilities,
  classifyAgentCapabilities,
} from "./adaptive/capability-classifier.js";
import {
  cleanupMemoryEntities,
  createDynamicRedteamJob,
  type DynamicDatapointMetadata,
  expandTraceSeedDatapoints,
  generateDynamicDatapoints,
  generateDynamicDatapointsForVulnerabilities,
} from "./adaptive/pipeline.js";
import { type Backend, BareTargetBackend } from "./backends/base.js";
import { createAsyncLlmClient } from "./backends/client.js";
import { makeAgentBackend } from "./backends/registry.js";
import { LLMConfig, RedTeamRecommendationConfig } from "./config.js";
import {
  normalizeCategory,
  PipelineStage,
  parseTarget,
  type SaveMode,
} from "./contracts.js";
import { CancelledError, RedTeamError } from "./exceptions.js";
import { loadOwaspAgenticDataset } from "./frameworks/owasp/evaluatorq-bridge.js";
import { getEvaluatorForCategory } from "./frameworks/owasp/evaluators.js";
import {
  CompositePipelineHooks,
  DefaultHooks,
  ManifestStageHooks,
  type PipelineHooks,
} from "./hooks.js";
import type { TargetConfig } from "./input.js";
import {
  dynamicEvaluatorqResultsToReport,
  staticEvaluatorqResultsToReports,
  staticResultsToReport,
} from "./reports/converters.js";
import { buildRedteamFacts } from "./reports/executive-summary.js";
import type { RedTeamReport } from "./reports/models.js";
import { generateFocusAreaRecommendations } from "./reports/recommendations.js";
import { mergeReports } from "./reports/summary.js";
import {
  getRedteamRunsDir,
  persistAndIndexRedteamRun,
  saveRedteamReport,
  saveRedteamStage,
} from "./run-store.js";
import {
  applyCoveragePolicy,
  buildRedteamEvaluator,
  collectFilterWarnings,
  datapointBreakdown,
  estimateDynamicDatapoints,
  hybridSource,
  sendCleanedRedteamResults,
} from "./runner-support.js";
import {
  backtrackingWarnings,
  capDatapointsBalanced,
  checkFilterResults,
  type DataSelectionOptions,
  deduplicateTargetLabels,
  type RedTeamTarget,
  rejectUnsupportedTargets,
  resolveFilterSets,
  resolveOutputDirs,
  resolveRedteamReplay,
  resolveSaveMode,
  resolveVulnsAndCategories,
  restoreReplayedBacktracks,
  splitAndDedupeTargets,
  validateBacktrackingTargets,
  validateCredentialsAndDeps,
  validateTraceDatapoints,
  validateTraceReplayTargets,
} from "./runner-validation.js";
import {
  createDeploymentJob,
  createStaticJobForAgentTarget,
  sanitizeJobName,
} from "./runtime/jobs.js";
import { withRedteamSpan } from "./tracing.js";

export interface RedTeamOptions extends DataSelectionOptions {
  llmConfig?: LLMConfig | null;
  datapointParallelism?: number | null;
  llmParallelism?: number | null;
  parallelism?: number | null;
  generateStrategies?: boolean;
  generatedStrategyCount?: number;
  cleanupMemory?: boolean;
  llmClient?: OpenAI | null;
  name?: string | null;
  description?: string | null;
  hooks?: PipelineHooks | null;
  artifactsDir?: string | null;
  targetConfig?: TargetConfig | null;
  recommendations?: boolean | RedTeamRecommendationConfig;
  generateExecutiveSummary?: boolean;
  verbosity?: number;
  save?: SaveMode | boolean;
}
interface PreparedTarget {
  target: RedTeamTarget;
  label: string;
  key: string;
  kind: string;
  safe: string;
  context: AgentContext;
  backend: Backend | null;
  capabilities: AgentCapabilities;
  memoryEntityIds: string[];
}
function uniqueSafeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  return labels.map((label) => {
    const base = sanitizeJobName(label) || "target";
    let safe = base,
      index = 1;
    while (seen.has(safe)) safe = `${base}-${index++}`;
    seen.add(safe);
    return safe;
  });
}
async function loadStaticData(
  options: RedTeamOptions,
  categories: string[],
  filters: ReturnType<typeof resolveFilterSets>,
  replayData: DataPoint[] | null,
): Promise<DataPoint[]> {
  let data =
    replayData ??
    (await loadOwaspAgenticDataset(options.dataset, {
      categories,
      deliveryMethods: filters.deliveryMethods,
      numSamples: options.maxStaticDatapoints,
    }));
  if (data.length) {
    const skipped = new Map<string, number>();
    const kept = data.filter((row) => {
      const category = normalizeCategory(String(row.inputs.category ?? ""));
      if (getEvaluatorForCategory(category)) return true;
      skipped.set(category, (skipped.get(category) ?? 0) + 1);
      return false;
    });
    for (const [category, count] of [...skipped].sort())
      console.warn(
        `Skipped ${count} datapoints for ${category}: no evaluator registered`,
      );
    if (!kept.length)
      throw new RangeError(
        "All datapoints were filtered out - no evaluator registered for any category.",
      );
    data = kept;
  }
  if (filters.strategyNames != null && options.mode === "static")
    console.warn(
      `Strategy selection does not apply to static datapoints; ignoring ${JSON.stringify([...filters.strategyNames].sort())}.`,
    );
  return data;
}
function splitResults(
  results: readonly DataPointResult[],
  name: string,
): DataPointResult[] {
  return results.map((row) => ({
    ...row,
    jobResults: row.jobResults?.filter((job) => job.jobName === name),
  }));
}
function convertTargetReport(
  target: PreparedTarget,
  results: DataPointResult[],
  mode: string,
  description: string,
  categories: string[],
  runId: string,
  durationSeconds: number,
): RedTeamReport {
  const reports: RedTeamReport[] = [];
  const dynamic = results.filter(
    (row) =>
      mode !== "static" &&
      (mode !== "hybrid" || hybridSource(row.dataPoint) === "dynamic"),
  );
  const staticRows = results.filter(
    (row) =>
      mode === "static" ||
      (mode === "hybrid" && hybridSource(row.dataPoint) !== "dynamic"),
  );
  if (dynamic.length)
    reports.push(
      dynamicEvaluatorqResultsToReport({
        agentContext: target.context,
        results: dynamic,
        categoriesTested: categories,
        description,
        runId,
        durationSeconds,
      }),
    );
  if (staticRows.length) {
    const converted = staticEvaluatorqResultsToReports({
      results: staticRows,
      description,
      agentKey: target.key,
      agentModel: target.context.model,
    });
    reports.push(...Object.values(converted));
  }
  const report = reports.length
    ? mergeReports(reports, { description })
    : staticResultsToReport([], {
        description,
        agentKey: target.key,
        agentModel: target.context.model,
      });
  report.pipeline = mode as RedTeamReport["pipeline"];
  for (const row of report.results) row.agent.key = target.key;
  return report;
}
function isProgrammingError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  );
}
export async function redTeam(
  target: RedTeamTarget | RedTeamTarget[],
  options: RedTeamOptions = {},
): Promise<RedTeamReport> {
  const parallelism = resolveDatapointParallelism(
    options.datapointParallelism,
    options.parallelism,
    { caller: "redTeam" },
  );
  if (!Number.isInteger(parallelism) || parallelism < 1)
    throw new RangeError("datapointParallelism must be a positive integer");
  const recommendations = resolveRecommendations(
    options.recommendations ?? true,
    () => new RedTeamRecommendationConfig(),
  );
  const save = resolveSaveMode(options.save ?? "final"),
    filters = resolveFilterSets(options),
    traceData = validateTraceDatapoints(options),
    runsDir = getRedteamRunsDir();
  const resolved = await resolveRedteamReplay(options, runsDir),
    { replay, mode } = resolved,
    maxTurns = resolved.maxTurns ?? 5;
  const { userOutputDir, pipelineOutputDir } = resolveOutputDirs(
    save,
    options.artifactsDir,
  );
  const split = splitAndDedupeTargets(target);
  validateTraceReplayTargets(
    split.raw,
    traceData ?? replay?.datapoints ?? null,
  );
  const config =
    restoreReplayedBacktracks(options.llmConfig, replay) ?? new LLMConfig();
  rejectUnsupportedTargets(split.strings, mode);
  validateBacktrackingTargets(split.raw, config, mode);
  validateCredentialsAndDeps({
    config,
    llmClient: options.llmClient,
    replay,
    mode,
    dataset: options.dataset,
  });
  const selection = resolveVulnsAndCategories(options, replay),
    labels = deduplicateTargetLabels(split.strings, split.agents).labels,
    safeLabels = uniqueSafeLabels(labels);
  const name = options.name || "red-team",
    description =
      options.description ||
      `${mode[0]?.toUpperCase()}${mode.slice(1)} red teaming (${labels.length} targets)`,
    runId = randomUUID();
  // Validate the request budget before a manifest or provider work is started.
  return llmConcurrencyLimit(options.llmParallelism ?? undefined, async () => {
    const writer =
      save === "none"
        ? null
        : await startManifest({
            runId,
            surface: "redteam",
            runName: name,
            runsDir,
            parallelism,
          });
    const userHooks = options.hooks ?? new DefaultHooks(),
      hooks = writer
        ? new CompositePipelineHooks([
            new ManifestStageHooks(writer),
            userHooks,
          ])
        : userHooks;
    let report: RedTeamReport | undefined;
    const prepared: PreparedTarget[] = [],
      startTime = new Date();
    const cleanup = async (): Promise<void> => {
      if (options.cleanupMemory === false) return;
      let firstHookError: unknown;
      for (const item of prepared) {
        if (
          !item.backend ||
          !item.context.memoryStores.length ||
          !item.memoryEntityIds.length
        )
          continue;
        let hookError: unknown;
        try {
          await hooks.onStageStart(PipelineStage.CLEANUP, {
            target: item.label,
            numEntities: item.memoryEntityIds.length,
          });
        } catch (error) {
          hookError = error;
        }
        const warning = await withRedteamSpan(
          "orq.redteam.cleanup",
          { "orq.redteam.target": item.label },
          () =>
            cleanupMemoryEntities(item.context, item.memoryEntityIds, {
              memoryCleanup: item.backend as Backend,
              pipelineConfig: config,
            }),
        );
        if (warning) report?.pipelineWarnings.push(warning);
        try {
          await hooks.onStageEnd(PipelineStage.CLEANUP, {
            target: item.label,
            numEntities: item.memoryEntityIds.length,
            ...(warning ? { error: warning } : {}),
          });
        } catch (error) {
          hookError ??= error;
        }
        item.memoryEntityIds.length = 0;
        firstHookError ??= hookError;
      }
      if (firstHookError) throw firstHookError;
    };
    try {
      await initTracingIfNeeded();
      const parent = await captureParentContext();
      return await evaluatorqPipeline("red_teaming", () =>
        withRedteamSpan(
          "Evaluatorq - Red Teaming",
          {
            "orq.trace_type": "redteam",
            "orq.redteam.targets": labels.join(", "),
            "orq.redteam.mode": mode,
            "orq.redteam.max_turns": maxTurns,
            "orq.redteam.parallelism": parallelism,
          },
          (span) =>
            evaluatorqRunScope(runId, span, async () => {
              const targets: RedTeamTarget[] = [
                ...split.strings,
                ...split.agents,
              ];
              for (const [index, current] of targets.entries()) {
                const label = labels[index] as string,
                  [kind, key] =
                    typeof current === "string"
                      ? parseTarget(current)
                      : ["custom", label];
                await hooks.onStageStart(PipelineStage.CONTEXT_RETRIEVAL, {
                  target: label,
                });
                const backend =
                  typeof current === "string" && kind !== "deployment"
                    ? makeAgentBackend({
                        targetConfig: options.targetConfig,
                        pipelineConfig: config,
                      })
                    : current instanceof AgentTarget
                      ? new BareTargetBackend(current)
                      : null;
                let context: AgentContext;
                try {
                  context = AgentContextSchema.parse(
                    current instanceof AgentTarget
                      ? await current.getAgentContext()
                      : backend
                        ? await backend.resolveContext(key)
                        : { key },
                  );
                } catch (error) {
                  if (mode !== "static") throw error;
                  console.warn(
                    `Could not retrieve agent context for '${label}'; proceeding without it`,
                    error,
                  );
                  context = AgentContextSchema.parse({ key });
                }
                prepared.push({
                  target: current,
                  label,
                  key,
                  kind,
                  safe: safeLabels[index] as string,
                  context,
                  backend,
                  capabilities: new AgentCapabilities(),
                  memoryEntityIds: [],
                });
              }
              if (config.targetReasoningEffort)
                for (const item of prepared) {
                  if (
                    typeof item.target === "string" &&
                    item.kind === "agent" &&
                    item.context.model
                  )
                    await validateReasoningEffort(
                      config.targetReasoningEffort,
                      item.context.model,
                      options.llmClient,
                    );
                  else
                    console.warn(
                      `targetReasoningEffort=${JSON.stringify(config.targetReasoningEffort)} could not be pre-validated for '${item.label}'; the target model or forwarding behavior is unknown.`,
                    );
                }
              let attackerClient =
                options.llmClient ??
                (config.attacker.client as OpenAI | undefined);
              if (mode !== "static" && !replay && !attackerClient)
                try {
                  attackerClient = await createAsyncLlmClient(config.attacker, {
                    maxRetries: config.retryCount,
                  });
                } catch (error) {
                  console.debug(
                    "No LLM client available for capability classification",
                    error,
                  );
                }
              for (const item of prepared) {
                let classificationError: string | null = null;
                if (mode !== "static" && !replay && attackerClient)
                  try {
                    item.capabilities = await withRedteamSpan(
                      "orq.redteam.capability_classification",
                      {
                        "orq.redteam.target": item.key,
                        "orq.redteam.model": config.attacker.model,
                      },
                      () =>
                        classifyAgentCapabilities(
                          item.context,
                          attackerClient as OpenAI,
                          {
                            model: config.attacker.model,
                            pipelineConfig: config,
                          },
                        ),
                    );
                  } catch (error) {
                    item.capabilities = new AgentCapabilities({
                      classificationFailed: true,
                    });
                    classificationError =
                      error instanceof Error ? error.message : String(error);
                    console.warn(
                      `Capability classification failed for '${item.label}'; continuing with optimistic selection`,
                      error,
                    );
                  }
                await hooks.onStageEnd(PipelineStage.CONTEXT_RETRIEVAL, {
                  target: item.label,
                  numTools: item.context.tools.length,
                  numMemoryStores: item.context.memoryStores.length,
                  numKnowledgeBases: item.context.knowledgeBases.length,
                  agentContext: item.context,
                  agentCapabilities: item.capabilities,
                  classificationError,
                  classificationAvailable:
                    !!attackerClient && !replay && mode !== "static",
                });
              }
              let staticData: DataPoint[] = [],
                dynamicData: DataPoint[] = [],
                metadata: DynamicDatapointMetadata = {};
              if (mode !== "dynamic")
                staticData = await loadStaticData(
                  { ...options, mode },
                  selection.categories,
                  filters,
                  replay
                    ? replay.datapoints.filter(
                        (row) =>
                          mode === "static" || hybridSource(row) === "static",
                      )
                    : null,
                );
              const first = prepared[0] as PreparedTarget;
              const estimated =
                mode === "static"
                  ? { count: 0, breakdown: {} }
                  : estimateDynamicDatapoints({
                      replayDatapoints: replay?.datapoints ?? null,
                      traceDatapoints: traceData,
                      vulnerabilities: selection.vulnerabilities,
                      categories: selection.categories,
                      context: first.context,
                      capabilities: first.capabilities,
                      generatedStrategyCount:
                        options.generatedStrategyCount ?? 2,
                      generateStrategies: options.generateStrategies ?? true,
                      maxPerCategory: options.maxPerCategory ?? null,
                      maxDynamicDatapoints:
                        options.maxDynamicDatapoints ?? null,
                      filters,
                    });
              if (
                !(await hooks.onConfirm({
                  agentContext: first.context,
                  agentContexts: Object.fromEntries(
                    prepared.map((item) => [item.label, item.context]),
                  ),
                  numDatapoints: estimated.count + staticData.length,
                  numDynamic: mode === "static" ? null : estimated.count,
                  numStatic: mode === "hybrid" ? staticData.length : null,
                  categories: selection.categories,
                  attackModel: config.attacker.model,
                  evaluatorModel: config.evaluator.model,
                  maxTurns,
                  datapointParallelism: parallelism,
                  filteringMetadata: null,
                  strategyBreakdown: Object.keys(estimated.breakdown).length
                    ? estimated.breakdown
                    : null,
                  mode,
                  target: labels.join(", "),
                  datasetPath: options.dataset ?? null,
                  vulnerabilities: selection.vulnerabilities,
                  replayOf: replay ? basename(replay.path) : null,
                }))
              )
                throw new CancelledError(
                  "Execution cancelled by confirmation callback",
                );
              if (mode !== "static") {
                await hooks.onStageStart(PipelineStage.DATAPOINT_GENERATION, {
                  target: first.label,
                  categories: selection.categories,
                });
                if (replay)
                  dynamicData = replay.datapoints.filter(
                    (row) => hybridSource(row) !== "static",
                  );
                else {
                  const generation = {
                    llmClient: attackerClient,
                    attackModel: config.attacker.model,
                    maxTurns,
                    maxPerCategory: options.maxPerCategory ?? null,
                    generateAdditionalStrategies:
                      options.generateStrategies ?? true,
                    generatedStrategyCount: options.generatedStrategyCount ?? 2,
                    attackerInstructions: resolved.attackerInstructions,
                    verbosity: options.verbosity,
                    pipelineConfig: config,
                    agentCapabilities: first.capabilities,
                    strategyNames: filters.strategyNames,
                    deliveryMethods: filters.deliveryMethods,
                    attackTechniques: filters.attackTechniques,
                  };
                  [dynamicData, metadata] = selection.vulnerabilities
                    ? await generateDynamicDatapointsForVulnerabilities(
                        first.context,
                        selection.vulnerabilities,
                        generation,
                      )
                    : await generateDynamicDatapoints(
                        first.context,
                        selection.categories,
                        generation,
                      );
                  dynamicData = expandTraceSeedDatapoints(
                    traceData,
                    dynamicData,
                  );
                  const cap = options.maxDynamicDatapoints;
                  if (cap != null && cap > 0 && dynamicData.length > cap)
                    dynamicData = capDatapointsBalanced(dynamicData, cap);
                }
                await hooks.onStageEnd(PipelineStage.DATAPOINT_GENERATION, {
                  numDatapoints: dynamicData.length + staticData.length,
                  numDynamic: dynamicData.length,
                  numStatic: mode === "hybrid" ? staticData.length : null,
                  filteringMetadata: metadata,
                });
              }
              let data: DataPoint[];
              if (replay && mode === "hybrid") data = [...replay.datapoints];
              else if (mode === "hybrid")
                data = [
                  ...dynamicData.map((row) => ({
                    ...row,
                    inputs: { ...row.inputs, hybridSource: "dynamic" },
                  })),
                  ...staticData.map((row) => ({
                    ...row,
                    inputs: { ...row.inputs, hybridSource: "static" },
                  })),
                ];
              else data = mode === "static" ? staticData : dynamicData;
              let presentMethods: string[] | null = null;
              if (
                mode === "static" &&
                !data.length &&
                filters.deliveryMethods != null
              ) {
                const present = await loadOwaspAgenticDataset(options.dataset);
                presentMethods = [
                  ...new Set(
                    present
                      .map((row) =>
                        String(
                          row.inputs.deliveryMethod ??
                            row.inputs.delivery_method ??
                            "",
                        ),
                      )
                      .filter(Boolean),
                  ),
                ].sort();
              }
              checkFilterResults(
                data,
                mode === "static"
                  ? { ...filters, strategyNames: null }
                  : filters,
                { namesApply: mode !== "static", presentMethods },
              );
              if (!data.length)
                throw new RedTeamError(
                  `No datapoints generated for any target in ${mode} multi-target mode.`,
                );
              await saveRedteamStage(
                pipelineOutputDir,
                mode === "static"
                  ? "01_datapoints.json"
                  : "01_all_datapoints.json",
                data.map((row) => row.inputs),
              );
              const jobs: Job[] = prepared.map((item) => {
                const common = { pipelineConfig: config, runId };
                const staticJob =
                  item.kind === "deployment"
                    ? createDeploymentJob(item.key, {
                        ...common,
                        jobLabel: item.safe,
                      })
                    : createStaticJobForAgentTarget(
                        () => {
                          if (!item.backend)
                            throw new TypeError("Missing target backend");
                          const target = item.backend.createTarget(item.key);
                          if (target.memoryEntityId)
                            item.memoryEntityIds.push(target.memoryEntityId);
                          return target;
                        },
                        item.safe,
                        {
                          ...common,
                          mapError: (error) => item.backend?.mapError(error),
                        },
                      );
                if (mode === "static") return staticJob;
                const dynamicJob = createDynamicRedteamJob({
                  ...common,
                  agentKey: item.key,
                  jobLabel: item.safe,
                  agentContext: item.context,
                  backend: item.backend as Backend,
                  attackLlmClient: attackerClient ?? undefined,
                  redTeamModel: config.attacker.model,
                  maxTurns,
                  memoryEntityIds: item.memoryEntityIds,
                  attackerInstructions: resolved.attackerInstructions,
                  verbosity: options.verbosity,
                });
                return mode === "dynamic"
                  ? dynamicJob
                  : async (row, index) => {
                      try {
                        const result = await (hybridSource(row) === "dynamic"
                          ? dynamicJob
                          : staticJob)(row, index);
                        return {
                          ...result,
                          name: `redteam:hybrid:${item.safe}`,
                        };
                      } catch (error) {
                        throw Object.assign(
                          error instanceof Error
                            ? error
                            : new Error(String(error)),
                          { jobName: `redteam:hybrid:${item.safe}` },
                        );
                      }
                    };
              });
              const evaluator = buildRedteamEvaluator(
                mode,
                config,
                prepared.map((item) => item.context),
                options.llmClient,
                staticData.length > 0,
              );
              await hooks.onStageStart(PipelineStage.ATTACK_EXECUTION, {
                numDatapoints: data.length,
                targets: labels,
              });
              const results = await evaluatorq(name, {
                data,
                jobs,
                evaluators: [evaluator],
                parallelism,
                print: false,
                sendResults: false,
                manageTracing: false,
                exitOnFailure: false,
                description,
              });
              await hooks.onStageEnd(PipelineStage.ATTACK_EXECUTION, {
                numResults: results.length,
              });
              await saveRedteamStage(
                pipelineOutputDir,
                "02_attack_results.json",
                results,
              );
              const durationSeconds = (Date.now() - startTime.getTime()) / 1000;
              await hooks.onStageStart(PipelineStage.REPORT_GENERATION, {
                numResults: results.length,
              });
              const reports = prepared.map((item) =>
                convertTargetReport(
                  item,
                  splitResults(results, `redteam:${mode}:${item.safe}`),
                  mode,
                  description,
                  selection.categories,
                  runId,
                  durationSeconds,
                ),
              );
              report = mergeReports(reports, { description });
              report.pipeline = mode;
              report.durationSeconds = durationSeconds;
              report.runId = runId;
              report.testedAgents = prepared.map((item) => item.key);
              report.agentContexts = Object.fromEntries(
                prepared.map((item) => [item.key, item.context]),
              );
              if (mode === "hybrid")
                report.summary.datapointBreakdown = datapointBreakdown(data);
              report.pipelineWarnings.push(...collectFilterWarnings(metadata));
              applyCoveragePolicy(report, config);
              if (selection.unevaluableCodes.length)
                report.pipelineWarnings.unshift(
                  `Skipped ${selection.unevaluableCodes.length} requested categories with no automated evaluator (${selection.unevaluableCodes.join(", ")}): requires live-system testing.`,
                );
              await hooks.onStageEnd(PipelineStage.REPORT_GENERATION, {
                resistanceRate: report.summary.resistanceRate,
                elapsedSeconds: durationSeconds,
              });
              try {
                await sendCleanedRedteamResults(
                  results,
                  name,
                  description,
                  startTime,
                  report,
                  mode === "static" ? options.llmClient : attackerClient,
                );
              } finally {
                await saveRedteamReport(
                  pipelineOutputDir,
                  "03_summary_report.json",
                  report,
                );
              }
              await cleanup();
              const usages: (Usage | null)[] = [];
              let recommendationClient: OpenAI | undefined;
              const getRecommendationClient = async () => {
                recommendationClient ??=
                  options.llmClient ??
                  (config.evaluator.client as OpenAI | undefined) ??
                  (await createAsyncLlmClient(config.evaluator.asCallConfig(), {
                    maxRetries: config.retryCount,
                  }));
                return recommendationClient;
              };
              if (recommendations)
                try {
                  const [items, usage] = await withRedteamSpan(
                    "orq.redteam.recommendations",
                    { "orq.redteam.model": config.evaluator.model },
                    async () =>
                      generateFocusAreaRecommendations(
                        report as RedTeamReport,
                        await getRecommendationClient(),
                        config.evaluator.model,
                        { recommendations, cfg: config },
                      ),
                  );
                  report.focusAreaRecommendations = items;
                  usages.push(usage);
                } catch (error) {
                  if (isProgrammingError(error)) throw error;
                  console.warn(
                    "Failed to generate focus area recommendations",
                    error,
                  );
                  report.pipelineWarnings.push(
                    "Failed to generate focus area recommendations. Check LLM credentials and model configuration.",
                  );
                }
              if (options.generateExecutiveSummary !== false)
                try {
                  const summary = await withRedteamSpan(
                    "orq.redteam.executive_summary",
                    { "orq.redteam.model": config.evaluator.model },
                    async () =>
                      generateExecutiveSummary(
                        buildRedteamFacts(report as RedTeamReport),
                        {
                          llmClient: await getRecommendationClient(),
                          model: config.evaluator.model,
                          config: new LLMCallConfig({
                            model: config.evaluator.model,
                            ...config.evaluator.setValues(
                              "temperature",
                              "reasoningEffort",
                              "extraKwargs",
                              "maxTokens",
                              "timeoutMs",
                            ),
                            extraBody: {
                              ...config.retryExtraBody(
                                await getRecommendationClient(),
                              ),
                              ...config.evaluator.extraBody,
                            },
                          }),
                        },
                      ),
                  );
                  report.executiveSummary = summary.text;
                  usages.push(summary.usage);
                } catch (error) {
                  if (isProgrammingError(error)) throw error;
                  console.warn("Failed to generate executive summary", error);
                  report.pipelineWarnings.push(
                    "Failed to generate executive summary. Check LLM credentials and model configuration.",
                  );
                }
              const postUsage = sumStructuredUsage(usages);
              if (postUsage) {
                report.summary.postProcessingTokenUsage = postUsage;
                report.summary.tokenUsageTotal = sumStructuredUsage([
                  report.summary.tokenUsageTotal,
                  postUsage,
                ]);
              }
              report.pipelineWarnings.push(
                ...backtrackingWarnings(report.results, config.maxBacktracks),
              );
              const persisted = await persistAndIndexRedteamRun({
                report,
                save,
                userOutputDir,
                pipelineOutputDir,
                name,
                datapointInputs: data.map((row) => ({ ...row.inputs })),
                runConfig: {
                  maxTurns,
                  attackerInstructions: resolved.attackerInstructions,
                  maxBacktracks: config.maxBacktracks,
                },
                runsDir,
              });
              await hooks.onComplete(report, {
                outputDir: userOutputDir,
                autoSavePath: persisted.autoSavePath,
              });
              await writer?.complete(
                persisted.runPath,
                report.manifestSummary(),
              );
              setSpanAttrs(span, {
                "orq.redteam.num_datapoints": data.length,
                "orq.redteam.num_categories": selection.categories.length,
                "orq.redteam.duration_seconds": durationSeconds,
              });
              return report;
            }),
          parent,
        ),
      );
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        console.warn(
          "Cleanup failed while handling a redteam error",
          cleanupError,
        );
      }
      if (
        error instanceof CancelledError ||
        (error as { name?: string })?.name === "AbortError"
      )
        await writer?.cancel();
      else
        await writer?.fail(
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    } finally {
      await flushTracing();
    }
  });
}
