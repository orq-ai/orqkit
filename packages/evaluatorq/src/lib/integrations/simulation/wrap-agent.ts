/**
 * Wraps the simulation framework as an evaluatorq Job.
 *
 * Follows the same pattern as wrapAISdkAgent() and wrapLangChainAgent().
 */

import type OpenAI from "openai";

import type { DataPoint, Job, Output } from "../../types.js";
import { fromOrqAgent } from "./adapters.js";
import { toOpenResponses } from "./convert.js";
import { failureReason } from "./evaluators/index.js";
import { FirstMessageGenerator } from "./generators/first-message-generator.js";
import {
  runSimulationInput,
  type SimulationInput,
} from "./runner/run-input.js";
import { SimulationRunner } from "./runner/simulation.js";
import type { ChatMessage, Datapoint, Persona, Scenario } from "./types.js";

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
  /** Model used for user simulator and judge agents. Defaults to DEFAULT_SIMULATION_MODEL. */
  model?: string;
  /** Pre-configured client for the user simulator, judge and first messages. */
  client?: OpenAI;
}

/**
 * Creates an evaluatorq Job that runs one simulated conversation per row.
 *
 * Each DataPoint should have inputs containing simulation data:
 * - `persona` (Persona object) and `scenario` (Scenario object), or
 * - `datapoint` (full Datapoint object), or
 * - `datapoints`, or `personas` and `scenarios`, holding exactly one entry
 *
 * The job:
 * 1. Extracts one persona/scenario/datapoint from data.inputs
 * 2. Runs the conversation against the target agent
 * 3. Returns { name, output: ResponseResource }, plus `error` if the run failed
 *
 * Score results with the `evaluators` option of evaluatorq(), not here.
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
  if ("evaluators" in options) {
    throw new Error(
      "wrapSimulationAgent no longer takes 'evaluators'. Pass scorers to the 'evaluators' option of evaluatorq() instead.",
    );
  }

  const {
    name = "simulation",
    targetCallback,
    agentKey,
    maxTurns = 10,
    model,
    client,
  } = options;

  // One of each per job, so rows share a client instead of opening their own.
  let runner: SimulationRunner | undefined;
  let firstMessages: FirstMessageGenerator | undefined;
  const getFirstMessages = () => {
    firstMessages ??= new FirstMessageGenerator({ model, client });
    return firstMessages;
  };

  return async (data: DataPoint, _row: number) => {
    if (!targetCallback && !agentKey) {
      throw new Error(
        "wrapSimulationAgent requires either targetCallback or agentKey",
      );
    }

    const input = extractSingleInput(data.inputs);

    runner ??= new SimulationRunner({
      targetCallback: targetCallback ?? fromOrqAgent(agentKey as string),
      model,
      maxTurns,
      client,
    });

    const result = await runSimulationInput(
      input,
      runner,
      maxTurns,
      getFirstMessages,
    );

    return {
      name,
      output: toOpenResponses(result, runner.modelName) as unknown as Output,
      error: failureReason(result) ?? undefined,
    };
  };
}

/** Pull exactly one conversation out of a row's inputs. */
function extractSingleInput(inputs: DataPoint["inputs"]): SimulationInput {
  if (inputs.datapoint) {
    validateDatapoint(inputs.datapoint, "datapoint");
    return { datapoint: inputs.datapoint as unknown as Datapoint };
  }

  if (inputs.datapoints) {
    const datapoints = requireSingle(inputs.datapoints, "datapoints");
    validateDatapoint(datapoints, "datapoints[]");
    return { datapoint: datapoints as Datapoint };
  }

  if (inputs.persona && inputs.scenario) {
    return singlePair(inputs.persona, inputs.scenario, "persona", "scenario");
  }

  if (inputs.personas && inputs.scenarios) {
    return singlePair(
      requireSingle(inputs.personas, "personas"),
      requireSingle(inputs.scenarios, "scenarios"),
      "personas[]",
      "scenarios[]",
    );
  }

  throw new Error(
    "Expected data.inputs to contain 'persona' + 'scenario', 'datapoint', 'datapoints', or 'personas' + 'scenarios'",
  );
}

function singlePair(
  persona: unknown,
  scenario: unknown,
  personaLabel: string,
  scenarioLabel: string,
): SimulationInput {
  validateShape(persona, personaLabel, ["name"]);
  validateShape(scenario, scenarioLabel, ["name", "goal"]);
  return { persona: persona as Persona, scenario: scenario as Scenario };
}

function requireSingle(value: unknown, label: string): unknown {
  if (!Array.isArray(value)) {
    throw new Error(`Expected '${label}' to be an array`);
  }
  if (value.length !== 1) {
    throw new Error(
      `'${label}' must encode exactly one datapoint, got ${value.length}. Use one row per conversation.`,
    );
  }
  return value[0];
}

function validateDatapoint(value: unknown, label: string): void {
  validateShape(value, label, ["persona", "scenario", "first_message"]);
}

/** Lightweight runtime check that an object has the expected keys. */
function validateShape(
  value: unknown,
  label: string,
  requiredKeys: string[],
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected '${label}' to be an object, got ${typeof value}`);
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      throw new Error(`Invalid '${label}': missing required field '${key}'`);
    }
  }
}
