/**
 * Wraps the simulation framework as an evaluatorq Job.
 *
 * Follows the same pattern as wrapAISdkAgent() and wrapLangChainAgent().
 */

import type { DataPoint, Job, Output } from "../../types.js";
import { toOpenResponses } from "./convert.js";
import { simulate } from "./simulation/index.js";
import type {
  ChatMessage,
  Datapoint,
  Persona,
  Scenario,
  SimulationResult,
} from "./types.js";

/**
 * Options for creating a simulation job.
 */
export interface SimulationJobOptions {
  /** Display name for this job in results. Defaults to "simulation". */
  name?: string;
  /** Target agent callback — receives messages and returns a response string. */
  targetCallback?: (messages: ChatMessage[]) => string | Promise<string>;
  /** Orq deployment key — used if targetCallback is not provided. */
  agentKey?: string;
  /** Maximum conversation turns per simulation. Defaults to 10. */
  maxTurns?: number;
  /** Model used for user simulator and judge agents. Defaults to "azure/gpt-4o-mini". */
  model?: string;
  /** Built-in evaluator names to apply to results. Defaults to ["goal_achieved", "criteria_met"]. */
  evaluators?: string[];
}

/**
 * Creates an evaluatorq Job that runs agent simulations.
 *
 * Each DataPoint should have inputs containing simulation data:
 * - `persona` (Persona object) and `scenario` (Scenario object), or
 * - `datapoint` (full Datapoint object), or
 * - `personas` (Persona[]) and `scenarios` (Scenario[]) for batch generation
 *
 * The job:
 * 1. Extracts persona/scenario/datapoint from data.inputs
 * 2. Runs simulate() with the target agent
 * 3. Converts the first result to OpenResponses format
 * 4. Returns { name, output: ResponseResource }
 *
 * @example
 * ```typescript
 * import { wrapSimulationAgent } from "@orq-ai/evaluatorq/simulation";
 *
 * const job = wrapSimulationAgent({
 *   targetCallback: async (messages) => {
 *     // Your agent logic here
 *     return "Agent response";
 *   },
 *   maxTurns: 5,
 * });
 *
 * await evaluatorq("simulation-eval", {
 *   data: [
 *     {
 *       inputs: {
 *         persona: { name: "Impatient User", patience: 0.2, ... },
 *         scenario: { name: "Refund Request", goal: "Get a refund", ... },
 *       },
 *     },
 *   ],
 *   jobs: [job],
 * });
 * ```
 */
export function wrapSimulationAgent(options: SimulationJobOptions): Job {
  const {
    name = "simulation",
    targetCallback,
    agentKey,
    maxTurns = 10,
    model,
    evaluators,
  } = options;

  return async (data: DataPoint, _row: number) => {
    // Resolve the target callback
    let resolvedCallback = targetCallback;
    if (!resolvedCallback && agentKey) {
      const { invoke } = await import("../../deployment-helper.js");
      resolvedCallback = async (messages: ChatMessage[]) => {
        return invoke(agentKey, { messages });
      };
    }

    if (!resolvedCallback) {
      throw new Error(
        "wrapSimulationAgent requires either targetCallback or agentKey",
      );
    }

    // Extract simulation inputs from DataPoint
    const inputs = data.inputs;

    let datapoints: Datapoint[] | undefined;
    let personas: Persona[] | undefined;
    let scenarios: Scenario[] | undefined;

    if (inputs.datapoint) {
      datapoints = [inputs.datapoint as Datapoint];
    } else if (inputs.datapoints) {
      datapoints = inputs.datapoints as Datapoint[];
    } else if (inputs.persona && inputs.scenario) {
      personas = [inputs.persona as Persona];
      scenarios = [inputs.scenario as Scenario];
    } else if (inputs.personas && inputs.scenarios) {
      personas = inputs.personas as Persona[];
      scenarios = inputs.scenarios as Scenario[];
    } else {
      throw new Error(
        "Expected data.inputs to contain 'persona' + 'scenario', 'datapoint', 'datapoints', or 'personas' + 'scenarios'",
      );
    }

    // Run simulation
    const results: SimulationResult[] = await simulate({
      evaluationName: name,
      targetCallback: resolvedCallback,
      datapoints,
      personas,
      scenarios,
      maxTurns,
      model,
      evaluators,
    });

    // Convert first result to OpenResponses format
    const result = results[0];
    if (!result) {
      throw new Error("Simulation produced no results");
    }
    if (results.length > 1) {
      console.warn(
        `wrapSimulationAgent: ${results.length} simulations ran but only the first result is returned. ` +
          "Use simulate() directly to collect all results.",
      );
    }

    const openResponsesOutput = toOpenResponses(result, model);

    return {
      name,
      output: openResponsesOutput as unknown as Output,
    };
  };
}
