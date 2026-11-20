import { z } from "zod";
import { z as z4 } from "zod/v4";

import { duplicateJudgesMessage } from "../common/jury.js";
import { clientRoutesThroughOrq } from "../common/llm-client.js";
import { roleModel } from "../common/model-roles.js";
import { RecommendationConfigBaseSchema } from "../common/recommendations.js";
import {
  DEFAULT_TARGET_TIMEOUT_MS,
  LLMCallConfig,
  type LLMCallConfigInput,
  LLMCallConfigSchema,
} from "../contracts.js";

function aliases(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Configuration must be an object");
  const raw = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (!(key in raw) && snake in raw) raw[key] = raw[snake];
    if (snake !== key) delete raw[snake];
  }
  return raw;
}
const callKeys = Object.keys(LLMCallConfigSchema.shape);
function sharedValues(config: LLMCallConfig): LLMCallConfigInput {
  return Object.fromEntries(
    callKeys.map((key) => {
      if (!(key in config))
        throw new Error(
          `LLMCallConfig field ${key} is missing from its instance`,
        );
      return [key, config[key as keyof LLMCallConfig]];
    }),
  ) as LLMCallConfigInput;
}
function serializableCall(config: LLMCallConfig): Record<string, unknown> {
  const values = sharedValues(config);
  delete values.client;
  return values;
}
const EvaluatorSchema = LLMCallConfigSchema.extend({
  model: z.string().nullable().default(null),
  api: z.enum(["chat_completions", "responses"]).default("responses"),
  judges: z
    .array(z.string())
    .min(1)
    .default(() => [roleModel("smart", { task: "redteam.evaluator" })]),
  repetitions: z.number().int().min(1).default(1),
  replacementJudges: z.array(z.string()).default([]),
  minSuccessfulJudges: z.number().int().min(1).default(1),
  minEvaluationCoverage: z.number().min(0).max(1).nullable().default(0.8),
  strictPanel: z.boolean().default(false),
}).strict();
export type EvaluatorConfigInput = z.input<typeof EvaluatorSchema>;
export class EvaluatorConfig extends LLMCallConfig {
  readonly judges: string[];
  readonly repetitions: number;
  readonly replacementJudges: string[];
  readonly minSuccessfulJudges: number;
  readonly minEvaluationCoverage: number | null;
  readonly strictPanel: boolean;
  constructor(input: EvaluatorConfigInput | LLMCallConfig = {}) {
    const raw = aliases(
      input instanceof LLMCallConfig
        ? {
            ...sharedValues(input),
            ...(input instanceof EvaluatorConfig
              ? {
                  judges: input.judges,
                  repetitions: input.repetitions,
                  replacementJudges: input.replacementJudges,
                  minSuccessfulJudges: input.minSuccessfulJudges,
                  minEvaluationCoverage: input.minEvaluationCoverage,
                  strictPanel: input.strictPanel,
                }
              : {}),
          }
        : input,
      Object.keys(EvaluatorSchema.shape),
    );
    const issue = (message: string | null) => {
      if (message) {
        if (raw.strictPanel) throw new RangeError(message);
        console.warn(message);
      }
    };
    if (raw.model !== undefined && raw.model !== null) {
      const judges = raw.judges || [];
      if (!Array.isArray(judges))
        throw new TypeError("evaluator.judges must be an array");
      issue(
        duplicateJudgesMessage(judges.filter((judge) => judge === raw.model)),
      );
      raw.judges = [
        raw.model,
        ...judges.filter((judge) => judge !== raw.model),
      ];
    }
    const parsed = EvaluatorSchema.parse(raw);
    issue(duplicateJudgesMessage(parsed.judges));
    const panel = [...new Set(parsed.judges.filter(Boolean))];
    if (!panel.length)
      throw new RangeError("evaluator.judges must contain at least one model");
    if (parsed.minSuccessfulJudges > panel.length)
      throw new RangeError(
        `minSuccessfulJudges (${parsed.minSuccessfulJudges}) exceeds effective panel size (${panel.length})`,
      );
    const model = panel[0] as string;
    super({ ...parsed, model });
    Object.defineProperty(this, "fieldsSet", {
      value: new Set(Object.keys(raw)),
    });
    this.judges = panel;
    this.repetitions = parsed.repetitions;
    this.replacementJudges = parsed.replacementJudges;
    this.minSuccessfulJudges = parsed.minSuccessfulJudges;
    this.minEvaluationCoverage = parsed.minEvaluationCoverage;
    this.strictPanel = parsed.strictPanel;
  }
  get primaryModel(): string {
    return this.judges[0] as string;
  }
  asCallConfig(): LLMCallConfig {
    return new LLMCallConfig(sharedValues(this));
  }
  toJSON(): Record<string, unknown> {
    const shared = serializableCall(this);
    delete shared.model;
    return {
      ...shared,
      judges: this.judges,
      repetitions: this.repetitions,
      replacementJudges: this.replacementJudges,
      minSuccessfulJudges: this.minSuccessfulJudges,
      minEvaluationCoverage: this.minEvaluationCoverage,
      strictPanel: this.strictPanel,
    };
  }
}
export const RedTeamRecommendationConfigSchema =
  RecommendationConfigBaseSchema.extend({
    maxSuggestions: z4.number().int().min(1).default(5),
    maxTokens: z4.number().int().min(1).default(1500),
    maxAreas: z4.number().int().min(1).default(5),
    maxAttacks: z4.number().int().min(1).default(10),
    maxAttackChars: z4.number().int().min(100).default(200000),
    maxExplanationChars: z4.number().int().min(50).default(300),
    condenseAboveChars: z4.number().int().min(100).default(1000),
    condenseMaxTokens: z4.number().int().min(1).default(10000),
    maxAreaPromptChars: z4.number().int().min(1000).default(400000),
  }).strict();
export type RedTeamRecommendationConfigInput = z4.input<
  typeof RedTeamRecommendationConfigSchema
>;
export class RedTeamRecommendationConfig {
  maxSuggestions!: number;
  maxTokens!: number;
  maxAreas!: number;
  maxAttacks!: number;
  maxAttackChars!: number;
  maxExplanationChars!: number;
  condenseAboveChars!: number;
  condenseMaxTokens!: number;
  maxAreaPromptChars!: number;
  constructor(input: RedTeamRecommendationConfigInput = {}) {
    Object.assign(
      this,
      RedTeamRecommendationConfigSchema.parse(
        aliases(input, Object.keys(RedTeamRecommendationConfigSchema.shape)),
      ),
    );
  }
}
const PipelineSchema = z
  .object({
    attacker: z.unknown().optional(),
    evaluator: z.unknown().optional(),
    retryCount: z.number().int().min(0).max(10).default(3),
    retryOnCodes: z.array(z.number().int()).default([429, 500, 502, 503, 504]),
    maxContentFilterRetries: z.number().int().min(0).max(10).default(2),
    maxConsecutiveAdversarialTimeouts: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2),
    maxObjectivesPerLlmCall: z.number().int().min(1).default(8),
    maxProbeTurns: z.number().int().min(1).default(8),
    maxBacktracks: z.number().int().min(0).max(10).default(0),
    cleanupTimeoutMs: z.number().int().default(60000),
    targetAgentTimeoutMs: z.number().int().default(DEFAULT_TARGET_TIMEOUT_MS),
    maxTargetRetries: z.number().int().min(0).max(10).default(2),
    targetReasoningEffort: z.string().nullable().default(null),
    maxToolContinuations: z.number().int().default(5),
  })
  .strict();
export type LLMConfigInput = Omit<
  z.input<typeof PipelineSchema>,
  "attacker" | "evaluator"
> & {
  attacker?: LLMCallConfigInput | LLMCallConfig;
  evaluator?: EvaluatorConfigInput | LLMCallConfig;
};
export class LLMConfig {
  declare readonly fieldsSet: ReadonlySet<string>;
  attacker: LLMCallConfig;
  evaluator: EvaluatorConfig;
  retryCount!: number;
  retryOnCodes!: number[];
  maxContentFilterRetries!: number;
  maxConsecutiveAdversarialTimeouts!: number;
  maxObjectivesPerLlmCall!: number;
  maxProbeTurns!: number;
  maxBacktracks!: number;
  cleanupTimeoutMs!: number;
  targetAgentTimeoutMs!: number;
  maxTargetRetries!: number;
  targetReasoningEffort!: string | null;
  maxToolContinuations!: number;
  constructor(input: LLMConfigInput = {}) {
    const raw = aliases(input, Object.keys(PipelineSchema.shape));
    const parsed = PipelineSchema.parse(raw);
    Object.defineProperty(this, "fieldsSet", {
      value: new Set(Object.keys(raw)),
    });
    const { attacker, evaluator, ...knobs } = parsed;
    Object.assign(this, knobs);
    const call =
      attacker instanceof LLMCallConfig
        ? attacker
        : new LLMCallConfig(
            attacker === undefined
              ? { model: roleModel("smart", { task: "redteam.attacker" }) }
              : (aliases(attacker, callKeys) as LLMCallConfigInput),
          );
    this.attacker = call.fieldsSet.has("model")
      ? call
      : new LLMCallConfig({
          ...call.setValues(...(callKeys as (keyof LLMCallConfigInput)[])),
          model: roleModel("smart", { task: "redteam.attacker" }),
        });
    this.evaluator =
      evaluator instanceof EvaluatorConfig
        ? evaluator
        : new EvaluatorConfig(
            evaluator as EvaluatorConfigInput | LLMCallConfig | undefined,
          );
  }
  get retryAttempts(): number {
    return this.retryCount + 1;
  }
  retryExtraBody(
    client?: { baseURL?: unknown } | null,
  ): Record<string, unknown> {
    return clientRoutesThroughOrq(client)
      ? { retry: { count: this.retryCount, on_codes: this.retryOnCodes } }
      : {};
  }
  toJSON(): Record<string, unknown> {
    return {
      attacker: serializableCall(this.attacker),
      evaluator: this.evaluator.toJSON(),
      ...Object.fromEntries(
        Object.keys(PipelineSchema.shape)
          .filter((key) => !["attacker", "evaluator"].includes(key))
          .map((key) => [key, this[key as keyof LLMConfig]]),
      ),
    };
  }
}
export const PIPELINE_CONFIG = new LLMConfig();
export const RED_TEAM_TIE_OUTCOME = "fail-closed to VULNERABLE";
export function evaluatorModelFor(
  model?: string | null,
  config?: LLMCallConfig | EvaluatorConfig | null,
): string {
  if (model) return model;
  if (config instanceof EvaluatorConfig) return config.primaryModel;
  if (config?.fieldsSet.has("model")) return config.model;
  return roleModel("smart", { task: "redteam.evaluator" });
}
export function attackerModelFor(
  model?: string | null,
  config?: LLMConfig | null,
): string {
  if (model) return model;
  if (config) return config.attacker.model;
  return roleModel("smart", { task: "redteam.attacker" });
}
