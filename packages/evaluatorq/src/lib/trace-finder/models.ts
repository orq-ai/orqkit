import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import {
  type ClassifyQuestion,
  ClassifyQuestionSchema,
  type ClassifyResponse,
} from "../common/judge.js";
import { pyG } from "../common/reports/number-format.js";
import {
  TraceDocument,
  TraceTimestampSchema,
} from "../common/trace-document.js";
import { parseIso } from "../formats/time.js";
import {
  signalBoolean,
  signalDictionary,
  signalFloat,
  signalInteger,
  signalModel,
  signalRecord,
} from "../signals/models.js";
import { MAX_TRACE_INPUT_CHARS } from "./settings.js";
export const FACET_NAMES = Object.freeze([
  "project",
  "model",
  "provider",
  "status",
  "product",
  "trace_type",
  "agent_name",
  "tool_name",
] as const);
export type FacetName = (typeof FACET_NAMES)[number];
export const NUMERIC_FACET_NAMES = Object.freeze([
  "tokens",
  "duration_ms",
] as const);
export type NumericFacetName = (typeof NUMERIC_FACET_NAMES)[number];
export const MAX_INPUT_CHAR_BUDGET = MAX_TRACE_INPUT_CHARS,
  MAX_DIMENSIONS = 3;
const nonnegative = signalInteger.refine((value) => value >= 0),
  optionalInt = nonnegative.nullable().default(null),
  optionalString = z.string().nullable().default(null),
  strings = z.array(z.string()).readonly().default([]);
function openModel<S extends z.ZodRawShape>(shape: S) {
  return z.preprocess((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const input = { ...value } as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      const legacy = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      if (key !== legacy && Object.hasOwn(input, legacy)) {
        if (
          Object.hasOwn(input, key) &&
          !isDeepStrictEqual(input[key], input[legacy])
        )
          throw new TypeError(`Conflicting ${key} and ${legacy}`);
        input[key] = input[legacy];
        delete input[legacy];
      }
    }
    return input;
  }, z.looseObject(shape).readonly());
}
const awareTime = TraceTimestampSchema.pipe(z.string());
export const TraceRecordSchema = openModel({
  schemaVersion: z.preprocess(
    (value) => (value === true ? 1 : value),
    z.literal(1),
  ),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  timestamp: awareTime,
  messages: z.array(signalDictionary).min(1).readonly(),
  project: z.string(),
  model: z.string(),
  provider: z.string(),
  status: z.string(),
  product: z.string(),
  traceType: z.string(),
  agentName: z.string().default(""),
  toolNames: strings,
  toolDefinitionCount: nonnegative.default(0),
  toolDefinitionTokens: nonnegative.default(0),
  totalTokens: optionalInt,
  durationMs: optionalInt,
  captureMetadata: signalDictionary.default({}),
});
export type TraceRecordFields = z.infer<typeof TraceRecordSchema>;
export class TraceRecord implements TraceRecordFields {
  declare readonly schemaVersion: TraceRecordFields["schemaVersion"];
  declare readonly traceId: TraceRecordFields["traceId"];
  declare readonly spanId: TraceRecordFields["spanId"];
  declare readonly timestamp: TraceRecordFields["timestamp"];
  declare readonly messages: TraceRecordFields["messages"];
  declare readonly project: TraceRecordFields["project"];
  declare readonly model: TraceRecordFields["model"];
  declare readonly provider: TraceRecordFields["provider"];
  declare readonly status: TraceRecordFields["status"];
  declare readonly product: TraceRecordFields["product"];
  declare readonly traceType: TraceRecordFields["traceType"];
  declare readonly agentName: TraceRecordFields["agentName"];
  declare readonly toolNames: TraceRecordFields["toolNames"];
  declare readonly toolDefinitionCount: TraceRecordFields["toolDefinitionCount"];
  declare readonly toolDefinitionTokens: TraceRecordFields["toolDefinitionTokens"];
  declare readonly totalTokens: TraceRecordFields["totalTokens"];
  declare readonly durationMs: TraceRecordFields["durationMs"];
  declare readonly captureMetadata: TraceRecordFields["captureMetadata"];
  constructor(input: unknown = {}) {
    Object.assign(this, TraceRecordSchema.parse(input));
    Object.freeze(this);
  }
  readonly [key: string]: unknown;
}
export const TraceProjectionSchema = signalModel({
  payload: signalDictionary,
  serialized: z.string(),
  estimatedTokens: nonnegative.refine(
    (value) => value <= MAX_INPUT_CHAR_BUDGET,
  ),
  omittedMessages: nonnegative,
  omittedBytes: nonnegative,
});
export type TraceProjection = z.infer<typeof TraceProjectionSchema>;
export const DimensionAnswerSchema = signalModel({
  value: z
    .union([
      z.boolean(),
      z.custom<number>((value) => typeof value === "number"),
      z.string(),
    ])
    .nullable()
    .default(null),
  confidence: signalFloat
    .refine((value) => value >= 0 && value <= 1)
    .nullable()
    .default(null),
  probabilities: signalRecord(signalFloat).nullable().default(null),
  matched: signalBoolean.default(false),
  error: optionalString,
  summary: optionalString,
});
export type DimensionAnswer = z.infer<typeof DimensionAnswerSchema>;
export const TraceClassificationSchema = signalModel({
  traceId: z.string(),
  spanId: z.string(),
  answers: z.array(DimensionAnswerSchema).readonly().default([]),
  matched: signalBoolean.default(false),
  error: optionalString,
  rawResult: signalDictionary.default({}),
});
export type TraceClassification = z.infer<typeof TraceClassificationSchema>;
const recordModel = TraceRecordSchema.transform(
    (value) => new TraceRecord(value),
  ),
  documentModel = z
    .unknown()
    .transform((value) =>
      value instanceof TraceDocument ? value : new TraceDocument(value),
    );
export const SnapshotSchema = signalModel({
  traces: z.array(recordModel).readonly(),
  documents: z.array(documentModel).readonly().default([]),
  captureMetadata: signalDictionary.default({}),
});
export type SnapshotFields = z.infer<typeof SnapshotSchema>;
export class Snapshot implements SnapshotFields {
  declare readonly traces: SnapshotFields["traces"];
  declare readonly documents: SnapshotFields["documents"];
  declare readonly captureMetadata: SnapshotFields["captureMetadata"];
  constructor(input: unknown = {}) {
    Object.assign(this, SnapshotSchema.parse(input));
    Object.freeze(this);
  }
  get isEmpty(): boolean {
    return !this.traces.length && !this.documents.length;
  }
}
class FrozenSet<T> extends Set<T> {
  constructor(values: Iterable<T>) {
    super();
    for (const value of values) super.add(value);
    Object.freeze(this);
  }
  override add(_value: T): this {
    throw new TypeError("Cannot modify a frozen selection");
  }
  override delete(_value: T): boolean {
    throw new TypeError("Cannot modify a frozen selection");
  }
  override clear(): void {
    throw new TypeError("Cannot modify a frozen selection");
  }
  toJSON(): T[] {
    return [...this];
  }
}
function frozenSet<T>(item: z.ZodType<T>) {
  return z
    .preprocess(
      (value) => (Array.isArray(value) ? new Set(value) : value),
      z.set(item),
    )
    .transform((value) => new FrozenSet(value) as ReadonlySet<T>)
    .default(() => new FrozenSet<T>([]));
}
const selectionSet = frozenSet(z.string());
export const FacetSelectionSchema = signalModel({
  project: selectionSet,
  projectId: optionalString,
  model: selectionSet,
  provider: selectionSet,
  status: selectionSet,
  product: selectionSet,
  traceType: selectionSet,
  agentName: selectionSet,
  toolName: selectionSet,
});
export type FacetSelectionFields = z.infer<typeof FacetSelectionSchema>;
export class FacetSelection implements FacetSelectionFields {
  declare readonly project: FacetSelectionFields["project"];
  declare readonly projectId: FacetSelectionFields["projectId"];
  declare readonly model: FacetSelectionFields["model"];
  declare readonly provider: FacetSelectionFields["provider"];
  declare readonly status: FacetSelectionFields["status"];
  declare readonly product: FacetSelectionFields["product"];
  declare readonly traceType: FacetSelectionFields["traceType"];
  declare readonly agentName: FacetSelectionFields["agentName"];
  declare readonly toolName: FacetSelectionFields["toolName"];
  constructor(input: unknown = {}) {
    Object.assign(this, FacetSelectionSchema.parse(input));
    Object.freeze(this);
  }
}
export const FacetCatalogueSchema = signalModel({
  project: strings,
  status: strings,
  product: strings,
  traceType: strings,
  model: strings,
  provider: strings,
  agentName: strings,
  toolName: strings,
  truncatedFacets: frozenSet(z.enum(FACET_NAMES)),
  valueCounts: signalRecord(signalRecord(signalInteger)).default({}),
});
export type FacetCatalogue = z.infer<typeof FacetCatalogueSchema>;
export const NumericFiltersSchema = signalModel({
  tokensMin: optionalInt,
  tokensMax: optionalInt,
  durationMsMin: optionalInt,
  durationMsMax: optionalInt,
}).superRefine((value, ctx) => {
  for (const [minimum, maximum] of [
    ["tokensMin", "tokensMax"],
    ["durationMsMin", "durationMsMax"],
  ] as const)
    if (
      value[minimum] !== null &&
      value[maximum] !== null &&
      value[minimum] > value[maximum]
    )
      ctx.addIssue({
        code: "custom",
        path: [minimum],
        message: `${minimum} must be less than or equal to ${maximum}`,
      });
});
export type NumericFiltersFields = z.infer<typeof NumericFiltersSchema>;
export class NumericFilters implements NumericFiltersFields {
  declare readonly tokensMin: NumericFiltersFields["tokensMin"];
  declare readonly tokensMax: NumericFiltersFields["tokensMax"];
  declare readonly durationMsMin: NumericFiltersFields["durationMsMin"];
  declare readonly durationMsMax: NumericFiltersFields["durationMsMax"];
  constructor(input: unknown = {}) {
    Object.assign(this, NumericFiltersSchema.parse(input));
    Object.freeze(this);
  }
}
export function timeMicros(value: string): bigint {
  const parsed = parseIso(value),
    date = new Date(0);
  date.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  date.setUTCHours(parsed.hour, parsed.minute, parsed.second, 0);
  return (
    BigInt(date.getTime()) * 1000n +
    BigInt(parsed.microsecond) -
    BigInt(Math.round((parsed.offsetSeconds ?? 0) * 1e6))
  );
}
export const PopulationRequestSchema = z
  .preprocess(
    (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return value;
      const input = value as Record<string, unknown>;
      return !Object.hasOwn(input, "time_origin") &&
        !Object.hasOwn(input, "timeOrigin") &&
        (input.start != null || input.end != null)
        ? { ...input, timeOrigin: "explicit" }
        : input;
    },
    signalModel({
      start: TraceTimestampSchema,
      end: TraceTimestampSchema,
      timeOrigin: z
        .enum(["default", "explicit", "within_results"])
        .default("default"),
      endExclusive: signalBoolean.default(false),
      facets: FacetSelectionSchema.transform(
        (value) => new FacetSelection(value),
      ).default(() => new FacetSelection({})),
      numeric: NumericFiltersSchema.transform(
        (value) => new NumericFilters(value),
      ).default(() => new NumericFilters({})),
      limit: signalInteger
        .refine((value) => value >= 1 && value <= 5000)
        .default(500),
    }),
  )
  .superRefine((value, ctx) => {
    if (
      value.start !== null &&
      value.end !== null &&
      timeMicros(value.start) > timeMicros(value.end)
    )
      ctx.addIssue({ code: "custom", message: "start must not be after end" });
  });
export type PopulationRequestFields = z.infer<typeof PopulationRequestSchema>;
export class PopulationRequest implements PopulationRequestFields {
  declare readonly start: PopulationRequestFields["start"];
  declare readonly end: PopulationRequestFields["end"];
  declare readonly timeOrigin: PopulationRequestFields["timeOrigin"];
  declare readonly endExclusive: PopulationRequestFields["endExclusive"];
  declare readonly facets: PopulationRequestFields["facets"];
  declare readonly numeric: PopulationRequestFields["numeric"];
  declare readonly limit: PopulationRequestFields["limit"];
  constructor(input: unknown = {}) {
    Object.assign(this, PopulationRequestSchema.parse(input));
    Object.freeze(this);
  }
  containsTime(timestamp: string | Date): boolean {
    const time = timeMicros(awareTime.parse(timestamp));
    if (this.start !== null && time < timeMicros(this.start)) return false;
    if (this.end === null) return true;
    return this.endExclusive
      ? time < timeMicros(this.end)
      : time <= timeMicros(this.end);
  }
}
export const ValueSelectionSchema = signalModel({
  kind: z.literal("values"),
  values: z
    .array(z.union([z.string(), z.boolean()]))
    .min(1)
    .readonly(),
});
export type ValueSelection = z.infer<typeof ValueSelectionSchema>;
export const ThresholdSelectionSchema = signalModel({
  kind: z.literal("threshold"),
  operator: z.enum(["gte", "lte"]),
  value: signalFloat.refine(
    (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  ),
});
export type ThresholdSelection = z.infer<typeof ThresholdSelectionSchema>;
export const SelectionRuleSchema = z.union([
  ValueSelectionSchema,
  ThresholdSelectionSchema,
]);
export type SelectionRule = z.infer<typeof SelectionRuleSchema>;
function invalid(path: string[], message: string): never {
  throw new z.ZodError([{ code: "custom", path, message, input: undefined }]);
}
export function validateCompiledQuery(
  task: ClassifyQuestion,
  selection: SelectionRule,
): void {
  if (
    task.state === null ||
    typeof task.state !== "object" ||
    Array.isArray(task.state) ||
    Object.keys(task.state).length
  )
    invalid(
      ["task", "state"],
      "compiled classifier task state must be exactly {}",
    );
  if (task.kind === "choice") {
    if (!task.criteria || Array.isArray(task.criteria))
      invalid(
        ["task", "criteria"],
        "choice criteria must be a label dictionary",
      );
    const labels = Object.keys(task.criteria);
    if (labels.length < 2 || labels.length > 5)
      invalid(
        ["task", "criteria"],
        "choice criteria must contain two to five unique labels",
      );
    if (selection.kind === "threshold")
      invalid(["selection"], "choice tasks require a values selection");
    if (
      selection.values.some(
        (value) =>
          typeof value !== "string" ||
          !Object.hasOwn(task.criteria as Record<string, unknown>, value),
      )
    )
      invalid(
        ["selection", "values"],
        "choice selection values must be labels from the task criteria",
      );
    return;
  }
  if (task.kind === "noul") {
    if (selection.kind === "threshold")
      invalid(["selection"], "noul tasks require a values selection");
    if (selection.values.some((value) => typeof value !== "boolean"))
      invalid(
        ["selection", "values"],
        "noul selection values must be booleans",
      );
    return;
  }
  if (selection.kind === "values")
    invalid(["selection"], "score tasks require a threshold selection");
}
export const CompiledQuerySchema = signalModel({
  name: z
    .string()
    .min(1)
    .refine((value) => [...value].length <= 40)
    .default("AI match"),
  task: ClassifyQuestionSchema,
  selection: SelectionRuleSchema,
}).superRefine((value, ctx) => {
  try {
    validateCompiledQuery(value.task, value.selection);
  } catch (error) {
    if (error instanceof z.ZodError)
      for (const issue of error.issues) ctx.addIssue(issue);
    else
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
  }
});
export type CompiledQuery = z.infer<typeof CompiledQuerySchema>;
export const LegendItemSchema = signalModel({
  label: z.string(),
  color: z.string(),
  kind: z.enum(["value", "gradient", "threshold"]).default("value"),
  threshold: signalFloat.nullable().default(null),
});
export type LegendItem = z.infer<typeof LegendItemSchema>;
export type RunState =
  | "idle"
  | "compiling"
  | "awaiting_review"
  | "classifying"
  | "completed"
  | "failed"
  | "cancelled";
export type RunPhase =
  | "planning"
  | "loading_traces"
  | "starting_classification";
export const RunRequestSchema = signalModel({
  query: z.string(),
  mode: z.enum(["immediate", "review"]),
  population: PopulationRequestSchema.transform(
    (value) => new PopulationRequest(value),
  ),
  parallelism: signalInteger
    .refine((value) => value >= 1 && value <= 200)
    .default(100),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;
export interface RunSnapshotFields {
  generation: number;
  explorerGeneration: number | null;
  state: RunState;
  phase: RunPhase | null;
  request: RunRequest | null;
  withinResults: boolean;
  dimensions: readonly CompiledQuery[] | null;
  explicitFilters: FacetSelection;
  explicitNumeric: NumericFilters;
  generatedFilters: FacetSelection;
  generatedNumeric: NumericFilters;
  filterResponse: ClassifyResponse | null;
  filterSelectionError: string | null;
  planWarning: string | null;
  traceIds: readonly string[];
  traces: readonly TraceRecord[];
  results: Readonly<Record<string, TraceClassification>>;
  projections: Readonly<Record<string, TraceProjection>>;
  loaded: number;
  toLoad: number;
  total: number;
  completed: number;
  failed: number;
  matched: number;
  active: number;
  queued: number;
  percent: number;
  elapsed: number;
  rate: number;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  classifierModel: string | null;
  generatedTime: readonly [string | null, string | null] | null;
  provenance: Readonly<Record<string, string>>;
}
export class RunSnapshot implements RunSnapshotFields {
  declare readonly generation: RunSnapshotFields["generation"];
  declare readonly explorerGeneration: RunSnapshotFields["explorerGeneration"];
  declare readonly state: RunSnapshotFields["state"];
  declare readonly phase: RunSnapshotFields["phase"];
  declare readonly request: RunSnapshotFields["request"];
  declare readonly withinResults: RunSnapshotFields["withinResults"];
  declare readonly dimensions: RunSnapshotFields["dimensions"];
  declare readonly explicitFilters: RunSnapshotFields["explicitFilters"];
  declare readonly explicitNumeric: RunSnapshotFields["explicitNumeric"];
  declare readonly generatedFilters: RunSnapshotFields["generatedFilters"];
  declare readonly generatedNumeric: RunSnapshotFields["generatedNumeric"];
  declare readonly filterResponse: RunSnapshotFields["filterResponse"];
  declare readonly filterSelectionError: RunSnapshotFields["filterSelectionError"];
  declare readonly planWarning: RunSnapshotFields["planWarning"];
  declare readonly traceIds: RunSnapshotFields["traceIds"];
  declare readonly traces: RunSnapshotFields["traces"];
  declare readonly results: RunSnapshotFields["results"];
  declare readonly projections: RunSnapshotFields["projections"];
  declare readonly loaded: RunSnapshotFields["loaded"];
  declare readonly toLoad: RunSnapshotFields["toLoad"];
  declare readonly total: RunSnapshotFields["total"];
  declare readonly completed: RunSnapshotFields["completed"];
  declare readonly failed: RunSnapshotFields["failed"];
  declare readonly matched: RunSnapshotFields["matched"];
  declare readonly active: RunSnapshotFields["active"];
  declare readonly queued: RunSnapshotFields["queued"];
  declare readonly percent: RunSnapshotFields["percent"];
  declare readonly elapsed: RunSnapshotFields["elapsed"];
  declare readonly rate: RunSnapshotFields["rate"];
  declare readonly createdAt: RunSnapshotFields["createdAt"];
  declare readonly startedAt: RunSnapshotFields["startedAt"];
  declare readonly finishedAt: RunSnapshotFields["finishedAt"];
  declare readonly error: RunSnapshotFields["error"];
  declare readonly classifierModel: RunSnapshotFields["classifierModel"];
  declare readonly generatedTime: RunSnapshotFields["generatedTime"];
  declare readonly provenance: RunSnapshotFields["provenance"];
  constructor(input: Partial<RunSnapshotFields> = {}) {
    Object.assign(
      this,
      {
        generation: 0,
        explorerGeneration: null,
        state: "idle",
        phase: null,
        request: null,
        withinResults: false,
        dimensions: null,
        explicitFilters: new FacetSelection({}),
        explicitNumeric: new NumericFilters({}),
        generatedFilters: new FacetSelection({}),
        generatedNumeric: new NumericFilters({}),
        filterResponse: null,
        filterSelectionError: null,
        planWarning: null,
        traceIds: [],
        traces: [],
        loaded: 0,
        toLoad: 0,
        total: 0,
        completed: 0,
        failed: 0,
        matched: 0,
        active: 0,
        queued: 0,
        percent: 0,
        elapsed: 0,
        rate: 0,
        createdAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        classifierModel: null,
        generatedTime: null,
      },
      input,
      {
        results: Object.freeze({ ...input.results }),
        projections: Object.freeze({ ...input.projections }),
        provenance: Object.freeze({ ...input.provenance }),
      },
    );
    Object.freeze(this);
  }
}
export class TraceDetail {
  constructor(
    readonly trace: TraceRecord,
    readonly projection: TraceProjection | null,
    readonly classification: TraceClassification | null,
    readonly dimensions: readonly CompiledQuery[] | null = null,
  ) {
    Object.freeze(this);
  }
}
export function selectionRuleText(
  compiled: CompiledQuery,
): readonly [string, string] {
  const selection = compiled.selection;
  if (selection.kind === "threshold")
    return [
      `Score ${selection.operator === "gte" ? "at least" : "at most"}`,
      pyG(selection.value),
    ];
  if (compiled.task.kind === "noul")
    return [
      "Answer is",
      selection.values.map((value) => (value ? "yes" : "no")).join(" or "),
    ];
  return ["Verdict", selection.values.map(String).join(" or ")];
}

export const FILTER_OR_JUDGMENT_RULE =
  'Metadata filter or conversation judgment:\n- Use a metadata filter only for an exact value the user literally names (a project, model, provider, agent, tool, product or trace type) or for an explicit trace status request ("failed traces", "status error", "errored traces").\n- Anything that needs reading what happened in the conversation is a conversation judgment: a tool call failed or returned an error, the agent gave up, the user was frustrated, a hallucination, a refusal. Never also map it onto a status filter or any other metadata value.\n- When a word could be either ("errors", "issues"), make it a conversation judgment and add no status filter, unless the user says status, failed trace or errored trace.\n- Aggregate questions (totals, averages, counts, rankings) cannot be answered by finding traces: use no filter and no judgment.\nExamples:\n- "failed traces" -> status filter; no judgment.\n- "tool errors" -> judgment "a tool call returned an error"; no status filter.\n- "gpt-5 traces where the user is angry" -> model filter gpt-5 and judgment "the user is angry".\n- "which model costs the most?" -> nothing; it is an aggregate question.';
