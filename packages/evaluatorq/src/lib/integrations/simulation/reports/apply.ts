import type OpenAI from "openai";

import {
  type AgentInstructionsClient,
  type ApplyRecommendationsResult,
  applyRecommendations,
} from "../../../common/apply.js";
import type { SimulationRecommendation } from "../run-store.js";
export type ApplySuggestionsResult = ApplyRecommendationsResult;
export function applySimulationSuggestions(
  recommendations: readonly SimulationRecommendation[],
  agentKey: string,
  orqClient: AgentInstructionsClient,
  llmClient: OpenAI,
  model: string,
  options: {
    apply?: boolean;
    temperature?: number | null;
    maxSuggestions?: number;
    alreadyApplied?: readonly string[];
  } = {},
): Promise<ApplySuggestionsResult> {
  return applyRecommendations(
    recommendations.map((value) => ({ recommendations: value.suggestions })),
    agentKey,
    orqClient,
    llmClient,
    model,
    {
      apply: options.apply ?? false,
      temperature: options.temperature ?? null,
      maxRecommendations: options.maxSuggestions ?? 20,
      alreadyApplied: options.alreadyApplied ?? [],
      context:
        "remediation suggestions from an evaluation of the agent's behavior",
    },
  );
}
