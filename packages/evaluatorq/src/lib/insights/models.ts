import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import {
  type ClassifyQuestion,
  ClassifyQuestionSchema,
} from "../common/judge.js";
import { roleModel } from "../common/model-roles.js";
import { pyRound } from "../common/reports/number-format.js";
import {
  pythonCasefold,
  pythonString,
  pythonStrip,
} from "../common/sanitize.js";
import {
  DatasetRefSchema,
  OutcomeSchema,
  TraceTimestampSchema,
} from "../common/trace-document.js";
import { parseUsage, StageRecordSchema } from "../contracts.js";
import { SignalsConfigSchema } from "../signals/config.js";
import {
  SignalReportSchema,
  signalBoolean,
  signalDictionary,
  signalFloat,
  signalInteger,
  signalModel,
  signalRecord,
} from "../signals/models.js";
import type { RunExport } from "../trace-finder/export.js";
import {
  FacetSelection,
  FacetSelectionSchema,
  NumericFilters,
  NumericFiltersSchema,
  timeMicros,
} from "../trace-finder/models.js";
import {
  DEFAULT_TRACE_INPUT_CHARS,
  effectiveDashboardSettings,
  MAX_TRACE_INPUT_CHARS,
  MIN_TRACE_INPUT_CHARS,
} from "../trace-finder/settings.js";

export function defaultInsightsModels(
  summary?: string | null,
  classifier?: string | null,
  embedding?: string | null,
): Record<"summary" | "classifier" | "embedding", string> {
  return {
    summary: summary || roleModel("smart", { task: "insights.summary" }),
    classifier:
      classifier || roleModel("classifier", { task: "insights.labels" }),
    embedding:
      embedding || roleModel("embedding", { task: "insights.embedding" }),
  };
}
export type PopulationSource =
  | "snapshot"
  | "query"
  | "export"
  | "filter"
  | "unknown";
export function populationSource(
  population: Readonly<Record<string, unknown>>,
): PopulationSource {
  const mode = population.mode;
  if (
    mode === "snapshot" ||
    population.snapshotPath ||
    population.snapshot_path
  )
    return "snapshot";
  return mode === "query" || mode === "export" || mode === "filter"
    ? mode
    : "unknown";
}
export const readsSnapshot = (population: Readonly<Record<string, unknown>>) =>
  populationSource(population) === "snapshot";
export const readsOrq = (population: Readonly<Record<string, unknown>>) =>
  ["query", "export", "filter"].includes(populationSource(population));
export function ensureUniqueTraceIds(
  traces: Iterable<{ traceId: string }>,
): void {
  const seen = new Set<string>();
  for (const trace of traces) {
    if (seen.has(trace.traceId))
      throw new Error(
        `trace_id values must be unique for analysis; select one span per trace or use distinct dataset-row trace IDs (duplicate trace_id=${pythonString([trace.traceId]).slice(1, -1)})`,
      );
    seen.add(trace.traceId);
  }
}
const ratio = signalFloat.refine(
  (value) => Number.isFinite(value) && value >= 0 && value <= 1,
);
const criteria = z.union([
  signalRecord(z.string().nullable()),
  z.array(z.string()),
  z.null(),
]);
export const LabelSpecSchema = signalModel({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  kind: z.enum(["noul", "choice", "score"]),
  instructions: z.string(),
  criteria: criteria.default(null),
  noulThreshold: ratio.default(0.5),
});
export type LabelSpecFields = z.infer<typeof LabelSpecSchema>;
export class LabelSpec implements LabelSpecFields {
  declare readonly name: LabelSpecFields["name"];
  declare readonly kind: LabelSpecFields["kind"];
  declare readonly instructions: LabelSpecFields["instructions"];
  declare readonly criteria: LabelSpecFields["criteria"];
  declare readonly noulThreshold: LabelSpecFields["noulThreshold"];
  constructor(value: unknown) {
    Object.assign(this, LabelSpecSchema.parse(value));
    Object.freeze(this);
  }
  toQuestion(
    state: Record<string, unknown> | string | unknown[],
  ): ClassifyQuestion {
    return ClassifyQuestionSchema.parse({
      kind: this.kind,
      instructions: this.instructions,
      criteria: this.criteria,
      state,
      noulThreshold: this.noulThreshold,
    });
  }
}
export function labelKey(spec: LabelSpec, value: unknown): string {
  if (spec.kind === "noul") return value === true ? "yes" : "no";
  if (spec.kind === "score" && typeof value === "number") {
    const levels = Array.isArray(spec.criteria) ? spec.criteria : [],
      index = pyRound(value * Math.max(0, levels.length - 1));
    if (index < levels.length) {
      const actual = index < 0 ? levels.length + index : index;
      if (actual < 0) throw new RangeError("list index out of range");
      return (
        levels[actual]?.match(/^\p{Decimal_Number}+/u)?.[0] ?? String(index)
      );
    }
    return String(index);
  }
  return pythonString(value);
}
export function labelOrder(spec: LabelSpec): string[] {
  if (spec.kind === "noul") return ["yes", "no"];
  if (spec.kind === "score" && Array.isArray(spec.criteria)) {
    const top = Math.max(1, spec.criteria.length - 1);
    return spec.criteria.map((_, index) => labelKey(spec, index / top));
  }
  return spec.criteria && !Array.isArray(spec.criteria)
    ? Object.keys(spec.criteria)
    : [];
}
export const TraceSummarySchema = signalModel({
  summary: z.string(),
  request: z.string().nullable(),
  task: z.string().nullable(),
  topic: z.string().nullable(),
  assistantErrors: z.array(z.string()).default([]),
  sentimentExplanation: z.string().nullable(),
  languages: z.array(z.string()).default([]),
});
export type TraceSummary = z.infer<typeof TraceSummarySchema>;
export function realAssistantErrors(summary: TraceSummary): string[] {
  const sentinels = new Set([
    "none",
    "n/a",
    "no errors",
    "no errors were made",
    "no error",
  ]);
  return summary.assistantErrors.filter(
    (error) =>
      !sentinels.has(pythonCasefold(pythonStrip(error).replace(/\.+$/, ""))),
  );
}

const facetFields = new Set([
  "project",
  "projectId",
  "model",
  "provider",
  "status",
  "product",
  "traceType",
  "agentName",
  "toolName",
]);
const numericFields = new Set([
  "tokensMin",
  "tokensMax",
  "durationMsMin",
  "durationMsMax",
]);
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const populationShape = signalModel({
  query: z.string().nullable().default(null),
  facets: FacetSelectionSchema.transform(
    (value) => new FacetSelection(value),
  ).default(() => new FacetSelection()),
  numeric: NumericFiltersSchema.transform(
    (value) => new NumericFilters(value),
  ).default(() => new NumericFilters()),
  start: TraceTimestampSchema,
  end: TraceTimestampSchema,
  timeOrigin: z.enum(["default", "explicit"]).default("default"),
  windowDays: signalInteger.refine((n) => n >= 1 && n <= 90).default(7),
  filterSelection: z.enum(["llm", "llm+jev"]).nullable().default(null),
  limit: signalInteger.refine((n) => n >= 1 && n <= 5000).default(500),
  finderExport: z.string().nullable().default(null),
  snapshotPath: z.string().nullable().default(null),
});
export const InsightsPopulationSchema = z
  .preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const input = value as Record<string, unknown>;
    if (input.filters == null) return value;
    if (
      !input.filters ||
      typeof input.filters !== "object" ||
      Array.isArray(input.filters)
    )
      throw new Error("filters must be a dictionary");
    if (Object.hasOwn(input, "facets") || Object.hasOwn(input, "numeric"))
      throw new Error(
        "filters cannot be combined with legacy facets or numeric arguments",
      );
    const facets: Record<string, unknown> = {},
      numeric: Record<string, unknown> = {},
      unknown: string[] = [];
    for (const [key, item] of Object.entries(input.filters)) {
      const native = camel(key);
      if (facetFields.has(native)) facets[key] = item;
      else if (numericFields.has(native)) numeric[key] = item;
      else unknown.push(key);
    }
    if (unknown.length)
      throw new Error(`unknown filter keys: ${unknown.sort().join(", ")}`);
    return { ...input, facets, numeric };
  }, populationShape)
  .superRefine((v, ctx) => {
    if (
      v.start !== null &&
      v.end !== null &&
      timeMicros(v.start) > timeMicros(v.end)
    )
      ctx.addIssue({
        code: "custom",
        message: "start must not be later than end",
      });
    if (v.filterSelection !== null && v.query === null)
      ctx.addIssue({
        code: "custom",
        message: "filter_selection requires query",
      });
    if (v.finderExport === null && v.snapshotPath === null) return;
    if (v.finderExport !== null && v.snapshotPath !== null) {
      ctx.addIssue({
        code: "custom",
        message: "finder_export and snapshot_path are mutually exclusive",
      });
      return;
    }
    const used = [
      ["query", v.query !== null],
      ["facets", !isDeepStrictEqual(v.facets, new FacetSelection())],
      ["numeric", !isDeepStrictEqual(v.numeric, new NumericFilters())],
      ["start", v.start !== null],
      ["end", v.end !== null],
      ["time_origin", v.timeOrigin !== "default"],
      ["window_days", v.windowDays !== 7],
      ["filter_selection", v.filterSelection !== null],
      ["limit", v.limit !== 500],
    ] as const;
    const conflicts = used.filter(([, active]) => active).map(([name]) => name);
    if (conflicts.length)
      ctx.addIssue({
        code: "custom",
        message: `file sources cannot be combined with live population settings (${conflicts.join(", ")}): the file already fixes the trace population`,
      });
  });
export type InsightsPopulationFields = z.infer<typeof InsightsPopulationSchema>;
const exportsByPopulation = new WeakMap<InsightsPopulation, RunExport | null>();
export class InsightsPopulation implements InsightsPopulationFields {
  declare readonly query: InsightsPopulationFields["query"];
  declare readonly facets: InsightsPopulationFields["facets"];
  declare readonly numeric: InsightsPopulationFields["numeric"];
  declare readonly start: InsightsPopulationFields["start"];
  declare readonly end: InsightsPopulationFields["end"];
  declare readonly timeOrigin: InsightsPopulationFields["timeOrigin"];
  declare readonly windowDays: InsightsPopulationFields["windowDays"];
  declare readonly filterSelection: InsightsPopulationFields["filterSelection"];
  declare readonly limit: InsightsPopulationFields["limit"];
  declare readonly finderExport: InsightsPopulationFields["finderExport"];
  declare readonly snapshotPath: InsightsPopulationFields["snapshotPath"];
  constructor(value: unknown = {}) {
    Object.assign(this, InsightsPopulationSchema.parse(value));
    Object.freeze(this);
  }
  static fromFinderExport(
    path: string,
    options: { export?: RunExport | null } = {},
  ): InsightsPopulation {
    const population = new InsightsPopulation({ finderExport: path });
    exportsByPopulation.set(population, options.export ?? null);
    return population;
  }
  static fromSnapshot(path: string): InsightsPopulation {
    return new InsightsPopulation({ snapshotPath: path });
  }
  finderExportSnapshot(): RunExport | null {
    return exportsByPopulation.get(this) ?? null;
  }
}

export type DimensionName = "intent" | "failure" | "sentiment";
const dimensionName = z.enum(["intent", "failure", "sentiment"]);
const finite = signalFloat.refine(Number.isFinite);
const labelSpecValue = LabelSpecSchema.transform((value) =>
  Object.freeze(
    Object.assign(Object.create(LabelSpec.prototype) as LabelSpec, value),
  ),
);
export const LabelAnswerSchema = signalModel({
  value: z.union([z.boolean(), ratio, z.string(), z.null()]),
  confidence: ratio.nullable(),
  probabilities: signalRecord(ratio).nullable(),
  error: z.string().nullable(),
});
export type LabelAnswer = z.infer<typeof LabelAnswerSchema>;
export const ClusterAssignmentSchema = signalModel({
  top: z.string(),
  base: z.string(),
});
export type ClusterAssignment = z.infer<typeof ClusterAssignmentSchema>;
export const ToolStatsSchema = signalModel({
  tools: signalRecord(signalInteger).default({}),
  skills: signalRecord(signalInteger).default({}),
  commands: signalRecord(signalInteger).default({}),
});
export type ToolStats = z.infer<typeof ToolStatsSchema>;
const traceTime = z
  .union([
    TraceTimestampSchema.pipe(z.string()),
    z.string().regex(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/),
  ])
  .nullable()
  .default(null);
const TraceInsightFieldsSchema = signalModel({
  traceId: z.string(),
  spanId: z.string().nullable().default(null),
  timestamp: traceTime,
  dataset: DatasetRefSchema.nullable().default(null),
  outcome: OutcomeSchema.nullable().default(null),
  agentName: z.string().default(""),
  project: z.string().default(""),
  labels: signalRecord(LabelAnswerSchema).default(() => ({})),
  summary: TraceSummarySchema.nullable().default(null),
  toolStats: ToolStatsSchema.nullable().default(null),
  signals: SignalReportSchema.nullable().default(null),
  sourceCoverage: signalDictionary.default(() => ({})),
  assignments: signalRecord(ClusterAssignmentSchema).default(() => ({})),
  coords: signalRecord(z.tuple([finite, finite, finite])).default(() => ({})),
  coords2d: signalRecord(z.tuple([finite, finite]))
    .nullable()
    .default(null),
  errors: signalRecord(z.string()).default(() => ({})),
});
export const TraceInsightSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (!Object.hasOwn(input, "coords_2d")) return value;
  if (
    Object.hasOwn(input, "coords2d") &&
    !isDeepStrictEqual(input.coords2d, input.coords_2d)
  )
    throw new Error("Conflicting coords2d and coords_2d");
  const { coords_2d, ...rest } = input;
  return { ...rest, coords2d: coords_2d };
}, TraceInsightFieldsSchema);
export type TraceInsight = z.infer<typeof TraceInsightSchema>;
export const ClusterSchema = signalModel({
  id: z.string(),
  parentId: z.string().nullable(),
  level: z.enum(["top", "base"]),
  name: z.string(),
  description: z.string(),
  size: signalInteger,
  traceIds: z.array(z.string()),
  exampleTraceIds: z.array(z.string()),
  group: z.string().nullable().default(null),
});
export type Cluster = z.infer<typeof ClusterSchema>;
export const DimensionResultSchema = signalModel({
  name: dimensionName,
  sourceField: z.string(),
  clusters: z.array(ClusterSchema),
  nNoise: signalInteger.default(0),
  nNoSignal: signalInteger.default(0),
  nFailed: signalInteger.default(0),
  warnings: z.array(z.string()).default([]),
});
export type DimensionResult = z.infer<typeof DimensionResultSchema>;
export const LabelResultSchema = signalModel({
  spec: labelSpecValue,
  counts: signalRecord(signalInteger),
  meanConfidence: ratio.nullable(),
  nLowConfidence: signalInteger,
  nFailed: signalInteger,
  nNotAsked: signalInteger.default(0),
});
export type LabelResultFields = z.infer<typeof LabelResultSchema>;
export class LabelResult implements LabelResultFields {
  declare readonly spec: LabelResultFields["spec"];
  declare readonly counts: LabelResultFields["counts"];
  declare readonly meanConfidence: LabelResultFields["meanConfidence"];
  declare readonly nLowConfidence: LabelResultFields["nLowConfidence"];
  declare readonly nFailed: LabelResultFields["nFailed"];
  declare readonly nNotAsked: LabelResultFields["nNotAsked"];
  constructor(value: unknown) {
    Object.assign(this, LabelResultSchema.parse(value));
  }
  get countsWarning(): string | null {
    if (this.spec.name !== "failure_taxonomy" || this.spec.kind !== "choice")
      return null;
    if (
      this.spec.criteria &&
      !Array.isArray(this.spec.criteria) &&
      Object.hasOwn(this.spec.criteria, "No failure")
    )
      return null;
    return 'This failure taxonomy did not offer "No failure". Its counts may include clean traces. Saved answers are unchanged.';
  }
}
export const PriorityPointSchema = signalModel({
  clusterId: z.string(),
  name: z.string(),
  volume: signalInteger,
  meanSatisfaction: ratio,
  errorShare: ratio,
});
export type PriorityPoint = z.infer<typeof PriorityPointSchema>;
export const StageFailureSchema = signalModel({
  stage: z.string(),
  message: z.string(),
  dimension: z.string().nullable().default(null),
});
export type StageFailure = z.infer<typeof StageFailureSchema>;
export const InsightsConfigSchema = signalModel({
  labels: z.array(labelSpecValue),
  dimensions: z.array(dimensionName),
  summaryModel: z.string().default(() => defaultInsightsModels().summary),
  classifierModel: z.string().default(() => defaultInsightsModels().classifier),
  compilerModel: z.string().nullable().default(null),
  embeddingModel: z.string().default(() => defaultInsightsModels().embedding),
  maxClusters: signalInteger.refine((n) => n >= 1).default(15),
  maxSubclusters: signalInteger.refine((n) => n >= 1).default(15),
  outlierZscore: finite
    .refine((n) => n >= 0)
    .nullable()
    .default(null),
  parallelism: signalInteger.refine((n) => n >= 1).default(100),
  traceInputChars: signalInteger
    .refine((n) => n >= MIN_TRACE_INPUT_CHARS && n <= MAX_TRACE_INPUT_CHARS)
    .default(DEFAULT_TRACE_INPUT_CHARS),
  priorityDimension: dimensionName.default("intent"),
  cache: signalBoolean.default(true),
  codingAnalysis: signalBoolean.default(false),
  codingLabels: z.array(labelSpecValue).default([]),
  signals: SignalsConfigSchema.nullable().default(null),
}).superRefine((config, ctx) => {
  const labels = config.labels.map((x) => x.name),
    coding = config.codingLabels.map((x) => x.name);
  for (const [ok, message] of [
    [new Set(labels).size === labels.length, "labels must have unique names"],
    [
      new Set(coding).size === coding.length,
      "coding_labels must have unique names",
    ],
    [
      !coding.some((name) => labels.includes(name)),
      "labels and coding_labels must have unique names",
    ],
    [
      new Set(config.dimensions).size === config.dimensions.length,
      "dimensions must not contain duplicates",
    ],
  ] as const)
    if (!ok) ctx.addIssue({ code: "custom", message });
});
export type InsightsConfigFields = z.infer<typeof InsightsConfigSchema>;
export class InsightsConfig implements InsightsConfigFields {
  declare readonly labels: InsightsConfigFields["labels"];
  declare readonly dimensions: InsightsConfigFields["dimensions"];
  declare readonly summaryModel: InsightsConfigFields["summaryModel"];
  declare readonly classifierModel: InsightsConfigFields["classifierModel"];
  declare readonly compilerModel: InsightsConfigFields["compilerModel"];
  declare readonly embeddingModel: InsightsConfigFields["embeddingModel"];
  declare readonly maxClusters: InsightsConfigFields["maxClusters"];
  declare readonly maxSubclusters: InsightsConfigFields["maxSubclusters"];
  declare readonly outlierZscore: InsightsConfigFields["outlierZscore"];
  declare readonly parallelism: InsightsConfigFields["parallelism"];
  declare readonly traceInputChars: InsightsConfigFields["traceInputChars"];
  declare readonly priorityDimension: InsightsConfigFields["priorityDimension"];
  declare readonly cache: InsightsConfigFields["cache"];
  declare readonly codingAnalysis: InsightsConfigFields["codingAnalysis"];
  declare readonly codingLabels: InsightsConfigFields["codingLabels"];
  declare readonly signals: InsightsConfigFields["signals"];
  constructor(value: unknown) {
    Object.assign(this, InsightsConfigSchema.parse(value));
    Object.freeze(this);
  }
  static async create(value: Record<string, unknown>): Promise<InsightsConfig> {
    const cap =
      Object.hasOwn(value, "traceInputChars") ||
      Object.hasOwn(value, "trace_input_chars")
        ? {}
        : {
            traceInputChars: (await effectiveDashboardSettings())
              .traceInputChars,
          };
    return new InsightsConfig({ ...cap, ...value });
  }
}

function legacyKeys(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    const old = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (old !== key && Object.hasOwn(out, old)) {
      if (Object.hasOwn(out, key) && !isDeepStrictEqual(out[key], out[old]))
        throw new Error(`Conflicting ${key} and ${old}`);
      out[key] = out[old];
      delete out[old];
    }
  }
  return out;
}
const SavedUsageSchema = z.unknown().transform((value, ctx) => {
  try {
    return parseUsage(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});
const SavedStageRecordSchema = z.unknown().transform((value, ctx) => {
  const result = StageRecordSchema.safeParse(
    legacyKeys(value, ["startedAt", "endedAt"]),
  );
  if (!result.success) {
    ctx.addIssue({ code: "custom", message: result.error.message });
    return z.NEVER;
  }
  return result.data;
});
export const InsightsStageHistorySchema = signalModel({
  plannedStages: z.array(z.string()).default([]),
  stageLabels: signalRecord(z.string()).default({}),
  stages: z.array(SavedStageRecordSchema).default([]),
});
export type InsightsStageHistory = z.infer<typeof InsightsStageHistorySchema>;
const codingKinds: Readonly<Record<string, "noul" | "choice" | "score">> = {
  coding_agent: "noul",
  task_type: "choice",
  outcome: "choice",
  verified: "choice",
  scope_creep: "noul",
  user_corrections: "score",
  unfixed_error: "noul",
  risky_action: "choice",
};
export const InsightsRunSchema = signalModel({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(2),
  evaluatorqVersion: z.string().nullable().default(null),
  runId: z.string(),
  runName: z.string(),
  createdAt: TraceTimestampSchema.pipe(z.string()),
  status: z.enum(["completed", "error"]),
  stageFailures: z.array(StageFailureSchema),
  population: signalDictionary,
  config: InsightsConfigSchema.transform((value) =>
    Object.freeze(
      Object.assign(
        Object.create(InsightsConfig.prototype) as InsightsConfig,
        value,
      ),
    ),
  ),
  traces: z.array(TraceInsightSchema),
  dimensions: signalRecord(DimensionResultSchema),
  labels: signalRecord(
    LabelResultSchema.transform((value) =>
      Object.assign(Object.create(LabelResult.prototype) as LabelResult, value),
    ),
  ),
  priority: z.array(PriorityPointSchema).nullable(),
  priorityReason: z.string().nullable(),
  counts: signalRecord(signalInteger),
  warnings: z.array(z.string()),
  costByStage: signalRecord(SavedUsageSchema.nullable()).default({}),
  stageHistory: InsightsStageHistorySchema.nullable().default(null),
}).superRefine((run, ctx) => {
  if (run.schemaVersion !== 1) {
    const identities = new Set<string>();
    for (const trace of run.traces) {
      const key = JSON.stringify([trace.traceId, trace.spanId || null]);
      if (identities.has(key))
        ctx.addIssue({
          code: "custom",
          message: `traces must have unique (trace_id, span_id) pairs; duplicate trace_id=${pythonString([trace.traceId]).slice(1, -1)}, span_id=${pythonString([trace.spanId]).slice(1, -1)}`,
        });
      identities.add(key);
    }
  }
  const kinds = new Map(
    run.config.labels.map((spec) => [spec.name, spec.kind]),
  );
  if (run.config.codingAnalysis)
    for (const [name, kind] of Object.entries(codingKinds))
      kinds.set(name, kind);
  else if (run.config.codingLabels.length) {
    kinds.set("coding_agent", "noul");
    for (const spec of run.config.codingLabels) kinds.set(spec.name, spec.kind);
  }
  for (const trace of run.traces)
    for (const [name, answer] of Object.entries(trace.labels)) {
      const kind = kinds.get(name);
      if (kind === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `trace ${pythonString([trace.traceId]).slice(1, -1)} has unconfigured label ${pythonString([name]).slice(1, -1)}`,
        });
        continue;
      }
      if (
        answer.value !== null &&
        !(
          (kind === "noul" && typeof answer.value === "boolean") ||
          (kind === "choice" && typeof answer.value === "string") ||
          (kind === "score" && typeof answer.value === "number")
        )
      )
        ctx.addIssue({
          code: "custom",
          message: `trace ${pythonString([trace.traceId]).slice(1, -1)} label ${pythonString([name]).slice(1, -1)} has a value incompatible with ${pythonString([kind]).slice(1, -1)}`,
        });
    }
});
export type InsightsRunFields = z.infer<typeof InsightsRunSchema>;
