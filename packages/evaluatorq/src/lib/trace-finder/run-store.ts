import { isDeepStrictEqual } from "node:util";

import {
  type ClassifyQuestion,
  ClassifyResponseSchema,
} from "../common/judge.js";
import { codepointCompare, pythonCasefold } from "../common/sanitize.js";
import { classifierQuestions } from "./classifier.js";
import type { CompiledPlan } from "./compiler.js";
import type { ExplorerStore } from "./explorer.js";
import { FilterSelectionResult } from "./filter-selector.js";
import {
  type CompiledQuery,
  CompiledQuerySchema,
  FACET_NAMES,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  type RunRequest,
  RunRequestSchema,
  RunSnapshot,
  type RunState,
  type Snapshot,
  type TraceClassification,
  TraceClassificationSchema,
  TraceDetail,
  type TraceProjection,
  TraceProjectionSchema,
  TraceRecord,
} from "./models.js";
import type { PlanningResult } from "./planner.js";
import { mergeNumeric } from "./planner.js";
import { withLoadReporter } from "./progress.js";
import { projectTrace } from "./projection.js";

type FacetKey = Exclude<keyof FacetSelection, "projectId">;
const nativeFacet = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as FacetKey;
const number = (value: number) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function mergeRunFacets(
  caller: FacetSelection,
  generated: FacetSelection,
): FacetSelection {
  return new FacetSelection({
    ...Object.fromEntries(
      FACET_NAMES.map((name) => {
        const key = nativeFacet(name);
        return [key, caller[key].size ? caller[key] : generated[key]];
      }),
    ),
    projectId: caller.projectId,
  });
}
export function withinFacets(
  trace: TraceRecord,
  facets: FacetSelection,
): boolean {
  return FACET_NAMES.every((name) => {
    const key = nativeFacet(name),
      selected = facets[key];
    if (!selected.size) return true;
    const values = key === "toolName" ? trace.toolNames : [trace[key]];
    return values.some((value) => selected.has(value));
  });
}
export function withinNumeric(
  trace: TraceRecord,
  bounds: NumericFilters,
): boolean {
  return (
    [
      [trace.totalTokens, bounds.tokensMin, bounds.tokensMax],
      [trace.durationMs, bounds.durationMsMin, bounds.durationMsMax],
    ] as const
  ).every(
    ([value, low, high]) =>
      (low === null && high === null) ||
      (value !== null &&
        (low === null || value >= low) &&
        (high === null || value <= high)),
  );
}
export function narrowTraces(
  traces: readonly TraceRecord[],
  facets: FacetSelection,
  bounds: NumericFilters,
  population?: PopulationRequest | null,
): TraceRecord[] {
  return traces.filter(
    (trace) =>
      withinFacets(trace, facets) &&
      withinNumeric(trace, bounds) &&
      (!population || population.containsTime(trace.timestamp)),
  );
}
export function nothingKeptMessage(
  traces: readonly TraceRecord[],
  facets: FacetSelection,
  bounds: NumericFilters,
): string {
  const reasons: string[] = [];
  for (const name of FACET_NAMES) {
    const selected = facets[nativeFacet(name)];
    if (
      selected.size &&
      !traces.every((trace) =>
        withinFacets(
          trace,
          new FacetSelection({ [nativeFacet(name)]: selected }),
        ),
      )
    )
      reasons.push(
        `${name.replaceAll("_", " ")} ${[...selected].sort(codepointCompare).join(" or ")}`,
      );
  }
  const tokens = traces.flatMap((t) =>
      t.totalTokens === null ? [] : [t.totalTokens],
    ),
    durations = traces.flatMap((t) =>
      t.durationMs === null ? [] : [t.durationMs],
    );
  const fields = [
    ["tokensMin", tokens, "at least", "tokens", "the largest has", Math.max],
    ["tokensMax", tokens, "at most", "tokens", "the smallest has", Math.min],
    [
      "durationMsMin",
      durations,
      "a duration of at least",
      "ms",
      "the longest took",
      Math.max,
    ],
    [
      "durationMsMax",
      durations,
      "a duration of at most",
      "ms",
      "the shortest took",
      Math.min,
    ],
  ] as const;
  for (const [field, values, description, unit, nearest, choose] of fields) {
    const bound = bounds[field];
    if (
      bound !== null &&
      !traces.every((trace) =>
        withinNumeric(trace, new NumericFilters({ [field]: bound })),
      )
    )
      reasons.push(
        `${description} ${number(bound)} ${unit}${values.length ? ` (${nearest} ${number(values.reduce((a, b) => choose(a, b)))})` : ""}`,
      );
  }
  return `None of the ${number(traces.length)} loaded traces have ${reasons.join(" and ") || "the filters in the question"}. Try New search to look beyond the loaded rows.`;
}

const numericQueryWords = new Set(
  "all any and are between calls conversations duration faster fewer find for get has have least less list longer milliseconds minutes more most over requests runs second seconds show shorter slower than that the them those total trace traces token tokens under used using which with above below took taking".split(
    " ",
  ),
);
export function unsupportedWarning(reason: string | null): string | null {
  return reason === null
    ? null
    : `Ask AI finds traces; it can't compute totals, averages or rankings. ${reason}`;
}
export function uncoveredWordsWarning(
  query: string,
  dimensions: readonly unknown[],
  filters: FacetSelection,
): string | null {
  if (
    dimensions.length ||
    FACET_NAMES.some((name) => filters[nativeFacet(name)].size)
  )
    return null;
  const words = [
    ...new Set(
      (pythonCasefold(query).match(/[a-z]{3,}/g) ?? []).filter(
        (word) => !numericQueryWords.has(word),
      ),
    ),
  ];
  return words.length
    ? `Only the numeric bounds were applied. No AI question or filter covers "${words.join(" ")}", so rephrase the question or use Review to add one.`
    : null;
}

export interface RunStoreOptions {
  populationLoader: (
    request: PopulationRequest,
    signal: AbortSignal,
  ) => Promise<Snapshot>;
  runClassifier: (
    traces: readonly TraceRecord[],
    projections: Readonly<Record<string, TraceProjection>>,
    dimensions: readonly CompiledQuery[],
    options: {
      parallelism: number;
      onComplete: (classification: TraceClassification) => Promise<void>;
      questionPayloads: Readonly<Record<string, ClassifyQuestion>>;
      signal: AbortSignal;
    },
  ) => Promise<unknown>;
  planner?: (
    query: string,
    population: PopulationRequest,
    options: { withinResults: boolean; signal: AbortSignal },
  ) => Promise<PlanningResult>;
  compiler?: (query: string, signal: AbortSignal) => Promise<CompiledPlan>;
  filterSelector?: (
    query: string,
    population: PopulationRequest,
    signal: AbortSignal,
  ) => Promise<FacetSelection | FilterSelectionResult>;
  projectTrace?: (
    trace: TraceRecord,
    options: { questionPayloads: Readonly<Record<string, ClassifyQuestion>> },
  ) => TraceProjection | Promise<TraceProjection>;
  monotonic?: () => number;
  nowUtc?: () => string;
  close?: () => void | Promise<void>;
  explorer?: ExplorerStore;
  classifierModel?: string | null;
}
export interface CompileOptions {
  wait?: boolean;
  traces?: (signal: AbortSignal) => Promise<readonly TraceRecord[]>;
  tracesLimited?: (
    limit: number,
    signal: AbortSignal,
  ) => Promise<readonly TraceRecord[]>;
  table?: (
    population: PopulationRequest,
    signal: AbortSignal,
  ) => Promise<readonly TraceRecord[]>;
  sourceGeneration?: () => number | null;
  signal?: AbortSignal;
}
interface RunTask {
  controller: AbortController;
  promise: Promise<unknown>;
  settled: boolean;
}
function runTask(
  work: (signal: AbortSignal) => Promise<unknown>,
  external?: AbortSignal,
): RunTask {
  const controller = new AbortController();
  const signal = external
    ? AbortSignal.any([controller.signal, external])
    : controller.signal;
  const task: RunTask = {
    controller,
    settled: false,
    promise: Promise.resolve().then(() => work(signal)),
  };
  void task.promise.then(
    () => {
      task.settled = true;
    },
    () => {
      task.settled = true;
    },
  );
  return task;
}
async function waitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    await Promise.allSettled([promise]);
    throw signal.reason;
  }
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  } catch (error) {
    if (signal.aborted) await Promise.allSettled([promise]);
    throw error;
  }
}
function detachedRun(snapshot: RunSnapshot): RunSnapshot {
  return new RunSnapshot({
    ...snapshot,
    request:
      snapshot.request === null
        ? null
        : RunRequestSchema.parse(snapshot.request),
    dimensions:
      snapshot.dimensions?.map((value) =>
        CompiledQuerySchema.parse(structuredClone(value)),
      ) ?? null,
    explicitFilters: new FacetSelection(snapshot.explicitFilters),
    explicitNumeric: new NumericFilters(snapshot.explicitNumeric),
    generatedFilters: new FacetSelection(snapshot.generatedFilters),
    generatedNumeric: new NumericFilters(snapshot.generatedNumeric),
    filterResponse:
      snapshot.filterResponse === null
        ? null
        : ClassifyResponseSchema.parse(
            structuredClone(snapshot.filterResponse),
          ),
    traces: snapshot.traces.map(
      (trace) => new TraceRecord(structuredClone(trace)),
    ),
    results: Object.fromEntries(
      Object.entries(snapshot.results).map(([id, value]) => [
        id,
        TraceClassificationSchema.parse(structuredClone(value)),
      ]),
    ),
    projections: Object.fromEntries(
      Object.entries(snapshot.projections).map(([id, value]) => [
        id,
        TraceProjectionSchema.parse(structuredClone(value)),
      ]),
    ),
    provenance: { ...snapshot.provenance },
    traceIds: [...snapshot.traceIds],
  });
}
export class RunStore {
  readonly explorer: ExplorerStore | null;
  private current = new RunSnapshot();
  private generation = 0;
  private task: RunTask | null = null;
  private stoppedGeneration: number | null = null;
  private started: number | null = null;
  private closed = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private closeCallback: RunStoreOptions["close"];
  constructor(private readonly options: RunStoreOptions) {
    if (!options.planner && (!options.compiler || !options.filterSelector))
      throw new Error(
        "a shared planner or legacy compiler and filter selector are required",
      );
    this.closeCallback = options.close;
    this.explorer = options.explorer ?? null;
  }
  private now(): string {
    return this.options.nowUtc?.() ?? new Date().toISOString();
  }
  private clock(): number {
    return this.options.monotonic?.() ?? performance.now() / 1000;
  }
  private elapsed(): number {
    return this.started === null
      ? 0
      : this.current.state === "classifying"
        ? Math.max(0, this.clock() - this.started)
        : this.current.elapsed;
  }
  private view(detach = true): RunSnapshot {
    const current = this.current,
      elapsed = this.elapsed(),
      remaining = current.total - current.completed;
    const active =
      current.state === "classifying"
        ? Math.min(current.request?.parallelism ?? 0, remaining)
        : 0;
    const result = new RunSnapshot({
      ...current,
      active,
      queued: current.state === "classifying" ? remaining - active : 0,
      percent: current.total ? (current.completed / current.total) * 100 : 0,
      elapsed,
      rate: elapsed ? current.completed / elapsed : 0,
      classifierModel: this.options.classifierModel ?? null,
    });
    return detach ? detachedRun(result) : result;
  }
  private finish(state: RunState, error: string | null = null): void {
    this.current = new RunSnapshot({
      ...this.current,
      state,
      phase: null,
      error,
      finishedAt: this.now(),
      elapsed: this.elapsed(),
    });
  }
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.lifecycle;
    let release!: () => void;
    this.lifecycle = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private async stopCurrent(): Promise<void> {
    const task = this.task;
    if (!task || task.settled) return;
    this.stoppedGeneration = this.generation;
    if (
      this.current.state === "compiling" ||
      this.current.state === "classifying"
    )
      this.finish("cancelled");
    task.controller.abort();
    await Promise.allSettled([task.promise]);
  }
  async snapshot(): Promise<RunSnapshot> {
    return this.view();
  }
  async snapshotForRender(): Promise<RunSnapshot> {
    return this.view(false);
  }
  async traceDetail(id: string): Promise<TraceDetail | null> {
    if (!this.current.traceIds.includes(id)) return null;
    const trace = this.current.traces.find((item) => item.traceId === id);
    if (!trace) return null;
    return new TraceDetail(
      new TraceRecord(structuredClone(trace)),
      Object.hasOwn(this.current.projections, id)
        ? TraceProjectionSchema.parse(
            structuredClone(this.current.projections[id]),
          )
        : null,
      Object.hasOwn(this.current.results, id)
        ? TraceClassificationSchema.parse(
            structuredClone(this.current.results[id]),
          )
        : null,
      this.current.dimensions?.map((item) =>
        CompiledQuerySchema.parse(structuredClone(item)),
      ) ?? null,
    );
  }
  async cancel(): Promise<RunSnapshot> {
    return this.serialize(async () => {
      await this.stopCurrent();
      if (
        ["compiling", "awaiting_review", "classifying"].includes(
          this.current.state,
        )
      )
        this.finish("cancelled");
      this.task = null;
      return this.view();
    });
  }
  async reset(): Promise<RunSnapshot> {
    return this.serialize(async () => {
      if (this.closed) throw new Error("Trace finder store is closed.");
      await this.stopCurrent();
      this.current = new RunSnapshot({ generation: ++this.generation });
      this.task = null;
      this.started = null;
      return this.view();
    });
  }
  async close(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      this.closed = true;
      try {
        await this.stopCurrent();
        if (
          ["compiling", "awaiting_review", "classifying"].includes(
            this.current.state,
          )
        )
          this.finish("cancelled");
        this.task = null;
      } finally {
        try {
          await this.options.explorer?.close();
        } finally {
          const close = this.closeCallback;
          this.closeCallback = undefined;
          await close?.();
        }
      }
    });
  }
  async compile(
    request: RunRequest,
    options: CompileOptions = {},
  ): Promise<RunSnapshot> {
    return this.prepare(request, null, true, options);
  }
  async start(
    request: RunRequest,
    dimensions: readonly CompiledQuery[],
    options: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<RunSnapshot> {
    return this.prepare(request, dimensions, false, options);
  }
  private async prepare(
    request: RunRequest,
    dimensions: readonly CompiledQuery[] | null,
    compileQuery: boolean,
    options: CompileOptions,
  ): Promise<RunSnapshot> {
    const [generation, staged] = await this.serialize(async () => {
      if (this.closed) throw new Error("Trace finder store is closed.");
      await this.stopCurrent();
      const previous = this.current,
        review =
          !compileQuery &&
          previous.state === "awaiting_review" &&
          previous.request !== null;
      const staged =
        review &&
        isDeepStrictEqual(previous.request?.population, request.population)
          ? previous.traces
          : [];
      let explicitFilters = request.population.facets,
        explicitNumeric = request.population.numeric;
      if (review && previous.request) {
        const before = previous.request.population;
        explicitFilters = new FacetSelection({
          ...Object.fromEntries(
            FACET_NAMES.map((name) => {
              const key = nativeFacet(name);
              return [
                key,
                isDeepStrictEqual(explicitFilters[key], before.facets[key])
                  ? previous.explicitFilters[key]
                  : explicitFilters[key],
              ];
            }),
          ),
          projectId:
            explicitFilters.projectId === before.facets.projectId
              ? previous.explicitFilters.projectId
              : explicitFilters.projectId,
        });
        explicitNumeric = new NumericFilters(
          Object.fromEntries(
            (
              [
                "tokensMin",
                "tokensMax",
                "durationMsMin",
                "durationMsMax",
              ] as const
            ).map((key) => [
              key,
              explicitNumeric[key] === before.numeric[key]
                ? previous.explicitNumeric[key]
                : explicitNumeric[key],
            ]),
          ),
        );
      }
      const generation = ++this.generation;
      this.current = new RunSnapshot({
        generation,
        state: "compiling",
        phase: compileQuery ? "planning" : "starting_classification",
        request: RunRequestSchema.parse(request),
        withinResults: compileQuery
          ? Boolean(options.traces || options.tracesLimited || options.table)
          : previous.withinResults,
        explicitFilters,
        explicitNumeric,
        generatedFilters: compileQuery
          ? new FacetSelection()
          : previous.generatedFilters,
        generatedNumeric: compileQuery
          ? new NumericFilters()
          : previous.generatedNumeric,
        filterResponse: compileQuery ? null : previous.filterResponse,
        filterSelectionError: compileQuery
          ? null
          : previous.filterSelectionError,
        planWarning: compileQuery ? null : previous.planWarning,
        generatedTime: compileQuery ? null : previous.generatedTime,
        provenance: compileQuery ? {} : previous.provenance,
        createdAt: this.now(),
      });
      this.started = null;
      this.task = null;
      return [generation, staged] as const;
    });
    const task = runTask(
      (signal) =>
        this.planAndStart(
          generation,
          staged,
          request,
          dimensions,
          compileQuery,
          options,
          signal,
        ),
      options.signal,
    );
    if (generation !== this.generation || this.current.state !== "compiling") {
      task.controller.abort();
      await Promise.allSettled([task.promise]);
      return this.view();
    }
    this.task = task;
    if (options.wait === false) return this.view();
    await task.promise;
    return this.view();
  }
  private async planAndStart(
    generation: number,
    stagedInput: readonly TraceRecord[],
    original: RunRequest,
    initialDimensions: readonly CompiledQuery[] | null,
    compileQuery: boolean,
    options: CompileOptions,
    signal: AbortSignal,
  ): Promise<void> {
    let request = RunRequestSchema.parse(original),
      dimensions =
        initialDimensions?.map((value) =>
          CompiledQuerySchema.parse(structuredClone(value)),
        ) ?? null,
      staged = [...stagedInput];
    const valid = () =>
      generation === this.generation &&
      this.current.state === "compiling" &&
      !signal.aborted;
    const explorerGeneration =
      (options.traces || options.tracesLimited) && this.options.explorer
        ? (await this.options.explorer.view()).generation
        : null;
    try {
      signal.throwIfAborted();
      let generatedFilters = this.current.generatedFilters,
        generatedNumeric = this.current.generatedNumeric,
        filterResponse = this.current.filterResponse,
        filterError = this.current.filterSelectionError,
        warning = this.current.planWarning,
        generatedTime = this.current.generatedTime,
        provenance = this.current.provenance,
        effectivePopulation = request.population,
        emptyMatch = false,
        unsupported: string | null = null;
      if (compileQuery) {
        if (this.options.planner) {
          const result = await waitAbortable(
            this.options.planner(request.query, request.population, {
              withinResults: Boolean(
                options.traces || options.tracesLimited || options.table,
              ),
              signal,
            }),
            signal,
          );
          generatedFilters = result.generatedFacets;
          generatedNumeric = result.generatedNumeric;
          dimensions = result.dimensions.map((value) =>
            CompiledQuerySchema.parse(structuredClone(value)),
          );
          filterResponse = result.selectorResponse;
          filterError = result.selectorError;
          effectivePopulation = result.effectivePopulation;
          generatedTime = result.generatedTime;
          provenance = result.provenance;
          emptyMatch = result.emptyMatch;
          unsupported = result.unsupportedReason;
          request = RunRequestSchema.parse({
            ...request,
            population: effectivePopulation,
          });
        } else {
          if (!this.options.compiler || !this.options.filterSelector)
            throw new Error("legacy compiler and filter selector are required");
          const child = new AbortController();
          const childSignal = AbortSignal.any([signal, child.signal]);
          const tasks = [
            this.options.compiler(request.query, childSignal),
            this.options.filterSelector(
              request.query,
              request.population,
              childSignal,
            ),
          ] as const;
          let plan: CompiledPlan,
            selection: FacetSelection | FilterSelectionResult;
          try {
            [plan, selection] = await waitAbortable(Promise.all(tasks), signal);
          } finally {
            child.abort();
            await Promise.allSettled(tasks);
          }
          const selected =
            selection instanceof FilterSelectionResult
              ? selection
              : new FilterSelectionResult(
                  selection instanceof FacetSelection
                    ? selection
                    : new FacetSelection(selection),
                );
          generatedFilters = selected.selection;
          generatedNumeric = plan.numeric;
          dimensions = plan.dimensions.map((value) =>
            CompiledQuerySchema.parse(structuredClone(value)),
          );
          filterResponse = selected.response;
          filterError = selected.error;
          unsupported = plan.unsupportedReason;
          if (!options.traces && !options.tracesLimited)
            request = RunRequestSchema.parse({
              ...request,
              population: new PopulationRequest({
                ...request.population,
                facets: mergeRunFacets(
                  request.population.facets,
                  generatedFilters,
                ),
                numeric: mergeNumeric(
                  request.population.numeric,
                  generatedNumeric,
                ),
              }),
            });
        }
        warning =
          unsupportedWarning(unsupported) ??
          uncoveredWordsWarning(
            request.query,
            dimensions ?? [],
            generatedFilters,
          );
      } else if (!dimensions)
        throw new Error(
          "reviewed classifier dimensions are required to start a run",
        );
      if (options.table)
        request = RunRequestSchema.parse({
          ...request,
          population: new PopulationRequest({
            ...request.population,
            facets: mergeRunFacets(request.population.facets, generatedFilters),
            numeric: mergeNumeric(request.population.numeric, generatedNumeric),
          }),
        });
      if (!valid()) return;
      this.current = new RunSnapshot({
        ...this.current,
        dimensions,
        generatedFilters,
        generatedNumeric,
        filterResponse,
        filterSelectionError: filterError,
        planWarning: warning,
        generatedTime,
        provenance,
        request,
      });
      if (
        compileQuery &&
        !emptyMatch &&
        unsupported !== null &&
        !dimensions?.length &&
        isDeepStrictEqual(generatedFilters, new FacetSelection()) &&
        isDeepStrictEqual(generatedNumeric, new NumericFilters())
      ) {
        this.finish("cancelled");
        this.task = null;
        return;
      }
      if (emptyMatch) {
        this.current = new RunSnapshot({
          ...this.current,
          traceIds: [],
          traces: [],
          total: 0,
          completed: 0,
          results: {},
          planWarning: filterError
            ? `Trace filter selection failed; no traces were selected: ${filterError}`
            : "The query time window does not overlap the loaded results; no traces were selected.",
        });
        this.finish("completed");
        this.task = null;
        return;
      }
      this.current = new RunSnapshot({
        ...this.current,
        phase: staged.length ? "starting_classification" : "loading_traces",
      });
      if (!staged.length) {
        if (options.traces || options.tracesLimited || options.table) {
          const useLimited = Boolean(
            options.tracesLimited &&
              isDeepStrictEqual(generatedFilters, new FacetSelection()) &&
              isDeepStrictEqual(generatedNumeric, new NumericFilters()) &&
              generatedTime === null,
          );
          const promise = withLoadReporter(
            (done, total) => {
              if (valid())
                this.current = new RunSnapshot({
                  ...this.current,
                  loaded: done,
                  toLoad: total,
                });
            },
            () =>
              useLimited && options.tracesLimited
                ? options.tracesLimited(request.population.limit, signal)
                : options.traces
                  ? options.traces(signal)
                  : options.table
                    ? options.table(request.population, signal)
                    : Promise.reject(
                        new Error("a trace or table loader is required"),
                      ),
          );
          const loaded = [...(await waitAbortable(promise, signal))];
          if (!valid()) return;
          this.current = new RunSnapshot({
            ...this.current,
            explorerGeneration: options.sourceGeneration
              ? options.sourceGeneration()
              : explorerGeneration,
            loaded: loaded.length,
            toLoad: loaded.length,
          });
          staged =
            options.traces && !useLimited
              ? narrowTraces(
                  loaded,
                  generatedFilters,
                  generatedNumeric,
                  generatedTime !== null ? effectivePopulation : null,
                )
              : loaded;
          if (
            options.traces &&
            !useLimited &&
            explorerGeneration !== null &&
            this.options.explorer &&
            !isDeepStrictEqual(staged, loaded)
          )
            await this.options.explorer.narrow(
              explorerGeneration,
              staged.map((trace) => trace.traceId),
              {
                facets: mergeRunFacets(
                  request.population.facets,
                  generatedFilters,
                ),
                numeric: mergeNumeric(
                  request.population.numeric,
                  generatedNumeric,
                ),
              },
            );
          staged = staged.slice(0, request.population.limit);
          if (
            (options.traces || options.tracesLimited) &&
            this.options.explorer &&
            explorerGeneration !== null
          )
            await this.options.explorer.retainRecords(
              explorerGeneration,
              staged.map((trace) => trace.traceId),
            );
          if (loaded.length && !staged.length) {
            if (valid()) {
              this.current = new RunSnapshot({
                ...this.current,
                planWarning: nothingKeptMessage(
                  loaded,
                  generatedFilters,
                  generatedNumeric,
                ),
              });
              this.finish("completed");
              this.task = null;
            }
            return;
          }
        } else {
          const loaded = await waitAbortable(
            withLoadReporter(
              (done, total) => {
                if (valid())
                  this.current = new RunSnapshot({
                    ...this.current,
                    loaded: done,
                    toLoad: total,
                  });
              },
              () => this.options.populationLoader(request.population, signal),
            ),
            signal,
          );
          staged = [...loaded.traces.slice(0, request.population.limit)];
        }
      }
      if (!valid()) return;
      if (!staged.length)
        throw new Error(
          options.traces || options.tracesLimited
            ? "None of the loaded traces have usable messages to classify."
            : "No traces match the classifier-selected filters.",
        );
      const ids = staged.map((trace) => trace.traceId);
      if (new Set(ids).size !== ids.length)
        throw new Error(
          "The selected population contains duplicate trace IDs.",
        );
      this.current = new RunSnapshot({
        ...this.current,
        traceIds: ids,
        traces: staged.map((trace) => new TraceRecord(structuredClone(trace))),
        total: staged.length,
      });
      if (compileQuery && request.mode === "review") {
        this.current = new RunSnapshot({
          ...this.current,
          state: "awaiting_review",
          phase: null,
        });
        this.task = null;
        return;
      }
      const payloads = classifierQuestions(dimensions ?? []),
        project = this.options.projectTrace ?? projectTrace;
      const entries: [string, TraceProjection][] = [];
      for (const trace of staged) {
        const value = await project(trace, { questionPayloads: payloads });
        if (!valid()) return;
        entries.push([trace.traceId, value]);
      }
      const projections = Object.fromEntries(entries);
      this.current = new RunSnapshot({
        ...this.current,
        projections,
        state: "classifying",
        phase: null,
        startedAt: this.now(),
      });
      this.started = this.clock();
      this.task = runTask((sig) =>
        this.execute(
          generation,
          staged,
          projections,
          dimensions ?? [],
          request.parallelism,
          payloads,
          sig,
        ),
      );
    } catch (error) {
      if (signal.aborted) {
        if (this.stoppedGeneration === generation) return;
        if (
          generation === this.generation &&
          this.current.state === "compiling"
        ) {
          this.finish("cancelled");
          this.task = null;
        }
        throw error;
      }
      if (generation === this.generation) {
        this.finish(
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        this.task = null;
      }
    }
  }
  async completeOne(
    generation: number,
    classification: TraceClassification,
  ): Promise<void> {
    const current = this.current;
    if (
      generation !== this.generation ||
      current.state !== "classifying" ||
      Object.hasOwn(current.results, classification.traceId)
    )
      return;
    try {
      if (current.completed >= current.total)
        throw new Error("Terminal callbacks would exceed the run total.");
      if (!current.traceIds.includes(classification.traceId))
        throw new Error(
          "Terminal callback trace ID is outside the selected population.",
        );
      const result = TraceClassificationSchema.parse(
          structuredClone(classification),
        ),
        results = { ...current.results, [classification.traceId]: result };
      this.current = new RunSnapshot({
        ...current,
        results,
        completed: Object.keys(results).length,
        failed: current.failed + Number(result.error !== null),
        matched:
          current.matched + Number(result.matched && result.error === null),
      });
    } catch (error) {
      this.finish(
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
  private async execute(
    generation: number,
    traces: readonly TraceRecord[],
    projections: Readonly<Record<string, TraceProjection>>,
    dimensions: readonly CompiledQuery[],
    parallelism: number,
    questionPayloads: Readonly<Record<string, ClassifyQuestion>>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await waitAbortable(
        this.options.runClassifier(traces, projections, dimensions, {
          parallelism,
          onComplete: (classification) =>
            this.completeOne(generation, classification),
          questionPayloads,
          signal,
        }),
        signal,
      );
      if (
        generation === this.generation &&
        this.current.state === "classifying"
      ) {
        if (this.current.completed !== this.current.total)
          throw new Error(
            "The classifier returned before all traces completed.",
          );
        this.finish("completed");
      }
    } catch (error) {
      if (
        generation === this.generation &&
        this.current.state === "classifying"
      )
        this.finish(
          signal.aborted ? "cancelled" : "failed",
          signal.aborted
            ? null
            : error instanceof Error
              ? error.message
              : String(error),
        );
      if (signal.aborted) throw error;
    }
  }
}
