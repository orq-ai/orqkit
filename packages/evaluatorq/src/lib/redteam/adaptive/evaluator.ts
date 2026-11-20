import type OpenAI from "openai";

import {
  buildEvalReplacements,
  JudgeError,
  type JudgeOutcome,
  judgeErrorPayload,
  runJudge,
} from "../../common/judge.js";
import { panelCompositionMessages, runJury } from "../../common/jury.js";
import { coerceContentText } from "../../common/messages.js";
import {
  EVAL_ERROR_RAW_OUTPUT_KEY,
  LLMCallConfig,
  type LLMCallConfigInput,
  LLMCallConfigSchema,
  type Message,
  type OutputMessage,
} from "../../contracts.js";
import { createAsyncLlmClient } from "../backends/client.js";
import {
  EvaluatorConfig,
  evaluatorModelFor,
  PIPELINE_CONFIG,
  RED_TEAM_TIE_OUTCOME,
} from "../config.js";
import { normalizeCategory, type Vulnerability } from "../contracts.js";
import { AttackEvaluationResult } from "../evaluation.js";
import {
  getEvaluatorForCategory,
  getEvaluatorForVulnerability,
} from "../frameworks/owasp/evaluators.js";
import type { LlmEvaluatorEntity } from "../frameworks/owasp/models.js";
import { resolveCategorySafe } from "../vulnerability-registry.js";
export interface OWASPEvaluatorOptions {
  evaluatorModel?: string | null;
  llmClient?: OpenAI | null;
  llmKwargs?: Record<string, unknown> | null;
  cfg?: LLMCallConfig | EvaluatorConfig | null;
  judges?: string[] | null;
  repetitions?: number;
  replacementJudges?: string[] | null;
  minSuccessfulJudges?: number;
  targetModels?: string[] | null;
  strictPanel?: boolean;
}
export class OWASPEvaluator {
  readonly evaluatorModel: string;
  readonly panel: string[];
  readonly replacementJudges: string[];
  readonly repetitions: number;
  readonly minSuccessfulJudges: number;
  readonly config: LLMCallConfig;
  private clientPromise?: Promise<OpenAI>;
  private readonly supplied?: OpenAI;
  constructor(readonly options: OWASPEvaluatorOptions = {}) {
    const base = options.cfg ?? PIPELINE_CONFIG.evaluator;
    this.evaluatorModel = evaluatorModelFor(
      options.evaluatorModel,
      options.cfg,
    );
    const call = base instanceof EvaluatorConfig ? base.asCallConfig() : base;
    this.config = new LLMCallConfig({
      ...call.setValues(
        ...(Object.keys(
          LLMCallConfigSchema.shape,
        ) as (keyof LLMCallConfigInput)[]),
      ),
      extraKwargs: { ...base.extraKwargs, ...options.llmKwargs },
    });
    this.supplied = options.llmClient ?? (base.client as OpenAI | undefined);
    this.panel = [
      ...new Set([
        this.evaluatorModel,
        ...(options.judges ?? []).filter(Boolean),
      ]),
    ];
    this.replacementJudges = [
      ...new Set(
        (options.replacementJudges ?? []).filter(
          (judge) => judge && !this.panel.includes(judge),
        ),
      ),
    ];
    this.repetitions = Math.max(1, options.repetitions ?? 1);
    this.minSuccessfulJudges = Math.max(1, options.minSuccessfulJudges ?? 1);
    if (this.minSuccessfulJudges > this.panel.length)
      throw new RangeError(
        `minSuccessfulJudges (${this.minSuccessfulJudges}) exceeds the effective panel size (${this.panel.length}) after de-duplication; panel=${JSON.stringify(this.panel)}`,
      );
    for (const issue of panelCompositionMessages(
      [this.evaluatorModel, ...(options.judges ?? [])],
      options.targetModels ?? [],
      { strict: options.strictPanel, tieOutcome: RED_TEAM_TIE_OUTCOME },
    )) {
      if (options.strictPanel) throw new RangeError(issue);
      console.warn(issue);
    }
  }
  private client(): Promise<OpenAI> {
    this.clientPromise ??= this.supplied
      ? Promise.resolve(this.supplied)
      : createAsyncLlmClient(undefined, { maxRetries: 0 });
    return this.clientPromise;
  }
  async evaluateVulnerability(
    vulnerability: Vulnerability,
    messages: readonly Message[] | readonly Record<string, unknown>[],
    outputMessages: readonly OutputMessage[],
  ): Promise<AttackEvaluationResult> {
    const evaluator = getEvaluatorForVulnerability(
      vulnerability,
      this.evaluatorModel,
    );
    if (!evaluator) {
      console.warn(`No evaluator found for vulnerability ${vulnerability}`);
      return new AttackEvaluationResult({
        passed: null,
        explanation: `No evaluator available for vulnerability ${vulnerability}`,
        evaluatorId: "none",
        rawOutput: null,
      });
    }
    return this.runEvaluator(
      evaluator,
      vulnerability,
      messages,
      outputMessages,
      {
        "orq.redteam.llm_purpose": "evaluation",
        "orq.llm.purpose": "evaluation",
        "orq.redteam.vulnerability": vulnerability,
      },
    );
  }
  async evaluate(
    category: string,
    messages: readonly Message[] | readonly Record<string, unknown>[],
    outputMessages: readonly OutputMessage[],
  ): Promise<AttackEvaluationResult> {
    const code = normalizeCategory(category),
      vulnerability = resolveCategorySafe(code);
    if (vulnerability)
      return this.evaluateVulnerability(
        vulnerability,
        messages,
        outputMessages,
      );
    const evaluator = getEvaluatorForCategory(category, this.evaluatorModel);
    if (!evaluator) {
      console.warn(`No evaluator found for category ${category}`);
      return new AttackEvaluationResult({
        passed: null,
        explanation: `No evaluator available for category ${category}`,
        evaluatorId: "none",
        rawOutput: null,
      });
    }
    return this.runEvaluator(evaluator, code, messages, outputMessages, {
      "orq.redteam.llm_purpose": "evaluation",
      "orq.llm.purpose": "evaluation",
      "orq.redteam.category": category,
      "orq.redteam.vulnerability": "",
    });
  }
  private async runEvaluator(
    evaluator: LlmEvaluatorEntity,
    evaluatorId: string,
    messages: readonly Message[] | readonly Record<string, unknown>[],
    outputMessages: readonly OutputMessage[],
    spanAttributes: Record<string, string>,
  ): Promise<AttackEvaluationResult> {
    const replacements = buildEvalReplacements({
      inputMessages: messages.map((message) => ({
        ...Object.fromEntries(
          Object.entries(message).filter(
            ([key, value]) =>
              !["name", "tool_calls", "tool_call_id"].includes(key) ||
              value != null,
          ),
        ),
        content: coerceContentText(message.content),
      })),
      outputMessages,
      expectedOutput: null,
      systemInstructions: null,
    });
    const client = await this.client();
    const judge = (model: string) =>
      runJudge({
        client,
        model,
        cfg: this.config,
        promptTemplate: evaluator.prompt,
        replacements,
        spanAttributes,
      });
    if (
      this.panel.length === 1 &&
      this.repetitions === 1 &&
      !this.replacementJudges.length
    )
      return this.singleOutcomeToResult(
        await judge(this.evaluatorModel),
        evaluatorId,
      );
    let lastError: JudgeOutcome | null = null;
    const deliberation = await runJury({
      judgeFn: async (model) => {
        const outcome = await judge(model);
        if (outcome.errorKind !== null || outcome.payload === null) {
          lastError = outcome;
          return {
            error: outcome.errorMessage || outcome.errorKind || "error",
            tokenUsage: outcome.tokenUsage,
          };
        }
        return {
          value: outcome.payload.value,
          explanation: outcome.payload.explanation,
          tokenUsage: outcome.tokenUsage,
          abstained: outcome.payload.abstain,
        };
      },
      panel: this.panel,
      repetitions: this.repetitions,
      replacementJudges: this.replacementJudges,
      minSuccessfulJudges: this.minSuccessfulJudges,
      verdictKind: "categorical",
      tieBreak: () => false,
      tieBreakLabel: RED_TEAM_TIE_OUTCOME,
      propagateErrors: false,
    });
    const passed =
        typeof deliberation.verdict === "boolean" ? deliberation.verdict : null,
      rawOutput: Record<string, unknown> = {
        value: passed,
        explanation: deliberation.explanation,
      };
    if (passed === null && lastError !== null)
      rawOutput[EVAL_ERROR_RAW_OUTPUT_KEY] = judgeErrorPayload(
        lastError,
        evaluatorId,
      );
    return new AttackEvaluationResult({
      passed,
      explanation: deliberation.explanation,
      evaluatorId,
      tokenUsage: deliberation.tokenUsage,
      rawOutput,
      jury: deliberation.jury,
    });
  }
  singleOutcomeToResult(
    outcome: JudgeOutcome,
    evaluatorId: string,
  ): AttackEvaluationResult {
    if (outcome.errorKind === JudgeError.TIMEOUT)
      return new AttackEvaluationResult({
        passed: null,
        explanation: `Evaluation timed out after ${outcome.timeoutMs}ms`,
        evaluatorId,
        tokenUsage: outcome.tokenUsage,
        rawOutput: {
          error: "timeout",
          timeout_ms: outcome.timeoutMs,
          [EVAL_ERROR_RAW_OUTPUT_KEY]: judgeErrorPayload(outcome, evaluatorId),
        },
      });
    if (outcome.errorKind !== null || outcome.payload === null)
      return new AttackEvaluationResult({
        passed: null,
        explanation: `Evaluation error: ${outcome.errorMessage ?? "None"}`,
        evaluatorId,
        tokenUsage: outcome.tokenUsage,
        rawOutput: {
          error: outcome.errorMessage,
          raw_content: outcome.rawContent,
          [EVAL_ERROR_RAW_OUTPUT_KEY]: judgeErrorPayload(outcome, evaluatorId),
        },
      });
    return new AttackEvaluationResult({
      passed:
        typeof outcome.payload.value === "boolean"
          ? outcome.payload.value
          : null,
      explanation: outcome.payload.explanation,
      evaluatorId,
      tokenUsage: outcome.tokenUsage,
      rawOutput: {
        value: outcome.payload.value,
        explanation: outcome.payload.explanation,
        raw_content: outcome.rawContent,
        endpoint: outcome.endpoint,
      },
    });
  }
}
export function evaluateAttack(
  category: string,
  messages: readonly Message[] | readonly Record<string, unknown>[],
  outputMessages: readonly OutputMessage[],
  options: OWASPEvaluatorOptions & {
    vulnerability?: Vulnerability | null;
  } = {},
): Promise<AttackEvaluationResult> {
  const evaluator = new OWASPEvaluator(options);
  return options.vulnerability
    ? evaluator.evaluateVulnerability(
        options.vulnerability,
        messages,
        outputMessages,
      )
    : evaluator.evaluate(category, messages, outputMessages);
}

export { providerFamily } from "../../common/jury.js";
