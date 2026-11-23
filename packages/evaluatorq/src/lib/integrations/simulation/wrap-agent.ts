/**
 * Wraps the simulation framework as an evaluatorq Job.
 *
 * Follows the same pattern as wrapAISdkAgent() and wrapLangChainAgent().
 */

import type OpenAI from "openai";

import { addUsage } from "../../contracts.js";
import type { DataPoint, Job, Output } from "../../types.js";
import {
  resolveSimulationTarget,
  type SimulationTargetOptions,
} from "./adapters.js";
import { toOpenResponses } from "./convert.js";
import { extractSingleInput } from "./datapoint-io.js";
import { failureReason } from "./evaluators/index.js";
import { FirstMessageGenerator } from "./generators/first-message-generator.js";
import { runSimulationInput } from "./runner/run-input.js";
import type { SimulationRunnerConfig } from "./runner/simulation.js";
import { SimulationRunner } from "./runner/simulation.js";
import { rememberSimulationResult } from "./scorer-adapter.js";
import type { TargetCallback } from "./types.js";
import { usageDetails } from "./usage.js";

/**
 * Options for creating a simulation job.
 */
export interface SimulationJobOptions
  extends SimulationTargetOptions,
    Omit<SimulationRunnerConfig, "hooks" | "onFatalError"> {
  /** Display name for this job in results. Defaults to "simulation". */
  name?: string;
  /** Target agent callback: receives messages and returns a response string. */
  targetCallback?: TargetCallback;
  /** Orq agent key, used if targetCallback is not provided. */
  agentKey?: string;
  /** Maximum conversation turns per simulation. Defaults to 10. */
  maxTurns?: number;
  /** Model used for user simulator and judge agents. Defaults to DEFAULT_SIMULATION_MODEL. */
  model?: string;
  /** Pre-configured client for the user simulator, judge and first messages. */
  client?: OpenAI;
  /** Limit per conversation in milliseconds. Unset leaves the run unbounded. */
  timeoutPerSimulation?: number;
  perSimulationTimeoutMs?: number;
}

/**
 * Creates an evaluatorq Job that runs one simulated conversation per row.
 *
 * Each DataPoint should have inputs containing simulation data:
 * - `persona` (Persona object) and `scenario` (Scenario object), with an optional
 *   `first_message` to use instead of generating one, or
 * - `datapoint` (full Datapoint object), or
 * - `datapoints`, or `personas` and `scenarios`, holding exactly one entry
 *
 * `persona`, `scenario`, `datapoint` and `datapoints` may also be JSON strings.
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
export type SimulationJob = Job & { close(): Promise<void> };

export function wrapSimulationAgent(
  options: SimulationJobOptions,
): SimulationJob {
  if ("evaluators" in options) {
    throw new Error(
      "wrapSimulationAgent no longer takes 'evaluators'. Pass scorers to the 'evaluators' option of evaluatorq() instead.",
    );
  }

  const {
    name = "simulation",
    maxTurns = 10,
    model,
    client,
    timeoutPerSimulation,
  } = options;

  if (
    options.timeoutPerSimulation !== undefined &&
    options.perSimulationTimeoutMs !== undefined &&
    options.timeoutPerSimulation !== options.perSimulationTimeoutMs
  )
    throw new Error(
      "timeoutPerSimulation and perSimulationTimeoutMs must match",
    );
  const timeout = options.perSimulationTimeoutMs ?? timeoutPerSimulation;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
    throw new RangeError("perSimulationTimeoutMs must be > 0");
  const target = resolveSimulationTarget(options);
  const runner = new SimulationRunner({
    ...options,
    ...target,
    model,
    maxTurns,
    client,
  });

  const wrapped: Job = async (data: DataPoint, _row: number) => {
    let firstMessages: FirstMessageGenerator | undefined;
    const getFirstMessages = () => {
      firstMessages ??= new FirstMessageGenerator({
        model,
        client,
        llmConfig: options.llmConfig,
      });
      return firstMessages;
    };

    const input = extractSingleInput(data);

    const result = await runSimulationInput(
      input,
      runner,
      maxTurns,
      getFirstMessages,
      timeout ?? 0,
    );
    const generationUsage = (
      firstMessages as FirstMessageGenerator | undefined
    )?.getUsage();
    if (generationUsage) {
      result.usage = addUsage(
        usageDetails(result.token_usage, result.usage),
        generationUsage,
      );
      result.token_usage = {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      };
    }

    const output = toOpenResponses(
      result,
      runner.resolvedModel,
    ) as unknown as Output;
    rememberSimulationResult(output, result);
    return { name, output, error: failureReason(result) ?? undefined };
  };
  return Object.assign(wrapped, { close: () => runner.close() });
}
