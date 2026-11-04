/**
 * evaluatorq integration for agent simulation.
 *
 * Provides high-level functions to run simulations,
 * either standalone or within the evaluatorq framework.
 */

import type OpenAI from "openai";

import { evaluatorq } from "../../../evaluatorq.js";
import { flushTracing, initTracingIfNeeded } from "../../../tracing/setup.js";
import type { DataPoint, Evaluator, Job, Output } from "../../../types.js";
import { fromOrqAgent } from "../adapters.js";
import { toOpenResponses } from "../convert.js";
import { DEFAULT_SIMULATION_MODEL } from "../defaults.js";
import {
  failureReason,
  getEvaluator,
  unverifiedReason,
} from "../evaluators/index.js";
import { FirstMessageGenerator } from "../generators/first-message-generator.js";
import { PersonaGenerator } from "../generators/persona-generator.js";
import { ScenarioGenerator } from "../generators/scenario-generator.js";
import {
  runSimulationInput,
  type SimulationInput,
} from "../runner/run-input.js";
import { SimulationRunner } from "../runner/simulation.js";
import {
  recordTokenUsage,
  setSpanAttrs,
  withSimulationSpan,
} from "../tracing.js";
import type {
  ChatMessage,
  Datapoint,
  Persona,
  Scenario,
  SimulationResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

export interface SimulateParams {
  evaluationName: string;
  agentKey?: string;
  targetCallback?: (messages: ChatMessage[]) => string | Promise<string>;
  personas?: Persona[];
  scenarios?: Scenario[];
  datapoints?: Datapoint[];
  maxTurns?: number;
  model?: string;
  evaluators?: string[];
  parallelism?: number;
  /** Limit per conversation in milliseconds. Defaults to 300_000. */
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
  // Initialize OTel tracing (no-op if already initialized or not configured)
  await initTracingIfNeeded();

  try {
    return await withSimulationSpan(
      "orq.simulation.pipeline",
      {
        "orq.simulation.evaluation_name": params.evaluationName,
        "orq.simulation.max_turns": params.maxTurns ?? 10,
        "orq.simulation.parallelism": params.parallelism ?? 5,
      },
      (pipelineSpan) => _simulateCore(params, pipelineSpan),
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
): Promise<SimulationResult[]> {
  const {
    evaluationName,
    targetCallback,
    agentKey,
    datapoints,
    personas,
    scenarios,
    maxTurns = 10,
    model = DEFAULT_SIMULATION_MODEL,
    evaluators: evaluatorNames,
    parallelism = 5,
    uploadResults = true,
    timeoutPerSimulation,
    description,
    path,
    client,
  } = params;

  // Validate evaluator names early — throw on unknown names
  const resolvedEvaluatorNames = evaluatorNames ?? [
    "goal_achieved",
    "criteria_met",
  ];
  const scorers = resolvedEvaluatorNames.map((name) => ({
    name,
    fn: getEvaluator(name),
  }));

  let inputs: SimulationInput[];
  let firstMessages: FirstMessageGenerator | undefined;

  if (datapoints) {
    inputs = datapoints.map((datapoint) => ({ datapoint }));
  } else {
    if (!personas || !scenarios) {
      throw new Error(
        "Either provide 'datapoints' or both 'personas' and 'scenarios'",
      );
    }
    if (personas.length === 0 || scenarios.length === 0) {
      throw new Error(
        "'personas' and 'scenarios' arrays must both be non-empty",
      );
    }
    firstMessages = new FirstMessageGenerator({ model, client });
    inputs = personas.flatMap((persona) =>
      scenarios.map((scenario) => ({ persona, scenario })),
    );
  }

  if (inputs.length === 0) {
    throw new Error(
      "No datapoints to simulate — persona or scenario generation may have failed",
    );
  }

  setSpanAttrs(pipelineSpan, {
    "orq.simulation.datapoints_count": inputs.length,
  });

  if (!targetCallback && !agentKey) {
    throw new Error("Either targetCallback or agentKey is required");
  }

  // The upload only reads ORQ_BASE_URL, so a staging run would land in production.
  const routerOnly = !process.env.ORQ_BASE_URL && process.env.ROUTER_BASE_URL;
  if (uploadResults && routerOnly) {
    console.warn(
      "simulate: not uploading results because only ROUTER_BASE_URL is set. Set ORQ_BASE_URL to the host instead.",
    );
  }

  const stampScores = (result: SimulationResult): void => {
    const scores: Record<string, number> = {};
    for (const { name, fn } of scorers) {
      scores[name] = fn(result);
    }
    (result.metadata as Record<string, unknown>).evaluator_scores = scores;
  };

  // evaluatorq() hands the same DataPoint object to the job and its evaluators,
  // so the full result can be looked up by row without going through the output.
  const resultsByRow = new Map<DataPoint, SimulationResult>();
  const rows = inputs.map(
    (input): DataPoint => ({ inputs: input as unknown as DataPoint["inputs"] }),
  );

  const job: Job = async (data) => {
    // A row gets its own runner because fromOrqAgent finds a conversation by
    // its first message, which rows can share.
    const runner = new SimulationRunner({
      targetCallback: targetCallback ?? fromOrqAgent(agentKey as string),
      model,
      maxTurns,
      client,
    });
    const result = await runSimulationInput(
      data.inputs as unknown as SimulationInput,
      runner,
      maxTurns,
      () => firstMessages as FirstMessageGenerator,
      timeoutPerSimulation,
    ).finally(() => runner.close());
    stampScores(result);
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
      return { value: fn(result), ...(explanation && { explanation }) };
    },
  }));

  await evaluatorq(evaluationName, {
    data: rows,
    jobs: [job],
    evaluators,
    parallelism,
    print: false,
    description,
    path,
    sendResults: uploadResults && !routerOnly,
    manageTracing: false,
  });

  const results = rows.map((row, i) => {
    const result = resultsByRow.get(row);
    if (result) {
      return result;
    }
    throw new Error(`simulate: row ${i} produced no result`);
  });

  // Record aggregate token usage on the pipeline span
  const totalUsage = results.reduce(
    (acc, r) => ({
      prompt: acc.prompt + (r.token_usage?.prompt_tokens ?? 0),
      completion: acc.completion + (r.token_usage?.completion_tokens ?? 0),
      total: acc.total + (r.token_usage?.total_tokens ?? 0),
    }),
    { prompt: 0, completion: 0, total: 0 },
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

  return results;
}

// ---------------------------------------------------------------------------
// generateAndSimulate
// ---------------------------------------------------------------------------

export interface GenerateAndSimulateParams {
  evaluationName: string;
  agentKey?: string;
  agentDescription: string;
  targetCallback?: (messages: ChatMessage[]) => string | Promise<string>;
  numPersonas?: number;
  numScenarios?: number;
  maxTurns?: number;
  model?: string;
  evaluators?: string[];
  parallelism?: number;
  /** Limit per conversation in milliseconds. Defaults to 300_000. */
  timeoutPerSimulation?: number;
  /** Upload the run to the Orq platform when ORQ_API_KEY is set. Defaults to true. */
  uploadResults?: boolean;
  /** Optional description for the evaluation run. */
  description?: string;
  /** Optional path (e.g. "MyProject/MyFolder") to place the run on the Orq platform. */
  path?: string;
  /** Pre-configured client for generation, the user simulator and the judge. */
  client?: OpenAI;
}

/**
 * Generate personas/scenarios and run simulations.
 *
 * Convenience function that combines generation and simulation.
 */
export async function generateAndSimulate(
  params: GenerateAndSimulateParams,
): Promise<SimulationResult[]> {
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
    model = DEFAULT_SIMULATION_MODEL,
    evaluators,
    parallelism = 5,
    uploadResults,
    timeoutPerSimulation,
    description,
    path,
    client,
  } = params;

  if (!targetCallback && !agentKey) {
    throw new Error(
      "Either targetCallback or agentKey is required for generateAndSimulate",
    );
  }

  try {
    return await withSimulationSpan(
      "orq.simulation.pipeline",
      {
        "orq.simulation.evaluation_name": evaluationName,
        "orq.simulation.mode": "generate_and_simulate",
        "orq.simulation.num_personas": numPersonas,
        "orq.simulation.num_scenarios": numScenarios,
        "orq.simulation.max_turns": maxTurns,
        "orq.simulation.parallelism": parallelism,
      },
      async (pipelineSpan) => {
        // Generate personas and scenarios in parallel (under the pipeline span)
        const personaGen = new PersonaGenerator({ model, client });
        const scenarioGen = new ScenarioGenerator({ model, client });

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

        // Delegate to core logic (no duplicate pipeline span)
        return _simulateCore(
          {
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
        );
      },
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
