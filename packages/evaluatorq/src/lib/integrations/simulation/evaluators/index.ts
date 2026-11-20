/**
 * Built-in evaluators for agent simulation.
 *
 * These evaluators assess simulation results using a scorer pattern
 * compatible with evaluatorq integration.
 */

import { pyFixed, pyRound } from "../../../common/reports/number-format.js";
import { parseCriteriaMeta } from "../criteria.js";
import type { SimulationResult } from "../types.js";
import {
  DEFAULT_SCORING_CONFIG,
  type SimulationScoringConfig,
} from "./scoring-config.js";

// ---------------------------------------------------------------------------
// Scorer type
// ---------------------------------------------------------------------------

export type SimulationScorer = (result: SimulationResult) => number;

// ---------------------------------------------------------------------------
// Run status helpers
// ---------------------------------------------------------------------------

/** Why this run's criteria cannot be trusted, or null if they can. */
export function unverifiedReason(result: SimulationResult): string | null {
  if (result.terminated_by === "error" || result.terminated_by === "timeout") {
    return `terminated_by=${result.terminated_by}`;
  }
  if (result.criteria_verified === false) {
    return "criteria_verified=false";
  }
  return null;
}

/** Failure message for a run that ended in error or timeout, otherwise null. */
export function failureReason(result: SimulationResult): string | null {
  if (result.terminated_by !== "error" && result.terminated_by !== "timeout") {
    return null;
  }
  const metadataError = result.metadata?.error;
  return (
    (typeof metadataError === "string" && metadataError) ||
    result.reason ||
    `simulation terminated by ${result.terminated_by}`
  );
}

export function readCriteriaMeta(result: Pick<SimulationResult, "metadata">) {
  const parsed = parseCriteriaMeta(result.metadata.criteria_meta);
  if (parsed.invalid.length) {
    const existing = result.metadata.criteria_errors;
    const errors = Array.isArray(existing) ? existing : [];
    for (const entry of parsed.invalid) {
      const message = `criteria_meta entry is invalid: ${JSON.stringify(entry)}`;
      console.warn(message);
      if (!errors.includes(message)) errors.push(message);
    }
    result.metadata.criteria_errors = errors;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Individual scorers
// ---------------------------------------------------------------------------

/**
 * Evaluate if the simulation goal was achieved.
 * Returns 1 if achieved, 0 otherwise.
 */
export const goalAchievedScorer: SimulationScorer = (result) => {
  return result.goal_achieved ? 1 : 0;
};

/**
 * Evaluate how many criteria were met.
 * Returns a value between 0 and 1 based on the ratio of met criteria.
 *
 * Scores 0.0 when the run cannot vouch for its criteria: it errored, timed out
 * or any criterion was never audited. A criterion that passed only because it was
 * never audited does not count as met. No criteria at all scores 1.0.
 */
export const criteriaMetScorer: SimulationScorer = (result) => {
  const reason = unverifiedReason(result);
  if (reason) {
    console.warn(`criteria_met: scoring 0.0, run is unverified (${reason})`);
    return 0.0;
  }

  const rawMeta = result.metadata?.criteria_meta;
  if (rawMeta !== undefined && rawMeta !== null) {
    const { valid, invalid } = readCriteriaMeta(result);
    if (invalid.length) {
      console.warn("criteria_met: scoring 0.0, criteria_meta is malformed");
      return 0.0;
    }
    if (valid.length > 0) {
      const metCount = valid.filter(
        (entry) => entry.passed && entry.audited !== false,
      ).length;
      return metCount / valid.length;
    }
  }

  const criteriaResults = result.criteria_results ?? {};
  const keys = Object.keys(criteriaResults);

  if (keys.length === 0) {
    return 1.0;
  }

  const met = Object.values(criteriaResults).filter((v) => v).length;
  const total = keys.length;

  return total > 0 ? met / total : 1.0;
};

/**
 * Evaluate conversation efficiency (fewer turns = better).
 * Returns a value between 0 and 1.
 */
export function turnEfficiencyScorer(
  result: SimulationResult,
  config: SimulationScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  if (!result.goal_achieved) return 0;
  for (const [turns, score] of config.turnEfficiencyCliffs)
    if (result.turn_count <= turns) return score;
  const [lastTurns, lastScore] = config.turnEfficiencyCliffs[
    config.turnEfficiencyCliffs.length - 1
  ] as readonly [number, number];
  return Number(
    pyFixed(
      Math.max(
        config.turnEfficiencyFloor,
        lastScore -
          (result.turn_count - lastTurns) * config.turnEfficiencyDecayPerTurn,
      ),
      4,
    ),
  );
}

export interface ConversationQualityScore {
  value: number;
  breakdown: {
    components: Record<string, number>;
    weights: Record<string, number>;
  };
}

export function conversationQualityDetails(
  result: SimulationResult,
  config: SimulationScoringConfig = DEFAULT_SCORING_CONFIG,
): ConversationQualityScore {
  const goal = goalAchievedScorer(result);
  const criteria = criteriaMetScorer(result);
  const efficiency = turnEfficiencyScorer(result, config);
  const value =
    pyRound(
      (goal * config.goalAchievedWeight +
        criteria * config.criteriaMetWeight +
        efficiency * config.turnEfficiencyWeight) *
        100,
    ) / 100;
  return {
    value,
    breakdown: {
      components: {
        goalAchieved: goal,
        criteriaMet: criteria,
        turnEfficiency: efficiency,
      },
      weights: {
        goalAchieved: config.goalAchievedWeight,
        criteriaMet: config.criteriaMetWeight,
        turnEfficiency: config.turnEfficiencyWeight,
      },
    },
  };
}

export function conversationQualityScorer(
  result: SimulationResult,
  config: SimulationScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  return conversationQualityDetails(result, config).value;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SIMULATION_EVALUATORS: Record<string, SimulationScorer> = {
  goal_achieved: goalAchievedScorer,
  criteria_met: criteriaMetScorer,
  turn_efficiency: turnEfficiencyScorer,
  conversation_quality: conversationQualityScorer,
};

/**
 * Get a built-in simulation evaluator by name.
 *
 * @param name - Evaluator name (goal_achieved, criteria_met, etc.)
 * @returns The scorer function
 * @throws Error if evaluator not found
 */
export function getEvaluator(
  name: string,
  config?: SimulationScoringConfig,
): SimulationScorer {
  const evaluator = getAllEvaluators(config)[name];
  if (!evaluator) {
    const available = Object.keys(SIMULATION_EVALUATORS).join(", ");
    throw new Error(`Unknown evaluator: ${name}. Available: ${available}`);
  }
  return evaluator;
}

/**
 * Get all built-in simulation evaluators.
 *
 * @returns Record of evaluator name to scorer function
 */
export function getAllEvaluators(
  config?: SimulationScoringConfig,
): Record<string, SimulationScorer> {
  return {
    ...SIMULATION_EVALUATORS,
    ...(config
      ? {
          turn_efficiency: (result: SimulationResult) =>
            turnEfficiencyScorer(result, config),
          conversation_quality: (result: SimulationResult) =>
            conversationQualityScorer(result, config),
        }
      : {}),
  };
}

export type { SimulationScoringConfigInput } from "./scoring-config.js";
export {
  DEFAULT_SCORING_CONFIG,
  SimulationScoringConfig,
} from "./scoring-config.js";
