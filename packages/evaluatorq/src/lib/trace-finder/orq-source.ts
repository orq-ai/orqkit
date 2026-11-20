import { AsyncLocalStorage } from "node:async_hooks";

import type { Orq } from "@orq-ai/node";

import { codepointCompare, pythonString } from "../common/sanitize.js";
import { parseIso } from "../formats/time.js";
import { loadProjectNames } from "./facets.js";
import {
  type FacetSelection,
  type NumericFilters,
  Snapshot,
  TraceRecord,
  timeMicros,
} from "./models.js";
import {
  BASE_FILTER,
  buildOql,
  checkWindow,
  conversationMessages,
  eligibleSpans,
  field,
  hasReply,
  record as isRecord,
  loadTargetReached,
  MAX_LIVE_TRACES,
  MAX_SPAN_PAGES,
  MAX_SPANS_PER_TRACE,
  mapping,
  matchingTargets,
  OrqSourceError,
  OrqSpanMismatchError,
  PAGE_SIZE,
  plain,
  type Row,
  rawTraceSummaries,
  requireCompleteTargetedLoad,
  SDK_TIMEOUT_MS,
  type SelectedSummary,
  selectedSpanSignalData,
  selectSummaries,
  signalStatus,
  spanToolCallId,
  summaryOutputTokens,
  TARGET_RELOAD_PAGE_BUDGET_SECONDS,
  toolCallEntries,
  traceRecord,
  truth,
  usable,
  withSpanModels,
} from "./orq-source-data.js";
import { reportLoadProgress } from "./progress.js";
import { rowFromSummary, summaryModels, type TraceRow } from "./rows.js";
import { isErrorSpan } from "./span-status.js";
export {
  BASE_FILTER,
  buildOql,
  OrqSourceError,
  OrqSpanMismatchError,
  requireCompleteTargetedLoad,
};
export type OrqSourceClient = Pick<Orq, "_options" | "_baseURL"> & {
  traces: Pick<Orq["traces"], "query" | "getSpan" | "listSpans">;
  projects: Pick<Orq["projects"], "list">;
};
const captureContext = new AsyncLocalStorage<symbol>(),
  registrations = new WeakMap<object, CaptureRegistration>();
const first = (...values: unknown[]): unknown =>
  values.find(truth) ?? values.at(-1);
const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
async function settleRequests<T>(tasks: Promise<T>[]): Promise<T[]> {
  try {
    return await Promise.all(tasks);
  } finally {
    await Promise.allSettled(tasks);
  }
}
class RawCapture {
  private readonly responses = new Map<symbol, Map<string, Row[]>>();
  static key(path: string): string {
    return path.replace(/^\/v\d+(?=\/)/, "");
  }
  push(marker: symbol, path: string, payload: Row): void {
    let rows = this.responses.get(marker);
    if (!rows) {
      rows = new Map();
      this.responses.set(marker, rows);
    }
    const key = RawCapture.key(path),
      queue = rows.get(key) ?? [];
    queue.push(payload);
    if (queue.length > 128) queue.shift();
    rows.set(key, queue);
  }
  pop(path: string): Row | null {
    const marker = captureContext.getStore();
    if (marker === undefined) return null;
    const rows = this.responses.get(marker),
      key = RawCapture.key(path),
      queue = rows?.get(key),
      value = queue?.shift() ?? null;
    if (!queue?.length) rows?.delete(key);
    if (!rows?.size) this.responses.delete(marker);
    return value;
  }
  clear(marker?: symbol): void {
    if (marker === undefined) this.responses.clear();
    else this.responses.delete(marker);
  }
}
interface CaptureRegistration {
  capture: RawCapture;
  sources: number;
}
class TargetDeadlineExceeded extends Error {
  override name = "TargetDeadlineExceeded";
}
class Deadline {
  readonly controller = new AbortController();
  readonly expires: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(ms: number) {
    this.expires = performance.now() + ms;
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new TargetDeadlineExceeded("targeted trace reload deadline exceeded"),
        ),
      ms,
    );
    this.timer.unref?.();
  }
  remaining(): number {
    const remaining = this.expires - performance.now();
    if (remaining <= 0 || this.controller.signal.aborted) {
      this.controller.abort(
        new TargetDeadlineExceeded("targeted trace reload deadline exceeded"),
      );
      throw new TargetDeadlineExceeded(
        "targeted trace reload deadline exceeded",
      );
    }
    return remaining;
  }
  get expired(): boolean {
    return this.controller.signal.aborted || performance.now() >= this.expires;
  }
  close(): void {
    clearTimeout(this.timer);
  }
}
interface Context {
  deadline: Deadline | null;
  signal: AbortSignal | undefined;
  external: AbortSignal | undefined;
}
function context(
  external?: AbortSignal,
  deadline: Deadline | null = null,
  extra?: AbortSignal,
): Context {
  const signals = [external, deadline?.controller.signal, extra].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  return {
    deadline,
    external,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  };
}
function check(ctx: Context): void {
  ctx.external?.throwIfAborted();
  ctx.deadline?.remaining();
  ctx.signal?.throwIfAborted();
}
class Semaphore {
  private active = 0;
  private queue: {
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(private readonly max: number) {}
  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.queue = this.queue.filter((value) => value !== entry);
          reject(signal?.reason);
        },
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }
  private release(): void {
    this.active--;
    while (this.queue.length) {
      const entry = this.queue.shift();
      if (!entry) break;
      entry.signal?.removeEventListener("abort", entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      this.active++;
      entry.resolve();
      break;
    }
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      this.release();
    }
  }
}
class HydrationIssues {
  readonly systemPromptErrors: string[] = [];
  readonly missingReply: string[] = [];
  readonly spanErrors: string[] = [];
  log(total: number): void {
    if (this.systemPromptErrors.length)
      console.warn(
        `system prompt lookup failed for ${this.systemPromptErrors.length} of ${total} trace(s); first error: ${this.systemPromptErrors[0]}`,
      );
    if (this.spanErrors.length)
      console.warn(
        `span lookup failed for ${this.spanErrors.length} of ${total} trace(s); kept summary messages where usable; first error: ${this.spanErrors[0]}`,
      );
    if (this.missingReply.length)
      console.warn(
        `${this.missingReply.length} of ${total} trace(s) report output tokens but their hydrated spans contain no visible reply; first: ${this.missingReply[0]}`,
      );
  }
}
interface Scan {
  scanned: number;
  wrongProject: number;
  incompleteReason: string | null;
}
export interface SourceLoadOptions {
  start?: Date | string | null;
  end?: Date | string | null;
  limit: number;
  facets: FacetSelection;
  numeric: NumericFilters;
  signal?: AbortSignal;
}
export class OrqTraceSource {
  private readonly capture: RawCapture;
  private readonly registration: CaptureRegistration | null;
  private closed = false;
  private readonly hydrationConcurrency: number;
  private readonly targetBudgetMs = TARGET_RELOAD_PAGE_BUDGET_SECONDS * 1000;
  constructor(
    private readonly client: OrqSourceClient,
    options: { hydrationConcurrency?: number; ownsClient?: boolean } = {},
  ) {
    this.hydrationConcurrency = options.hydrationConcurrency ?? 20;
    if (
      !Number.isInteger(this.hydrationConcurrency) ||
      this.hydrationConcurrency < 1
    )
      throw new RangeError("hydrationConcurrency must be at least 1");
    const hooks = client._options.hooks;
    if (hooks && typeof hooks.registerAfterSuccessHook === "function") {
      let registration = registrations.get(hooks);
      if (!registration) {
        registration = { capture: new RawCapture(), sources: 0 };
        const registered = registration;
        hooks.registerAfterSuccessHook({
          afterSuccess: async (ctx, response) => {
            const marker = captureContext.getStore();
            if (
              !registered.sources ||
              marker === undefined ||
              !["TracesGetSpan", "TracesQueryOql", "TracesListSpans"].includes(
                ctx.operationID,
              )
            )
              return response;
            try {
              const payload: unknown = await response.clone().json(),
                path = new URL(response.url).pathname;
              if (isRecord(payload))
                registered.capture.push(marker, path, payload);
            } catch {}
            return response;
          },
        });
        registrations.set(hooks, registration);
      }
      registration.sources++;
      this.registration = registration;
      this.capture = registration.capture;
    } else {
      this.registration = null;
      this.capture = new RawCapture();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.registration) {
      this.registration.sources = Math.max(0, this.registration.sources - 1);
      if (!this.registration.sources) this.capture.clear();
    } else this.capture.clear();
  }
  async aclose(): Promise<void> {
    this.close();
  }
  private options(ctx: Context): { timeoutMs: number; signal?: AbortSignal } {
    check(ctx);
    return {
      timeoutMs: ctx.deadline
        ? Math.max(
            1,
            Math.min(SDK_TIMEOUT_MS, Math.floor(ctx.deadline.remaining())),
          )
        : SDK_TIMEOUT_MS,
      signal: ctx.signal,
    };
  }
  private async call<T>(fn: () => Promise<T>, ctx: Context): Promise<T> {
    check(ctx);
    try {
      const value = await fn();
      check(ctx);
      return value;
    } catch (error) {
      if (ctx.external?.aborted) ctx.external.throwIfAborted();
      if (ctx.deadline?.expired)
        throw new TargetDeadlineExceeded(
          "targeted trace reload deadline exceeded",
        );
      throw error;
    }
  }
  private validRaw(path: string, payload: Row): boolean {
    const pagination = (value: unknown): boolean => {
      if (!isRecord(value) || !Array.isArray(value.data)) return false;
      const more = field(value, "has_more"),
        token = field(value, "next_page_token");
      return (
        (more == null || typeof more === "boolean") &&
        (token == null || typeof token === "string") &&
        value.data.every(isRecord)
      );
    };
    if (path === "/traces/query") {
      const search = field(payload, "search");
      return (
        pagination(search) &&
        (field(search, "data") as Row[]).every((row) => {
          const id = first(field(row, "trace_id"), field(row, "id"));
          return typeof id === "string" && id.length > 0;
        })
      );
    }
    if (/^\/traces\/[^/]+\/spans$/.test(path)) return pagination(payload);
    const requested = /^\/traces\/([^/]+)\/spans\/([^/]+)$/.exec(path),
      span = field(payload, "span");
    if (!requested || !isRecord(span)) return false;
    const summary = first(field(span, "summary"), span),
      id = first(field(summary, "span_id"), field(summary, "id")),
      traceId = field(summary, "trace_id");
    return id === requested[2] && (traceId == null || traceId === requested[1]);
  }
  private async captured<T>(
    path: string,
    fn: () => Promise<T>,
    ctx: Context,
  ): Promise<readonly [T, Row | null]> {
    const marker = Symbol();
    return captureContext.run(marker, async () => {
      try {
        let response: T;
        try {
          response = await this.call(fn, ctx);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== "ResponseValidationError"
          )
            throw error;
          const raw = this.capture.pop(path);
          if (raw === null || !this.validRaw(path, raw))
            throw new OrqSourceError(
              `SDK returned an invalid trace payload for ${path}`,
              { cause: error },
            );
          if (process.env.ORQ_DEBUG)
            console.warn(
              `SDK model validation rejected the trace response for ${path}; using its validated raw v3 payload`,
            );
          return [raw as T, raw] as const;
        }
        const raw = this.capture.pop(path);
        if (raw !== null) {
          if (!this.validRaw(path, raw))
            throw new OrqSourceError(`Invalid raw trace payload for ${path}`);
          return [raw as T, raw] as const;
        }
        return [response, null] as const;
      } finally {
        this.capture.clear(marker);
      }
    });
  }
  private async projects(
    start: string,
    end: string,
    ctx: Context,
  ): Promise<Record<string, string>> {
    return this.call(
      () =>
        loadProjectNames(
          this.client as Parameters<typeof loadProjectNames>[0],
          { start, end, signal: ctx.signal },
        ),
      ctx,
    );
  }
  private async queryPage(
    start: string,
    end: string,
    oql: string,
    limit: number,
    pageToken: string | null,
    ctx: Context,
  ): Promise<readonly [unknown, Row | null]> {
    return this.captured(
      "/traces/query",
      () =>
        this.client.traces.query(
          {
            from: new Date(start),
            to: new Date(end),
            oql,
            limit,
            ...(pageToken ? { pageToken } : {}),
          },
          this.options(ctx),
        ),
      ctx,
    );
  }
  private async *pages(
    start: string,
    end: string,
    oql: string,
    projectId: string | null,
    limit: number,
    remaining: () => number,
    scan: Scan,
    ctx: Context,
    targets: ReadonlySet<string> | null = null,
  ): AsyncGenerator<SelectedSummary[]> {
    const seen = new Set<string>(),
      used = new Set<string>(),
      maxScanned =
        targets !== null ? MAX_LIVE_TRACES : Math.max(PAGE_SIZE, limit * 5),
      maxPages = Math.max(20, Math.ceil(maxScanned / PAGE_SIZE) * 2);
    let count = 0,
      token: string | null = null;
    while (remaining() > 0) {
      check(ctx);
      if (scan.scanned >= maxScanned || count >= maxPages) {
        console.warn(
          `stopped trace search after scanning ${scan.scanned} summaries across ${count} pages for ${limit} usable traces`,
        );
        if (targets !== null) scan.incompleteReason = "scan_limit";
        return;
      }
      count++;
      if (token !== null) {
        if (used.has(token))
          throw new OrqSourceError(`repeated OQL page token '${token}'`);
        used.add(token);
      }
      const [response, raw] = await this.queryPage(
          start,
          end,
          oql,
          targets !== null ? PAGE_SIZE : Math.min(PAGE_SIZE, remaining()),
          token,
          ctx,
        ),
        search = first(field(response, "search"), response),
        data = field(search, "data"),
        summaries = Array.isArray(data) ? data : [];
      scan.scanned += summaries.length;
      const rawById = new Map(
          rawTraceSummaries(raw).flatMap((payload) => {
            const id = first(field(payload, "trace_id"), field(payload, "id"));
            return truth(id) ? [[pythonString(id), payload] as const] : [];
          }),
        ),
        selection = selectSummaries(summaries, rawById, seen, projectId);
      scan.wrongProject += selection.rejected;
      yield [...matchingTargets(selection.selected, targets)];
      if (remaining() <= 0) return;
      if (!truth(field(search, "has_more"))) return;
      const next = field(search, "next_page_token");
      if (!truth(next))
        throw new OrqSourceError(
          "OQL response reported more pages without a page token",
        );
      if (used.has(pythonString(next)))
        throw new OrqSourceError(
          `repeated OQL page token '${pythonString(next)}'`,
        );
      token = pythonString(next);
    }
  }
  async loadAsync(
    options: SourceLoadOptions & {
      targetTraceIds?: ReadonlySet<string> | null;
    },
  ): Promise<Snapshot> {
    const [start, end] = checkWindow(
        options.start ?? null,
        options.end ?? null,
        options.limit,
      ),
      limit = Math.min(options.limit, MAX_LIVE_TRACES),
      targets =
        options.targetTraceIds == null ? null : new Set(options.targetTraceIds),
      deadline = targets !== null ? new Deadline(this.targetBudgetMs) : null,
      ctx = context(options.signal, deadline);
    try {
      return await this.load(
        start,
        end,
        limit,
        options.facets,
        options.numeric,
        targets,
        ctx,
      );
    } catch (error) {
      if (options.signal?.aborted) options.signal.throwIfAborted();
      if (error instanceof OrqSourceError) throw error;
      throw new OrqSourceError(
        `live Orq trace loading failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      deadline?.close();
    }
  }
  private async load(
    start: string,
    end: string,
    limit: number,
    facets: FacetSelection,
    numeric: NumericFilters,
    targets: ReadonlySet<string> | null,
    ctx: Context,
  ): Promise<Snapshot> {
    let names: Record<string, string>;
    try {
      names = await this.projects(start, end, ctx);
    } catch (error) {
      if (error instanceof TargetDeadlineExceeded) {
        console.warn(
          "targeted trace reload reached its 30 second deadline during project lookup",
        );
        return new Snapshot({
          traces: [],
          captureMetadata: {
            source: "orq-oql",
            start: parseIso(start).iso,
            end: parseIso(end).iso,
            incomplete_reason: "target_deadline",
          },
        });
      }
      throw error;
    }
    const oql = buildOql(facets, numeric, names, { traceIds: targets }),
      semaphore = new Semaphore(this.hydrationConcurrency),
      records: TraceRecord[] = [],
      scan: Scan = { scanned: 0, wrongProject: 0, incompleteReason: null };
    let dropped = 0,
      fallbacks = 0;
    try {
      for await (const selected of this.pages(
        start,
        end,
        oql,
        facets.projectId,
        limit,
        () => (targets !== null ? 1 : limit - records.length),
        scan,
        ctx,
        targets,
      )) {
        const issues = new HydrationIssues(),
          [hydrated, timedOut] = await this.hydratePage(
            selected,
            names,
            semaphore,
            issues,
            ctx,
          );
        issues.log(selected.length);
        for (const [record, fallback] of hydrated) {
          fallbacks += fallback;
          if (record === null) dropped++;
          else records.push(record);
        }
        reportLoadProgress(Math.min(records.length, limit), limit);
        if (timedOut) {
          console.warn(
            "targeted trace reload reached its 30 second deadline during trace hydration",
          );
          scan.incompleteReason = "target_deadline";
          break;
        }
        if (targets !== null && loadTargetReached(records, limit, targets))
          break;
      }
    } catch (error) {
      if (error instanceof TargetDeadlineExceeded) {
        console.warn(
          "targeted trace reload reached its 30 second deadline during trace acquisition",
        );
        scan.incompleteReason = "target_deadline";
      } else throw error;
    }
    this.warnProjects(scan.wrongProject, facets.projectId, records.length);
    if (fallbacks)
      console.warn(
        `used SDK-model fallback for ${fallbacks} trace response(s) because raw-response capture was unavailable; generated SDK models may omit conversation fields`,
      );
    if (dropped)
      console.warn(
        `dropped ${dropped} trace(s) because messages or timestamps were unusable`,
      );
    const enriched = records.map(
      (record) =>
        new TraceRecord({
          ...record,
          captureMetadata: {
            ...record.captureMetadata,
            population_start: parseIso(start).iso,
            population_end: parseIso(end).iso,
          },
        }),
    );
    enriched.sort((a, b) => {
      const x = timeMicros(a.timestamp),
        y = timeMicros(b.timestamp);
      return x > y ? -1 : x < y ? 1 : -codepointCompare(a.traceId, b.traceId);
    });
    const captureMetadata: Row = {
      source: "orq-oql",
      start: parseIso(start).iso,
      end: parseIso(end).iso,
    };
    let reason = scan.incompleteReason;
    if (
      reason === null &&
      targets !== null &&
      !loadTargetReached(enriched, limit, targets) &&
      scan.scanned >= MAX_LIVE_TRACES
    )
      reason = "scan_limit";
    if (reason !== null) captureMetadata.incomplete_reason = reason;
    return new Snapshot({ traces: enriched.slice(0, limit), captureMetadata });
  }
  private warnProjects(
    count: number,
    projectId: string | null,
    loaded: number,
  ): void {
    if (count) {
      console.warn(
        `discarded ${count} trace summary(s) outside selected project ${projectId} despite the OQL filter`,
      );
      if (!loaded)
        throw new OrqSourceError(
          "Orq returned only traces outside the selected project. No traces were loaded.",
        );
    }
  }
  async loadTrace(
    traceId: string,
    options: Omit<SourceLoadOptions, "limit"> & {
      expectedSpanId: string | null;
    },
  ): Promise<TraceRecord | null> {
    const snapshot = await this.loadAsync({
      ...options,
      limit: 1,
      targetTraceIds: new Set([traceId]),
    });
    requireCompleteTargetedLoad(snapshot, {
      errorType: OrqSourceError,
      operation: `targeted load of trace ${traceId}`,
    });
    const record =
      snapshot.traces.find((record) => record.traceId === traceId) ?? null;
    if (record !== null && record.spanId !== options.expectedSpanId)
      throw new OrqSpanMismatchError(
        `trace ${traceId} reloaded as span '${record.spanId}'; the analysis used ${options.expectedSpanId === null ? "None" : `'${options.expectedSpanId}'`}`,
      );
    return record;
  }
  async search(
    options: SourceLoadOptions & {
      onPage?: ((rows: readonly TraceRow[]) => void) | null;
    },
  ): Promise<readonly TraceRow[]> {
    const [start, end] = checkWindow(
        options.start ?? null,
        options.end ?? null,
        options.limit,
      ),
      limit = Math.min(options.limit, MAX_LIVE_TRACES),
      ctx = context(options.signal),
      names = await this.projects(start, end, ctx),
      oql = buildOql(options.facets, options.numeric, names),
      rows: TraceRow[] = [],
      scan: Scan = { scanned: 0, wrongProject: 0, incompleteReason: null };
    let fallbacks = 0;
    for await (const selected of this.pages(
      start,
      end,
      oql,
      options.facets.projectId,
      limit,
      () => limit - rows.length,
      scan,
      ctx,
    )) {
      for (const [summary, raw, fallback] of selected) {
        fallbacks += Number(fallback);
        const row = rowFromSummary(summary, isRecord(raw) ? raw : null);
        if (row !== null) rows.push(row);
      }
      options.onPage?.(rows.slice(0, limit));
    }
    this.warnProjects(scan.wrongProject, options.facets.projectId, rows.length);
    if (fallbacks)
      console.warn(
        `used SDK-model fallback for ${fallbacks} trace summary response(s) because raw-response capture was unavailable; some optional explorer fields may render as -`,
      );
    const exclusive = rows.filter((row) => row.usageExclusive).length;
    if (exclusive)
      console.warn(
        `${exclusive} trace(s) reported cache tokens outside prompt_tokens (native provider usage); counted them into tokens in`,
      );
    return rows.slice(0, limit);
  }
  private async hydratePage(
    summaries: readonly SelectedSummary[],
    names: Record<string, string>,
    semaphore: Semaphore,
    issues: HydrationIssues,
    ctx: Context,
  ): Promise<readonly [(readonly [TraceRecord | null, number])[], boolean]> {
    const controller = new AbortController(),
      scoped = context(
        ctx.external,
        ctx.deadline,
        ctx.signal
          ? AbortSignal.any([ctx.signal, controller.signal])
          : controller.signal,
      ),
      completed: (readonly [TraceRecord | null, number] | undefined)[] = Array(
        summaries.length,
      ),
      tasks = summaries.map(async ([summary, raw, fallback], index) => {
        const value = await this.hydrateTrace(
          summary,
          raw,
          names,
          semaphore,
          issues,
          scoped,
          fallback,
        );
        completed[index] = value;
        return value;
      });
    try {
      await Promise.all(tasks);
      return [
        completed.filter(
          (value): value is readonly [TraceRecord | null, number] =>
            value !== undefined,
        ),
        ctx.deadline?.expired ?? false,
      ];
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(tasks);
      if (error instanceof TargetDeadlineExceeded || ctx.deadline?.expired)
        return [
          completed.filter(
            (value): value is readonly [TraceRecord | null, number] =>
              value !== undefined,
          ),
          true,
        ];
      throw error;
    } finally {
      controller.abort();
      await Promise.allSettled(tasks);
    }
  }
  async hydrateRows(
    rows: readonly TraceRow[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, TraceRecord | null>> {
    const [start, end] = checkWindow(null, null, 1),
      ctx = context(options.signal),
      names = await this.projects(start, end, ctx),
      semaphore = new Semaphore(this.hydrationConcurrency),
      issues = new HydrationIssues(),
      errors: string[] = [],
      failed = new Set<string>(),
      fallbacks: string[] = [];
    let done = 0;
    const records = await settleRequests(
      rows.map(async (row) => {
        try {
          const [record, fallback] = await this.hydrateTrace(
            row,
            row.raw,
            names,
            semaphore,
            issues,
            ctx,
            false,
          );
          if (fallback) fallbacks.push(row.traceId);
          return record;
        } catch (error) {
          if (options.signal?.aborted) options.signal.throwIfAborted();
          errors.push(errorText(error));
          failed.add(row.traceId);
          return null;
        } finally {
          done++;
          reportLoadProgress(done, rows.length);
        }
      }),
    );
    issues.log(rows.length);
    if (fallbacks.length)
      console.warn(
        `used SDK-model fallback for span details of ${fallbacks.length} trace(s)`,
      );
    if (errors.length)
      console.warn(
        `fetching messages failed for ${errors.length} of ${rows.length} trace(s); first error: ${errors[0]}`,
      );
    const empty =
      records.filter((record) => record === null).length - errors.length;
    if (empty)
      console.warn(
        `${empty} of ${rows.length} trace(s) have no usable messages; drawing them as empty bars`,
      );
    return Object.fromEntries(
      rows.flatMap((row, index) =>
        failed.has(row.traceId) ? [] : [[row.traceId, records[index] ?? null]],
      ),
    );
  }
  private async hydrateTrace(
    summary: unknown,
    raw: unknown,
    names: Record<string, string>,
    semaphore: Semaphore,
    issues: HydrationIssues,
    ctx: Context,
    rawFallback: boolean,
  ): Promise<readonly [TraceRecord | null, number]> {
    let fallbacks = Number(rawFallback),
      messages = conversationMessages(raw);
    const output =
        field(field(raw, "usage"), "completion_tokens") ??
        summaryOutputTokens(summary),
      missing = typeof output === "number" && output > 0 && !hasReply(messages);
    if (usable(messages) && !missing && summaryModels(summary, raw).length) {
      messages = await this.withSystemPrompt(
        summary,
        raw,
        messages,
        semaphore,
        issues,
        ctx,
      );
      return [
        traceRecord(summary, raw, summary, raw, messages, names),
        fallbacks,
      ];
    }
    const traceId = pythonString(
      first(field(summary, "trace_id"), field(summary, "id"), ""),
    );
    if (!traceId) return [null, fallbacks];
    let fallback: TraceRecord | null = null,
      lookupFailed = false,
      models: string[] = [];
    try {
      const spans = await this.listSpanPages(traceId, semaphore, ctx);
      models = [
        ...new Set(spans.flatMap((span) => summaryModels(span, plain(span)))),
      ];
      for (const span of eligibleSpans(spans)) {
        const spanId = pythonString(
          first(field(span, "span_id"), field(span, "id"), ""),
        );
        if (!spanId) continue;
        const [response, captured] = await this.getSpan(
            traceId,
            spanId,
            semaphore,
            ctx,
          ),
          detail = first(field(response, "span"), response),
          rawDetail = captured ? field(captured, "span") : null;
        fallbacks += Number(rawDetail == null);
        const source = rawDetail ?? plain(detail),
          detailMessages = conversationMessages(source);
        if (usable(detailMessages)) {
          const record = withSpanModels(
            traceRecord(summary, raw, detail, source, detailMessages, names),
            models,
          );
          if (!missing || hasReply(detailMessages)) return [record, fallbacks];
          if (fallback === null) fallback = record;
        }
      }
    } catch (error) {
      if (ctx.external?.aborted) ctx.external.throwIfAborted();
      if (fallback === null && !usable(messages)) throw error;
      lookupFailed = true;
      issues.spanErrors.push(`${traceId}: ${errorText(error)}`);
    }
    if (missing && !lookupFailed) issues.missingReply.push(traceId);
    if (fallback !== null) return [fallback, fallbacks];
    if (usable(messages)) {
      messages = await this.withSystemPrompt(
        summary,
        raw,
        messages,
        semaphore,
        issues,
        ctx,
      );
      return [
        withSpanModels(
          traceRecord(summary, raw, summary, raw, messages, names),
          models,
        ),
        fallbacks,
      ];
    }
    return [null, fallbacks];
  }
  private async getSpan(
    traceId: string,
    spanId: string,
    semaphore: Semaphore,
    ctx: Context,
  ): Promise<readonly [unknown, Row | null]> {
    return semaphore.run(
      () =>
        this.captured(
          `/traces/${traceId}/spans/${spanId}`,
          () =>
            this.client.traces.getSpan({ traceId, spanId }, this.options(ctx)),
          ctx,
        ),
      ctx.signal,
    );
  }
  private async withSystemPrompt(
    summary: unknown,
    raw: unknown,
    messages: Row[],
    semaphore: Semaphore,
    issues: HydrationIssues,
    ctx: Context,
  ): Promise<Row[]> {
    if (messages.some((message) => message.role === "system")) return messages;
    const traceId = pythonString(
        first(field(summary, "trace_id"), field(summary, "id"), ""),
      ),
      spanId = pythonString(
        first(field(summary, "span_id"), field(raw, "span_id"), ""),
      );
    if (!traceId || !spanId) return messages;
    let detail: unknown;
    try {
      const [response, captured] = await this.getSpan(
        traceId,
        spanId,
        semaphore,
        ctx,
      );
      detail = first(
        captured ? field(captured, "span") : null,
        field(response, "span"),
        response,
      );
    } catch (error) {
      if (error instanceof TargetDeadlineExceeded) throw error;
      if (ctx.external?.aborted) ctx.external.throwIfAborted();
      issues.systemPromptErrors.push(errorText(error));
      return messages;
    }
    return [
      ...conversationMessages(plain(detail)).filter(
        (message) => message.role === "system" && usable([message]),
      ),
      ...messages,
    ];
  }
  private async listSpanPages(
    traceId: string,
    semaphore: Semaphore,
    ctx: Context,
  ): Promise<unknown[]> {
    const spans: unknown[] = [],
      used = new Set<string>();
    let token: string | null = null,
      pages = 0;
    while (true) {
      if (pages >= MAX_SPAN_PAGES)
        throw new OrqSourceError(
          `span pagination exceeded ${MAX_SPAN_PAGES} pages for trace '${traceId}'`,
        );
      pages++;
      const [response, raw] = await semaphore.run(
          () =>
            this.captured(
              `/traces/${traceId}/spans`,
              () =>
                this.client.traces.listSpans(
                  {
                    traceId,
                    limit: PAGE_SIZE,
                    ...(token ? { pageToken: token } : {}),
                  },
                  this.options(ctx),
                ),
              ctx,
            ),
          ctx.signal,
        ),
        data = field(raw ?? response, "data");
      if (Array.isArray(data)) spans.push(...data);
      if (spans.length > MAX_SPANS_PER_TRACE)
        throw new OrqSourceError(
          `span pagination exceeded ${MAX_SPANS_PER_TRACE} spans for trace '${traceId}'`,
        );
      if (!truth(field(response, "has_more"))) return spans;
      const next = field(response, "next_page_token");
      if (!truth(next) || used.has(pythonString(next)))
        throw new OrqSourceError(
          `repeated span page token for trace '${traceId}'`,
        );
      used.add(pythonString(next));
      token = pythonString(next);
    }
  }
  async listSpans(
    traceId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown[]> {
    return traceId
      ? this.listSpanPages(
          traceId,
          new Semaphore(this.hydrationConcurrency),
          context(options.signal),
        )
      : [];
  }
  async enrichSelectedSignalSpans(
    records: readonly TraceRecord[],
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly TraceRecord[]> {
    const semaphore = new Semaphore(this.hydrationConcurrency),
      ctx = context(options.signal);
    return settleRequests(
      records.map(async (record) => {
        const ids = new Set<string>();
        for (const message of record.messages)
          if (message.role === "assistant")
            for (const call of toolCallEntries(message.tool_calls)) {
              if (!isRecord(call)) continue;
              const id = first(call.id, call.call_id);
              if (truth(id)) ids.add(pythonString(id));
            }
        try {
          const spans = await this.listSpanPages(
              record.traceId,
              semaphore,
              ctx,
            ),
            byId = new Map<string, unknown>();
          for (const span of spans) {
            const id = first(field(span, "span_id"), field(span, "id"));
            if (truth(id)) byId.set(pythonString(id), span);
          }
          const selected = byId.get(record.spanId);
          if (selected === undefined) {
            console.warn(
              `selected trace ${record.traceId} span ${record.spanId} was missing during signal enrichment`,
            );
            return new TraceRecord({
              ...record,
              captureMetadata: {
                ...record.captureMetadata,
                signal_span_coverage: {
                  selected_span_id: record.spanId,
                  selected_span_found: false,
                  scoped_span_count: 0,
                  matched_tool_span_count: 0,
                  missing_call_ids: [...ids].sort(codepointCompare),
                },
              },
            });
          }
          const children = new Map<string, string[]>();
          for (const span of spans) {
            const id = pythonString(
                first(field(span, "span_id"), field(span, "id"), ""),
              ),
              parent = first(
                field(span, "parent_span_id"),
                field(span, "parent_id"),
              );
            if (id && truth(parent)) {
              const key = pythonString(parent);
              children.set(key, [...(children.get(key) ?? []), id]);
            }
          }
          const scoped = new Set([record.spanId]),
            queue = [record.spanId];
          for (let i = 0; i < queue.length; i++)
            for (const child of children.get(queue[i] as string) ?? [])
              if (!scoped.has(child)) {
                scoped.add(child);
                queue.push(child);
              }
          const matching = [...byId]
              .filter(
                ([id, span]) =>
                  scoped.has(id) && ids.has(spanToolCallId(span) ?? ""),
              )
              .map(([, span]) => span),
            statuses = new Map<string, Row>(),
            errors: string[] = [];
          for (const span of matching) {
            const spanId = pythonString(
                first(field(span, "span_id"), field(span, "id"), ""),
              ),
              callId = spanToolCallId(span);
            if (!spanId || callId === null) continue;
            let detail: unknown;
            try {
              const [response, raw] = await this.getSpan(
                record.traceId,
                spanId,
                semaphore,
                ctx,
              );
              detail = first(
                raw ? field(raw, "span") : null,
                field(response, "span"),
                response,
              );
            } catch (error) {
              if (options.signal?.aborted) options.signal.throwIfAborted();
              errors.push(`${spanId}: ${errorText(error)}`);
              detail = span;
            }
            const status = signalStatus(detail);
            if (Object.keys(status).length) statuses.set(callId, status);
          }
          let selectedDetail: unknown,
            captured = true;
          try {
            const [response, raw] = await this.getSpan(
              record.traceId,
              record.spanId,
              semaphore,
              ctx,
            );
            selectedDetail = first(
              raw ? field(raw, "span") : null,
              field(response, "span"),
              response,
            );
          } catch (error) {
            if (options.signal?.aborted) options.signal.throwIfAborted();
            errors.push(`${record.spanId}: ${errorText(error)}`);
            selectedDetail = selected;
            captured = false;
          }
          const data = selectedSpanSignalData(selectedDetail, record.messages),
            byOrder = mapping(data.output_items_by_order),
            orders = data.step_orders,
            coverage = {
              selected_span_id: record.spanId,
              selected_span_found: true,
              scoped_span_count: scoped.size,
              matched_tool_span_count: matching.length,
              matched_call_ids: [...statuses.keys()].sort(codepointCompare),
              missing_call_ids: [...ids]
                .filter((id) => !statuses.has(id))
                .sort(codepointCompare),
              selected_data_correlated:
                Array.isArray(orders) && orders.length > 0,
              responses_items_captured: Object.values(byOrder).reduce<number>(
                (n, items) => n + (Array.isArray(items) ? items.length : 0),
                0,
              ),
              selected_detail_captured: captured,
              enrichment_errors: errors,
            };
          if (truth(data.output_item_count) && !truth(orders))
            console.warn(
              `selected trace ${record.traceId} response items could not be correlated to transcript assistant steps`,
            );
          return new TraceRecord({
            ...record,
            captureMetadata: {
              ...record.captureMetadata,
              signal_span_coverage: coverage,
              signal_tool_spans: Object.fromEntries(statuses),
              signal_selected_span: data,
            },
          });
        } catch (error) {
          if (options.signal?.aborted) options.signal.throwIfAborted();
          console.warn(
            `selected trace ${record.traceId} signal-span enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return new TraceRecord({
            ...record,
            captureMetadata: {
              ...record.captureMetadata,
              signal_span_coverage: {
                selected_span_id: record.spanId,
                selected_span_found: false,
                enrichment_error: errorText(error),
              },
            },
          });
        }
      }),
    );
  }
  async firstErrorMessage(
    traceId: string,
    spans: readonly unknown[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    if (!traceId || !this.registration) return null;
    let id = "";
    for (const span of spans)
      if (isErrorSpan(span)) {
        id = pythonString(first(field(span, "span_id"), field(span, "id"), ""));
        if (id) break;
      }
    if (!id) return null;
    const [, raw] = await this.getSpan(
        traceId,
        id,
        new Semaphore(this.hydrationConcurrency),
        context(options.signal),
      ),
      span = raw ? field(raw, "span") : null,
      attributes = field(span, "attributes");
    for (const path of [
      ["otlp", "status", "message"],
      ["otel", "status_description"],
    ]) {
      let value = attributes;
      for (const key of path) {
        value = field(value, key);
        if (value == null) break;
      }
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  }
}
