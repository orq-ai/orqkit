/**
 * Dataset export/import utilities for JSONL format.
 */

import fs from "node:fs";
import path from "node:path";

import type {
  Criterion,
  Datapoint,
  Persona,
  Scenario,
  SimulationResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export datapoints to JSONL format for orq.ai datasets.
 */
export function exportDatapointsToJsonl(
  datapoints: Datapoint[],
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  const lines = datapoints.map((dp) =>
    JSON.stringify({
      inputs: {
        category: `${dp.persona.name} - ${dp.scenario.name}`,
        first_message: dp.first_message,
        user_system_prompt: dp.user_system_prompt,
        persona: dp.persona,
        scenario: dp.scenario,
      },
      expected_output: null,
    }),
  );
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf-8");
}

/**
 * Export simulation results to JSONL format.
 */
export function exportResultsToJsonl(
  results: SimulationResult[],
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  const lines = results.map((r) => JSON.stringify(r));
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Load datapoints from a JSONL file.
 *
 * Supports both the current format (with full persona/scenario objects) and a
 * legacy format (with flat fields).
 */
export function loadDatapointsFromJsonl(inputPath: string): Datapoint[] {
  const content = fs.readFileSync(inputPath, "utf-8");
  const datapoints: Datapoint[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const data = JSON.parse(trimmed) as {
      inputs?: Record<string, unknown>;
    };
    const inputs = data.inputs ?? {};

    // Reconstruct persona
    let persona: Persona;
    if (inputs.persona && typeof inputs.persona === "object") {
      persona = inputs.persona as Persona;
    } else {
      persona = {
        name: (inputs.persona_name as string | undefined) ?? "Unknown",
        patience: 0.5,
        assertiveness: 0.5,
        politeness: 0.5,
        technical_level: 0.5,
        communication_style: "casual",
        background: (inputs.context as string | undefined) ?? "",
      };
    }

    // Reconstruct scenario
    let scenario: Scenario;
    if (inputs.scenario && typeof inputs.scenario === "object") {
      const raw = inputs.scenario as Record<string, unknown>;
      const criteriaRaw = raw.criteria;
      const criteria: Criterion[] = Array.isArray(criteriaRaw)
        ? (criteriaRaw as Criterion[])
        : [];

      scenario = { ...raw, criteria } as Scenario;
    } else {
      scenario = {
        name: (inputs.scenario_name as string | undefined) ?? "Unknown",
        goal: (inputs.goal as string | undefined) ?? "",
        context: (inputs.context as string | undefined) ?? "",
      };
    }

    datapoints.push({
      id: `dp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      persona,
      scenario,
      user_system_prompt:
        (inputs.user_system_prompt as string | undefined) ?? "",
      first_message: (inputs.first_message as string | undefined) ?? "",
    });
  }

  return datapoints;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/**
 * Convert simulation results to JSONL string for dataset export.
 */
export function resultsToJsonl(
  results: { datapoint: Datapoint; result: SimulationResult }[],
): string {
  return results
    .map((r) =>
      JSON.stringify({
        id: r.datapoint.id,
        persona: r.datapoint.persona.name,
        scenario: r.datapoint.scenario.name,
        first_message: r.datapoint.first_message,
        goal_achieved: r.result.goal_achieved,
        goal_completion_score: r.result.goal_completion_score,
        terminated_by: r.result.terminated_by,
        turn_count: r.result.turn_count,
        messages: r.result.messages,
        rules_broken: r.result.rules_broken,
        token_usage: r.result.token_usage,
        turn_metrics: r.result.turn_metrics,
        metadata: r.result.metadata,
      }),
    )
    .join("\n");
}

/**
 * Parse a JSONL string into an array of objects.
 */
export function parseJsonl<T = Record<string, unknown>>(content: string): T[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
