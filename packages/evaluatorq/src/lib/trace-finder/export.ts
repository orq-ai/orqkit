import { createHash } from "node:crypto";

import { z } from "zod/v4";

import { codepointCompare } from "../common/sanitize.js";
import { TraceTimestampSchema } from "../common/trace-document.js";
import { parseIso } from "../formats/time.js";
import {
  signalBoolean,
  signalDictionary,
  signalFloat,
  signalInteger,
  signalModel,
  signalRecord,
} from "../signals/models.js";
import {
  type CompiledQuery,
  type DimensionAnswer,
  FACET_NAMES,
  type FacetSelection,
  type NumericFilters,
  type RunSnapshot,
  type TraceClassification,
  type TraceRecord,
  timeMicros,
} from "./models.js";

const text = z.string(),
  optionalText = text.nullable().default(null),
  nonnegative = signalInteger.refine((value) => value >= 0),
  bound = nonnegative.nullable().default(null),
  strings = z
    .array(text)
    .readonly()
    .default(() => []),
  unit = signalFloat.refine(
    (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  );
const dateTime = z
  .unknown()
  .transform((value, ctx) => {
    if (value == null) return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      try {
        return parseIso(value).iso.replace(/\+00:00$/, "Z");
      } catch {}
    }
    const parsed = TraceTimestampSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    ctx.addIssue({ code: "custom", message: "Invalid export datetime" });
    return z.NEVER;
  })
  .default(null);
export const ExportTaskSchema = signalModel(
  {
    kind: z.enum(["noul", "choice", "score"]),
    instructions: text,
    criteria: z
      .union([signalRecord(text.nullable()), z.array(text)])
      .nullable()
      .default(null),
    state: signalDictionary,
    noulThreshold: unit,
  },
  true,
);
export type ExportTask = z.infer<typeof ExportTaskSchema>;
export const ExportValuesSelectionSchema = signalModel(
  {
    kind: z.literal("values"),
    values: z
      .array(z.union([text, z.boolean()]))
      .min(1)
      .readonly(),
  },
  true,
);
export type ExportValuesSelection = z.infer<typeof ExportValuesSelectionSchema>;
export const ExportThresholdSelectionSchema = signalModel(
  {
    kind: z.literal("threshold"),
    operator: z.enum(["gte", "lte"]),
    value: unit,
  },
  true,
);
export type ExportThresholdSelection = z.infer<
  typeof ExportThresholdSelectionSchema
>;
export const ExportSelectionSchema = z.union([
  ExportValuesSelectionSchema,
  ExportThresholdSelectionSchema,
]);
export type ExportSelection = z.infer<typeof ExportSelectionSchema>;
export const ExportDimensionSchema = signalModel(
  { name: text, task: ExportTaskSchema, selection: ExportSelectionSchema },
  true,
);
export type ExportDimension = z.infer<typeof ExportDimensionSchema>;
export const ExportAnswerSchema = signalModel(
  {
    value: z
      .union([
        z.boolean(),
        z.custom<number>((value) => typeof value === "number"),
        text,
      ])
      .nullable()
      .default(null),
    confidence: signalFloat
      .refine((value) => value >= 0 && value <= 1)
      .nullable()
      .default(null),
    probabilities: signalRecord(signalFloat).nullable().default(null),
    matched: signalBoolean,
    error: optionalText,
  },
  true,
);
export type ExportAnswer = z.infer<typeof ExportAnswerSchema>;
export const ExportFiltersSchema = signalModel(
  {
    project: strings,
    model: strings,
    provider: strings,
    status: strings,
    product: strings,
    traceType: strings,
    agentName: strings,
    toolNames: strings,
  },
  true,
);
export type ExportFilters = z.infer<typeof ExportFiltersSchema>;
export const ExportNumericFiltersSchema = signalModel(
  {
    tokensMin: bound,
    tokensMax: bound,
    durationMsMin: bound,
    durationMsMax: bound,
  },
  true,
);
export type ExportNumericFilters = z.infer<typeof ExportNumericFiltersSchema>;
export const ExportTimesSchema = signalModel(
  {
    createdAt: dateTime,
    startedAt: dateTime,
    finishedAt: dateTime,
    elapsed: signalFloat,
    rate: signalFloat,
  },
  true,
);
export type ExportTimes = z.infer<typeof ExportTimesSchema>;
export const ExportCountsSchema = signalModel(
  {
    total: signalInteger,
    completed: signalInteger,
    failed: signalInteger,
    matched: signalInteger,
    active: signalInteger,
    queued: signalInteger,
    percent: signalFloat,
  },
  true,
);
export type ExportCounts = z.infer<typeof ExportCountsSchema>;
export const ExportTraceSchema = signalModel(
  {
    traceId: text,
    spanId: text,
    timestamp: dateTime.pipe(z.string()),
    agentName: optionalText,
    toolNames: strings,
    answers: z
      .array(ExportAnswerSchema)
      .readonly()
      .default(() => []),
    matched: signalBoolean,
    error: optionalText,
  },
  true,
);
export type ExportTrace = z.infer<typeof ExportTraceSchema>;
export const RunExportSchema = signalModel(
  {
    schemaVersion: z.literal(2).default(2),
    query: text,
    dimensions: z.array(ExportDimensionSchema).readonly(),
    generatedFilters: ExportFiltersSchema,
    filters: ExportFiltersSchema,
    generatedNumeric: ExportNumericFiltersSchema,
    numeric: ExportNumericFiltersSchema,
    start: dateTime,
    end: dateTime,
    limit: signalInteger,
    parallelism: signalInteger,
    times: ExportTimesSchema,
    counts: ExportCountsSchema,
    traces: z.array(ExportTraceSchema).readonly(),
    matchedTraceIds: z.array(text),
  },
  true,
);
export type RunExportFields = z.infer<typeof RunExportSchema>;
export class RunExport implements RunExportFields {
  declare readonly schemaVersion: RunExportFields["schemaVersion"];
  declare readonly query: RunExportFields["query"];
  declare readonly dimensions: RunExportFields["dimensions"];
  declare readonly generatedFilters: RunExportFields["generatedFilters"];
  declare readonly filters: RunExportFields["filters"];
  declare readonly generatedNumeric: RunExportFields["generatedNumeric"];
  declare readonly numeric: RunExportFields["numeric"];
  declare readonly start: RunExportFields["start"];
  declare readonly end: RunExportFields["end"];
  declare readonly limit: RunExportFields["limit"];
  declare readonly parallelism: RunExportFields["parallelism"];
  declare readonly times: RunExportFields["times"];
  declare readonly counts: RunExportFields["counts"];
  declare readonly traces: RunExportFields["traces"];
  declare readonly matchedTraceIds: RunExportFields["matchedTraceIds"];
  constructor(input: unknown) {
    Object.assign(this, RunExportSchema.parse(input));
    Object.freeze(this);
  }
}
function exportTask(compiled: CompiledQuery): ExportTask {
  const task = compiled.task;
  return ExportTaskSchema.parse({
    kind: task.kind,
    instructions: task.instructions,
    criteria: Array.isArray(task.criteria)
      ? [...task.criteria]
      : task.criteria
        ? { ...task.criteria }
        : null,
    state: {},
    noulThreshold: task.noulThreshold,
  });
}
function exportFilters(facets: FacetSelection): ExportFilters {
  const values = Object.fromEntries(
    FACET_NAMES.filter(
      (name) => !["agent_name", "tool_name"].includes(name),
    ).map((name) => {
      const key = name === "trace_type" ? "traceType" : name;
      return [
        key,
        [...(facets[key as keyof FacetSelection] as ReadonlySet<string>)].sort(
          codepointCompare,
        ),
      ];
    }),
  );
  return ExportFiltersSchema.parse({
    ...values,
    agentName: [...facets.agentName].sort(codepointCompare),
    toolNames: [...facets.toolName].sort(codepointCompare),
  });
}
function exportNumeric(numeric: NumericFilters): ExportNumericFilters {
  return ExportNumericFiltersSchema.parse({
    tokensMin: numeric.tokensMin,
    tokensMax: numeric.tokensMax,
    durationMsMin: numeric.durationMsMin,
    durationMsMax: numeric.durationMsMax,
  });
}
function exportAnswer(answer: DimensionAnswer): ExportAnswer {
  return ExportAnswerSchema.parse({
    value: answer.value,
    confidence: answer.confidence,
    probabilities: answer.probabilities ? { ...answer.probabilities } : null,
    matched: answer.matched,
    error: answer.error,
  });
}
function exportTrace(
  trace: TraceRecord,
  classification: TraceClassification | undefined,
): ExportTrace {
  return ExportTraceSchema.parse({
    traceId: trace.traceId,
    spanId: trace.spanId,
    timestamp: trace.timestamp,
    agentName: trace.agentName || null,
    toolNames: trace.toolNames,
    answers: classification?.answers.map(exportAnswer) ?? [],
    matched: classification?.matched ?? false,
    error: classification
      ? classification.error
      : "classification not completed",
  });
}
export function buildExport(
  run: RunSnapshot,
  options: { matchedOnly?: boolean } = {},
): RunExport {
  if (!run.request || run.dimensions === null)
    throw new Error("run has no request and classifier dimensions to export");
  const sources = new Map(run.traces.map((trace) => [trace.traceId, trace])),
    selected = run.traceIds.map((id) => {
      const trace = sources.get(id);
      if (!trace)
        throw new Error(
          `selected trace '${id}' is missing from the run snapshot`,
        );
      return trace;
    });
  selected.sort((a, b) => {
    const x = timeMicros(a.timestamp),
      y = timeMicros(b.timestamp);
    return x > y ? -1 : x < y ? 1 : 0;
  });
  let traces = selected.map((trace) =>
    exportTrace(trace, run.results[trace.traceId]),
  );
  if (options.matchedOnly)
    traces = traces.filter((trace) => trace.matched && trace.error === null);
  let start = run.request.population.start,
    end = run.request.population.end;
  if (selected.length && (start === null || end === null)) {
    const windows = new Map<string, readonly [unknown, unknown]>();
    for (const trace of selected) {
      const a = trace.captureMetadata.population_start ?? null,
        b = trace.captureMetadata.population_end ?? null;
      if (
        (a !== null && typeof a === "object") ||
        (b !== null && typeof b === "object")
      )
        throw new TypeError("unhashable population window metadata");
      const key = JSON.stringify([
        typeof a === "boolean" ? Number(a) : a,
        typeof b === "boolean" ? Number(b) : b,
      ]);
      windows.set(key, [a, b]);
    }
    if (windows.size === 1) {
      const [recordedStart, recordedEnd] = [
        ...windows.values(),
      ][0] as readonly [unknown, unknown];
      if (start === null && typeof recordedStart === "string")
        start = dateTime.parse(recordedStart);
      if (end === null && typeof recordedEnd === "string")
        end = dateTime.parse(recordedEnd);
    }
  }
  return new RunExport({
    query: run.request.query,
    dimensions: run.dimensions.map((dimension) => ({
      name: dimension.name,
      task: exportTask(dimension),
      selection: { ...dimension.selection },
    })),
    generatedFilters: exportFilters(run.generatedFilters),
    filters: exportFilters(run.request.population.facets),
    generatedNumeric: exportNumeric(run.generatedNumeric),
    numeric: exportNumeric(run.request.population.numeric),
    start,
    end,
    limit: run.request.population.limit,
    parallelism: run.request.parallelism,
    times: {
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      elapsed: run.elapsed,
      rate: run.rate,
    },
    counts: {
      total: run.total,
      completed: run.completed,
      failed: run.failed,
      matched: run.matched,
      active: run.active,
      queued: run.queued,
      percent: run.percent,
    },
    traces,
    matchedTraceIds: traces
      .filter((trace) => trace.matched && trace.error === null)
      .map((trace) => trace.traceId),
  });
}
export function exportJson(
  run: RunSnapshot,
  options: { matchedOnly?: boolean } = {},
): string {
  return JSON.stringify(buildExport(run, options), null, 2);
}
export function exportFilename(run: RunSnapshot): string {
  if (run.createdAt === null || run.finishedAt === null)
    throw new Error(
      "completed run timestamps are required for an export filename",
    );
  const identity = `${run.generation}:${parseIso(run.createdAt).iso}:${parseIso(run.finishedAt).iso}`,
    digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `trace-finder-${run.generation}-${digest}.json`;
}
