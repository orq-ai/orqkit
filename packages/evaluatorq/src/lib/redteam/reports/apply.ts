import type OpenAI from "openai";

import {
  type AgentInstructionsClient,
  type ApplyRecommendationsResult,
  applyRecommendations,
} from "../../common/apply.js";
import { LLMConfig } from "../config.js";
import type { FocusAreaRecommendation } from "./models.js";

export type { ApplyRecommendationsResult } from "../../common/apply.js";
export function applyRedteamRecommendations(
  recommendations: readonly FocusAreaRecommendation[],
  agentKey: string,
  orqClient: AgentInstructionsClient,
  llmClient: OpenAI,
  model: string,
  options: {
    apply?: boolean;
    maxRecommendations?: number;
    alreadyApplied?: readonly string[];
    cfg?: LLMConfig | null;
  } = {},
): Promise<ApplyRecommendationsResult> {
  return applyRecommendations(
    recommendations,
    agentKey,
    orqClient,
    llmClient,
    model,
    {
      apply: options.apply ?? false,
      maxRecommendations: options.maxRecommendations ?? 20,
      alreadyApplied: options.alreadyApplied ?? [],
      cfg: options.cfg ?? new LLMConfig(),
      intro: "You are an AI security expert. ",
      context:
        "security-remediation recommendations from a red-team assessment of the agent",
    },
  );
}
