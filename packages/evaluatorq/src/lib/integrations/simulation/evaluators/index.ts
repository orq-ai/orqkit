/**
 * Built-in evaluators for agent simulation.
 *
 * These evaluators assess simulation results using a scorer pattern
 * compatible with evaluatorq integration.
 */

import type { CriteriaMeta, SimulationResult } from "../types.js";

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
    return "criteria_verified=False";
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

function isCriteriaMeta(value: unknown): value is CriteriaMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CriteriaMeta).passed === "boolean"
  );
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
 * or the judge never audited them. A criterion that passed only because it was
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
    if (!Array.isArray(rawMeta) || !rawMeta.every(isCriteriaMeta)) {
      console.warn("criteria_met: scoring 0.0, criteria_meta is malformed");
      return 0.0;
    }
    if (rawMeta.length > 0) {
      const metCount = rawMeta.filter(
        (entry) => entry.passed && entry.audited !== false,
      ).length;
      return metCount / rawMeta.length;
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
export const turnEfficiencyScorer: SimulationScorer = (result) => {
  const totalTurns = result.turn_count;
  const goalAchieved = result.goal_achieved;

  if (!goalAchieved) {
    return 0.0;
  }

  if (totalTurns <= 2) {
    return 1.0;
  }

  if (totalTurns <= 4) {
    return 0.9;
  }

  if (totalTurns <= 6) {
    return 0.7;
  }

  return Math.max(0.3, 1.0 - (totalTurns - 6) * 0.1);
};

/**
 * Evaluate overall conversation quality.
 *
 * Composite score based on:
 * - Goal achievement (40%)
 * - Criteria met (30%)
 * - Turn efficiency (30%)
 */
export const conversationQualityScorer: SimulationScorer = (result) => {
  const goalScore = goalAchievedScorer(result);
  const criteriaScore = criteriaMetScorer(result);
  const efficiencyScore = turnEfficiencyScorer(result);

  const score = goalScore * 0.4 + criteriaScore * 0.3 + efficiencyScore * 0.3;
  return Math.round(score * 100) / 100;
};

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
export function getEvaluator(name: string): SimulationScorer {
  const evaluator = SIMULATION_EVALUATORS[name];
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
export function getAllEvaluators(): Record<string, SimulationScorer> {
  return { ...SIMULATION_EVALUATORS };
}
