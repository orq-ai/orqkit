import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type OpenAI from "openai";

import type { Orq } from "@orq-ai/node";

import {
  effectiveTraceInputChars,
  fitClassifierInput,
  hasTruncatedSourceText,
  isJevModel,
  serializedChars,
  serializedQuestionChars,
} from "../common/model-input.js";
import { roleModel } from "../common/model-roles.js";
import { camelToSnake } from "../common/python-json.js";
import {
  ensureTraceDocument,
  type TraceDocument,
  toChatMessages,
} from "../common/trace-document.js";
import { type ExportFilters, RunExport } from "../trace-finder/export.js";
import {
  type CompiledQuery,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  Snapshot,
  type SnapshotFields,
  type TraceRecord,
} from "../trace-finder/models.js";
import {
  type OrqSourceClient,
  OrqTraceSource,
} from "../trace-finder/orq-source.js";
import { requireCompleteTargetedLoad } from "../trace-finder/orq-source-data.js";
import {
  mergeFacets,
  mergeNumeric,
  planQuery,
} from "../trace-finder/planner.js";
import { serializeProjection } from "../trace-finder/projection.js";
import { effectiveDashboardSettings } from "../trace-finder/settings.js";
import { matchKey, prepareClassifierState } from "./labeling.js";
import { ensureUniqueTraceIds, type InsightsPopulation } from "./models.js";
import { buildSummaryPromptWithCoverage } from "./summarize.js";
import type { UsageLedger } from "./usage.js";

function populationFields(fields: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(JSON.parse(JSON.stringify(fields))).map(([key, value]) => [
      camelToSnake(key),
      value,
    ]),
  );
}

export class PopulationError extends Error {
  override readonly name = "PopulationError";
}
export interface ResolvedPopulation {
  traces: TraceDocument[];
  compiled: readonly CompiledQuery[] | null;
  echo: Record<string, unknown>;
  nScanned: number;
}
export function snapshotDocuments(snapshot: SnapshotFields): TraceDocument[] {
  return [
    ...snapshot.traces.map((trace) => ensureTraceDocument(trace)),
    ...snapshot.documents,
  ];
}
export async function readSnapshot(
  path: string,
): Promise<{ snapshot: Snapshot; sha256: string }> {
  try {
    const raw = await readFile(path);
    return {
      snapshot: new Snapshot(JSON.parse(raw.toString("utf8"))),
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  } catch (error) {
    throw new PopulationError(
      `loading local trace snapshot ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
export async function resolveSnapshot(
  path: string,
): Promise<ResolvedPopulation> {
  const { snapshot, sha256 } = await readSnapshot(path),
    traces = snapshotDocuments(snapshot);
  return {
    traces,
    compiled: null,
    echo: populationFields({
      mode: "snapshot",
      snapshotPath: path,
      snapshotSha256: sha256,
      limit: traces.length,
    }),
    nScanned: traces.length,
  };
}
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}
export function describeLocalSend(options: {
  nTraces: number;
  nBytes: number;
  fileName: string;
  models: { summary: string; classifier: string; embedding: string };
  preview?: boolean;
}): string {
  const verb = options.preview ? "A run would send" : "Sending",
    noun = options.nTraces === 1 ? "trace" : "traces";
  return `${verb} ${options.nTraces.toLocaleString("en-US")} ${noun} (${formatSize(options.nBytes)}) from ${options.fileName} to models: summary ${options.models.summary}, classifier ${options.models.classifier}, embedding ${options.models.embedding}.`;
}

export async function projectionCoverage(
  traces: readonly (TraceRecord | TraceDocument)[],
  options: {
    traceInputChars?: number;
    classifierModel?: string;
    classifierQuestions?:
      | readonly Record<string, unknown>[]
      | Readonly<Record<string, unknown>>;
  } = {},
) {
  const cap = options.traceInputChars ?? (await effectiveTraceInputChars()),
    model =
      options.classifierModel ??
      roleModel("classifier", { task: "insights.labels" }),
    jev = isJevModel(model),
    questions = options.classifierQuestions;
  const coverage = {
    nTraces: traces.length,
    nProjectionTruncated: 0,
    nSummaryTruncated: 0,
    nClassifierTruncated: 0,
    nSourceMessages: 0,
    nOmittedMessages: 0,
    sourceChars: 0,
    classifierStateChars: 0,
    classifierQuestionChars: 0,
    classifierRequestChars: 0,
    traceInputChars: cap,
    summaryInputChars: 0,
    classifierStateFormat: jev ? "jev" : "text",
    classifierQuestionReserve:
      questions === undefined ? "not_available" : "applied",
  };
  const questionChars =
    questions === undefined ? 0 : serializedQuestionChars(questions);
  for (const trace of traces) {
    const messages = toChatMessages(trace),
      [prompt, summaryTruncated] = buildSummaryPromptWithCoverage(trace, cap);
    let state = prepareClassifierState(trace, { model, charCap: cap });
    if (questions !== undefined)
      state = fitClassifierInput(state, {
        model,
        questions,
        globalCharCap: cap,
      });
    const stateChars =
      typeof state === "string" || state instanceof String
        ? Array.from(String(state)).length
        : serializedChars(state);
    let omitted = 0;
    if (typeof state === "object" && !(state instanceof String)) {
      const represented = new Set<number>();
      if (Array.isArray(state.messages))
        for (const entry of state.messages) {
          if (!entry || typeof entry !== "object") continue;
          if (Number.isInteger(entry.index))
            represented.add(entry.index as number);
          if (Array.isArray(entry.results))
            for (const result of entry.results)
              if (
                result &&
                typeof result === "object" &&
                Number.isInteger(result.index)
              )
                represented.add(result.index as number);
        }
      omitted = Math.max(0, messages.length - represented.size);
    }
    const classifierTruncated = omitted > 0 || hasTruncatedSourceText(state);
    coverage.nSummaryTruncated += Number(summaryTruncated);
    coverage.nClassifierTruncated += Number(classifierTruncated);
    coverage.nProjectionTruncated += Number(
      summaryTruncated || classifierTruncated,
    );
    coverage.nSourceMessages += messages.length;
    coverage.nOmittedMessages += omitted;
    coverage.sourceChars += Array.from(
      serializeProjection({ trace_status: trace.status, messages }),
    ).length;
    coverage.classifierStateChars += stateChars;
    coverage.classifierQuestionChars += questionChars;
    coverage.classifierRequestChars += stateChars + questionChars;
    coverage.summaryInputChars += Array.from(prompt).length;
  }
  return coverage;
}

export async function loadPopulationTraces(
  client: OrqSourceClient,
  options: {
    start: string | null;
    end: string | null;
    limit: number;
    facets: FacetSelection;
    numeric: NumericFilters;
    targetTraceIds?: ReadonlySet<string>;
    window?: PopulationRequest;
    signal?: AbortSignal;
  },
): Promise<TraceDocument[]> {
  const source = new OrqTraceSource(client);
  try {
    const snapshot = await source.loadAsync(options);
    if (options.targetTraceIds !== undefined)
      requireCompleteTargetedLoad(snapshot, {
        errorType: PopulationError,
        operation: "reloading Finder export traces",
      });
    const selected = options.window
      ? snapshot.traces.filter((trace) =>
          options.window?.containsTime(trace.timestamp),
        )
      : snapshot.traces;
    const enriched = await source.enrichSelectedSignalSpans(selected, {
      signal: options.signal,
    });
    const documents = enriched.map((trace) => ensureTraceDocument(trace));
    ensureUniqueTraceIds(documents);
    return documents;
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (error instanceof PopulationError) throw error;
    throw new PopulationError(
      `loading the trace population failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    source.close();
  }
}

export async function resolveFilterPopulation(
  population: InsightsPopulation,
  client: OrqSourceClient,
  options: { now?: Date; signal?: AbortSignal } = {},
): Promise<ResolvedPopulation> {
  const end = population.end ?? (options.now ?? new Date()).toISOString();
  const start =
    population.start ??
    new Date(
      new Date(end).getTime() - population.windowDays * 86400000,
    ).toISOString();
  const traces = await loadPopulationTraces(client, {
    start,
    end,
    limit: population.limit,
    facets: population.facets,
    numeric: population.numeric,
    signal: options.signal,
  });
  return {
    traces,
    compiled: null,
    echo: populationFields({
      mode: "filter",
      query: null,
      facets: populationFields(population.facets) as Record<string, unknown>,
      numeric: populationFields(population.numeric) as Record<string, unknown>,
      start,
      end,
      limit: population.limit,
    }),
    nScanned: traces.length,
  };
}

function facetsFromExport(filters: ExportFilters): FacetSelection {
  return new FacetSelection({ ...filters, toolName: filters.toolNames });
}
export async function resolveExportPopulation(
  population: InsightsPopulation,
  client: OrqSourceClient,
  options: { signal?: AbortSignal } = {},
): Promise<ResolvedPopulation> {
  if (population.finderExport === null)
    throw new PopulationError("Finder export path is required");
  let exported = population.finderExportSnapshot();
  if (exported === null) {
    try {
      exported = new RunExport(
        JSON.parse(await readFile(population.finderExport, "utf8")),
      );
    } catch (error) {
      throw new PopulationError(
        `loading finder export ${population.finderExport} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const facets = mergeFacets(
    facetsFromExport(exported.filters),
    facetsFromExport(exported.generatedFilters),
  );
  const numeric = mergeNumeric(
    new NumericFilters(exported.numeric),
    new NumericFilters(exported.generatedNumeric),
  );
  const ids = new Set(exported.matchedTraceIds),
    start = exported.start,
    end = exported.end,
    limit = Math.max(exported.limit, ids.size);
  if (ids.size && (start === null || end === null))
    throw new PopulationError(
      "Finder export does not record its original time window; re-export the run before using it in Insights.",
    );
  const loaded = ids.size
    ? await loadPopulationTraces(client, {
        start,
        end,
        limit,
        facets,
        numeric,
        targetTraceIds: ids,
        signal: options.signal,
      })
    : [];
  const byId = new Map(loaded.map((trace) => [trace.traceId, trace]));
  const traces = exported.matchedTraceIds.flatMap((id) => {
    const trace = byId.get(id);
    return trace ? [trace] : [];
  });
  const missing = exported.matchedTraceIds.length - traces.length;
  if (missing)
    console.warn(
      `Insights population from finder export ${population.finderExport} could not find ${missing} of ${exported.matchedTraceIds.length} matched traces in the reloaded window`,
    );
  return {
    traces,
    compiled: null,
    echo: populationFields({
      mode: "export",
      query: exported.query,
      finderExport: resolve(population.finderExport),
      facets: populationFields(facets),
      numeric: populationFields(numeric),
      start,
      end,
      limit,
      nMatchedIds: exported.matchedTraceIds.length,
      nMissingExportIds: missing,
    }),
    nScanned: loaded.length,
  };
}

export async function resolveQueryPopulation(
  population: InsightsPopulation,
  options: {
    orq: Orq;
    client: OpenAI;
    compilerModel: string;
    classifierModel: string;
    fastFilterModel: string;
    filterSelection?: "llm" | "llm+jev";
    now?: Date;
    usage?: UsageLedger;
    signal?: AbortSignal;
  },
): Promise<ResolvedPopulation> {
  if (population.query === null) throw new PopulationError("query is required");
  const end = population.end ?? (options.now ?? new Date()).toISOString();
  const start =
    population.start ??
    new Date(
      new Date(end).getTime() - population.windowDays * 86400000,
    ).toISOString();
  const origin =
    population.timeOrigin === "explicit" ||
    population.start !== null ||
    population.end !== null ||
    population.windowDays !== 7
      ? "explicit"
      : "default";
  const request = new PopulationRequest({
    start,
    end,
    timeOrigin: origin,
    facets: population.facets,
    numeric: population.numeric,
    limit: population.limit,
  });
  const filterSelection =
    population.filterSelection ?? options.filterSelection ?? "llm+jev";
  let plan: Awaited<ReturnType<typeof planQuery>>;
  try {
    plan = await planQuery(population.query, request, {
      client: options.client,
      orq: options.orq,
      compilerModel: options.compilerModel,
      classifierModel: options.classifierModel,
      fastFilterModel: options.fastFilterModel,
      filterSelection,
      now: options.now,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    throw new PopulationError(
      `planning the population query failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  for (const usage of plan.modelCalls) options.usage?.add("population", usage);
  const effective = plan.effectivePopulation;
  const traces = plan.emptyMatch
    ? []
    : await loadPopulationTraces(options.orq, {
        start: effective.start,
        end: effective.end,
        limit: effective.limit,
        facets: effective.facets,
        numeric: effective.numeric,
        window: effective,
        signal: options.signal,
      });
  return {
    traces,
    compiled: plan.dimensions,
    echo: populationFields({
      mode: "query",
      query: population.query,
      filterSelection,
      compilerModel: options.compilerModel,
      filterModel:
        filterSelection === "llm"
          ? options.fastFilterModel
          : options.classifierModel,
      filterModelRole:
        filterSelection === "llm"
          ? "fast/finder.filters"
          : "classifier/finder.classifier",
      compiledDimensions: plan.dimensions.map((dimension) => ({
        name: dimension.name,
        task: dimension.task.instructions,
        selection: dimension.selection,
      })),
      facets: populationFields(effective.facets),
      generatedFacets: populationFields(plan.generatedFacets),
      numeric: populationFields(effective.numeric),
      generatedNumeric: populationFields(plan.generatedNumeric),
      start: effective.start,
      end: effective.end,
      timeOrigin: effective.timeOrigin,
      endExclusive: effective.endExclusive,
      emptyMatch: plan.emptyMatch,
      generatedTime: plan.generatedTime,
      timeProvenance: plan.provenance.time ?? null,
      provenance: { ...plan.provenance },
      limit: effective.limit,
      filterSelectionError: plan.selectorError,
    }),
    nScanned: traces.length,
  };
}

export interface ResolvePopulationOptions {
  orq?: Orq | null;
  client?: OpenAI | null;
  compilerModel: string;
  classifierModel: string;
  fastFilterModel?: string;
  filterSelection?: "llm" | "llm+jev";
  traceInputChars?: number;
  labelClassifierModel?: string;
  classifierQuestions?:
    | readonly Record<string, unknown>[]
    | Readonly<Record<string, unknown>>;
  usage?: UsageLedger;
  now?: Date;
  signal?: AbortSignal;
}
export async function resolvePopulation(
  population: InsightsPopulation,
  options: ResolvePopulationOptions,
): Promise<ResolvedPopulation> {
  let result: ResolvedPopulation;
  if (population.snapshotPath !== null)
    result = await resolveSnapshot(population.snapshotPath);
  else if (population.finderExport !== null) {
    if (!options.orq)
      throw new PopulationError(
        "a Finder export population requires an Orq client",
      );
    result = await resolveExportPopulation(population, options.orq, {
      signal: options.signal,
    });
  } else if (population.query !== null) {
    if (!options.orq)
      throw new PopulationError("a query population requires an Orq client");
    if (!options.client)
      throw new PopulationError("a query population requires an LLM client");
    const filterSelection =
      population.filterSelection ??
      options.filterSelection ??
      (await effectiveDashboardSettings()).filterSelection;
    result = await resolveQueryPopulation(population, {
      orq: options.orq,
      client: options.client,
      compilerModel: options.compilerModel,
      classifierModel: options.classifierModel,
      fastFilterModel:
        options.fastFilterModel ??
        roleModel("fast", { task: "finder.filters" }),
      filterSelection,
      usage: options.usage,
      now: options.now,
      signal: options.signal,
    });
  } else {
    if (!options.orq)
      throw new PopulationError("a filter population requires an Orq client");
    result = await resolveFilterPopulation(population, options.orq, {
      now: options.now,
      signal: options.signal,
    });
  }
  try {
    ensureUniqueTraceIds(result.traces);
  } catch (error) {
    throw new PopulationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  let questions: Record<string, unknown> | undefined;
  if (options.classifierQuestions !== undefined) {
    questions = Array.isArray(options.classifierQuestions)
      ? Object.fromEntries(
          options.classifierQuestions.map((question, index) => [
            `question_${index}`,
            question,
          ]),
        )
      : { ...options.classifierQuestions };
    for (const [index, dimension] of (result.compiled ?? []).entries())
      questions[matchKey(index, result.compiled?.length ?? 0)] = dimension.task;
  }
  try {
    const coverage = await projectionCoverage(result.traces, {
      traceInputChars: options.traceInputChars,
      classifierModel: options.labelClassifierModel,
      classifierQuestions: questions,
    });
    Object.assign(result.echo, populationFields(coverage));
    if (coverage.nProjectionTruncated)
      console.warn(
        `Insights ${String(result.echo.mode)} population has ${coverage.nProjectionTruncated} of ${result.traces.length} traces with shortened summary or classifier input`,
      );
  } catch (error) {
    throw new PopulationError(
      `projecting loaded traces failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return result;
}

/** Describe measured rendered character sizes without presenting estimates as tokenizer counts. */
export async function describeProjectionCoverage(
  coverage: Readonly<Record<string, unknown>>,
): Promise<string> {
  const num = (key: string, fallback = 0) =>
    Math.trunc(Number(coverage[key] ?? fallback));
  const fmt = (n: number) => n.toLocaleString("en-US");
  const traces = num("n_traces");
  const affected = num("n_projection_truncated");
  const inputCap = Object.hasOwn(coverage, "trace_input_chars")
    ? num("trace_input_chars")
    : await effectiveTraceInputChars();
  const per = (key: string) => Math.floor(num(key) / Math.max(traces, 1));
  const detail =
    coverage.classifier_state_format === "jev"
      ? `${fmt(num("n_omitted_messages"))} of ${fmt(num("n_source_messages"))} source messages were omitted from the Jev classifier state.`
      : "The non-Jev classifier receives a readable transcript shortened as needed to fit its questions.";
  return (
    `${fmt(affected)} of ${fmt(traces)} traces hit a summary or classifier input cap of ${fmt(inputCap)} characters. ` +
    `Average rendered inputs: summary ${fmt(per("summary_input_chars"))} characters; classifier request ${fmt(per("classifier_request_chars"))} ` +
    `(state ${fmt(per("classifier_state_chars"))}, questions ${fmt(per("classifier_question_chars"))}). ${detail}`
  );
}
