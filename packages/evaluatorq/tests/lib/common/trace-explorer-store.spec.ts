import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ExplorerStore,
  type ExplorerView,
} from "../../../src/lib/trace-finder/explorer.js";
import {
  FacetSelection,
  NumericFilters,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import { TraceRow } from "../../../src/lib/trace-finder/rows.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-explorer-store-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const start = "2026-11-10T00:00:00Z",
  end = "2026-11-11T00:00:00Z";
const row = (traceId: string) => new TraceRow({ traceId });
const record = (traceId: string, model = "unknown", length = 1) =>
  new TraceRecord({
    schemaVersion: 1,
    traceId,
    spanId: "s",
    timestamp: start,
    project: "p",
    model,
    provider: "p",
    status: "ok",
    product: "agents",
    traceType: "agent",
    messages: Array.from({ length }, (_, i) => ({
      role: "user",
      content: String(i),
    })),
  });
const opts = () => ({
  facets: new FacetSelection(),
  numeric: new NumericFilters(),
  wait: true,
  warmTrajectories: false,
});
const compact = (values: Record<string, TraceRecord | null>) =>
  Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v?.traceId ?? null]),
  );
const snapshot = (v: ExplorerView, base: number) => ({
  generation: v.generation - base + 1,
  version: v.version - base + 1,
  state: v.state,
  initial_load: v.initialLoad,
  trajectory_warming: v.trajectoryWarming,
  rows: v.rows.map((r) => r.traceId),
  models: Object.fromEntries(
    v.rows
      .filter((r) => r.models.length)
      .map((r) => [r.traceId, [...r.models]]),
  ),
  limit: v.limit,
  facets: [...v.facets.model].sort(),
  numeric_min: v.numeric.tokensMin,
  message_counts: v.messageCounts,
  message_counting: v.messageCounting,
  message_count_error: v.messageCountError,
  error: v.error,
  sort: v.sort,
  descending: v.descending,
  page: v.page,
  view: v.view,
  show_tool_definitions: v.showToolDefinitions,
  matched_only: v.matchedOnly,
  quick_view: v.quickView,
  narrowed_from: v.narrowedFrom,
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
async function settled(store: ExplorerStore) {
  for (let i = 0; i < 100; i++) {
    const v = await store.view();
    if (!v.messageCounting) return v;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("message counting did not settle");
}

test("view transitions match Python", async () => {
  const rows = ["t1", "t2", "t3"].map(row);
  const store = new ExplorerStore({
    search: async ({ onPage }) => {
      onPage(rows.slice(0, 2));
      return rows;
    },
    hydrate: async () => ({}),
  });
  try {
    const first = await store.load(start, end, 3, opts()),
      base = first.generation,
      out = [snapshot(first, base)];
    const save = async () => out.push(snapshot(await store.view(), base));
    await store.setView({
      sort: "match",
      descending: false,
      page: 5,
      view: "trajectories",
      showToolDefinitions: true,
      matchedOnly: true,
      quickView: "matches",
    });
    await save();
    await store.narrow(base, ["t1", "t3"], {
      facets: new FacetSelection({ model: ["m1"] }),
      numeric: new NumericFilters({ tokensMin: 0 }),
    });
    await save();
    await store.narrow(base, ["t3"], {
      facets: new FacetSelection({ model: ["m2"] }),
      numeric: new NumericFilters({ tokensMin: 1 }),
    });
    await save();
    await store.narrow(base + 999, ["t1"], opts());
    await save();
    await store.restoreNarrowed();
    await save();
    await store.clearAiViewState();
    await save();
    await store.setView({
      sort: "cost",
      descending: false,
      quickView: "errors",
      page: 9,
    });
    await save();
    await store.load(start, end, 3, { ...opts(), initialLoad: true });
    await save();
    expect(out).toEqual(gold.views);
  } finally {
    await store.close();
  }
});

test("record cache and model backfill match Python", async () => {
  const rows = ["t1", "t2", "t3", "t4"].map(row),
    calls: string[][] = [];
  const store = new ExplorerStore({
    search: async () => rows,
    hydrate: async (wanted) => {
      const ids = wanted.map((r) => r.traceId);
      calls.push(ids);
      return Object.fromEntries(
        Object.entries({ t1: record("t1", "m1, m2"), t2: null }).filter(([k]) =>
          ids.includes(k),
        ),
      );
    },
  });
  try {
    const base = (await store.load(start, end, 4, opts())).generation;
    const first = compact(await store.records(["t1", "t2", "t3", "missing"])),
      second = compact(await store.records(["t3", "t1", "t2"])),
      cached = compact(store.cachedRecords(["t1", "t2", "t3", "missing"])),
      view = snapshot(await store.view(), base),
      has = await Promise.all(
        ["t1", "t2", "t3", "missing"].map((id) => store.hasCachedRecord(id)),
      );
    expect({ first, second, cached, has, calls, view }).toEqual(gold.records);
  } finally {
    await store.close();
  }
});

test("usable records and bounded message count cache match Python", async () => {
  const rows = ["t1", "t2", "t3", "t4"].map(row),
    calls: string[][] = [];
  const store = new ExplorerStore({
    search: async () => rows,
    hydrate: async (wanted) => {
      calls.push(wanted.map((r) => r.traceId));
      return Object.fromEntries(
        wanted.map((r) => [
          r.traceId,
          ["t2", "t4"].includes(r.traceId) ? record(r.traceId) : null,
        ]),
      );
    },
  });
  try {
    const generation = (await store.load(start, end, 4, opts())).generation;
    const [found, skipped] = await store.recordsUntilUsable(
      ["missing", "t1", "t2", "t3", "t4"],
      { generation, limit: 2 },
    );
    expect({
      found: found.map((r) => r.traceId),
      skipped,
      cached: compact(store.cachedRecords(["t1", "t2", "t3", "t4"])),
      calls,
    }).toEqual(gold.usable);
  } finally {
    await store.close();
  }
  const many = Array.from({ length: 205 }, (_, i) => row(`t${i}`)),
    sizes: number[] = [];
  const counts = new ExplorerStore({
    search: async () => many,
    hydrate: async (wanted) => {
      sizes.push(wanted.length);
      return Object.fromEntries(
        wanted.map((r) => [
          r.traceId,
          record(r.traceId, "unknown", 1 + (Number(r.traceId.slice(1)) % 3)),
        ]),
      );
    },
  });
  try {
    await counts.load(start, end, 205, opts());
    await counts.records(["t0"]);
    const v = await counts.messageCounts();
    expect({
      count: Object.keys(v.messageCounts).length,
      examples: Object.fromEntries(
        ["t0", "t1", "t204"].map((id) => [id, v.messageCounts[id]]),
      ),
      cached: compact(counts.cachedRecords(["t0", "t1", "t204"])),
      calls: sizes,
    }).toEqual(gold.counts);
  } finally {
    await counts.close();
  }
});

test("message count failure can be retried", async () => {
  let fail = true;
  const store = new ExplorerStore({
    search: async () => [row("t1")],
    hydrate: async (wanted) => {
      if (fail) throw new Error("count failed");
      return Object.fromEntries(
        wanted.map((r) => [r.traceId, record(r.traceId)]),
      );
    },
  });
  try {
    const base = (await store.load(start, end, 1, opts())).generation;
    const startView = snapshot(await store.startMessageCounting(), base),
      failed = snapshot(await settled(store), base);
    fail = false;
    const retry = snapshot(
        await store.startMessageCounting({ retry: true }),
        base,
      ),
      done = snapshot(await settled(store), base);
    expect({ start: startView, failed, retry, done }).toEqual(gold.retry);
  } finally {
    await store.close();
  }
});

test("shared hydration survives caller cancellation", async () => {
  const started = gate(),
    finish = gate(),
    calls: string[][] = [];
  const store = new ExplorerStore({
    search: async () => ["t1", "t2"].map(row),
    hydrate: async (wanted) => {
      calls.push(wanted.map((r) => r.traceId));
      started.release();
      await finish.promise;
      return Object.fromEntries(
        wanted.map((r) => [r.traceId, record(r.traceId)]),
      );
    },
  });
  try {
    await store.load(start, end, 2, opts());
    const controller = new AbortController();
    const a = store.records(["t2", "t1"], { signal: controller.signal }).then(
        () => false,
        () => true,
      ),
      b = store.records(["t1", "t2"]);
    await started.promise;
    controller.abort();
    const first_cancelled = await a;
    finish.release();
    const second = compact(await b),
      cached = compact(store.cachedRecords(["t1", "t2"]));
    expect({ first_cancelled, second, cached, calls }).toEqual(gold.coalesce);
  } finally {
    finish.release();
    await store.close();
  }
});

test("old hydration cannot populate a new generation", async () => {
  const started = gate(),
    finish = gate();
  let index = 0;
  const store = new ExplorerStore({
    search: async () => [row(++index === 1 ? "old" : "new")],
    hydrate: async (wanted) => {
      started.release();
      await finish.promise;
      return Object.fromEntries(
        wanted.map((r) => [r.traceId, record(r.traceId)]),
      );
    },
  });
  try {
    await store.load(start, end, 1, opts());
    const pending = store.records(["old"]);
    await started.promise;
    await store.load(start, end, 1, opts());
    finish.release();
    const returned = compact(await pending),
      cached = compact(store.cachedRecords(["old", "new"])),
      rows = (await store.view()).rows.map((r) => r.traceId);
    expect({ returned, cached, rows }).toEqual(gold.stale);
  } finally {
    finish.release();
    await store.close();
  }
});

test("failed search cancels prewarm", async () => {
  const calls: number[] = [];
  const store = new ExplorerStore({
    search: async ({ onPage }) => {
      onPage(Array.from({ length: 100 }, (_, i) => row(`t${i}`)));
      throw new Error("page failed");
    },
    hydrate: async (wanted) => {
      calls.push(wanted.length);
      return {};
    },
  });
  try {
    const v = await store.load(start, end, 100, {
      ...opts(),
      warmTrajectories: true,
    });
    expect({
      state: v.state,
      error: v.error,
      rows: v.rows.length,
      warming: v.trajectoryWarming,
      calls,
    }).toEqual(gold.search_error);
  } finally {
    await store.close();
  }
});

test("a newer load ignores late pages from a cancelled search", async () => {
  const started = gate(),
    finish = gate();
  let index = 0;
  const store = new ExplorerStore({
    search: async ({ onPage }) => {
      if (++index === 1) {
        started.release();
        await finish.promise;
        onPage([row("stale")]);
        return [row("stale")];
      }
      return [row("new")];
    },
    hydrate: async () => ({}),
  });
  try {
    await store.load(start, end, 1, { ...opts(), wait: false });
    await started.promise;
    await store.load(start, end, 1, opts());
    finish.release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.view()).rows.map((r) => r.traceId)).toEqual(["new"]);
  } finally {
    finish.release();
    await store.close();
  }
});
