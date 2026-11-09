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
import {
  errorResult,
  type SimulationRunner,
  timedOutResult,
} from "./simulation.js";

/** Per-conversation limit for runs started through evaluatorq(). */
export const SIMULATION_TIMEOUT_MS = 300_000;

const TIMED_OUT = Symbol("timed out");

/** Stop waiting for `work` after `timeoutMs`. It cannot be cancelled, so it may keep running. */
async function withinLimit<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  if (timeoutMs <= 0) {
    return work;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

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
  const startedAt = Date.now();
  let firstMessage = input.firstMessage;
  if (!firstMessage) {
    try {
      const generated = await withinLimit(
        getFirstMessages().generate(persona, scenario),
        timeoutMs,
      );
      if (generated === TIMED_OUT) {
        return timedOutResult(errorResult("", persona, scenario), timeoutMs);
      }
      firstMessage = generated;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`First message failed: ${reason}`, persona, scenario);
    }
  }

  return runner.runWithTimeout(
    generateDatapoint(persona, scenario, firstMessage),
    maxTurns,
    timeoutMs,
    Date.now() - startedAt,
  );
}
