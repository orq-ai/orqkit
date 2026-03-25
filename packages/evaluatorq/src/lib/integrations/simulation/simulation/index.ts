/**
 * evaluatorq integration for agent simulation.
 *
 * Provides high-level functions to run simulations,
 * either standalone or within the evaluatorq framework.
 */

import OpenAI from "openai";

import { fromOrqDeployment } from "../adapters.js";
import { getEvaluator } from "../evaluators/index.js";
import { FirstMessageGenerator } from "../generators/first-message-generator.js";
import { SimulationRunner } from "../runner/simulation.js";
import type {
  ChatMessage,
  Datapoint,
  Persona,
  Scenario,
  SimulationResult,
} from "../types.js";
import { generateDatapoint } from "../utils/prompt-builders.js";

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
}

/**
 * High-level function to run agent simulations.
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
  const {
    targetCallback,
    personas,
    scenarios,
    maxTurns = 10,
    model = "azure/gpt-4o-mini",
    evaluators: evaluatorNames,
    parallelism = 5,
  } = params;

  let { datapoints } = params;

  // Validate evaluator names early — throw on unknown names
  const resolvedEvaluatorNames = evaluatorNames ?? [
    "goal_achieved",
    "criteria_met",
  ];
  const scorers = resolvedEvaluatorNames.map((name) => ({
    name,
    fn: getEvaluator(name),
  }));

  // Build datapoints from personas x scenarios if not provided
  if (!datapoints) {
    if (!personas || !scenarios) {
      throw new Error(
        "Either provide 'datapoints' or both 'personas' and 'scenarios'",
      );
    }

    const apiKey = process.env.ORQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ORQ_API_KEY environment variable is not set. Set it before calling simulate().",
      );
    }
    // Create a shared HTTP client so the generator doesn't leak its own pool
    const sharedClient = new OpenAI({
      apiKey,
      baseURL: process.env.ROUTER_BASE_URL ?? "https://api.orq.ai/v2/router",
    });
    // Generate first messages for each combination (with bounded concurrency)
    const firstMsgGen = new FirstMessageGenerator({
      model,
      client: sharedClient,
    });
    const pairs = personas.flatMap((persona) =>
      scenarios.map((scenario) => ({ persona, scenario })),
    );
    const FIRST_MSG_CONCURRENCY = 5;
    const generatedDatapoints: Datapoint[] = [];
    for (let i = 0; i < pairs.length; i += FIRST_MSG_CONCURRENCY) {
      const batch = pairs.slice(i, i + FIRST_MSG_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ persona, scenario }) => {
          const firstMessage = await firstMsgGen.generate(persona, scenario);
          return generateDatapoint(persona, scenario, firstMessage);
        }),
      );
      generatedDatapoints.push(...batchResults);
    }
    datapoints = generatedDatapoints;
  }

  if (!datapoints || datapoints.length === 0) {
    throw new Error(
      "No datapoints to simulate — persona or scenario generation may have failed",
    );
  }

  // Bridge agentKey to invoke() if no callback is provided
  let resolvedCallback = targetCallback;
  if (!resolvedCallback && params.agentKey) {
    resolvedCallback = fromOrqDeployment(params.agentKey);
  }

  if (!resolvedCallback) {
    throw new Error("Either targetCallback or agentKey is required");
  }

  // Create simulation runner
  const runner = new SimulationRunner({
    targetCallback: resolvedCallback,
    model,
    maxTurns,
  });

  try {
    // Run simulations
    const results = await runner.runBatch({
      datapoints,
      maxTurns,
      maxConcurrency: parallelism,
    });

    // Apply evaluators to results
    for (const result of results) {
      const scores: Record<string, number> = {};
      for (const { name, fn } of scorers) {
        scores[name] = fn(result);
      }
      (result.metadata as Record<string, unknown>).evaluator_scores = scores;
    }

    return results;
  } finally {
    await runner.close();
  }
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
}

/**
 * Generate personas/scenarios and run simulations.
 *
 * Convenience function that combines generation and simulation.
 */
export async function generateAndSimulate(
  params: GenerateAndSimulateParams,
): Promise<SimulationResult[]> {
  const {
    evaluationName,
    agentDescription,
    targetCallback,
    numPersonas = 5,
    numScenarios = 5,
    maxTurns = 10,
    model = "azure/gpt-4o-mini",
    evaluators,
    parallelism = 5,
  } = params;

  // Bridge agentKey to invoke() if no callback is provided
  let resolvedCallback = targetCallback;
  if (!resolvedCallback && params.agentKey) {
    resolvedCallback = fromOrqDeployment(params.agentKey);
  }

  if (!resolvedCallback) {
    throw new Error(
      "Either targetCallback or agentKey is required for generateAndSimulate",
    );
  }

  // Dynamic import to avoid hard dependency on generators module
  let PersonaGenerator: new (config?: {
    model?: string;
  }) => {
    generate(params: {
      agentDescription: string;
      numPersonas: number;
    }): Promise<Persona[]>;
  };
  let ScenarioGenerator: new (config?: {
    model?: string;
  }) => {
    generate(params: {
      agentDescription: string;
      numScenarios: number;
    }): Promise<Scenario[]>;
  };

  try {
    const generators = await import("../generators/index.js");
    PersonaGenerator = generators.PersonaGenerator;
    ScenarioGenerator = generators.ScenarioGenerator;
  } catch (err) {
    throw new Error(
      "Generators module not available. Install generators or provide pre-built datapoints using simulate() instead.",
      { cause: err },
    );
  }

  // Generate personas and scenarios in parallel
  const personaGen = new PersonaGenerator({ model });
  const scenarioGen = new ScenarioGenerator({ model });

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

  // Run simulations
  return simulate({
    evaluationName,
    targetCallback: resolvedCallback,
    personas,
    scenarios,
    maxTurns,
    model,
    evaluators,
    parallelism,
  });
}

// Re-export evaluator utilities for convenience
export {
  getAllEvaluators,
  getEvaluator,
  SIMULATION_EVALUATORS,
} from "../evaluators/index.js";
