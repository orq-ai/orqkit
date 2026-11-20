import { simulationHtml } from "../../../common/reports/standalone.js";
import type { Usage } from "../../../contracts.js";
import { type SimulationRecommendation, SimulationRun } from "../run-store.js";
import type { ReportResult } from "./helpers.js";

export function exportSimulationHtml(
  results: SimulationRun | readonly ReportResult[],
  options: {
    target?: string;
    runDate?: Date | string;
    executiveSummary?: string | null;
    experimentUrl?: string | null;
    recommendations?: readonly SimulationRecommendation[] | null;
    runTokenUsageTotal?: Usage | null;
  } = {},
): Promise<string> {
  const run =
    results instanceof SimulationRun
      ? results
      : new SimulationRun({
          runName: "Agent Simulation Report",
          createdAt: options.runDate ?? new Date(),
          mode: "simulate",
          targetKind: "callback",
          target: options.target ?? "agent",
          evaluatorNames: [],
          totalResults: results.length,
          scorerAverages: {},
          results,
          executiveSummary: options.executiveSummary ?? null,
          experimentUrl: options.experimentUrl ?? null,
          recommendations: options.recommendations ?? null,
          tokenUsageTotal: options.runTokenUsageTotal ?? null,
        });
  return simulationHtml(run);
}
