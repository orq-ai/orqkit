import { z } from "zod/v4";

import { checkLlmParallelism } from "../common/llm-limit.js";
import { AgentResponse } from "../contracts.js";
import {
  LLMConfig,
  type LLMConfigInput,
  RedTeamRecommendationConfig,
  type RedTeamRecommendationConfigInput,
} from "./config.js";
import {
  type Pipeline,
  PipelineSchema,
  type SaveMode,
  SaveModeSchema,
} from "./contracts.js";
import {
  CanonicalMessageSchema,
  type TargetConfig,
  TargetConfigSchema,
} from "./input.js";

const optionalString = z.string().nullable().default(null);
const optionalInt = z.number().int().nullable().default(null);
const optionalStrings = z.array(z.string()).nullable().default(null);
function aliases(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const raw = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (!(key in raw) && snake in raw) raw[key] = raw[snake];
    if (snake !== key) delete raw[snake];
  }
  return raw;
}
function validatedModel<T>(factory: (raw: unknown) => T) {
  return z.unknown().transform((raw, ctx) => {
    try {
      return factory(raw);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray(error.issues)
      ) {
        for (const issue of error.issues as {
          path: (string | number)[];
          message: string;
        }[])
          ctx.addIssue({
            code: "custom",
            path: issue.path,
            message: issue.message,
          });
      } else
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      return z.NEVER;
    }
  });
}
export const RedTeamDataPointSchema = z.preprocess(
  (value) => aliases(value, ["expectedOutput"]),
  z.object({
    inputs: z.record(z.string(), z.unknown()),
    expectedOutput: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.instanceof(AgentResponse),
        z.record(z.string(), z.unknown()),
        z.array(CanonicalMessageSchema),
      ])
      .nullable()
      .default(null),
  }),
);
export type RedTeamDataPoint = z.infer<typeof RedTeamDataPointSchema>;
export const RedTeamRunConfigSchema = z
  .object({
    target: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .default(null),
    llmConfig: validatedModel((value) =>
      value instanceof LLMConfig
        ? value
        : new LLMConfig(value as LLMConfigInput),
    )
      .nullable()
      .default(null),
    mode: PipelineSchema.nullable().default(null),
    categories: optionalStrings,
    vulnerabilities: optionalStrings,
    strategies: optionalStrings,
    datapoints: z.array(RedTeamDataPointSchema).nullable().default(null),
    attackTechniques: optionalStrings,
    deliveryMethods: optionalStrings,
    maxTurns: optionalInt,
    maxPerCategory: optionalInt,
    datapointParallelism: optionalInt,
    parallelism: optionalInt,
    llmParallelism: optionalInt.superRefine((value, ctx) => {
      if (value !== null)
        try {
          checkLlmParallelism(value);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: String(error) });
        }
    }),
    generateStrategies: z.boolean().default(true),
    generatedStrategyCount: z.number().int().default(2),
    maxDynamicDatapoints: optionalInt,
    maxStaticDatapoints: optionalInt,
    cleanupMemory: z.boolean().default(true),
    name: optionalString,
    description: optionalString,
    dataset: optionalString,
    previousRun: optionalString,
    artifactsDir: optionalString,
    targetConfig: TargetConfigSchema.nullable().default(null),
    recommendations: z
      .union([
        z.boolean(),
        validatedModel((value) =>
          value instanceof RedTeamRecommendationConfig
            ? value
            : new RedTeamRecommendationConfig(
                value as RedTeamRecommendationConfigInput,
              ),
        ),
      ])
      .default(true),
    generateExecutiveSummary: z.boolean().default(true),
    attackerInstructions: optionalString,
    verbosity: z.number().int().default(0),
    save: SaveModeSchema.default("final"),
  })
  .strict();
export type RedTeamRunConfigInput = z.input<typeof RedTeamRunConfigSchema>;
export class RedTeamRunConfig {
  static readonly defaultVerbosity: number = 0;
  target!: string | string[] | null;
  llmConfig!: LLMConfig | null;
  mode!: Pipeline | null;
  categories!: string[] | null;
  vulnerabilities!: string[] | null;
  strategies!: string[] | null;
  datapoints!: RedTeamDataPoint[] | null;
  attackTechniques!: string[] | null;
  deliveryMethods!: string[] | null;
  maxTurns!: number | null;
  maxPerCategory!: number | null;
  datapointParallelism!: number | null;
  parallelism!: number | null;
  llmParallelism!: number | null;
  generateStrategies!: boolean;
  generatedStrategyCount!: number;
  maxDynamicDatapoints!: number | null;
  maxStaticDatapoints!: number | null;
  cleanupMemory!: boolean;
  name!: string | null;
  description!: string | null;
  dataset!: string | null;
  previousRun!: string | null;
  artifactsDir!: string | null;
  targetConfig!: TargetConfig | null;
  recommendations!: boolean | RedTeamRecommendationConfig;
  generateExecutiveSummary!: boolean;
  attackerInstructions!: string | null;
  verbosity!: number;
  save!: SaveMode;
  readonly fieldsSet: ReadonlySet<string>;
  constructor(input: RedTeamRunConfigInput = {}) {
    const raw = aliases(input, Object.keys(RedTeamRunConfigSchema.shape));
    const schema = RedTeamRunConfigSchema.extend({
      verbosity: z
        .number()
        .int()
        .default(new.target.defaultVerbosity),
    });
    const parsed = schema.parse(raw);
    Object.assign(this, parsed);
    this.fieldsSet = new Set(Object.keys(raw as Record<string, unknown>));
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(
      Object.keys(RedTeamRunConfigSchema.shape).map((key) => {
        const value = this[key as keyof RedTeamRunConfig];
        return [
          key,
          value instanceof LLMConfig
            ? value.toJSON()
            : value instanceof RedTeamRecommendationConfig
              ? { ...value }
              : value,
        ];
      }),
    );
  }
}
export class RedTeamCliConfig extends RedTeamRunConfig {
  static override readonly defaultVerbosity: number = 1;
}
