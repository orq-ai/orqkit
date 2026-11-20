import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  FacetSelection,
  NumericFilters,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import {
  type OrqSourceClient,
  OrqTraceSource,
} from "../../../src/lib/trace-finder/orq-source.js";
import {
  rowFromSummary,
  type TraceRow,
} from "../../../src/lib/trace-finder/rows.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/orq-source-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    input: Fixture;
    ok: boolean;
    expected: unknown;
    calls: {
      projects: number;
      query: unknown[];
      spans: number;
      details: number;
    };
  }[];
};
interface Fixture {
  op: string;
  projects: Record<string, unknown>[];
  pages: Record<string, unknown>[];
  spans: Record<string, Record<string, unknown>[]>;
  details: Record<string, Record<string, unknown>>;
  limit: number;
  facets: unknown;
  numeric: unknown;
  expectedSpanId?: string | null;
  targets?: string[];
  scanForever?: boolean;
  records?: unknown[];
}
function fake(doc: Fixture) {
  const calls = { projects: 0, query: [] as unknown[], spans: 0, details: 0 },
    spanIndex = new Map<string, number>();
  let queryIndex = 0;
  const failure = (result: Record<string, unknown>) => {
    if (result.error)
      throw Object.assign(new Error(String(result.error)), {
        name: "RuntimeError",
      });
    return result;
  };
  const client = {
    _options: {},
    _baseURL: null,
    projects: {
      list: async () => {
        calls.projects++;
        return doc.projects[0];
      },
    },
    traces: {
      query: async ({
        oql,
        limit,
        pageToken,
      }: {
        oql: string;
        limit: number;
        pageToken?: string;
      }) => {
        calls.query.push({ oql, limit, token: pageToken ?? null });
        if (doc.scanForever) {
          const index = queryIndex++;
          return {
            search: {
              data: Array.from({ length: 200 }, (_, i) => ({
                trace_id: `other-${index}-${i}`,
              })),
              has_more: true,
              next_page_token: String(index + 1),
            },
          };
        }
        return failure(
          doc.pages[Math.min(queryIndex++, doc.pages.length - 1)] as Record<
            string,
            unknown
          >,
        );
      },
      listSpans: async ({ traceId }: { traceId: string }) => {
        calls.spans++;
        const index = spanIndex.get(traceId) ?? 0;
        spanIndex.set(traceId, index + 1);
        const pages = doc.spans[traceId] ?? [{ data: [], has_more: false }];
        return failure(
          pages[Math.min(index, pages.length - 1)] as Record<string, unknown>,
        );
      },
      getSpan: async ({
        traceId,
        spanId,
      }: {
        traceId: string;
        spanId: string;
      }) => {
        calls.details++;
        return failure(
          doc.details[`${traceId}/${spanId}`] ?? {
            span: { summary: { span_id: spanId } },
          },
        );
      },
    },
  } as unknown as OrqSourceClient;
  return { client, calls };
}
const fields = new Set([
  "schema_version",
  "trace_id",
  "span_id",
  "trace_type",
  "agent_name",
  "tool_names",
  "tool_definition_count",
  "tool_definition_tokens",
  "total_tokens",
  "duration_ms",
  "capture_metadata",
  "started_at",
  "ended_at",
  "project_id",
  "session_id",
  "thread_id",
  "response_models",
  "tokens_in",
  "tokens_out",
  "cached_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "context_tokens",
  "usage_exclusive",
  "cost_total",
]);
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        fields.has(key)
          ? key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
          : key,
        ["capture_metadata", "raw", "messages"].includes(key)
          ? item
          : native(item),
      ]),
    );
  return value;
}
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.cases.entries())
  test(`Python bounded trace source ${i} ${row.input.op}`, async () => {
    const doc = row.input,
      fixture = fake(doc),
      source = new OrqTraceSource(fixture.client, { hydrationConcurrency: 2 }),
      options = {
        start: "2026-11-09T00:00:00Z",
        end: "2026-11-11T00:00:00Z",
        facets: new FacetSelection(doc.facets),
        numeric: new NumericFilters(doc.numeric),
        limit: doc.limit,
      };
    let result: unknown,
      ok = false;
    try {
      if (doc.op === "search") result = await source.search(options);
      else if (doc.op === "loadTrace")
        result = await source.loadTrace("t", {
          ...options,
          expectedSpanId: doc.expectedSpanId ?? null,
        });
      else if (doc.op === "listSpans") result = await source.listSpans("t");
      else if (doc.op === "hydrate") {
        const page = doc.pages[0]?.search as Record<string, unknown>;
        result = await source.hydrateRows(
          (page.data as unknown[]).map(
            (summary) =>
              rowFromSummary(
                summary,
                summary as Record<string, unknown>,
              ) as TraceRow,
          ),
        );
      } else if (doc.op === "enrich")
        result = await source.enrichSelectedSignalSpans(
          (doc.records ?? []).map((record) => new TraceRecord(record)),
        );
      else
        result = await source.loadAsync({
          ...options,
          targetTraceIds:
            doc.targets === undefined ? null : new Set(doc.targets),
        });
      ok = true;
    } catch {
    } finally {
      source.close();
    }
    expect(ok).toBe(row.ok);
    if (ok)
      expect<unknown>(result).toEqual(
        doc.op === "listSpans" ? row.expected : native(row.expected),
      );
    expect(fixture.calls).toEqual(row.calls);
  });

function stalledClient() {
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = 0,
    active = 0;
  const client = {
    _options: {},
    _baseURL: null,
    projects: { list: async () => ({ data: [], has_more: false }) },
    traces: {
      query: async () => ({
        search: {
          data: [{ trace_id: "t", started_at: "2026-11-10T10:00:00Z" }],
          has_more: false,
        },
      }),
      listSpans: async (
        _input: unknown,
        { signal }: { signal: AbortSignal },
      ) => {
        active++;
        started();
        try {
          return await new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted++;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        } finally {
          active--;
        }
      },
    },
  } as unknown as OrqSourceClient;
  return { client, ready, aborted: () => aborted, active: () => active };
}
test("targeted reload deadline cancels active requests and returns explicit incomplete coverage", async () => {
  const fixture = stalledClient(),
    source = new OrqTraceSource(fixture.client, { hydrationConcurrency: 1 });
  (source as unknown as { targetBudgetMs: number }).targetBudgetMs = 100;
  try {
    const result = await source.loadAsync({
      start: "2026-11-09T00:00:00Z",
      end: "2026-11-11T00:00:00Z",
      limit: 1,
      facets: new FacetSelection(),
      numeric: new NumericFilters(),
      targetTraceIds: new Set(["t"]),
    });
    expect(result.traces).toEqual([]);
    expect(result.captureMetadata.incomplete_reason).toBe("target_deadline");
    expect(fixture.aborted()).toBe(1);
    expect(fixture.active()).toBe(0);
  } finally {
    source.close();
  }
});
test("caller cancellation propagates after every pending hydration request settles", async () => {
  const fixture = stalledClient(),
    source = new OrqTraceSource(fixture.client, { hydrationConcurrency: 1 }),
    controller = new AbortController();
  try {
    const pending = source.loadAsync({
      start: "2026-11-09T00:00:00Z",
      end: "2026-11-11T00:00:00Z",
      limit: 1,
      facets: new FacetSelection(),
      numeric: new NumericFilters(),
      signal: controller.signal,
    });
    const rejected = pending.then(
      () => null,
      (error) => error,
    );
    await fixture.ready;
    controller.abort();
    expect(((await rejected) as Error).name).toBe("AbortError");
    expect(fixture.aborted()).toBe(1);
    expect(fixture.active()).toBe(0);
  } finally {
    source.close();
  }
});
test("hydration concurrency rejects values that cannot bound a request pool", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5])
    expect(
      () =>
        new OrqTraceSource(fake(goldens.cases[0]?.input as Fixture).client, {
          hydrationConcurrency: value,
        }),
    ).toThrow();
});
for (const method of ["hydrateRows", "enrichSelectedSignalSpans"] as const)
  test(`${method} settles every owned request before cancellation returns`, async () => {
    let active = 0,
      notify: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const client = {
      _options: {},
      _baseURL: null,
      projects: { list: async () => ({ data: [], has_more: false }) },
      traces: {
        listSpans: async (_: unknown, { signal }: { signal: AbortSignal }) => {
          active++;
          if (active === 2) notify();
          try {
            return await new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          } finally {
            if (active === 2)
              await new Promise((resolve) => setTimeout(resolve, 20));
            active--;
          }
        },
      },
    } as unknown as OrqSourceClient;
    const source = new OrqTraceSource(client, { hydrationConcurrency: 2 }),
      controller = new AbortController();
    try {
      const ids = ["a", "b"],
        pending =
          method === "hydrateRows"
            ? source.hydrateRows(
                ids.map((id) => {
                  const row = rowFromSummary(
                    { trace_id: id },
                    { trace_id: id },
                  );
                  if (row === null) throw new Error("missing synthetic row");
                  return row;
                }),
                { signal: controller.signal },
              )
            : source.enrichSelectedSignalSpans(
                ids.map(
                  (traceId) =>
                    new TraceRecord({
                      schemaVersion: 1,
                      traceId,
                      spanId: "root",
                      timestamp: "2026-11-10T00:00:00Z",
                      project: "p",
                      model: "m",
                      provider: "p",
                      status: "ok",
                      product: "agents",
                      traceType: "agent",
                      messages: [{ role: "assistant", content: "a" }],
                    }),
                ),
                { signal: controller.signal },
              );
      const result = pending.then(
        () => null,
        (error) => error,
      );
      await ready;
      controller.abort();
      expect(((await result) as Error).name).toBe("AbortError");
      expect(active).toBe(0);
    } finally {
      source.close();
    }
  });
