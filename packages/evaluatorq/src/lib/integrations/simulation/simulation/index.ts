/**
 * evaluatorq integration for agent simulation.
 *
 * Provides high-level functions to run simulations,
 * either standalone or within the evaluatorq framework.
 */

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import type OpenAI from "openai";

import { resolveLlmClient } from "../../../common/llm-client.js";
import { llmConcurrencyLimit } from "../../../common/llm-limit.js";
import { resolveDatapointParallelism } from "../../../common/parallelism.js";
import { resolveRecommendations } from "../../../common/recommendations.js";
import {
  type ManifestWriter,
  startManifest,
} from "../../../common/run-manifest.js";
import { sumStructuredUsage } from "../../../common/structured-output.js";
import { extractStatusCode } from "../../../common/target-call.js";
import {
  buildThreadId,
  conversationThread,
  evaluatorqPipeline,
  evaluatorqRunId,
} from "../../../common/thread-context.js";
import type { AgentTarget, LLMCallConfig, Usage } from "../../../contracts.js";
import { evaluatorq } from "../../../evaluatorq.js";
import { configuredOrqHost } from "../../../orq-host.js";
import { flushTracing, initTracingIfNeeded } from "../../../tracing/setup.js";
import type { DataPoint, Evaluator, Job, Output } from "../../../types.js";
import { OrqResponsesTarget } from "../../openresponses/target.js";
import { resolveSimulationTarget } from "../adapters.js";
import { fetchAgentInfo } from "../agent-snapshot.js";
import { resolveSimLlmConfig, simRoleConfig } from "../config.js";
import { toOpenResponses } from "../convert.js";
import { datapointsFromDataset } from "../datasets.js";
import {
  conversationQualityDetails,
  failureReason,
  getEvaluator,
  type SimulationScoringConfig,
  unverifiedReason,
} from "../evaluators/index.js";
import {
  SimulationCancelledError,
  SimulationDroppedError,
} from "../exceptions.js";
import { datapointsFromExperiment } from "../experiments.js";
import { FirstMessageGenerator } from "../generators/first-message-generator.js";
import { PersonaGenerator } from "../generators/persona-generator.js";
import { ScenarioGenerator } from "../generators/scenario-generator.js";
import {
  CompositeSimulationHooks,
  DefaultHooks,
  ManifestStageHooks,
  SimStage,
  type SimulationHooks,
  type SimulationRunMeta,
} from "../hooks.js";
import { populateSimulationExecutiveSummary } from "../reports/executive-summary.js";
import {
  findSimulationTriggers,
  generateSimulationRecommendations,
  SimulationRecommendationConfig,
} from "../reports/recommendations.js";
import {
  autoSaveSimulationRun,
  buildSimulationRun,
  getSimulationRunsDir,
  loadSimulationReplay,
  type SimulationRunInput,
} from "../run-store.js";
import {
  runSimulationInput,
  type SimulationInput,
} from "../runner/run-input.js";
import type {
  SimulationRunnerConfig,
  TargetAgent,
} from "../runner/simulation.js";
import { SimulationRunner } from "../runner/simulation.js";
import {
  recordTokenUsage,
  setSpanAttrs,
  withSimulationSpan,
} from "../tracing.js";
import type {
  Datapoint,
  Persona,
  Scenario,
  SimulationResult,
  TargetCallback,
} from "../types.js";
import { usageDetails } from "../usage.js";
import { generateDatapoint } from "../utils/prompt-builders.js";

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

export interface SimulateParams {
  evaluatorNames?: string[];
  experimentDescription?: string;
  evaluationDescription?: string;
  orqFolderPath?: string;
  orqResultsPath?: string;
  exitOnFailure?: boolean;
  perSimulationTimeoutMs?: number;
  evaluationName?: string;
  runName?: string;
  agentKey?: string;
  target?: string | TargetCallback | AgentTarget | TargetAgent;
  targetAgent?: AgentTarget | TargetAgent;
  llmConfig?: LLMCallConfig;
  scoring?: SimulationScoringConfig;
  generationClient?: OpenAI;
  datapointParallelism?: number;
  llmParallelism?: number;
  targetAgentTimeoutMs?: number;
  maxTargetRetries?: number;
  targetReasoningEffort?: string;
  memoryEntityId?: string;
  maxToolResultChars?: number;
  userSimulator?: SimulationRunnerConfig["userSimulator"];
  judge?: SimulationRunnerConfig["judge"];
  hooks?: SimulationHooks | SimulationHooks[];
  raiseOnExecutionFailure?: boolean;
  targetCallback?: TargetCallback;
  personas?: Persona[];
  scenarios?: Scenario[];
  datapoints?: Datapoint[];
  datasetId?: string;
  experimentId?: string;
  experimentRunId?: string;
  previousRun?: string;
  save?: boolean;
  reportPath?: string;
  report?: string;
  executiveSummary?: boolean;
  recommendations?:
    | boolean
    | import("../reports/recommendations.js").SimulationRecommendationConfig
    | import("../reports/recommendations.js").SimulationRecommendationConfigInput;
  maxTurns?: number;
  model?: string;
  evaluators?: string[];
  parallelism?: number;
  /** Limit per conversation in milliseconds. Unset leaves the run unbounded. */
  timeoutPerSimulation?: number;
  /** Upload the run to the Orq platform when ORQ_API_KEY is set. Defaults to true. */
  uploadResults?: boolean;
  /** Optional description for the evaluation run. */
  description?: string;
  /** Optional path (e.g. "MyProject/MyFolder") to place the run on the Orq platform. */
  path?: string;
  /** Pre-configured client for the user simulator, judge and first messages. */
  client?: OpenAI;
}

/**
 * High-level function to run agent simulations.
 *
 * Runs through evaluatorq(), so a simulation gets the same run and upload as any
 * other evaluation. Results come back in input order, and a failed conversation
 * becomes an error result for that row.
 *
 * Handles:
 * - Creating persona x scenario combinations
 * - Generating first messages for each combination
 * - Running simulations in parallel
 * - Applying evaluators to results
 */
export async function simulate(
  params: SimulateParams,
): Promise<SimulationResult[]> {
  if (params.uploadResults !== false && process.env.ORQ_API_KEY)
    configuredOrqHost();
  // Initialize OTel tracing (no-op if already initialized or not configured)
  await initTracingIfNeeded();

  try {
    return await llmConcurrencyLimit(params.llmParallelism, () =>
      evaluatorqPipeline("simulation", () =>
        withSimulationSpan(
          "orq.simulation.pipeline",
          {
            "orq.simulation.evaluation_name": params.evaluationName,
            "orq.simulation.max_turns": params.maxTurns ?? 10,
            "orq.simulation.parallelism": params.parallelism ?? 5,
          },
          (pipelineSpan) =>
            withSimulationSession(params, "simulate", (session) =>
              _simulateCore(params, pipelineSpan, undefined, session),
            ),
        ),
      ),
    );
  } finally {
    // Flush pending spans to ensure they're exported before the process exits
    await flushTracing();
  }
}

// ---------------------------------------------------------------------------
// Core simulation logic (shared by simulate and generateAndSimulate)
// ---------------------------------------------------------------------------

async function _simulateCore(
  params: SimulateParams,
  pipelineSpan: import("@opentelemetry/api").Span | undefined,
  generationUsage?: Usage | null,
  session?: SimulationSession,
): Promise<SimulationResult[]> {
  const {
    evaluationName: suppliedName,
    targetCallback,
    agentKey,
    datapoints,
    personas,
    scenarios,
    maxTurns: suppliedMaxTurns,
    model: suppliedModel,
    evaluators: legacyEvaluators,
    parallelism: legacyParallelism,
    uploadResults = true,
    timeoutPerSimulation: legacyTimeout,
    description: legacyDescription,
    path: legacyPath,
    client,
  } = params;

  const description = resolveAlias(
    "description/evaluationDescription",
    resolveAlias(
      "description",
      legacyDescription,
      "evaluationDescription",
      params.evaluationDescription,
    ),
    "experimentDescription",
    params.experimentDescription,
  );
  const path = resolveAlias(
    "path/orqResultsPath",
    resolveAlias("path", legacyPath, "orqResultsPath", params.orqResultsPath),
    "orqFolderPath",
    params.orqFolderPath,
  );
  const timeoutPerSimulation =
    resolveAlias(
      "timeoutPerSimulation",
      legacyTimeout,
      "perSimulationTimeoutMs",
      params.perSimulationTimeoutMs,
    ) ?? 0;
  const raiseOnExecutionFailure =
    resolveAlias(
      "exitOnFailure",
      params.exitOnFailure,
      "raiseOnExecutionFailure",
      params.raiseOnExecutionFailure,
    ) ?? true;
  if (
    params.evaluatorNames !== undefined &&
    legacyEvaluators !== undefined &&
    JSON.stringify(params.evaluatorNames) !== JSON.stringify(legacyEvaluators)
  )
    throw new Error(
      "evaluators and evaluatorNames must match when both are supplied",
    );
  const evaluatorNames = params.evaluatorNames ?? legacyEvaluators;
  if (
    params.runName !== undefined &&
    suppliedName &&
    suppliedName !== params.runName
  )
    throw new Error(
      "runName and evaluationName must match when both are supplied",
    );
  const evaluationName = (params.runName ?? suppliedName) || "sim";
  const llmConfig = resolveSimLlmConfig(
    { llmConfig: params.llmConfig, model: suppliedModel, client },
    "simulate",
  );
  const model = simRoleConfig(llmConfig, "sim.user").model;
  const parallelism = resolveDatapointParallelism(
    params.datapointParallelism,
    legacyParallelism,
    { caller: "simulate" },
  );
  if (!Number.isInteger(parallelism) || parallelism < 1)
    throw new RangeError("datapointParallelism must be >= 1");
  if (
    (legacyTimeout !== undefined ||
      params.perSimulationTimeoutMs !== undefined) &&
    (!Number.isFinite(timeoutPerSimulation) || timeoutPerSimulation <= 0)
  )
    throw new RangeError("timeoutPerSimulation must be > 0");
  const sources = [
    params.previousRun !== undefined,
    params.datasetId !== undefined,
    params.experimentId !== undefined,
    datapoints !== undefined,
    personas !== undefined || scenarios !== undefined,
  ];
  if (sources.filter(Boolean).length > 1)
    throw new Error(
      "Pass exactly one of previousRun, datasetId, experimentId, datapoints or personas+scenarios",
    );
  if (params.experimentRunId !== undefined && params.experimentId === undefined)
    throw new Error("experimentRunId requires experimentId");
  const replay =
    params.previousRun === undefined
      ? null
      : await loadSimulationReplay(params.previousRun);
  const maxTurns = suppliedMaxTurns ?? replay?.maxTurns ?? 10;
  setSpanAttrs(pipelineSpan, { "orq.simulation.max_turns": maxTurns });
  const selected =
    params.target ?? params.targetAgent ?? targetCallback ?? agentKey;
  const { targetCallback: resolvedCallback, targetAgent: resolvedTarget } =
    session?.targetResolution ?? resolveSimulationTarget(params);
  const hooks =
    session?.hooks ??
    new CompositeSimulationHooks(
      params.hooks
        ? Array.isArray(params.hooks)
          ? params.hooks
          : [params.hooks]
        : [new DefaultHooks()],
    );
  let fatalError: unknown;
  const abort = new AbortController();
  const runId = session?.runId ?? randomUUID();

  // Validate evaluator names early : throw on unknown names
  const resolvedEvaluatorNames = evaluatorNames ?? [
    "goal_achieved",
    "criteria_met",
  ];
  if (new Set(resolvedEvaluatorNames).size !== resolvedEvaluatorNames.length)
    throw new Error("duplicate evaluator names are not allowed");
  const scorers = resolvedEvaluatorNames.map((name) => ({
    name,
    fn: getEvaluator(name, params.scoring),
  }));

  let inputs: SimulationInput[];
  let firstMessages: FirstMessageGenerator | undefined;

  if (replay) {
    inputs = replay.datapoints.map((datapoint) => ({ datapoint }));
  } else if (
    params.datasetId !== undefined ||
    params.experimentId !== undefined
  ) {
    const rows =
      params.datasetId !== undefined
        ? await datapointsFromDataset(params.datasetId)
        : await datapointsFromExperiment(params.experimentId as string, {
            runId: params.experimentRunId,
          });
    inputs = rows.map((datapoint) => ({ datapoint }));
  } else if (datapoints) {
    inputs = datapoints.map((datapoint) => ({ datapoint }));
  } else {
    if (!personas || !scenarios) {
      throw new Error(
        "Either provide datasetId, experimentId, datapoints or both personas and scenarios",
      );
    }
    if (personas.length === 0 || scenarios.length === 0) {
      throw new Error(
        "'personas' and 'scenarios' arrays must both be non-empty",
      );
    }
    inputs = personas.flatMap((persona) =>
      scenarios.map((scenario) => ({ persona, scenario })),
    );
  }

  if (inputs.length === 0) {
    throw new Error(
      "No datapoints to simulate : persona or scenario generation may have failed",
    );
  }

  setSpanAttrs(pipelineSpan, {
    "orq.simulation.datapoints_count": inputs.length,
  });

  if (!resolvedCallback && !resolvedTarget) {
    throw new Error(
      "Either target, targetCallback, targetAgent, or agentKey is required",
    );
  }

  // evaluatorq() hands the same DataPoint object to the job and its evaluators,
  // so the full result can be looked up by row without going through the output.
  const resultsByRow = new Map<DataPoint, SimulationResult>();
  const casesByRow = new Map<DataPoint, Datapoint>();
  const rows = inputs.map(
    (input): DataPoint => ({ inputs: input as unknown as DataPoint["inputs"] }),
  );

  // Before the job exists: evaluatorq() records a throwing job as a row error, so
  // a bad maxTurns, model or agentKey has to surface here to keep its own message.
  const meta: SimulationRunMeta = {
    numDatapoints: inputs.length,
    model,
    maxTurns,
    datapointParallelism: parallelism,
    evaluationName,
    evaluatorNames: resolvedEvaluatorNames,
    target:
      typeof selected === "string"
        ? selected
        : resolvedTarget
          ? "agent"
          : "callback",
  };
  if (!(await hooks.onConfirm(meta)))
    throw new SimulationCancelledError("Simulation cancelled before execution");
  const runner = new SimulationRunner({
    targetCallback: resolvedCallback,
    targetAgent: resolvedTarget,
    llmConfig,
    maxTurns,
    client,
    userSimulator: params.userSimulator,
    judge: params.judge,
    hooks,
    targetAgentTimeoutMs: params.targetAgentTimeoutMs,
    maxTargetRetries: params.maxTargetRetries,
    maxToolResultChars: params.maxToolResultChars,
    signal: abort.signal,
    onFatalError: (error) => {
      fatalError ??= error;
      abort.abort(error);
    },
  });

  const job: Job = async (data, index) => {
    if (fatalError) throw fatalError;
    let result: SimulationResult;
    try {
      result = await conversationThread(buildThreadId(runId, index), () =>
        runSimulationInput(
          data.inputs as unknown as SimulationInput,
          runner,
          maxTurns,
          () => {
            firstMessages ??= new FirstMessageGenerator({
              llmConfig,
              client: params.generationClient ?? client,
            });
            return firstMessages;
          },
          timeoutPerSimulation,
          abort.signal,
        ),
      );
    } catch (error) {
      if ([401, 403].includes(extractStatusCode(error) ?? 0)) {
        fatalError ??= error;
        abort.abort(error);
      }
      throw error;
    }
    result.thread_id = buildThreadId(runId, index);
    if (evaluationName) result.metadata.evaluation_name = evaluationName;

    const input = data.inputs as unknown as SimulationInput;
    const opening = result.messages.find(
      (message) => message.role === "user",
    )?.content;
    if (typeof opening === "string" && opening) {
      const actual =
        "datapoint" in input
          ? { ...input.datapoint, first_message: opening }
          : generateDatapoint(input.persona, input.scenario, opening);
      if (typeof result.metadata.datapoint_id === "string")
        actual.id = result.metadata.datapoint_id;
      casesByRow.set(data, structuredClone(actual));
    }
    resultsByRow.set(data, result);
    return {
      name: evaluationName,
      output: toOpenResponses(result, model) as unknown as Output,
      error: failureReason(result) ?? undefined,
    };
  };

  // These never set `pass`: evaluatorq() exits the process when a pass is false,
  // and a low simulation score must not end the caller's process.
  const evaluators: Evaluator[] = scorers.map(({ name, fn }) => ({
    name,
    scorer: async ({ data }) => {
      const result = resultsByRow.get(data);
      if (!result) {
        throw new Error(`simulate: no result to score with ${name}`);
      }
      const explanation = unverifiedReason(result);
      const value = fn(result);
      const rawOutput =
        name === "conversation_quality"
          ? conversationQualityDetails(result, params.scoring).breakdown
          : name === "criteria_met"
            ? {
                criteria:
                  result.metadata.criteria_meta ?? result.criteria_results,
                criteria_verified: explanation === null,
                unverified_reason: explanation,
              }
            : undefined;
      return {
        value,
        ...(rawOutput ? { rawOutput } : {}),
        ...(explanation && { explanation }),
      };
    },
  }));

  let experimentUrl: string | null = null;
  await hooks.onRunStart(meta);
  await hooks.onStageStart(SimStage.Simulate, {});
  let primaryError: unknown;
  let cleanupError: unknown;
  let primaryFailed = false;
  let cleanupFailed = false;
  try {
    const eqResults = await evaluatorq(evaluationName, {
      data: rows,
      jobs: [job],
      evaluators,
      parallelism,
      print: false,
      description,
      path,
      sendResults: uploadResults,
      onResultsUploaded: (url) => {
        experimentUrl = url;
      },
      manageTracing: false,
    });
    for (const row of eqResults) {
      const result = resultsByRow.get(row.dataPoint);
      if (!result) continue;
      const scores: Record<string, number> = {};
      const details: Record<string, unknown> = {};
      for (const score of row.jobResults?.[0]?.evaluatorScores ?? []) {
        if (typeof score.score.value === "number" && !score.error)
          scores[score.evaluatorName] = score.score.value;
        if (score.error) {
          details[score.evaluatorName] = { error: score.error.message };
          const errors = Array.isArray(result.metadata.scorer_errors)
            ? result.metadata.scorer_errors
            : [];
          errors.push(`${score.evaluatorName}: ${score.error.message}`);
          result.metadata.scorer_errors = errors;
        } else if (score.score.rawOutput)
          details[score.evaluatorName] = score.score.rawOutput;
        await hooks.onEvaluatorComplete(
          String(result.metadata.datapoint_id ?? ""),
          score.evaluatorName,
          score,
        );
      }
      result.metadata.evaluator_scores = scores;
      result.evaluator_details = details;
    }
    const completed = rows.flatMap((row) => {
      const result = resultsByRow.get(row);
      return result ? [result] : [];
    });
    const failed = completed.filter((result) => failureReason(result)).length;
    if (
      raiseOnExecutionFailure &&
      (completed.length !== rows.length || failed > 0)
    )
      throw new SimulationDroppedError(
        `Simulation execution failed: ${rows.length - completed.length} missing row(s), ${failed} failed row(s)`,
        completed,
      );
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  } finally {
    const results = rows.flatMap((row) => {
      const result = resultsByRow.get(row);
      return result ? [result] : [];
    });
    for (const cleanup of [
      () => runner.close(),
      () => hooks.onRunComplete(results),
      () => hooks.onStageEnd(SimStage.Simulate, { error: primaryError }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        if (!cleanupFailed) cleanupError = error;
        cleanupFailed = true;
        console.warn("Simulation cleanup hook failed", error);
      }
    }
  }

  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;

  const partial = rows.flatMap((row) => {
    const result = resultsByRow.get(row);
    return result ? [result] : [];
  });

  const results = partial;
  generationUsage = sumStructuredUsage([
    generationUsage,
    firstMessages?.getUsage(),
  ]);

  // Record aggregate token usage on the pipeline span
  const totalUsage = results.reduce(
    (acc, r) => ({
      prompt: acc.prompt + (r.token_usage?.prompt_tokens ?? 0),
      completion: acc.completion + (r.token_usage?.completion_tokens ?? 0),
      total: acc.total + (r.token_usage?.total_tokens ?? 0),
    }),
    {
      prompt: generationUsage?.inputTokens ?? 0,
      completion: generationUsage?.outputTokens ?? 0,
      total: generationUsage?.totalTokens ?? 0,
    },
  );
  recordTokenUsage(pipelineSpan, {
    promptTokens: totalUsage.prompt,
    completionTokens: totalUsage.completion,
    totalTokens: totalUsage.total,
  });

  setSpanAttrs(pipelineSpan, {
    "orq.simulation.results_count": results.length,
    "orq.simulation.goal_achieved_count": results.filter((r) => r.goal_achieved)
      .length,
  });

  {
    let savedPath: string | null = null;
    let summary: import("../../../contracts.js").RunSummary = {
      mode: session?.mode ?? "simulate",
      totalResults: results.length,
    };
    try {
      const deploymentKey =
        typeof selected === "function" &&
        "deploymentKey" in selected &&
        typeof selected.deploymentKey === "string"
          ? selected.deploymentKey
          : null;
      const stringTarget =
        typeof selected === "string"
          ? selected
          : deploymentKey
            ? `deployment:${deploymentKey}`
            : null;
      const modelTarget =
        resolvedTarget instanceof OrqResponsesTarget
          ? resolvedTarget.config.model
          : null;
      const kind: SimulationRunInput["targetKind"] = stringTarget?.startsWith(
        "deployment:",
      )
        ? "orq_deployment"
        : stringTarget !== null || modelTarget?.startsWith("agent/")
          ? "orq_agent"
          : modelTarget
            ? "openai_model"
            : "callback";
      const target = stringTarget ?? modelTarget ?? "callback";
      const recorded = rows.map((row) => casesByRow.get(row));
      const completeCases = recorded.every(
        (value): value is Datapoint => value !== undefined,
      );
      if (!completeCases)
        console.warn(
          "Some simulation cases have no recorded opening; saved results cannot be replayed.",
        );
      const run = buildSimulationRun({
        runName: evaluationName,
        mode: session?.mode ?? "simulate",
        targetKind: kind,
        target,
        agentInfo:
          kind === "orq_agent"
            ? await fetchAgentInfo(target.replace(/^agent[:/]/, ""))
            : null,
        targetModel:
          results
            .map((result) => result.metadata.target_model)
            .find((value): value is string => typeof value === "string") ??
          modelTarget,
        maxTurns,
        runId,
        experimentUrl,
        evaluatorNames: resolvedEvaluatorNames,
        results,
        datapoints: completeCases ? recorded : null,
        tokenUsageTotal: sumStructuredUsage([
          generationUsage,
          ...results.map((result) =>
            usageDetails(result.token_usage, result.usage),
          ),
        ]),
      });
      const recommendationConfig = resolveRecommendations(
        params.recommendations ?? true,
        () => new SimulationRecommendationConfig(),
      );
      if (recommendationConfig !== null) {
        try {
          const config = new SimulationRecommendationConfig(
            recommendationConfig,
          );
          if (
            !params.save &&
            run.results.some(
              (result) => findSimulationTriggers(result, config).length,
            )
          )
            console.warn(
              "recommendations are enabled but the run is not saved; generated suggestions will be discarded",
            );
          const resolved = await resolveLlmClient(
            llmConfig.client as OpenAI | undefined,
            { maxRetries: 0 },
          );
          const recommendations = await generateSimulationRecommendations(
            run.results,
            resolved.client,
            simRoleConfig(llmConfig, "sim.generator").model,
            {
              config,
              llmConfig,
              onUsage: (usage) => {
                if (usage)
                  run.tokenUsageTotal = sumStructuredUsage([
                    run.tokenUsageTotal,
                    usage,
                  ]);
              },
            },
          );
          run.recommendations = recommendations.length ? recommendations : null;
        } catch (error) {
          console.warn(
            "Failed to generate remediation suggestions; completed results remain available",
            error,
          );
        }
      }
      try {
        await populateSimulationExecutiveSummary(run, {
          enabled: params.executiveSummary ?? true,
          model: simRoleConfig(llmConfig, "sim.generator").model,
          llmConfig,
        });
      } catch (error) {
        console.warn(
          "Failed to generate executive summary; completed results remain available",
          error,
        );
      }
      summary = run.manifestSummary();
      const output = session?.reportPath;
      if (!params.save) return results;
      if (output) {
        await run.save(output);
        savedPath = output;
      } else savedPath = await autoSaveSimulationRun(run);
      console.debug(`Run saved: ${savedPath}`);
    } catch (error) {
      console.warn(
        "Failed to prepare or save simulation run; completed results are still returned",
        error,
      );
    }
    if (params.save) await session?.writer?.complete(savedPath, summary);
  }
  return results;
}

// ---------------------------------------------------------------------------
// generateAndSimulate
// ---------------------------------------------------------------------------

export interface GenerateAndSimulateParams
  extends Omit<
    SimulateParams,
    | "personas"
    | "scenarios"
    | "datapoints"
    | "datasetId"
    | "experimentId"
    | "experimentRunId"
    | "previousRun"
  > {
  agentDescription: string;
  numPersonas?: number;
  numScenarios?: number;
}

/**
 * Generate personas/scenarios and run simulations.
 *
 * Convenience function that combines generation and simulation.
 */
export async function generateAndSimulate(
  params: GenerateAndSimulateParams,
): Promise<SimulationResult[]> {
  if (params.uploadResults !== false && process.env.ORQ_API_KEY)
    configuredOrqHost();
  // Initialize tracing early so generation spans are captured
  await initTracingIfNeeded();

  const {
    evaluationName,
    agentDescription,
    targetCallback,
    agentKey,
    numPersonas = 5,
    numScenarios = 5,
    maxTurns = 10,
    model,
    evaluators,
    parallelism,
    uploadResults,
    timeoutPerSimulation,
    description,
    path,
    client,
  } = params;

  if (!targetCallback && !agentKey && !params.target && !params.targetAgent) {
    throw new Error(
      "Either targetCallback or agentKey is required for generateAndSimulate",
    );
  }

  try {
    return await llmConcurrencyLimit(params.llmParallelism, () =>
      evaluatorqPipeline("simulation", () =>
        withSimulationSpan(
          "orq.simulation.pipeline",
          {
            "orq.simulation.evaluation_name": evaluationName,
            "orq.simulation.mode": "generate_and_simulate",
            "orq.simulation.num_personas": numPersonas,
            "orq.simulation.num_scenarios": numScenarios,
            "orq.simulation.max_turns": maxTurns,
            "orq.simulation.parallelism":
              params.datapointParallelism ?? parallelism ?? 10,
          },
          async (pipelineSpan) => {
            return withSimulationSession(params, "run", async (session) => {
              await session.hooks.onStageStart(SimStage.Generate, {});
              // Generate personas and scenarios in parallel (under the pipeline span)
              const llmConfig = resolveSimLlmConfig(
                params,
                "generateAndSimulate",
              );
              const personaGen = new PersonaGenerator({
                llmConfig,
                client: params.generationClient ?? client,
              });
              const scenarioGen = new ScenarioGenerator({
                llmConfig,
                client: params.generationClient ?? client,
              });

              const [personas, scenarios] = await Promise.all([
                personaGen.generate({
                  agentDescription,
                  numPersonas,
                }),
                scenarioGen.generate({
                  agentDescription,
                  numScenarios,
                }),
              ]);

              await session.hooks.onStageEnd(SimStage.Generate, {});
              // Delegate to core logic (no duplicate pipeline span)
              return _simulateCore(
                {
                  ...params,
                  evaluationName,
                  targetCallback,
                  agentKey,
                  personas,
                  scenarios,
                  maxTurns,
                  model,
                  evaluators,
                  parallelism,
                  uploadResults,
                  timeoutPerSimulation,
                  description,
                  path,
                  client,
                },
                pipelineSpan,
                sumStructuredUsage([
                  personaGen.getUsage(),
                  scenarioGen.getUsage(),
                ]),
                session,
              );
            });
          },
        ),
      ),
    );
  } finally {
    await flushTracing();
  }
}

// Re-export evaluator utilities for convenience
export {
  getAllEvaluators,
  getEvaluator,
  SIMULATION_EVALUATORS,
} from "../evaluators/index.js";

function resolveAlias<T>(
  oldName: string,
  oldValue: T | undefined,
  newName: string,
  newValue: T | undefined,
): T | undefined {
  if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue)
    throw new Error(
      `${oldName} and ${newName} must match when both are supplied`,
    );
  return newValue ?? oldValue;
}

interface SimulationSession {
  targetResolution: ReturnType<typeof resolveSimulationTarget>;
  runId: string;
  mode: "run" | "simulate";
  hooks: CompositeSimulationHooks;
  writer: ManifestWriter | null;
  reportPath?: string;
}
async function withSimulationSession(
  params: SimulateParams,
  mode: "run" | "simulate",
  work: (session: SimulationSession) => Promise<SimulationResult[]>,
): Promise<SimulationResult[]> {
  const targetResolution = resolveSimulationTarget(params);
  const selected =
    params.target ??
    params.targetAgent ??
    params.targetCallback ??
    params.agentKey;
  if (
    typeof selected === "string" &&
    (selected.startsWith("agent:") || !selected.includes(":"))
  )
    await resolveLlmClient(null, { requireOrq: true, maxRetries: 0 });
  else if (
    selected instanceof OrqResponsesTarget &&
    selected.options.requireOrq
  )
    await resolveLlmClient(
      selected.options.client ?? (selected.config.client as OpenAI | undefined),
      {
        requireOrq: true,
        maxRetries: 0,
      },
    );
  if (
    !(params.client ?? params.llmConfig?.client) &&
    (!params.userSimulator ||
      !params.judge ||
      (mode === "run" && !params.generationClient)) &&
    !process.env.ORQ_API_KEY &&
    !process.env.OPENAI_API_KEY
  ) {
    throw new Error(
      "Set ORQ_API_KEY or OPENAI_API_KEY, or pass client/llmConfig.client for simulation",
    );
  }
  const reportPath = resolveAlias(
    "report",
    params.report,
    "reportPath",
    params.reportPath,
  );
  const runName =
    resolveAlias(
      "evaluationName",
      params.evaluationName,
      "runName",
      params.runName,
    ) || "sim";
  const runId = randomUUID();
  const writer = params.save
    ? await startManifest({
        runId,
        surface: "sim",
        runName,
        runsDir: reportPath
          ? dirname(resolve(reportPath))
          : getSimulationRunsDir(),
        plannedStages:
          mode === "run"
            ? [SimStage.Generate, SimStage.Simulate]
            : [SimStage.Simulate],
      })
    : null;
  const user = params.hooks
    ? Array.isArray(params.hooks)
      ? params.hooks
      : [params.hooks]
    : [new DefaultHooks()];
  const hooks = new CompositeSimulationHooks([
    ...(writer ? [new ManifestStageHooks(writer)] : []),
    ...user,
  ]);
  try {
    return await evaluatorqRunId(runId, () =>
      work({
        targetResolution,
        runId,
        mode,
        hooks,
        writer,
        reportPath: reportPath ? resolve(reportPath) : undefined,
      }),
    );
  } catch (error) {
    if (error instanceof SimulationCancelledError) await writer?.cancel();
    else
      await writer?.fail(
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  }
}
