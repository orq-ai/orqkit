import { z } from "zod/v4";

import { FrameworkSchema, PipelineSchema } from "../contracts.js";
import { CanonicalMessageSchema, RedTeamInputSchema } from "../input.js";
import { savedKeys, savedUsage } from "../saved-model.js";
import { AttackStrategySchema } from "../strategy.js";
import { EvaluationPayloadSchema } from "./models.js";

const text = z.string().nullable().default(null),
  integer = z.number().int().nullable().default(null),
  number = z.number().nullable().default(null);
const usage = savedUsage.nullable().default(null),
  strings = z.array(z.string()).default(() => []);
const errorFields = {
  error: text,
  errorType: text,
  errorStage: text,
  errorCode: text,
  errorDetails: z.record(z.string(), z.unknown()).nullable().default(null),
};
const evaluatedFields = {
  input: RedTeamInputSchema,
  messages: z.array(CanonicalMessageSchema).default(() => []),
  response: text,
  ...errorFields,
};
export const EvaluatedRowBaseSchema = savedKeys(
  z.object(evaluatedFields).passthrough(),
);
export type EvaluatedRowBase = z.infer<typeof EvaluatedRowBaseSchema>;
export const EvaluatedRowSchema = savedKeys(
  z
    .object({
      ...evaluatedFields,
      evaluationResult: EvaluationPayloadSchema.prefault({}),
    })
    .passthrough(),
);
export type EvaluatedRow = z.infer<typeof EvaluatedRowSchema>;
export const AttackEvaluationRowSchema = z.object({
  value: z.unknown().default(null),
  passed: z.boolean().nullable().default(null),
  explanation: z.string().default(""),
  skipped: z.boolean().default(false),
});
export type AttackEvaluationRow = z.infer<typeof AttackEvaluationRowSchema>;
export const DynamicAttackResultRowSchema = savedKeys(
  z.object({
    id: text,
    vulnerability: z.string().default(""),
    category: z.string().default("unknown"),
    strategy: AttackStrategySchema.nullable().default(null),
    objective: text,
    ...errorFields,
    conversation: z.array(CanonicalMessageSchema).default(() => []),
    finalResponse: z.string().default(""),
    turns: z.number().int().default(1),
    objectiveAchieved: z.boolean().nullable().default(null),
    objectiveRationale: text,
    durationSeconds: number,
    tokenUsage: usage,
    tokenUsageAdversarial: usage,
    tokenUsageTarget: usage,
    systemPrompt: text,
    jobError: text,
    evaluation: AttackEvaluationRowSchema.nullable().default(null),
    vulnerable: z.boolean().nullable().default(null),
  }),
);
export type DynamicAttackResultRow = z.infer<
  typeof DynamicAttackResultRowSchema
>;
export const DynamicCategorySummaryRowSchema = savedKeys(
  z.object({
    total: z.number().int().default(0),
    vulnerable: z.number().int().default(0),
    resistant: z.number().int().default(0),
    errors: z.number().int().default(0),
    strategies: strings,
    resistanceRate: z.number().default(0),
  }),
);
export type DynamicCategorySummaryRow = z.infer<
  typeof DynamicCategorySummaryRowSchema
>;
export const ErrorTypeDetailsSchema = savedKeys(
  z.object({
    count: z.number().int().default(0),
    categories: strings,
    strategies: strings,
    sampleError: z.string().default(""),
  }),
);
export type ErrorTypeDetails = z.infer<typeof ErrorTypeDetailsSchema>;
export const DynamicErrorAnalysisRowSchema = savedKeys(
  z.object({
    errorRate: z.number().default(0),
    byErrorType: z
      .record(z.string(), ErrorTypeDetailsSchema)
      .default(() => ({})),
  }),
);
export type DynamicErrorAnalysisRow = z.infer<
  typeof DynamicErrorAnalysisRowSchema
>;
export const DynamicRunMetadataSchema = savedKeys(
  z
    .object({
      mode: text,
      target: text,
      agentKey: text,
      attackModel: text,
      evaluatorModel: text,
      categoriesTested: z.array(z.string()).nullable().default(null),
      maxDynamicDatapoints: integer,
      maxStaticDatapoints: integer,
      maxTurns: integer,
      maxPerCategory: integer,
      generatedStrategyCount: integer,
      datapointParallelism: integer,
      timestamp: text,
      durationSeconds: number,
    })
    .passthrough(),
);
export type DynamicRunMetadata = z.infer<typeof DynamicRunMetadataSchema>;
export const StrategySelectionRowSchema = z
  .object({
    count: z.number().int().default(0),
    strategies: z.array(AttackStrategySchema).default(() => []),
  })
  .passthrough();
export type StrategySelectionRow = z.infer<typeof StrategySelectionRowSchema>;
export const GeneratedPromptRowSchema = savedKeys(
  z.object({
    id: z.string(),
    category: z.string(),
    strategyName: z.string(),
    turnType: z.string(),
    isGenerated: z.boolean().default(false),
    objective: z.string(),
    promptTemplate: text,
  }),
);
export type GeneratedPromptRow = z.infer<typeof GeneratedPromptRowSchema>;
export const DynamicSummaryReportRowSchema = savedKeys(
  z.object({
    runMetadata: DynamicRunMetadataSchema,
    totalAttacks: z.number().int().default(0),
    evaluatedAttacks: z.number().int().default(0),
    vulnerabilitiesFound: z.number().int().default(0),
    resistanceRate: z.number().default(0),
    errors: z.number().int().default(0),
    errorAnalysis: DynamicErrorAnalysisRowSchema.prefault({}),
    tokenUsageBySource: z.record(z.string(), savedUsage).default(() => ({})),
    byCategory: z
      .record(z.string(), DynamicCategorySummaryRowSchema)
      .default(() => ({})),
  }),
);
export type DynamicSummaryReportRow = z.infer<
  typeof DynamicSummaryReportRowSchema
>;
export const DatasetInferenceRowSchema = savedKeys(
  z
    .object({
      response: text,
      agentType: z.string(),
      agentModel: z.string(),
      error: text,
      errorType: text,
    })
    .passthrough(),
);
export type DatasetInferenceRow = z.infer<typeof DatasetInferenceRowSchema>;
export const ReportSnapshotSchema = savedKeys(
  z.object({
    pipeline: PipelineSchema,
    framework: FrameworkSchema.nullable().default(null),
    totalResults: z.number().int(),
    categoriesTested: z.array(z.string()),
    resistanceRate: z.number().min(0).max(1).nullable().default(null),
    vulnerabilitiesFound: z.number().int(),
    topTechniques: z.record(z.string(), z.number().int()).default(() => ({})),
  }),
);
export type ReportSnapshot = z.infer<typeof ReportSnapshotSchema>;
