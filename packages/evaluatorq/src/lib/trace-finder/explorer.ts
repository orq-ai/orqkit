import { isDeepStrictEqual } from "node:util";

import { codepointCompare, pythonStrip } from "../common/sanitize.js";
import { pythonFloatSum } from "../formats/shared.js";
import { COLUMNS, MATCH, sortRows } from "./columns.js";
import {
  FacetSelection,
  NumericFilters,
  type RunSnapshot,
  type TraceClassification,
  type TraceRecord,
  timeMicros,
} from "./models.js";
import { TraceRow } from "./rows.js";

export type ViewMode = "table" | "trajectories";
export type QuickView =
  | "all"
  | "errors"
  | "matches"
  | "slow"
  | "costly"
  | "tokens"
  | "context"
  | "conv_costly"
  | "conv_tokens"
  | "conv_longest";
export const QUICK_VIEWS: ReadonlySet<string> = new Set([
  "all",
  "errors",
  "matches",
  "slow",
  "costly",
  "tokens",
  "context",
  "conv_costly",
  "conv_tokens",
  "conv_longest",
]);
export const TOP_SHARE = 0.1;
export type RowMetric = (row: TraceRow) => number | null;
export type ConversationMetric = (
  rows: readonly TraceRow[],
  messageCounts: Readonly<Record<string, number>>,
) => number | null;
export function totalTokens(row: TraceRow): number | null {
  return row.tokensIn === null && row.tokensOut === null
    ? null
    : (row.tokensIn ?? 0) + (row.tokensOut ?? 0);
}
export const TOP_METRICS: Readonly<
  Record<string, readonly [string, RowMetric]>
> = Object.freeze({
  slow: ["duration", (row) => row.durationMs],
  costly: ["cost", (row) => row.costTotal],
  tokens: ["total tokens", totalTokens],
  context: ["largest prompt", (row) => row.contextTokens],
});
export const CONVERSATION_METRICS: Readonly<
  Record<string, readonly [string, ConversationMetric]>
> = Object.freeze({
  conv_costly: [
    "cost",
    (rows) =>
      sumKnown(
        rows.map((row) => row.costTotal),
        true,
      ),
  ],
  conv_tokens: ["total tokens", (rows) => sumKnown(rows.map(totalTokens))],
  conv_longest: [
    "messages",
    (rows, counts) => {
      const values = rows
        .filter((row) => Object.hasOwn(counts, row.traceId))
        .map((row) => counts[row.traceId] as number);
      return values.length
        ? values.reduce((largest, value) => Math.max(largest, value), -Infinity)
        : null;
    },
  ],
});
export function aiMatched(
  result: TraceClassification | null | undefined,
): boolean {
  return Boolean(result?.matched && result.answers.length > 0);
}
export function conversationKey(row: TraceRow): string | null {
  return row.threadId || row.sessionId;
}
export function topConversations(
  rows: readonly TraceRow[],
  metric: ConversationMetric,
  messageCounts: Readonly<Record<string, number>> = {},
): readonly TraceRow[] {
  const grouped = new Map<string, TraceRow[]>();
  for (const row of rows) {
    const key = conversationKey(row);
    if (key !== null) {
      const group = grouped.get(key);
      if (group) group.push(row);
      else grouped.set(key, [row]);
    }
  }
  const valued: [number, TraceRow[]][] = [];
  for (const conversation of grouped.values()) {
    const value = metric(conversation, messageCounts);
    if (value !== null)
      valued.push([
        value,
        [...conversation].sort((a, b) =>
          a.startedAt === null
            ? b.startedAt === null
              ? 0
              : 1
            : b.startedAt === null
              ? -1
              : timeMicros(a.startedAt) < timeMicros(b.startedAt)
                ? -1
                : timeMicros(a.startedAt) > timeMicros(b.startedAt)
                  ? 1
                  : 0,
        ),
      ]);
  }
  valued.sort((a, b) => b[0] - a[0]);
  return Object.freeze(
    valued
      .slice(0, Math.ceil(valued.length * TOP_SHARE))
      .flatMap(([, conversation]) => conversation),
  );
}
export function topShare(
  rows: readonly TraceRow[],
  metric: RowMetric,
): readonly TraceRow[] {
  const valued = rows.filter((row) => metric(row) !== null);
  valued.sort((a, b) => (metric(b) ?? 0) - (metric(a) ?? 0));
  return Object.freeze(valued.slice(0, Math.ceil(valued.length * TOP_SHARE)));
}
export interface Totals {
  readonly traces: number;
  readonly errors: number;
  readonly cost: number | null;
  readonly currency: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cacheShare: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}
export function sumKnown(
  values: readonly (number | null)[],
  floats = false,
): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length
    ? floats
      ? pythonFloatSum(known)
      : known.reduce((sum, value) => sum + value, 0)
    : null;
}
export function nearestRank(
  sortedValues: readonly number[],
  quantile: number,
): number | null {
  if (!sortedValues.length) return null;
  if (!Number.isFinite(quantile))
    throw new RangeError("quantile must be finite");
  const index = Math.max(0, Math.ceil(quantile * sortedValues.length) - 1);
  if (index >= sortedValues.length)
    throw new RangeError("percentile rank is out of range");
  return sortedValues[index] as number;
}

export function totals(rows: readonly TraceRow[]): Totals {
  const currencies = new Set(
      rows.filter((row) => row.costTotal !== null).map((row) => row.currency),
    ),
    cost =
      currencies.size <= 1
        ? sumKnown(
            rows.map((row) => row.costTotal),
            true,
          )
        : null,
    cachedRows = rows.filter(
      (row) => Boolean(row.tokensIn) && row.cachedTokens !== null,
    ),
    cachedInput = cachedRows.reduce((sum, row) => sum + (row.tokensIn ?? 0), 0),
    durations = rows
      .flatMap((row) => (row.durationMs === null ? [] : [row.durationMs]))
      .sort((a, b) => a - b);
  return Object.freeze({
    traces: rows.length,
    errors: rows.filter((row) => row.isError).length,
    cost,
    currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    tokensIn: sumKnown(rows.map((row) => row.tokensIn)),
    tokensOut: sumKnown(rows.map((row) => row.tokensOut)),
    cacheShare: cachedInput
      ? cachedRows.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0) /
        cachedInput
      : null,
    p50Ms: nearestRank(durations, 0.5),
    p95Ms: nearestRank(durations, 0.95),
  });
}
export type ExplorerState = "idle" | "loading" | "loaded" | "failed";
export const PAGE_ROWS = 100;
export interface ExplorerViewFields {
  readonly generation: number;
  readonly version: number;
  readonly state: ExplorerState;
  readonly initialLoad: boolean;
  readonly trajectoryWarming: boolean;
  readonly rows: readonly TraceRow[];
  readonly limit: number;
  readonly start: string | null;
  readonly end: string | null;
  readonly facets: FacetSelection;
  readonly messageCounts: Readonly<Record<string, number>>;
  readonly messageCounting: boolean;
  readonly messageCountError: string | null;
  readonly numeric: NumericFilters;
  readonly error: string | null;
  readonly sort: string | null;
  readonly descending: boolean;
  readonly page: number;
  readonly view: ViewMode;
  readonly showToolDefinitions: boolean;
  readonly matchedOnly: boolean;
  readonly quickView: QuickView;
  readonly narrowedFrom: number | null;
}
export class ExplorerView implements ExplorerViewFields {
  declare readonly generation: number;
  declare readonly version: number;
  declare readonly state: ExplorerState;
  declare readonly initialLoad: boolean;
  declare readonly trajectoryWarming: boolean;
  declare readonly rows: readonly TraceRow[];
  declare readonly limit: number;
  declare readonly start: string | null;
  declare readonly end: string | null;
  declare readonly facets: FacetSelection;
  declare readonly messageCounts: Readonly<Record<string, number>>;
  declare readonly messageCounting: boolean;
  declare readonly messageCountError: string | null;
  declare readonly numeric: NumericFilters;
  declare readonly error: string | null;
  declare readonly sort: string | null;
  declare readonly descending: boolean;
  declare readonly page: number;
  declare readonly view: ViewMode;
  declare readonly showToolDefinitions: boolean;
  declare readonly matchedOnly: boolean;
  declare readonly quickView: QuickView;
  declare readonly narrowedFrom: number | null;
  constructor(input: Partial<ExplorerViewFields> = {}) {
    Object.assign(
      this,
      {
        generation: 0,
        version: 0,
        state: "idle",
        initialLoad: false,
        trajectoryWarming: false,
        rows: [],
        limit: 0,
        start: null,
        end: null,
        facets: new FacetSelection(),
        messageCounts: {},
        messageCounting: false,
        messageCountError: null,
        numeric: new NumericFilters(),
        error: null,
        sort: null,
        descending: true,
        page: 0,
        view: "table",
        showToolDefinitions: false,
        matchedOnly: false,
        quickView: "all",
        narrowedFrom: null,
      },
      input,
      {
        rows: Object.freeze([...(input.rows ?? [])]),
        messageCounts: Object.freeze({ ...input.messageCounts }),
      },
    );
    Object.freeze(this);
  }
  visibleRows(
    results: Readonly<Record<string, TraceClassification>> | null = null,
  ): readonly TraceRow[] {
    let rows = this.rows;
    if (this.quickView === "errors") rows = rows.filter((row) => row.isError);
    else if (this.quickView === "matches")
      rows = rows.filter(
        (row) =>
          results !== null &&
          Object.hasOwn(results, row.traceId) &&
          aiMatched(results[row.traceId]),
      );
    else if (Object.hasOwn(TOP_METRICS, this.quickView))
      rows = topShare(
        rows,
        (TOP_METRICS[this.quickView] as readonly [string, RowMetric])[1],
      );
    else if (Object.hasOwn(CONVERSATION_METRICS, this.quickView))
      rows = topConversations(
        rows,
        (
          CONVERSATION_METRICS[this.quickView] as readonly [
            string,
            ConversationMetric,
          ]
        )[1],
        this.messageCounts,
      );
    if (this.matchedOnly && results !== null)
      rows = rows.filter(
        (row) =>
          Object.hasOwn(results, row.traceId) &&
          Boolean(results[row.traceId]?.matched),
      );
    return this.sort === null
      ? rows
      : sortRows(rows, this.sort, { descending: this.descending, results });
  }
  pageCount(
    results: Readonly<Record<string, TraceClassification>> | null = null,
  ): number {
    return Math.max(1, Math.ceil(this.visibleRows(results).length / PAGE_ROWS));
  }
  pageRows(
    results: Readonly<Record<string, TraceClassification>> | null = null,
  ): readonly TraceRow[] {
    const visible = this.visibleRows(results),
      start =
        Math.min(
          this.page,
          Math.max(1, Math.ceil(visible.length / PAGE_ROWS)) - 1,
        ) * PAGE_ROWS;
    return visible.slice(start, start + PAGE_ROWS);
  }
}
export function matchesFirstView(
  view: ExplorerView,
  snapshot: RunSnapshot | null,
): ExplorerView {
  if (
    snapshot?.withinResults &&
    snapshot.state === "completed" &&
    snapshot.dimensions?.length &&
    view.quickView === "all" &&
    view.sort === null
  ) {
    const matched = view.rows.filter(
        (row) =>
          Object.hasOwn(snapshot.results, row.traceId) &&
          aiMatched(snapshot.results[row.traceId]),
      ),
      unmatched = view.rows.filter(
        (row) =>
          !Object.hasOwn(snapshot.results, row.traceId) ||
          !aiMatched(snapshot.results[row.traceId]),
      );
    return new ExplorerView({ ...view, rows: [...matched, ...unmatched] });
  }
  return view;
}

export interface RowSearchOptions {
  start: string;
  end: string;
  limit: number;
  facets: FacetSelection;
  numeric: NumericFilters;
  onPage: (rows: readonly TraceRow[]) => void;
  signal?: AbortSignal;
}
export type RowSearch = (
  options: RowSearchOptions,
) => Promise<readonly TraceRow[]>;
export type RowHydrator = (
  rows: readonly TraceRow[],
) => Promise<Record<string, TraceRecord | null>>;
interface OwnedTask {
  controller: AbortController;
  promise: Promise<void>;
  settled: boolean;
}
interface Hydration {
  promise: Promise<Record<string, TraceRecord | null>>;
  settled: boolean;
}
let sequence = 1;
const nextSequence = () => sequence++;
const isAbort = (error: unknown, signal?: AbortSignal) =>
  Boolean(
    signal?.aborted ||
      (error !== null &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "AbortError"),
  );
function shield<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void task.then(
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
}
function ownTask(
  fn: (signal: AbortSignal) => Promise<void>,
  extraSignal?: AbortSignal,
): OwnedTask {
  const controller = new AbortController(),
    signal = extraSignal
      ? AbortSignal.any([controller.signal, extraSignal])
      : controller.signal;
  const owned: OwnedTask = {
    controller,
    promise: Promise.resolve().then(() => {
      signal.throwIfAborted();
      return fn(signal);
    }),
    settled: false,
  };
  void owned.promise.then(
    () => {
      owned.settled = true;
    },
    () => {
      owned.settled = true;
    },
  );
  return owned;
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export class ExplorerStore {
  private current = new ExplorerView();
  private task: OwnedTask | null = null;
  private prewarmTask: OwnedTask | null = null;
  private messageCountTask: OwnedTask | null = null;
  private cache = new Map<string, TraceRecord | null>();
  private hydrations = new Map<string, Hydration>();
  private preNarrow: ExplorerView | null = null;
  constructor(
    private readonly options: {
      search: RowSearch;
      hydrate: RowHydrator;
      loadSpans?: (traceId: string) => Promise<unknown[]>;
      loadFirstErrorMessage?: (
        traceId: string,
        spans: readonly unknown[],
      ) => Promise<string | null>;
    },
  ) {}
  async spans(traceId: string): Promise<unknown[]> {
    if (!this.options.loadSpans)
      throw new Error("Span loading is unavailable.");
    return this.options.loadSpans(traceId);
  }
  async firstErrorMessage(
    traceId: string,
    spans: readonly unknown[],
  ): Promise<string | null> {
    return this.options.loadFirstErrorMessage
      ? this.options.loadFirstErrorMessage(traceId, spans)
      : null;
  }
  async load(
    start: string,
    end: string,
    limit: number,
    options: {
      facets: FacetSelection;
      numeric: NumericFilters;
      wait?: boolean;
      warmTrajectories?: boolean;
      initialLoad?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ExplorerView> {
    await this.cancel();
    this.hydrations.clear();
    this.cache.clear();
    const generation = nextSequence();
    this.preNarrow = null;
    const previous = this.current,
      keptSort =
        previous.sort !== null && Object.hasOwn(COLUMNS, previous.sort)
          ? previous.sort
          : null;
    this.current = new ExplorerView({
      generation,
      version: generation,
      state: "loading",
      initialLoad: options.initialLoad ?? false,
      limit,
      start,
      end,
      facets: options.facets,
      numeric: options.numeric,
      view: previous.view,
      quickView: previous.quickView,
      sort: keptSort,
      descending: keptSort !== null ? previous.descending : true,
      showToolDefinitions: previous.showToolDefinitions,
    });
    const startPrewarm = (rows: readonly TraceRow[]) => {
      if (this.prewarmTask !== null || options.warmTrajectories === false)
        return;
      this.current = new ExplorerView({
        ...this.current,
        trajectoryWarming: true,
      });
      this.prewarmTask = ownTask(async (signal) => {
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, 0);
            const abort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
          });
          await this.records(
            rows.slice(0, PAGE_ROWS).map((row) => row.traceId),
            { signal },
          );
        } catch (error) {
          if (isAbort(error, signal)) throw error;
          console.warn(
            `Explorer trajectory prewarm failed: ${errorMessage(error)}`,
          );
        } finally {
          if (this.current.generation === generation)
            this.current = new ExplorerView({
              ...this.current,
              trajectoryWarming: false,
            });
        }
      });
    };
    const onPage = (rows: readonly TraceRow[]) => {
      if (this.current.generation === generation) {
        this.current = new ExplorerView({ ...this.current, rows });
        if (rows.length >= PAGE_ROWS) startPrewarm(rows);
      }
    };
    const task = ownTask(async (signal) => {
      try {
        const rows = await shield(
          this.options.search({
            start,
            end,
            limit,
            facets: options.facets,
            numeric: options.numeric,
            onPage,
            signal,
          }),
          signal,
        );
        if (this.current.generation === generation) {
          this.current = new ExplorerView({ ...this.current, rows });
          startPrewarm(rows);
          this.current = new ExplorerView({ ...this.current, state: "loaded" });
        }
      } catch (error) {
        if (isAbort(error, signal)) {
          if (
            this.current.generation === generation &&
            this.current.state === "loading"
          )
            this.current = new ExplorerView({
              ...this.current,
              state: "failed",
              error: "Loading was cancelled.",
            });
          throw error;
        }
        if (this.prewarmTask && !this.prewarmTask.settled) {
          this.prewarmTask.controller.abort();
          await Promise.allSettled([this.prewarmTask.promise]);
        }
        if (this.current.generation === generation) {
          console.warn(
            `Explorer load failed after ${this.current.rows.length} row(s): ${errorMessage(error)}`,
          );
          this.current = new ExplorerView({
            ...this.current,
            state: "failed",
            error: errorMessage(error),
            trajectoryWarming: false,
          });
        }
      }
    }, options.signal);
    this.task = task;
    if (options.wait) await task.promise;
    return this.current;
  }
  async view(): Promise<ExplorerView> {
    return this.current;
  }
  async setView(
    options: {
      sort?: string | null;
      descending?: boolean | null;
      page?: number | null;
      view?: ViewMode | null;
      showToolDefinitions?: boolean | null;
      matchedOnly?: boolean | null;
      quickView?: QuickView | null;
    } = {},
  ): Promise<ExplorerView> {
    const current = this.current,
      switching =
        options.quickView != null && options.quickView !== current.quickView;
    let updated = new ExplorerView({
      ...current,
      sort: options.sort ?? current.sort,
      descending: options.descending ?? current.descending,
      page:
        options.page != null
          ? Math.max(0, options.page)
          : switching
            ? 0
            : current.page,
      view: options.view ?? current.view,
      showToolDefinitions:
        options.showToolDefinitions ?? current.showToolDefinitions,
      matchedOnly: options.matchedOnly ?? current.matchedOnly,
      quickView: options.quickView ?? current.quickView,
      messageCountError:
        switching && options.quickView === "conv_longest"
          ? null
          : current.messageCountError,
    });
    if (
      (
        [
          "sort",
          "descending",
          "page",
          "view",
          "showToolDefinitions",
          "matchedOnly",
          "quickView",
        ] as const
      ).some((name) => updated[name] !== current[name])
    )
      updated = new ExplorerView({ ...updated, version: nextSequence() });
    this.current = updated;
    return updated;
  }
  async narrow(
    generation: number,
    keep: ReadonlySet<string> | readonly string[],
    options: { facets: FacetSelection; numeric: NumericFilters },
  ): Promise<void> {
    if (this.current.generation !== generation) return;
    const current = this.current;
    if (this.preNarrow === null) this.preNarrow = current;
    const wanted = keep instanceof Set ? keep : new Set(keep);
    let updated = new ExplorerView({
      ...current,
      narrowedFrom: current.narrowedFrom ?? current.rows.length,
      rows: current.rows.filter((row) => wanted.has(row.traceId)),
      facets: options.facets,
      numeric: options.numeric,
      page: 0,
    });
    if (!isDeepStrictEqual(updated, current))
      updated = new ExplorerView({ ...updated, version: nextSequence() });
    this.current = updated;
  }
  async restoreNarrowed(): Promise<ExplorerView> {
    const previous = this.preNarrow;
    if (previous === null || previous.generation !== this.current.generation)
      return this.current;
    this.preNarrow = null;
    const current = this.current;
    let updated = new ExplorerView({
      ...current,
      rows: previous.rows,
      facets: previous.facets,
      numeric: previous.numeric,
      narrowedFrom: null,
      page: 0,
      sort: current.sort === MATCH ? null : current.sort,
      descending: current.sort === MATCH ? true : current.descending,
    });
    if (!isDeepStrictEqual(updated, current))
      updated = new ExplorerView({ ...updated, version: nextSequence() });
    this.current = updated;
    return updated;
  }
  async clearAiViewState(): Promise<ExplorerView> {
    const current = this.current;
    let updated = new ExplorerView({
      ...current,
      sort: current.sort === MATCH ? null : current.sort,
      descending: current.sort === MATCH ? true : current.descending,
      matchedOnly: false,
      quickView: current.quickView === "matches" ? "all" : current.quickView,
      page: 0,
    });
    if (!isDeepStrictEqual(updated, current))
      updated = new ExplorerView({ ...updated, version: nextSequence() });
    this.current = updated;
    return updated;
  }
  async records(
    traceIds: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, TraceRecord | null>> {
    const generation = this.current.generation,
      requested = new Set(traceIds),
      wanted = this.current.rows.filter(
        (row) => requested.has(row.traceId) && !this.cache.has(row.traceId),
      );
    let key: string | null = null,
      task: Hydration | undefined;
    if (wanted.length) {
      key = JSON.stringify(
        wanted.map((row) => row.traceId).sort(codepointCompare),
      );
      task = this.hydrations.get(key);
      if (!task) {
        const created: Hydration = {
          promise: Promise.resolve().then(() => this.options.hydrate(wanted)),
          settled: false,
        };
        void created.promise.then(
          () => {
            created.settled = true;
          },
          () => {
            created.settled = true;
          },
        );
        this.hydrations.set(key, created);
        task = created;
      }
    }
    if (task) {
      let hydrated: Record<string, TraceRecord | null>;
      try {
        hydrated = await shield(task.promise, options.signal);
      } finally {
        if (key !== null && this.hydrations.get(key) === task && task.settled)
          this.hydrations.delete(key);
      }
      if (this.current.generation === generation) {
        for (const [id, value] of Object.entries(hydrated))
          if (
            !this.cache.has(id) ||
            (this.cache.get(id) === null && value !== null)
          )
            this.cache.set(id, value);
        const models = new Map<string, string>();
        for (const id of Object.keys(hydrated)) {
          const value = this.cache.get(id);
          if (value && value.model !== "" && value.model !== "unknown")
            models.set(id, value.model);
        }
        if (models.size) {
          let changed = false;
          const rows = this.current.rows.map((row) => {
            const model = models.get(row.traceId);
            if (row.models.length || model === undefined) return row;
            const values = model.split(",").map(pythonStrip).filter(Boolean);
            if (!values.length) return row;
            changed = true;
            return new TraceRow({ ...row, models: values });
          });
          if (changed)
            this.current = new ExplorerView({
              ...this.current,
              rows,
              version: nextSequence(),
            });
        }
        return Object.fromEntries(
          traceIds.map((id) => [id, this.cache.get(id) ?? null]),
        );
      }
      return Object.fromEntries(
        traceIds.map((id) => [
          id,
          Object.hasOwn(hydrated, id) ? (hydrated[id] ?? null) : null,
        ]),
      );
    }
    return Object.fromEntries(
      traceIds.map((id) => [id, this.cache.get(id) ?? null]),
    );
  }
  cachedRecords(
    traceIds: readonly string[],
  ): Record<string, TraceRecord | null> {
    return Object.fromEntries(
      traceIds.flatMap((id) =>
        this.cache.has(id) ? [[id, this.cache.get(id) ?? null]] : [],
      ),
    );
  }
  async retainRecords(
    generation: number,
    traceIds: ReadonlySet<string> | readonly string[],
  ): Promise<void> {
    if (this.current.generation !== generation) return;
    const keep = traceIds instanceof Set ? traceIds : new Set(traceIds);
    for (const id of this.cache.keys())
      if (!keep.has(id)) this.cache.delete(id);
  }
  async recordsUntilUsable(
    traceIds: readonly string[],
    options: { generation: number; limit: number },
  ): Promise<readonly [readonly TraceRecord[], number]> {
    const byId = new Map(this.current.rows.map((row) => [row.traceId, row])),
      rows = traceIds.flatMap((id) =>
        byId.has(id) ? [byId.get(id) as TraceRow] : [],
      ),
      usable: TraceRecord[] = [];
    let skipped = 0,
      position = 0;
    while (
      position < rows.length &&
      usable.length < options.limit &&
      this.current.generation === options.generation
    ) {
      const batch = rows.slice(
          position,
          position + options.limit - usable.length,
        ),
        records = await this.records(batch.map((row) => row.traceId));
      if (this.current.generation !== options.generation) break;
      for (const row of batch) {
        const record = Object.hasOwn(records, row.traceId)
          ? records[row.traceId]
          : null;
        if (record == null) skipped++;
        else usable.push(record);
      }
      position += batch.length;
      await this.retainRecords(
        options.generation,
        usable.map((record) => record.traceId),
      );
    }
    return [Object.freeze(usable), skipped];
  }
  async messageCounts(
    options: { signal?: AbortSignal } = {},
  ): Promise<ExplorerView> {
    const generation = this.current.generation,
      rows = this.current.rows,
      keep = new Set(this.cache.keys()),
      counts: Record<string, number> = Object.create(null) as Record<
        string,
        number
      >;
    for (let offset = 0; offset < rows.length; offset += PAGE_ROWS) {
      if (this.current.generation !== generation) break;
      const batch = rows.slice(offset, offset + PAGE_ROWS),
        records = await this.records(
          batch.map((row) => row.traceId),
          options,
        );
      if (this.current.generation !== generation) break;
      for (const [id, record] of Object.entries(records))
        if (record !== null) counts[id] = record.messages.length;
      await this.retainRecords(generation, keep);
    }
    if (this.current.generation === generation)
      this.current = new ExplorerView({
        ...this.current,
        messageCounts: counts,
      });
    return this.current;
  }
  async startMessageCounting(
    options: { retry?: boolean } = {},
  ): Promise<ExplorerView> {
    if (options.retry && this.current.messageCountError)
      this.current = new ExplorerView({
        ...this.current,
        messageCountError: null,
      });
    if (
      Object.keys(this.current.messageCounts).length ||
      this.current.messageCounting ||
      this.current.messageCountError ||
      !this.current.rows.length
    )
      return this.current;
    const generation = this.current.generation;
    this.current = new ExplorerView({
      ...this.current,
      messageCounting: true,
      messageCountError: null,
      version: nextSequence(),
    });
    this.messageCountTask = ownTask(async (signal) => {
      try {
        const counted = await this.messageCounts({ signal });
        if (
          this.current.generation === generation &&
          counted.generation === generation
        )
          this.current = new ExplorerView({
            ...this.current,
            messageCounting: false,
            messageCountError: null,
            version: nextSequence(),
          });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (this.current.generation === generation) {
          console.warn(
            `Counting conversation messages failed: ${errorMessage(error)}`,
          );
          this.current = new ExplorerView({
            ...this.current,
            messageCounting: false,
            messageCountError: errorMessage(error),
            version: nextSequence(),
          });
        }
      }
    });
    return this.current;
  }
  async row(traceId: string): Promise<TraceRow | null> {
    return this.current.rows.find((row) => row.traceId === traceId) ?? null;
  }
  async hasCachedRecord(traceId: string): Promise<boolean> {
    return this.cache.has(traceId);
  }
  async close(): Promise<void> {
    await this.cancel();
    this.cache.clear();
  }
  private async cancel(): Promise<void> {
    const tasks = [this.task, this.prewarmTask, this.messageCountTask].filter(
      (task): task is OwnedTask => task !== null && !task.settled,
    );
    this.task = null;
    this.prewarmTask = null;
    this.messageCountTask = null;
    for (const task of tasks) task.controller.abort();
    if (tasks.length)
      await Promise.allSettled(tasks.map((task) => task.promise));
  }
}
