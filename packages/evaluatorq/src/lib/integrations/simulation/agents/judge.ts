/**
 * Judge agent for conversation evaluation.
 *
 * Evaluates conversations and decides when to terminate based on
 * goal achievement or rule violations.
 */

import type OpenAI from "openai";

import { criterionIdFor } from "../criteria.js";
import type {
  ChatMessage,
  Criterion,
  CriterionVerdict,
  Judgment,
} from "../types.js";
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

const CRITERIA_VERDICTS_PROPERTY = {
  type: "array" as const,
  description:
    "Occurrence audit. One entry for every criterion listed under EVALUATION CRITERIA, no omissions. Skip any criterion listed as ALREADY CONFIRMED in the final user message; those are settled and re-reporting them changes nothing. Send [] when that leaves nothing to report. Report only what literally happened in the conversation so far; do NOT judge whether that is good or bad.",
  items: {
    type: "object" as const,
    properties: {
      criterion_id: {
        type: "string" as const,
        description: "The criterion ID, copied exactly as listed",
      },
      occurred: {
        type: "boolean" as const,
        description:
          "Whether the described event has happened in the conversation so far",
      },
      evidence: {
        type: "string" as const,
        description: "Short quote from the conversation when occurred is true",
      },
    },
    required: ["criterion_id", "occurred"],
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
        "Allow the conversation to continue. Use when the goal is not yet achieved and no must_not_happen criterion has occurred.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Brief explanation of why the conversation should continue",
          },
          goal_completion_score: {
            type: "number",
            description:
              "How much of the goal is achieved SO FAR, from 0.0 (none) to 1.0 (fully). Assess every turn: if the run hits max turns this is the final score.",
          },
          criteria_verdicts: CRITERIA_VERDICTS_PROPERTY,
          ...QUALITY_SCORE_PROPERTIES,
        },
        required: ["reason", "criteria_verdicts"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_conversation",
      description:
        "Terminate the conversation. Use when the goal is achieved OR a must_not_happen criterion has occurred.",
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
          goal_completion_score: {
            type: "number",
            description:
              "How much of the goal was achieved, from 0.0 (none) to 1.0 (fully achieved). Use intermediate values for partial completion.",
          },
          criteria_verdicts: CRITERIA_VERDICTS_PROPERTY,
          ...QUALITY_SCORE_PROPERTIES,
        },
        required: [
          "reason",
          "goal_achieved",
          "goal_completion_score",
          "criteria_verdicts",
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
3. Criteria that should or should not happen

Each criterion has a unique ID (e.g., "criteria_0", "criteria_1"). When reporting criteria_verdicts, copy the criterion ID exactly as listed in \`criterion_id\`. Never paraphrase the description, renumber the IDs, or invent one that is not listed.

Your task:
- Evaluate whether the conversation should continue or end
- Determine if the user's goal has been achieved
- Report which criteria have occurred

Decision rules:
1. FINISH if the user's goal is clearly achieved
2. FINISH if any "must_not_happen" criterion has occurred
3. CONTINUE if the goal is not yet achieved and no "must_not_happen" criterion has occurred
4. CONTINUE if progress is being made toward the goal
5. An unmet "must_happen" criterion is NOT a reason to end early, it may still happen later

CRITERIA AUDIT (required in every tool call):
- Send exactly one criteria_verdicts entry for every criterion ID, except those listed as ALREADY CONFIRMED in the final user message.
- Report OCCURRENCE only: occurred=true if the described event happened in the conversation so far, occurred=false if it has not. Answer identically for must_happen and must_not_happen; pass or fail is computed elsewhere.
- Quote the conversation in \`evidence\` when occurred=true.
- Judge the literal transcript. Do not credit intent or plans.

For EVERY evaluation (continue or finish), also assess the agent's LAST response:
- response_quality: How helpful, accurate, and complete was the response? (0.0=poor, 1.0=excellent)
- hallucination_risk: Did the agent make up information not grounded in the conversation? (0.0=none, 1.0=high risk)
- tone_appropriateness: Was the agent's tone appropriate for the situation? (0.0=inappropriate, 1.0=perfect)
- factual_accuracy: If GROUND TRUTH is provided below, score how accurate the agent's response is against it (0.0=wrong, 1.0=correct). Skip if no ground truth.

You MUST call one of the provided tools to make your decision.`;

const CRITERION_PREFIX = "criteria_";
const CRITERION_ID_PATTERN = /^criteria_\d+$/;

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
  private settledIds = new Set<string>();

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
   * Record criteria whose occurrence is final, so the judge stops re-reporting
   * them. They go in the final user message to keep the system prompt static
   * and cacheable.
   */
  markSettled(ids: Iterable<string>): void {
    this.settledIds = new Set(ids);
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
    let instruction =
      "Evaluate the conversation above. Should it continue or end? Use the appropriate tool.";
    if (this.settledIds.size > 0) {
      const settled = [...this.settledIds].sort().join(", ");
      instruction += `\n\nALREADY CONFIRMED (occurrence is settled, do not re-report these in criteria_verdicts): ${settled}`;
    }

    const evalMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: instruction },
    ];

    const result = await this.callLLM(evalMessages, {
      temperature: 0.0,
      maxTokens: 4096,
      tools: JUDGE_TOOLS,
      toolChoice: "required",
      useResponsesApi: true,
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
      const verdicts = this.parseVerdicts(args.criteria_verdicts);
      return {
        should_terminate: false,
        reason: typeof args.reason === "string" ? args.reason : "",
        goal_achieved: false,
        rules_broken: this.violatedIds(verdicts),
        goal_completion_score: clamp(toNumber(args.goal_completion_score, 0.0)),
        criteria_verdicts: verdicts,
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

      const verdicts = this.parseVerdicts(args.criteria_verdicts);

      return {
        should_terminate: true,
        reason: typeof args.reason === "string" ? args.reason : "",
        goal_achieved: goalAchieved,
        rules_broken: this.violatedIds(verdicts),
        goal_completion_score: goalCompletionScore,
        criteria_verdicts: verdicts,
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
   * Validate the judge's occurrence audit.
   *
   * Null means unknown and an empty list means nothing to report. A non-empty
   * payload that loses every entry returns null, because a broken audit must
   * not count as verified.
   */
  private parseVerdicts(raw: unknown): CriterionVerdict[] | null {
    if (raw === undefined || raw === null) {
      this.warnIfUnreported(null);
      return null;
    }
    if (!Array.isArray(raw)) {
      console.warn(
        `JudgeAgent: criteria_verdicts is not a list: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return null;
    }

    const verdicts = new Map<number, CriterionVerdict>();
    for (const entry of raw as unknown[]) {
      const verdict = this.parseVerdict(entry);
      if (!verdict) {
        console.warn(
          `JudgeAgent: dropping invalid verdict: ${JSON.stringify(entry)?.slice(0, 200)}`,
        );
        continue;
      }
      const index = Number(verdict.criterion_id.slice(CRITERION_PREFIX.length));
      if (verdicts.has(index)) {
        console.warn(
          `JudgeAgent: duplicate verdict for ${verdict.criterion_id}, keeping the last`,
        );
      }
      verdicts.set(index, verdict);
    }

    if (raw.length > 0 && verdicts.size === 0) {
      console.warn("JudgeAgent: no usable entries in criteria_verdicts");
      return null;
    }

    const parsed = [...verdicts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, verdict]) => verdict);
    if (parsed.length === 0) {
      this.warnIfUnreported(parsed);
    }
    return parsed;
  }

  private parseVerdict(entry: unknown): CriterionVerdict | null {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const {
      criterion_id: id,
      occurred,
      evidence,
    } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof occurred !== "boolean") {
      return null;
    }
    if (!CRITERION_ID_PATTERN.test(id)) {
      return null;
    }
    const index = Number(id.slice(CRITERION_PREFIX.length));
    if (index >= this.criteria.length || criterionIdFor(index) !== id) {
      return null;
    }
    return {
      criterion_id: id,
      occurred,
      evidence: typeof evidence === "string" ? evidence : "",
    };
  }

  private warnIfUnreported(verdicts: CriterionVerdict[] | null): void {
    const unsettled = this.criteria.length - this.settledIds.size;
    if (unsettled > 0) {
      console.warn(
        `JudgeAgent: ${unsettled} unsettled criteria but ${verdicts ? "an empty" : "no"} criteria_verdicts`,
      );
    }
  }

  /** must_not_happen criteria the judge just reported as having occurred. */
  private violatedIds(verdicts: CriterionVerdict[] | null): string[] {
    return (verdicts ?? [])
      .filter((verdict) => {
        const index = Number(
          verdict.criterion_id.slice(CRITERION_PREFIX.length),
        );
        return (
          verdict.occurred && this.criteria[index]?.type === "must_not_happen"
        );
      })
      .map((verdict) => verdict.criterion_id);
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

    const lines = (type: Criterion["type"]): string[] =>
      this.criteria.flatMap((c, i) =>
        c.type === type
          ? [`${criterionIdFor(i)}: ${delimit(c.description)} (${c.type})`]
          : [],
      );

    const mustHappen = lines("must_happen");
    const mustNot = lines("must_not_happen");

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
