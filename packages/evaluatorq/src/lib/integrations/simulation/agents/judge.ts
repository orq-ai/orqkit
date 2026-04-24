/**
 * Judge agent for conversation evaluation.
 *
 * Evaluates conversations and decides when to terminate based on
 * goal achievement or rule violations.
 */

import type OpenAI from "openai";

import type { ChatMessage, Criterion, Judgment } from "../types.js";
import { delimit } from "../utils/sanitize.js";
import type { AgentConfig, LLMResult } from "./base.js";
import { BaseAgent } from "./base.js";

// ---------------------------------------------------------------------------
// Quality score property definitions (shared by both judge tools)
// ---------------------------------------------------------------------------

const QUALITY_SCORE_PROPERTIES = {
  response_quality: {
    type: "number" as const,
    description:
      "Quality of the agent's last response: helpful, accurate, complete (0.0=poor, 1.0=excellent)",
  },
  hallucination_risk: {
    type: "number" as const,
    description:
      "Risk that the agent fabricated information not grounded in the conversation (0.0=none, 1.0=high risk)",
  },
  tone_appropriateness: {
    type: "number" as const,
    description:
      "How appropriate the agent's tone was for the situation (0.0=inappropriate, 1.0=perfect)",
  },
  factual_accuracy: {
    type: "number" as const,
    description:
      "Accuracy of the agent's response against the provided ground truth (0.0=completely wrong, 1.0=fully correct). Only score this if ground truth is provided.",
  },
};

// ---------------------------------------------------------------------------
// Judge tools for structured decision making
// ---------------------------------------------------------------------------

export const JUDGE_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "continue_conversation",
      description:
        "Allow the conversation to continue. Use when the goal is not yet achieved and no rules are broken.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Brief explanation of why the conversation should continue",
          },
          ...QUALITY_SCORE_PROPERTIES,
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_conversation",
      description:
        "Terminate the conversation. Use when the goal is achieved OR a rule is broken.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Explanation of why the conversation should end",
          },
          goal_achieved: {
            type: "boolean",
            description: "Whether the user's goal was successfully achieved",
          },
          rules_broken: {
            type: "array",
            items: { type: "string" },
            description: "List of criteria that were violated (empty if none)",
          },
          goal_completion_score: {
            type: "number",
            description:
              "How much of the goal was achieved, from 0.0 (none) to 1.0 (fully achieved). Use intermediate values for partial completion.",
          },
          ...QUALITY_SCORE_PROPERTIES,
        },
        required: [
          "reason",
          "goal_achieved",
          "rules_broken",
          "goal_completion_score",
        ],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Default judge system prompt
// ---------------------------------------------------------------------------

export const DEFAULT_JUDGE_PROMPT = `You are a conversation judge. Your role is to evaluate conversations between a user and an AI agent.

You will be given:
1. The conversation history
2. The user's goal
3. Criteria that should or should not be satisfied

Your task:
- Evaluate whether the conversation should continue or end
- Determine if the user's goal has been achieved
- Check if any rules/criteria have been violated

Decision rules:
1. FINISH if the user's goal is clearly achieved
2. FINISH if any "must_not_happen" criteria are violated
3. CONTINUE if the goal is not yet achieved and no rules are broken
4. CONTINUE if progress is being made toward the goal

For EVERY evaluation (continue or finish), also assess the agent's LAST response:
- response_quality: How helpful, accurate, and complete was the response? (0.0=poor, 1.0=excellent)
- hallucination_risk: Did the agent make up information not grounded in the conversation? (0.0=none, 1.0=high risk)
- tone_appropriateness: Was the agent's tone appropriate for the situation? (0.0=inappropriate, 1.0=perfect)
- factual_accuracy: If GROUND TRUTH is provided below, score how accurate the agent's response is against it (0.0=wrong, 1.0=correct). Skip if no ground truth.

You MUST call one of the provided tools to make your decision.`;

// ---------------------------------------------------------------------------
// JudgeAgent configuration
// ---------------------------------------------------------------------------

export interface JudgeAgentConfig extends AgentConfig {
  goal?: string;
  criteria?: Criterion[];
  groundTruth?: string;
}

// ---------------------------------------------------------------------------
// Quality score field names
// ---------------------------------------------------------------------------

const QUALITY_SCORE_FIELDS = [
  "response_quality",
  "hallucination_risk",
  "tone_appropriateness",
  "factual_accuracy",
] as const;

type QualityScoreField = (typeof QUALITY_SCORE_FIELDS)[number];

// ---------------------------------------------------------------------------
// JudgeAgent
// ---------------------------------------------------------------------------

/**
 * Agent that evaluates conversations and decides termination.
 *
 * Uses tool calling to make structured decisions about whether a conversation
 * should continue or end.
 */
export class JudgeAgent extends BaseAgent {
  private goal: string;
  private criteria: Criterion[];
  private groundTruth: string;

  constructor(config?: JudgeAgentConfig) {
    super(config);
    this.goal = config?.goal ?? "";
    this.criteria = config?.criteria ?? [];
    this.groundTruth = config?.groundTruth ?? "";
  }

  get name(): string {
    return "JudgeAgent";
  }

  get systemPrompt(): string {
    const criteriaText = this.formatCriteria();

    let groundTruthText = "";
    if (this.groundTruth) {
      groundTruthText = `\n\nGROUND TRUTH (use this to score factual_accuracy):\n${delimit(this.groundTruth)}`;
    }

    return `${DEFAULT_JUDGE_PROMPT}\n\n---\n\nUSER'S GOAL: ${delimit(this.goal)}\n\nEVALUATION CRITERIA:\n${criteriaText}${groundTruthText}`;
  }

  /**
   * Evaluate a conversation and decide next action.
   *
   * @param messages - Conversation history to evaluate
   * @returns Judgment with termination decision and reasoning
   */
  async evaluate(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<Judgment> {
    const evalMessages: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content:
          "Evaluate the conversation above. Should it continue or end? Use the appropriate tool.",
      },
    ];

    const result = await this.callLLM(evalMessages, {
      temperature: 0.0,
      tools: JUDGE_TOOLS,
      signal: options?.signal,
      llmPurpose: "judge",
    });

    return this.parseJudgment(result);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private parseJudgment(result: LLMResult): Judgment {
    const toolCalls = result.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      const content = (result.content ?? "").slice(0, 200);
      console.warn(
        `JudgeAgent: No tool call in response (LLM may have failed). ` +
          `Content: ${JSON.stringify(content)}. Defaulting to TERMINATE to prevent runaway conversations.`,
      );
      return {
        should_terminate: true,
        reason:
          "Judge failed to make explicit decision - terminating for safety",
        goal_achieved: false,
        rules_broken: [],
        goal_completion_score: 0.0,
      };
    }

    const toolCall = toolCalls[0] as (typeof toolCalls)[0];
    const functionName = toolCall.function.name;
    const argumentsStr = toolCall.function.arguments;

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(argumentsStr);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TypeError(`Expected object, got ${typeof parsed}`);
      }
      args = parsed as Record<string, unknown>;
    } catch (err) {
      console.error(
        `JudgeAgent: Failed to parse tool arguments: ${String(err)} (raw: ${JSON.stringify(argumentsStr)})`,
      );
      return {
        should_terminate: true,
        reason: "Failed to parse judgment decision - terminating for safety",
        goal_achieved: false,
        rules_broken: [],
        goal_completion_score: 0.0,
      };
    }

    // Extract quality scores (shared by both tools)
    const qualityScores = JudgeAgent.extractQualityScores(args);

    if (functionName === "continue_conversation") {
      return {
        should_terminate: false,
        reason: typeof args.reason === "string" ? args.reason : "",
        goal_achieved: false,
        rules_broken: [],
        goal_completion_score: 0.0,
        ...qualityScores,
      };
    }

    if (functionName === "finish_conversation") {
      const goalAchieved =
        typeof args.goal_achieved === "boolean" ? args.goal_achieved : false;

      // Clamp goal_completion_score to [0.0, 1.0]
      const rawScore = args.goal_completion_score;
      const defaultScore = goalAchieved ? 1.0 : 0.0;
      const goalCompletionScore = clamp(toNumber(rawScore, defaultScore));

      const rulesBroken = Array.isArray(args.rules_broken)
        ? (args.rules_broken as unknown[]).map(String)
        : [];

      return {
        should_terminate: true,
        reason: typeof args.reason === "string" ? args.reason : "",
        goal_achieved: goalAchieved,
        rules_broken: rulesBroken,
        goal_completion_score: goalCompletionScore,
        ...qualityScores,
      };
    }

    // Unknown function -- terminate for safety
    console.warn(
      `JudgeAgent: Unknown function ${functionName} - terminating for safety`,
    );
    return {
      should_terminate: true,
      reason: `Unknown function '${functionName}' - terminating for safety`,
      goal_achieved: false,
      rules_broken: [],
      goal_completion_score: 0.0,
    };
  }

  /**
   * Extract and clamp quality scores from tool call arguments.
   */
  private static extractQualityScores(
    args: Record<string, unknown>,
  ): Partial<Pick<Judgment, QualityScoreField>> {
    const scores: Partial<Pick<Judgment, QualityScoreField>> = {};

    for (const field of QUALITY_SCORE_FIELDS) {
      const raw = args[field];
      if (raw !== undefined && raw !== null) {
        const num = Number(raw);
        if (!Number.isNaN(num)) {
          scores[field] = clamp(num);
        }
      }
    }

    return scores;
  }

  /**
   * Format criteria for the system prompt.
   */
  private formatCriteria(): string {
    if (this.criteria.length === 0) {
      return "No specific criteria defined.";
    }

    const mustHappen = this.criteria
      .filter((c) => c.type === "must_happen")
      .map((c) => delimit(c.description));

    const mustNot = this.criteria
      .filter((c) => c.type === "must_not_happen")
      .map((c) => delimit(c.description));

    let text = "";
    if (mustHappen.length > 0) {
      text += `MUST HAPPEN:\n${mustHappen.map((c) => `- ${c}`).join("\n")}\n\n`;
    }
    if (mustNot.length > 0) {
      text += `MUST NOT HAPPEN:\n${mustNot.map((c) => `- ${c}`).join("\n")}`;
    }

    return text.trim() || "No specific criteria defined.";
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Clamp a number to [0.0, 1.0]. */
function clamp(value: number): number {
  return Math.max(0.0, Math.min(1.0, value));
}

/** Safely convert an unknown value to a number, falling back to a default. */
function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}
