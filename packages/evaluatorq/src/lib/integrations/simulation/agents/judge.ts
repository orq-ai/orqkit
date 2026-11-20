/**
 * Judge agent for conversation evaluation.
 *
 * Evaluates conversations and decides when to terminate based on
 * goal achievement or rule violations.
 */

import { z } from "zod/v4";

import { criterionIdFor } from "../criteria.js";
import type {
  ChatMessage,
  Criterion,
  CriterionVerdict,
  Judgment,
} from "../types.js";
import { extractJsonFromResponse } from "../utils/extract-json.js";
import { delimit } from "../utils/sanitize.js";
import type { AgentConfig, LLMResult } from "./base.js";
import { BaseAgent } from "./base.js";

// ---------------------------------------------------------------------------
// Fields shared by both judge tools
// ---------------------------------------------------------------------------

const QUALITY_SCORES = {
  response_quality: z
    .number()
    .nullable()
    .describe(
      "Quality of the agent's last response: helpful, accurate, complete (0.0=poor, 1.0=excellent). Null if not scored.",
    ),
  hallucination_risk: z
    .number()
    .nullable()
    .describe(
      "Risk that the agent fabricated information not grounded in the conversation (0.0=none, 1.0=high risk). Null if not scored.",
    ),
  tone_appropriateness: z
    .number()
    .nullable()
    .describe(
      "How appropriate the agent's tone was for the situation (0.0=inappropriate, 1.0=perfect). Null if not scored.",
    ),
  factual_accuracy: z
    .number()
    .nullable()
    .describe(
      "Accuracy of the agent's response against the provided ground truth (0.0=completely wrong, 1.0=fully correct). Null if no ground truth is provided.",
    ),
};

const CRITERIA_VERDICTS = z
  .array(
    z.object({
      criterion_id: z
        .string()
        .describe("The criterion ID, copied exactly as listed"),
      occurred: z
        .boolean()
        .describe(
          "Whether the described event has happened in the conversation so far",
        ),
      evidence: z
        .string()
        .default("")
        .describe(
          "Short quote from the conversation showing the behaviour, or empty when occurred is false.",
        ),
    }),
  )
  .describe(
    "Occurrence audit. One entry for every criterion listed under EVALUATION CRITERIA, no omissions. Skip any criterion listed as ALREADY CONFIRMED in the final user message; those are settled and re-reporting them changes nothing. Send [] when that leaves nothing to report. Report only what literally happened in the conversation so far; do NOT judge whether that is good or bad.",
  );

// ---------------------------------------------------------------------------
// Judge tools for structured decision making
// ---------------------------------------------------------------------------

export const JudgeDecisionSchema = z.object({
  reason: z.string().default("").describe("Brief explanation of the decision"),
  should_terminate: z
    .boolean()
    .describe(
      "true to end the conversation when the goal is achieved or a must_not_happen criterion has occurred; false to continue.",
    ),
  goal_achieved: z
    .boolean()
    .default(false)
    .describe(
      "Whether the user goal was achieved. false unless should_terminate is true.",
    ),
  goal_completion_score: z
    .number()
    .default(0)
    .describe(
      "How much of the goal is achieved SO FAR, 0.0 (none) to 1.0 (fully). Assess every turn.",
    ),
  criteria_verdicts: CRITERIA_VERDICTS,
  ...QUALITY_SCORES,
});

// ---------------------------------------------------------------------------
// Default judge system prompt
// ---------------------------------------------------------------------------

export const DEFAULT_JUDGE_PROMPT =
  'You are a conversation judge. Your role is to evaluate conversations between a user and an AI agent.\n\nYou will be given:\n1. The conversation history\n2. The user\'s goal\n3. Criteria that should or should not be satisfied\n\nYour task:\n- Evaluate whether the conversation should continue or end\n- Determine if the user\'s goal has been achieved\n- Check if any rules/criteria have been violated\n\nIMPORTANT: Each criterion has a unique ID (e.g., "criteria_0", "criteria_1").\nWhen reporting criteria_verdicts, copy the criterion ID exactly as listed in `criterion_id`.\nNever paraphrase the description, renumber the IDs, or invent one that is not listed.\n\nDecision rules (should_terminate):\n1. true if the user\'s goal is clearly achieved\n2. true if any "must_not_happen" criteria are violated\n3. false if the goal is not yet achieved and no rules are broken\n4. false if progress is being made toward the goal\n5. An unmet "must_happen" criterion is NOT a reason to end early : it may still happen later\n\nCRITERIA AUDIT (every evaluation, whether or not you end the conversation):\nYou MUST return criteria_verdicts with exactly one entry for every criterion ID listed\nbelow : no omissions, even when nothing has changed since the last turn. The only\nexception is a criterion the final user message lists as ALREADY CONFIRMED: those are\nsettled, so skip them, and send [] when that leaves nothing to report.\n\nThis is an OCCURRENCE report, not a verdict. For each criterion answer one question:\n"has the behaviour in this description actually appeared in the conversation so far?"\n- occurred=true if it is there, occurred=false if it is not.\n- Answer identically whether the criterion is must_happen or must_not_happen. Do NOT\n  flip the answer because the behaviour is desired or forbidden : pass/fail is computed\n  from your answer, not by you.\n- Quote the supporting text in `evidence` when occurred=true; leave it empty otherwise.\n- Judge the literal transcript. Do not credit intent, plans, or things the agent looks\n  likely to do next.\n\nFor EVERY evaluation, also assess the agent\'s LAST response:\n- response_quality: How helpful, accurate, and complete was the response? (0.0=poor, 1.0=excellent)\n- hallucination_risk: Did the agent make up information not grounded in the conversation? (0.0=none, 1.0=high risk)\n- tone_appropriateness: Was the agent\'s tone appropriate for the situation? (0.0=inappropriate, 1.0=perfect)\n- factual_accuracy: If GROUND TRUTH is provided below, score how accurate the agent\'s response is against it (0.0=wrong, 1.0=correct). Skip if no ground truth.\n\nRespond with the JSON decision.';

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

const CRITERION_PREFIX = "criteria_";
const CRITERION_ID_PATTERN = /^criteria_\d+$/;

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
  protected override get modelTask(): string {
    return "sim.judge";
  }
  protected override get requiredApi(): "responses" {
    return "responses";
  }
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

  updateContext(context: {
    goal?: string;
    criteria?: Criterion[];
    groundTruth?: string;
  }): void {
    if (context.goal !== undefined) this.goal = context.goal;
    if (context.criteria !== undefined) this.criteria = [...context.criteria];
    if (context.groundTruth !== undefined)
      this.groundTruth = context.groundTruth;
    this.settledIds = new Set();
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
      "Evaluate the conversation above and return your decision.";
    if (this.settledIds.size > 0) {
      const settled = [...this.settledIds].sort().join(", ");
      instruction += `\n\nALREADY CONFIRMED (occurrence is settled, do not re-report these in criteria_verdicts): ${settled}`;
    }

    const evalMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: instruction },
    ];

    const result = await this.callLLM(evalMessages, {
      responseFormat: {
        name: "JudgeDecision",
        schema: JudgeDecisionSchema,
        scrubWire: true,
      },
      volatileTail: 1,
      signal: options?.signal,
      llmPurpose: "judge",
    });

    return this.parseJudgment(result);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private parseJudgment(result: LLMResult): Judgment {
    const safety = (): Judgment => ({
      should_terminate: true,
      reason: "Failed to parse judgment decision - terminating for safety",
      goal_achieved: false,
      rules_broken: [],
      goal_completion_score: 0,
    });
    if (result.refusal) return safety();
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        extractJsonFromResponse(result.content),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return safety();
      args = parsed as Record<string, unknown>;
    } catch {
      return safety();
    }
    const terminate = decisionBoolean(args.should_terminate);
    const achieved =
      args.goal_achieved === undefined
        ? false
        : decisionBoolean(args.goal_achieved);
    if (terminate === null || achieved === null) return safety();
    const goalAchieved = terminate && achieved;
    // An achieved finish with no score means 1.0, as in Python.
    const score = goalScore(args.goal_completion_score, goalAchieved ? 1 : 0);
    const verdicts = this.parseVerdicts(args.criteria_verdicts);
    const reason =
      args.reason == null
        ? ""
        : typeof args.reason === "string"
          ? args.reason
          : typeof args.reason === "object"
            ? JSON.stringify(args.reason)
            : String(args.reason);
    return {
      should_terminate: terminate,
      reason,
      goal_achieved: goalAchieved,
      rules_broken: this.violatedIds(verdicts),
      goal_completion_score: score,
      criteria_verdicts: verdicts,
      ...this.extractQualityScores(args),
    };
  }

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
    const observed = decisionBoolean(occurred);
    if (
      typeof id !== "string" ||
      observed === null ||
      (evidence !== undefined && typeof evidence !== "string")
    ) {
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
      occurred: observed,
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
  private extractQualityScores(
    args: Record<string, unknown>,
  ): Partial<Pick<Judgment, QualityScoreField>> {
    const scores: Partial<Pick<Judgment, QualityScoreField>> = {};

    for (const field of QUALITY_SCORE_FIELDS) {
      // With no ground truth there is nothing to measure this against.
      if (field === "factual_accuracy" && !this.groundTruth) continue;
      const raw = args[field];
      const num = unitInterval(raw);
      if (num !== null) {
        scores[field] = num;
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

const DECIMAL = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** A finite number or plain decimal string, clamped to 0..1; null for anything else. */
function unitInterval(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && DECIMAL.test(value)) n = Number(value);
  else return null;
  return Number.isFinite(n) ? clamp(n) : null;
}

/** Missing or null takes the fallback; an unusable value scores 0 with a warning. */
function goalScore(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const score = unitInterval(value);
  if (score !== null) return score;
  console.warn(
    `JudgeAgent: unusable goal_completion_score ${JSON.stringify(value)}; scoring this turn 0.0.`,
  );
  return 0.0;
}

function decisionBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return Boolean(value);
  if (typeof value === "string") {
    if (["0", "off", "f", "false", "n", "no"].includes(value.toLowerCase()))
      return false;
    if (["1", "on", "t", "true", "y", "yes"].includes(value.toLowerCase()))
      return true;
  }
  return null;
}
