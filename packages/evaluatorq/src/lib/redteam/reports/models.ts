import { z } from "zod/v4";

import { scrubKnownSecrets } from "../../common/redact.js";
import { codepointCompare, pythonStrip } from "../../common/sanitize.js";
import { AgentContextSchema, type RunSummary } from "../../contracts.js";
import {
  AttackTechniqueSchema,
  FrameworkSchema,
  PipelineSchema,
  ReliabilityMethod,
  ReliabilityMethodSchema,
  SeveritySchema,
  TurnTypeSchema,
  VulnerabilityDomainSchema,
} from "../contracts.js";
import { CanonicalMessageSchema } from "../input.js";
import {
  savedAdapter,
  savedJury,
  savedKeys,
  savedUsage,
} from "../saved-model.js";
import { RunErrorSchema } from "../strategy.js";
import { Turn } from "../turn.js";

const nullableString = z.string().nullable().default(null);
const nullableInt = z.number().int().nullable().default(null);
const nullableNumber = z.number().nullable().default(null);
const nullableBool = z.boolean().nullable().default(null);
const metadata = z.record(z.string(), z.unknown()).nullable().default(null);
const messages = z.array(CanonicalMessageSchema).default(() => []);
const usage = savedUsage.nullable().default(null);
const framework = z.preprocess(
  (value) => (value === "OWASP-AGENTIC" ? "OWASP-ASI" : value),
  FrameworkSchema,
);
const turn = savedAdapter((value) =>
  value instanceof Turn ? value : new Turn(value as Record<string, unknown>),
);
const turns = z.array(turn).default(() => []);
const runError = savedAdapter((value) => RunErrorSchema.parse(value));
const responseTrace = savedKeys(
  z.object({ traceId: nullableString, spanId: nullableString }),
);
const responseTraces = z.array(responseTrace).default(() => []);
const unitRate = z.number().min(0).max(1);
const nullableRate = unitRate.nullable().default(null);

export const AttackInfoSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const raw = { ...value } as Record<string, unknown>;
    if (
      !("vulnerabilityDomain" in raw) &&
      !("vulnerability_domain" in raw) &&
      "scope" in raw
    )
      raw.vulnerabilityDomain =
        raw.scope === "application" ? "agent" : raw.scope;
    return raw;
  },
  savedKeys(
    z.object({
      id: z.string(),
      vulnerability: z.string().default(""),
      category: z.string(),
      framework,
      attackTechnique: AttackTechniqueSchema,
      deliveryMethods: z.array(z.string()),
      turnType: TurnTypeSchema,
      severity: SeveritySchema,
      vulnerabilityDomain: VulnerabilityDomainSchema.nullable().default(null),
      source: z.string(),
      strategyName: nullableString,
      objective: nullableString,
      evaluatorId: nullableString,
      evaluatorName: nullableString,
      additionalMetadata: metadata,
    }),
  ),
);
export type AttackInfo = z.infer<typeof AttackInfoSchema>;

const evaluationFields = {
  value: z.unknown().default(null),
  passed: nullableBool,
  explanation: z.string().default(""),
  evaluatorId: nullableString,
  evaluatorName: nullableString,
  tokenUsage: usage,
  rawOutput: metadata,
};
export const UnifiedEvaluationResultSchema = savedKeys(
  z.object({ ...evaluationFields, jury: savedJury.nullable().default(null) }),
);
export type UnifiedEvaluationResult = z.infer<
  typeof UnifiedEvaluationResultSchema
>;
export const EvaluationPayloadSchema = savedKeys(
  z.object({ ...evaluationFields, error: nullableString }),
);
export type EvaluationPayload = z.infer<typeof EvaluationPayloadSchema>;

export const JobOutputPayloadSchema = savedKeys(
  z
    .object({
      conversation: messages,
      finalResponse: nullableString,
      response: nullableString,
      output: nullableString,
      turns: nullableInt,
      maxTurns: nullableInt,
      objectiveAchieved: nullableBool,
      objectiveRationale: nullableString,
      durationSeconds: nullableNumber,
      tokenUsage: usage,
      tokenUsageAdversarial: usage,
      tokenUsageTarget: usage,
      tokenUsageBootstrap: usage,
      seedContext: messages,
      systemPrompt: nullableString,
      error: nullableString,
      errorType: nullableString,
      errorStage: nullableString,
      errorCode: nullableString,
      errorDetails: metadata,
      errorTurn: nullableInt,
      truncatedTurns: z.array(z.number().int()).default(() => []),
      backtrackedTurns: turns,
      refusalJudgeFailures: z.number().int().default(0),
      finishReason: nullableString,
      threadId: nullableString,
      responseTraces,
    })
    .passthrough(),
);

export class JobOutputPayload {
  declare conversation: z.infer<typeof JobOutputPayloadSchema>["conversation"];
  declare finalResponse: z.infer<
    typeof JobOutputPayloadSchema
  >["finalResponse"];
  declare response: z.infer<typeof JobOutputPayloadSchema>["response"];
  declare output: z.infer<typeof JobOutputPayloadSchema>["output"];
  declare turns: z.infer<typeof JobOutputPayloadSchema>["turns"];
  declare maxTurns: z.infer<typeof JobOutputPayloadSchema>["maxTurns"];
  declare objectiveAchieved: z.infer<
    typeof JobOutputPayloadSchema
  >["objectiveAchieved"];
  declare objectiveRationale: z.infer<
    typeof JobOutputPayloadSchema
  >["objectiveRationale"];
  declare durationSeconds: z.infer<
    typeof JobOutputPayloadSchema
  >["durationSeconds"];
  declare tokenUsage: z.infer<typeof JobOutputPayloadSchema>["tokenUsage"];
  declare tokenUsageAdversarial: z.infer<
    typeof JobOutputPayloadSchema
  >["tokenUsageAdversarial"];
  declare tokenUsageTarget: z.infer<
    typeof JobOutputPayloadSchema
  >["tokenUsageTarget"];
  declare tokenUsageBootstrap: z.infer<
    typeof JobOutputPayloadSchema
  >["tokenUsageBootstrap"];
  declare seedContext: z.infer<typeof JobOutputPayloadSchema>["seedContext"];
  declare systemPrompt: z.infer<typeof JobOutputPayloadSchema>["systemPrompt"];
  declare error: z.infer<typeof JobOutputPayloadSchema>["error"];
  declare errorType: z.infer<typeof JobOutputPayloadSchema>["errorType"];
  declare errorStage: z.infer<typeof JobOutputPayloadSchema>["errorStage"];
  declare errorCode: z.infer<typeof JobOutputPayloadSchema>["errorCode"];
  declare errorDetails: z.infer<typeof JobOutputPayloadSchema>["errorDetails"];
  declare errorTurn: z.infer<typeof JobOutputPayloadSchema>["errorTurn"];
  declare truncatedTurns: z.infer<
    typeof JobOutputPayloadSchema
  >["truncatedTurns"];
  declare backtrackedTurns: z.infer<
    typeof JobOutputPayloadSchema
  >["backtrackedTurns"];
  declare refusalJudgeFailures: z.infer<
    typeof JobOutputPayloadSchema
  >["refusalJudgeFailures"];
  declare finishReason: z.infer<typeof JobOutputPayloadSchema>["finishReason"];
  declare threadId: z.infer<typeof JobOutputPayloadSchema>["threadId"];
  declare responseTraces: z.infer<
    typeof JobOutputPayloadSchema
  >["responseTraces"];
  [key: string]: unknown;
  constructor(value: unknown = {}) {
    Object.assign(this, JobOutputPayloadSchema.parse(value));
  }
  get responseText(): string {
    if (this.finalResponse && pythonStrip(this.finalResponse))
      return this.finalResponse;
    return this.response ?? this.output ?? "";
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}

export const ExecutionDetailsSchema = savedKeys(
  z.object({
    turns: z.number().int().default(1),
    maxTurns: nullableInt,
    durationSeconds: nullableNumber,
    objectiveAchieved: nullableBool,
    objectiveRationale: nullableString,
    tokenUsage: usage,
    tokenUsageBootstrap: usage,
    seedContext: messages,
    backtrackedTurns: turns,
    refusalJudgeFailures: z.number().int().default(0),
  }),
);
export type ExecutionDetails = z.infer<typeof ExecutionDetailsSchema>;
export const AgentInfoSchema = savedKeys(
  z.object({
    key: nullableString,
    model: nullableString,
    displayName: nullableString,
  }),
);
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export const RedTeamResultSchema = savedKeys(
  z.object({
    attack: AttackInfoSchema,
    agent: AgentInfoSchema,
    messages: z.array(CanonicalMessageSchema),
    response: nullableString,
    evaluation: UnifiedEvaluationResultSchema.nullable().default(null),
    vulnerable: nullableBool,
    execution: ExecutionDetailsSchema.nullable().default(null),
    tokenUsageBootstrap: usage,
    seedContext: messages,
    evaluationError: runError.nullable().default(null),
    error: nullableString,
    errorType: nullableString,
    errorStage: nullableString,
    errorCode: nullableString,
    errorDetails: metadata,
    threadId: nullableString,
    responseTraces,
  }),
);

export class RedTeamResult {
  declare attack: z.infer<typeof RedTeamResultSchema>["attack"];
  declare agent: z.infer<typeof RedTeamResultSchema>["agent"];
  declare messages: z.infer<typeof RedTeamResultSchema>["messages"];
  declare response: z.infer<typeof RedTeamResultSchema>["response"];
  declare evaluation: z.infer<typeof RedTeamResultSchema>["evaluation"];
  declare vulnerable: z.infer<typeof RedTeamResultSchema>["vulnerable"];
  declare execution: z.infer<typeof RedTeamResultSchema>["execution"];
  declare tokenUsageBootstrap: z.infer<
    typeof RedTeamResultSchema
  >["tokenUsageBootstrap"];
  declare seedContext: z.infer<typeof RedTeamResultSchema>["seedContext"];
  declare evaluationError: z.infer<
    typeof RedTeamResultSchema
  >["evaluationError"];
  declare error: z.infer<typeof RedTeamResultSchema>["error"];
  declare errorType: z.infer<typeof RedTeamResultSchema>["errorType"];
  declare errorStage: z.infer<typeof RedTeamResultSchema>["errorStage"];
  declare errorCode: z.infer<typeof RedTeamResultSchema>["errorCode"];
  declare errorDetails: z.infer<typeof RedTeamResultSchema>["errorDetails"];
  declare threadId: z.infer<typeof RedTeamResultSchema>["threadId"];
  declare responseTraces: z.infer<typeof RedTeamResultSchema>["responseTraces"];
  constructor(value: unknown) {
    Object.assign(this, RedTeamResultSchema.parse(value));
  }
  get lastTraceId(): string | null {
    for (const trace of [...this.responseTraces].reverse())
      if (trace.traceId) return trace.traceId;
    return null;
  }
  get errorInfo() {
    return this.error === null
      ? null
      : RunErrorSchema.parse({
          message: this.error,
          errorType: this.errorType || "unknown",
          stage: this.errorStage,
          code: this.errorCode,
          details: this.errorDetails,
        });
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}

export const VulnerabilitySummarySchema = savedKeys(
  z.object({
    vulnerability: z.string(),
    vulnerabilityName: z.string(),
    domain: z.string(),
    totalAttacks: z.number().int(),
    evaluatedAttacks: z.number().int().default(0),
    vulnerabilitiesFound: z.number().int(),
    resistanceRate: nullableRate,
    strategiesUsed: z.array(z.string()).default(() => []),
    frameworkCategories: z
      .record(z.string(), z.array(z.string()))
      .default(() => ({})),
  }),
);
export type VulnerabilitySummary = z.infer<typeof VulnerabilitySummarySchema>;
export const CategorySummarySchema = savedKeys(
  z.object({
    category: z.string(),
    categoryName: z.string(),
    totalAttacks: z.number().int(),
    evaluatedAttacks: z.number().int().default(0),
    unevaluatedAttacks: z.number().int().default(0),
    evaluationCoverage: unitRate.default(0),
    totalConversations: z.number().int().default(0),
    totalTurns: z.number().int().default(0),
    vulnerabilitiesFound: z.number().int(),
    vulnerabilityRate: nullableRate,
    resistanceRate: nullableRate,
    totalErrors: z.number().int().default(0),
    strategiesUsed: z.array(z.string()).default(() => []),
  }),
);
export type CategorySummary = z.infer<typeof CategorySummarySchema>;
const dimensionFields = {
  totalAttacks: z.number().int().default(0),
  vulnerabilitiesFound: z.number().int().default(0),
  resistanceRate: nullableRate,
  vulnerabilityRate: nullableRate,
};
export const DimensionSummarySchema = savedKeys(z.object(dimensionFields));
export type DimensionSummary = z.infer<typeof DimensionSummarySchema>;
export const TechniqueSummarySchema = DimensionSummarySchema;
export type TechniqueSummary = DimensionSummary;
export const SeveritySummarySchema = DimensionSummarySchema;
export type SeveritySummary = DimensionSummary;
export const DeliveryMethodSummarySchema = DimensionSummarySchema;
export type DeliveryMethodSummary = DimensionSummary;
export const DomainSummarySchema = DimensionSummarySchema;
export type DomainSummary = DimensionSummary;
export const FrameworkSummarySchema = DimensionSummarySchema;
export type FrameworkSummary = DimensionSummary;
export const TurnTypeSummarySchema = savedKeys(
  z.object({ ...dimensionFields, averageTurns: z.number().default(0) }),
);
export type TurnTypeSummary = z.infer<typeof TurnTypeSummarySchema>;
export const JuryReliabilitySchema = savedKeys(
  z.object({
    krippendorffAlpha: nullableNumber,
    samples: z.number().int().nonnegative().default(0),
    method: ReliabilityMethodSchema.default(
      ReliabilityMethod.KRIPPENDORFF_ALPHA_NOMINAL,
    ),
  }),
).readonly();
export type JuryReliability = z.infer<typeof JuryReliabilitySchema>;

const sampleIssues = [
  ["samplesWithJudgeFailure", "judge-fail"],
  ["ties", "tie"],
  ["inconclusive", "inconclusive"],
  ["samplesWithRepetitionFailure", "rep-fail"],
  ["samplesWithAbstention", "abstained"],
] as const;

export { codepointCompare } from "../../common/sanitize.js";

const issueNumber = z.number().int().nonnegative().default(0);
export const JuryHealthSchema = savedKeys(
  z.object({
    samples: z.number().int().nonnegative(),
    samplesWithJudgeFailure: issueNumber,
    replacementsUsed: issueNumber,
    ties: issueNumber,
    inconclusive: issueNumber,
    samplesWithRepetitionFailure: issueNumber,
    samplesWithAbstention: issueNumber,
    judgeFailureReasons: z
      .array(z.string())
      .default(() => [])
      .transform((reasons) =>
        [
          ...new Set(
            reasons
              .map((reason) => pythonStrip(scrubKnownSecrets(reason)))
              .filter(Boolean),
          ),
        ].sort(codepointCompare),
      ),
  }),
)
  .superRefine((value, ctx) => {
    for (const [field] of sampleIssues)
      if (value[field] > value.samples)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} cannot exceed samples`,
        });
    if (
      value.samples === 0 &&
      (value.replacementsUsed || value.judgeFailureReasons.length)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Replacement judges and failure reasons require multi-judge samples",
      });
  })
  .readonly();

export class JuryHealth {
  declare readonly samples: z.infer<typeof JuryHealthSchema>["samples"];
  declare readonly samplesWithJudgeFailure: z.infer<
    typeof JuryHealthSchema
  >["samplesWithJudgeFailure"];
  declare readonly replacementsUsed: z.infer<
    typeof JuryHealthSchema
  >["replacementsUsed"];
  declare readonly ties: z.infer<typeof JuryHealthSchema>["ties"];
  declare readonly inconclusive: z.infer<
    typeof JuryHealthSchema
  >["inconclusive"];
  declare readonly samplesWithRepetitionFailure: z.infer<
    typeof JuryHealthSchema
  >["samplesWithRepetitionFailure"];
  declare readonly samplesWithAbstention: z.infer<
    typeof JuryHealthSchema
  >["samplesWithAbstention"];
  declare readonly judgeFailureReasons: z.infer<
    typeof JuryHealthSchema
  >["judgeFailureReasons"];
  constructor(value: unknown) {
    Object.assign(this, JuryHealthSchema.parse(value));
    Object.freeze(this);
  }
  issueCount(): number {
    return (
      sampleIssues.filter(([field]) => this[field]).length +
      Number(this.replacementsUsed > 0) +
      Number(
        this.judgeFailureReasons.length > 0 && !this.samplesWithJudgeFailure,
      )
    );
  }
  issueSummary(): string {
    const parts = sampleIssues
      .filter(([field]) => this[field])
      .map(([field, label]) => `${this[field]} ${label}`);
    if (this.replacementsUsed)
      parts.push(`${this.replacementsUsed} replacement judge(s)`);
    if (this.judgeFailureReasons.length) {
      const reasons = this.judgeFailureReasons
        .slice(0, 3)
        .map((reason) =>
          Array.from(reason).length <= 80
            ? reason
            : `${Array.from(reason).slice(0, 79).join("")}…`,
        );
      if (this.judgeFailureReasons.length > 3)
        reasons.push(`+${this.judgeFailureReasons.length - 3} more`);
      parts.push(`judge failures: ${reasons.join("; ")}`);
    }
    return parts.join(", ") || "clean";
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}

export const ReportSummarySchema = savedKeys(
  z.object({
    totalAttacks: z.number().int().default(0),
    evaluatedAttacks: z.number().int().default(0),
    unevaluatedAttacks: z.number().int().default(0),
    evaluationCoverage: unitRate.default(0),
    totalConversations: z.number().int().default(0),
    totalTurns: z.number().int().default(0),
    averageTurnsPerAttack: z.number().default(0),
    vulnerabilitiesFound: z.number().int().default(0),
    vulnerabilityRate: nullableRate,
    resistanceRate: nullableRate,
    totalErrors: z.number().int().default(0),
    preExecutionErrors: z.number().int().default(0),
    errorsByType: z.record(z.string(), z.number().int()).default(() => ({})),
    tokenUsageTotal: usage,
    tokenUsageBySource: z.record(z.string(), savedUsage).default(() => ({})),
    postProcessingTokenUsage: usage,
    byVulnerability: z
      .record(z.string(), VulnerabilitySummarySchema)
      .default(() => ({})),
    byCategory: z.record(z.string(), CategorySummarySchema).default(() => ({})),
    byTechnique: z
      .record(z.string(), TechniqueSummarySchema)
      .default(() => ({})),
    bySeverity: z.record(z.string(), SeveritySummarySchema).default(() => ({})),
    byDeliveryMethod: z
      .record(z.string(), DeliveryMethodSummarySchema)
      .default(() => ({})),
    byTurnType: z.record(z.string(), TurnTypeSummarySchema).default(() => ({})),
    byDomain: z.record(z.string(), DomainSummarySchema).default(() => ({})),
    byFramework: z
      .record(z.string(), FrameworkSummarySchema)
      .default(() => ({})),
    juryReliability: JuryReliabilitySchema.nullable().default(null),
    juryHealth: JuryHealthSchema.transform((value) => new JuryHealth(value))
      .nullable()
      .default(null),
    datapointBreakdown: z
      .record(z.string(), z.number().int())
      .nullable()
      .default(null),
    minEvaluationCoverage: nullableRate,
  }),
);

export class ReportSummary {
  declare totalAttacks: z.infer<typeof ReportSummarySchema>["totalAttacks"];
  declare evaluatedAttacks: z.infer<
    typeof ReportSummarySchema
  >["evaluatedAttacks"];
  declare unevaluatedAttacks: z.infer<
    typeof ReportSummarySchema
  >["unevaluatedAttacks"];
  declare evaluationCoverage: z.infer<
    typeof ReportSummarySchema
  >["evaluationCoverage"];
  declare totalConversations: z.infer<
    typeof ReportSummarySchema
  >["totalConversations"];
  declare totalTurns: z.infer<typeof ReportSummarySchema>["totalTurns"];
  declare averageTurnsPerAttack: z.infer<
    typeof ReportSummarySchema
  >["averageTurnsPerAttack"];
  declare vulnerabilitiesFound: z.infer<
    typeof ReportSummarySchema
  >["vulnerabilitiesFound"];
  declare vulnerabilityRate: z.infer<
    typeof ReportSummarySchema
  >["vulnerabilityRate"];
  declare resistanceRate: z.infer<typeof ReportSummarySchema>["resistanceRate"];
  declare totalErrors: z.infer<typeof ReportSummarySchema>["totalErrors"];
  declare preExecutionErrors: z.infer<
    typeof ReportSummarySchema
  >["preExecutionErrors"];
  declare errorsByType: z.infer<typeof ReportSummarySchema>["errorsByType"];
  declare tokenUsageTotal: z.infer<
    typeof ReportSummarySchema
  >["tokenUsageTotal"];
  declare tokenUsageBySource: z.infer<
    typeof ReportSummarySchema
  >["tokenUsageBySource"];
  declare postProcessingTokenUsage: z.infer<
    typeof ReportSummarySchema
  >["postProcessingTokenUsage"];
  declare byVulnerability: z.infer<
    typeof ReportSummarySchema
  >["byVulnerability"];
  declare byCategory: z.infer<typeof ReportSummarySchema>["byCategory"];
  declare byTechnique: z.infer<typeof ReportSummarySchema>["byTechnique"];
  declare bySeverity: z.infer<typeof ReportSummarySchema>["bySeverity"];
  declare byDeliveryMethod: z.infer<
    typeof ReportSummarySchema
  >["byDeliveryMethod"];
  declare byTurnType: z.infer<typeof ReportSummarySchema>["byTurnType"];
  declare byDomain: z.infer<typeof ReportSummarySchema>["byDomain"];
  declare byFramework: z.infer<typeof ReportSummarySchema>["byFramework"];
  declare juryReliability: z.infer<
    typeof ReportSummarySchema
  >["juryReliability"];
  declare juryHealth: z.infer<typeof ReportSummarySchema>["juryHealth"];
  declare datapointBreakdown: z.infer<
    typeof ReportSummarySchema
  >["datapointBreakdown"];
  declare minEvaluationCoverage: z.infer<
    typeof ReportSummarySchema
  >["minEvaluationCoverage"];
  constructor(value: unknown = {}) {
    Object.assign(this, ReportSummarySchema.parse(value));
  }
  get noVerdict(): boolean {
    return this.totalAttacks > 0 && this.evaluatedAttacks === 0;
  }
  get coverageBelowMinimum(): boolean {
    return (
      this.minEvaluationCoverage !== null &&
      this.totalAttacks !== 0 &&
      this.evaluationCoverage < this.minEvaluationCoverage
    );
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}
export const FocusAreaRecommendationSchema = savedKeys(
  z.object({
    category: z.string(),
    categoryName: z.string(),
    riskScore: z.number(),
    tracesAnalyzed: z.number().int(),
    recommendations: z.array(z.string()),
    patternsObserved: z.string(),
  }),
);
export type FocusAreaRecommendation = z.infer<
  typeof FocusAreaRecommendationSchema
>;
const savedContext = savedAdapter((value) => AgentContextSchema.parse(value));
export const RedTeamReportSchema = savedKeys(
  z.object({
    version: z.string().default("2.0.0"),
    createdAt: z.preprocess(
      (value) => (value instanceof Date ? value.toISOString() : value),
      z.iso.datetime({ offset: true, local: true }),
    ),
    description: nullableString,
    pipeline: z.preprocess(
      (value) => (value === "mixed" ? "hybrid" : value),
      PipelineSchema,
    ),
    framework: framework.nullable().default(null),
    categoriesTested: z.array(z.string()),
    testedAgents: z.array(z.string()).default(() => []),
    totalResults: z.number().int(),
    errors: z.array(runError).default(() => []),
    agentContexts: z.record(z.string(), savedContext).default(() => ({})),
    results: z.array(
      RedTeamResultSchema.transform((value) => new RedTeamResult(value)),
    ),
    summary: ReportSummarySchema.transform((value) => new ReportSummary(value)),
    focusAreaRecommendations: z
      .array(FocusAreaRecommendationSchema)
      .nullable()
      .default(null),
    appliedRecommendations: z.array(z.string()).default(() => []),
    executiveSummary: nullableString,
    tokenUsageSummary: usage,
    durationSeconds: nullableNumber,
    pipelineWarnings: z.array(z.string()).default(() => []),
    orqBaseUrl: nullableString,
    experimentUrl: nullableString,
    runId: nullableString,
    uploadedCount: nullableInt,
    rowsCreated: nullableInt,
  }),
);

export class RedTeamReport {
  declare version: z.infer<typeof RedTeamReportSchema>["version"];
  declare createdAt: z.infer<typeof RedTeamReportSchema>["createdAt"];
  declare description: z.infer<typeof RedTeamReportSchema>["description"];
  declare pipeline: z.infer<typeof RedTeamReportSchema>["pipeline"];
  declare framework: z.infer<typeof RedTeamReportSchema>["framework"];
  declare categoriesTested: z.infer<
    typeof RedTeamReportSchema
  >["categoriesTested"];
  declare testedAgents: z.infer<typeof RedTeamReportSchema>["testedAgents"];
  declare totalResults: z.infer<typeof RedTeamReportSchema>["totalResults"];
  declare errors: z.infer<typeof RedTeamReportSchema>["errors"];
  declare agentContexts: z.infer<typeof RedTeamReportSchema>["agentContexts"];
  declare results: z.infer<typeof RedTeamReportSchema>["results"];
  declare summary: z.infer<typeof RedTeamReportSchema>["summary"];
  declare focusAreaRecommendations: z.infer<
    typeof RedTeamReportSchema
  >["focusAreaRecommendations"];
  declare appliedRecommendations: z.infer<
    typeof RedTeamReportSchema
  >["appliedRecommendations"];
  declare executiveSummary: z.infer<
    typeof RedTeamReportSchema
  >["executiveSummary"];
  declare tokenUsageSummary: z.infer<
    typeof RedTeamReportSchema
  >["tokenUsageSummary"];
  declare durationSeconds: z.infer<
    typeof RedTeamReportSchema
  >["durationSeconds"];
  declare pipelineWarnings: z.infer<
    typeof RedTeamReportSchema
  >["pipelineWarnings"];
  declare orqBaseUrl: z.infer<typeof RedTeamReportSchema>["orqBaseUrl"];
  declare experimentUrl: z.infer<typeof RedTeamReportSchema>["experimentUrl"];
  declare runId: z.infer<typeof RedTeamReportSchema>["runId"];
  declare uploadedCount: z.infer<typeof RedTeamReportSchema>["uploadedCount"];
  declare rowsCreated: z.infer<typeof RedTeamReportSchema>["rowsCreated"];
  constructor(value: unknown) {
    Object.assign(this, RedTeamReportSchema.parse(value));
  }
  manifestSummary(): RunSummary {
    return {
      pipeline: this.pipeline,
      totalResults: this.totalResults,
      totalAttacks: this.summary.totalAttacks,
      vulnerabilityRate: this.summary.vulnerabilityRate,
      resistanceRate: this.summary.resistanceRate,
      testedAgents: [...this.testedAgents],
    };
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}
