/**
 * Runs one row of simulation input, shared by simulate() and wrapSimulationAgent().
 */

import type { FirstMessageGenerator } from "../generators/first-message-generator.js";
import type {
  Datapoint,
  Persona,
  Scenario,
  SimulationResult,
} from "../types.js";
import { generateDatapoint } from "../utils/prompt-builders.js";
import { errorResult, type SimulationRunner } from "./simulation.js";

/** Per-conversation limit for runs started through evaluatorq(). */
export const SIMULATION_TIMEOUT_MS = 300_000;

/** One conversation, either ready to run or still needing a first message. */
export type SimulationInput =
  | { datapoint: Datapoint }
  | { persona: Persona; scenario: Scenario; firstMessage?: string };

/**
 * Run one conversation. Never throws: a failed first message fails this row
 * only, and the other rows keep going.
 */
export async function runSimulationInput(
  input: SimulationInput,
  runner: SimulationRunner,
  maxTurns: number,
  getFirstMessages: () => FirstMessageGenerator,
  timeoutMs: number = SIMULATION_TIMEOUT_MS,
): Promise<SimulationResult> {
  if ("datapoint" in input) {
    return runner.runWithTimeout(input.datapoint, maxTurns, timeoutMs);
  }

  const { persona, scenario } = input;
  let firstMessage = input.firstMessage;
  if (!firstMessage) {
    try {
      firstMessage = await getFirstMessages().generate(persona, scenario);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`First message failed: ${reason}`, persona, scenario);
    }
  }

  return runner.runWithTimeout(
    generateDatapoint(persona, scenario, firstMessage),
    maxTurns,
    timeoutMs,
  );
}
