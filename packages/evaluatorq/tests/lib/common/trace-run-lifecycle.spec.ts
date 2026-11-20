import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CompiledPlan } from "../../../src/lib/trace-finder/compiler.js";
import {
  CompiledQuerySchema,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  RunRequestSchema,
  type RunSnapshot,
  Snapshot,
  type TraceClassification,
  TraceClassificationSchema,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import { reportLoadProgress } from "../../../src/lib/trace-finder/progress.js";
import {
  RunStore,
  type RunStoreOptions,
} from "../../../src/lib/trace-finder/run-store.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-run-lifecycle-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const dimension = CompiledQuerySchema.parse({
  task: { kind: "noul", instructions: "Is this a help request?", state: {} },
  selection: { kind: "values", values: [true] },
});
const trace = (index: number) =>
  new TraceRecord({
    schemaVersion: 1,
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    timestamp: `2026-09-20T12:0${index}:00Z`,
    messages: [{ role: "user", content: `hello ${index}` }],
    project: "alpha",
    model: "gpt-5",
    provider: "openai",
    status: "completed",
    product: "chat",
    traceType: "conversation",
    agentName: "support",
    toolNames: ["lookup"],
    totalTokens: 100 + index,
    durationMs: 10 + index,
    captureMetadata: { source: "test" },
  });
const request = (mode: "immediate" | "review" = "immediate") =>
  RunRequestSchema.parse({
    query: "Find help requests",
    mode,
    population: new PopulationRequest(),
    parallelism: 2,
  });
const classification = (index: number) =>
  TraceClassificationSchema.parse({
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    answers: [{ value: true, matched: true }],
    matched: true,
    rawResult: {
      private: "must not be exported",
      nested: { value: "original" },
    },
  });
const snap = (v: RunSnapshot) => ({
  generation: v.generation,
  state: v.state,
  phase: v.phase,
  within_results: v.withinResults,
  loaded: v.loaded,
  to_load: v.toLoad,
  total: v.total,
  completed: v.completed,
  failed: v.failed,
  matched: v.matched,
  active: v.active,
  queued: v.queued,
  percent: v.percent,
  elapsed: v.elapsed,
  rate: v.rate,
  error: v.error,
  plan_warning: v.planWarning,
  ids: [...v.traceIds],
  results: Object.keys(v.results).sort(),
  dimensions: v.dimensions?.length ?? null,
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
function setup(input: { traces?: TraceRecord[]; fail?: boolean } = {}) {
  const entered = gate(),
    finish = gate();
  let onComplete!: (result: TraceClassification) => Promise<void>,
    seconds = 0,
    loads = 0;
  const options: RunStoreOptions = {
    compiler: async () =>
      new CompiledPlan({
        dimensions: [dimension],
        numeric: new NumericFilters({ tokensMin: 100, durationMsMin: 20 }),
      }),
    filterSelector: async () => new FacetSelection({ provider: ["openai"] }),
    populationLoader: async () => {
      loads++;
      return new Snapshot({
        traces: input.traces ?? [trace(0), trace(1), trace(2)],
      });
    },
    runClassifier: async (traces, _projections, _dimensions, options) => {
      onComplete = options.onComplete;
      entered.release();
      if (input.fail) {
        await onComplete(classification(0));
        throw new Error("classifier runner exploded");
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        finish.promise.then(() => {
          options.signal.removeEventListener("abort", abort);
          resolve();
        });
      });
      for (const t of traces)
        await onComplete(classification(Number(t.traceId.slice(6))));
    },
    projectTrace: () => ({
      payload: {},
      serialized: "",
      estimatedTokens: 0,
      omittedMessages: 0,
      omittedBytes: 0,
    }),
    monotonic: () => seconds,
    nowUtc: () => new Date(Date.UTC(2026, 8, 20, 0, 0, seconds)).toISOString(),
  };
  const store = new RunStore(options);
  return {
    store,
    entered,
    finish,
    complete: (i: number) => onComplete(classification(i)),
    setTime: (v: number) => {
      seconds = v;
    },
    loads: () => loads,
  };
}
async function terminal(store: RunStore) {
  for (let i = 0; i < 100; i++) {
    const view = await store.snapshot();
    if (!["compiling", "classifying"].includes(view.state)) return view;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("run did not settle");
}

test("immediate lifecycle, duplicate callbacks and reset match Python", async () => {
  const x = setup();
  try {
    const out = [snap(await x.store.compile(request()))];
    await x.entered.promise;
    x.setTime(2);
    await x.complete(0);
    await x.complete(0);
    out.push(snap(await x.store.snapshot()));
    x.finish.release();
    out.push(snap(await terminal(x.store)));
    out.push(snap(await x.store.reset()));
    expect(out).toEqual(gold.immediate);
  } finally {
    x.finish.release();
    await x.store.close();
  }
});

test("review and reviewed start match Python", async () => {
  const x = setup();
  try {
    const review = await x.store.compile(request("review"));
    const started = await x.store.start(
      request("review"),
      review.dimensions ?? [],
    );
    await x.entered.promise;
    x.finish.release();
    const done = await terminal(x.store);
    expect([snap(review), snap(started), snap(done), x.loads()]).toEqual(
      gold.review,
    );
  } finally {
    x.finish.release();
    await x.store.close();
  }
});

test("empty and duplicate populations fail like Python", async () => {
  for (const [traces, key] of [
    [[], "empty"],
    [[trace(0), trace(0)], "duplicate"],
  ] as const) {
    const x = setup({ traces: [...traces] });
    try {
      expect(snap(await x.store.compile(request()))).toEqual(gold[key]);
    } finally {
      await x.store.close();
    }
  }
});

test("runner failure and cancellation match Python", async () => {
  const x = setup({ fail: true });
  try {
    await x.store.compile(request());
    await x.entered.promise;
    expect(snap(await terminal(x.store))).toEqual(gold.failure);
  } finally {
    await x.store.close();
  }
  const y = setup();
  try {
    await y.store.compile(request());
    await y.entered.promise;
    expect(snap(await y.store.cancel())).toEqual(gold.cancel);
  } finally {
    y.finish.release();
    await y.store.close();
  }
});

test("cancellation waits for planning cleanup and ignores stale callbacks", async () => {
  const entered = gate(),
    cleaning = gate(),
    release = gate();
  const x = setup();
  const store = new RunStore({
    compiler: async (_query, signal) => {
      entered.release();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cleaning.release();
            release.promise.then(resolve);
          },
          { once: true },
        ),
      );
      return new CompiledPlan({
        dimensions: [dimension],
        numeric: new NumericFilters(),
      });
    },
    filterSelector: async () => new FacetSelection(),
    populationLoader: async () => new Snapshot({ traces: [trace(0)] }),
    runClassifier: async () => {
      throw new Error("unexpected classifier");
    },
  });
  try {
    await store.compile(request(), { wait: false });
    await entered.promise;
    let done = false;
    const cancellation = store.cancel().then((v) => {
      done = true;
      return v;
    });
    await cleaning.promise;
    await Promise.resolve();
    expect(done).toBe(false);
    release.release();
    expect((await cancellation).state).toBe("cancelled");
    await store.completeOne(1, classification(0));
    expect((await store.snapshot()).completed).toBe(0);
  } finally {
    release.release();
    await store.close();
    await x.store.close();
  }
});

test("reviewed unchanged population reuses the staged traces", async () => {
  const x = setup();
  try {
    const review = await x.store.compile(request("review"));
    expect(x.loads()).toBe(1);
    if (!review.request) throw new Error("missing review request");
    const started = await x.store.start(
      review.request,
      review.dimensions ?? [],
    );
    expect(started.state).toBe("classifying");
    expect(x.loads()).toBe(1);
    await x.entered.promise;
    x.finish.release();
    await terminal(x.store);
  } finally {
    x.finish.release();
    await x.store.close();
  }
});

test("shared planner narrows loaded rows before applying the limit", async () => {
  const x = setup();
  let limited = 0;
  const store = new RunStore({
    planner: async (_query, population) => ({
      dimensions: [dimension],
      generatedFacets: new FacetSelection({ status: ["completed"] }),
      generatedNumeric: new NumericFilters({ tokensMin: 101 }),
      generatedTime: null,
      effectivePopulation: population,
      selectorResponse: null,
      selectorError: null,
      provenance: {},
      usage: {},
      unsupportedReason: null,
      emptyMatch: false,
      modelCalls: [],
    }),
    populationLoader: async () => {
      throw new Error("unexpected population load");
    },
    runClassifier: async () => {},
    projectTrace: () => ({
      payload: {},
      serialized: "",
      estimatedTokens: 0,
      omittedMessages: 0,
      omittedBytes: 0,
    }),
  });
  try {
    const req = RunRequestSchema.parse({
      ...request("review"),
      population: new PopulationRequest({ limit: 1 }),
    });
    const view = await store.compile(req, {
      traces: async () => [trace(0), trace(1), trace(2)],
      tracesLimited: async () => {
        limited++;
        return [trace(0)];
      },
    });
    expect(view.state).toBe("awaiting_review");
    expect(view.traceIds).toEqual(["trace-1"]);
    expect(limited).toBe(0);
    expect(view.loaded).toBe(3);
  } finally {
    await store.close();
    await x.store.close();
  }
});

test("detached snapshots do not expose mutable nested results", async () => {
  const x = setup();
  try {
    await x.store.compile(request());
    await x.entered.promise;
    await x.complete(0);
    const first = await x.store.snapshot();
    const firstResult = first.results["trace-0"];
    if (!firstResult) throw new Error("missing result");
    firstResult.rawResult.private = "changed";
    (firstResult.rawResult.nested as { value: string }).value = "changed";
    const next = await x.store.snapshot();
    expect(next.results["trace-0"]?.rawResult.private).toBe(
      "must not be exported",
    );
    expect(next.results["trace-0"]?.rawResult.nested).toEqual({
      value: "original",
    });
  } finally {
    x.finish.release();
    await x.store.close();
  }
});

test("population progress is scoped to the current run", async () => {
  const entered = gate(),
    finish = gate();
  const store = new RunStore({
    compiler: async () =>
      new CompiledPlan({
        dimensions: [dimension],
        numeric: new NumericFilters(),
      }),
    filterSelector: async () => new FacetSelection(),
    populationLoader: async () => {
      reportLoadProgress(2, 5);
      entered.release();
      await finish.promise;
      return new Snapshot({ traces: [trace(0)] });
    },
    runClassifier: async () => {},
    projectTrace: () => ({
      payload: {},
      serialized: "",
      estimatedTokens: 0,
      omittedMessages: 0,
      omittedBytes: 0,
    }),
  });
  try {
    await store.compile(request("review"), { wait: false });
    await entered.promise;
    const loading = await store.snapshot();
    expect([loading.phase, loading.loaded, loading.toLoad]).toEqual([
      "loading_traces",
      2,
      5,
    ]);
    finish.release();
    expect((await terminal(store)).state).toBe("awaiting_review");
    reportLoadProgress(99, 99);
    expect((await store.snapshot()).loaded).toBe(2);
  } finally {
    finish.release();
    await store.close();
  }
});

test("unselected callback IDs fail the active run", async () => {
  const x = setup();
  try {
    const view = await x.store.compile(request());
    await x.entered.promise;
    await expect(
      x.store.completeOne(view.generation, classification(99)),
    ).rejects.toThrow(
      "Terminal callback trace ID is outside the selected population.",
    );
    expect((await x.store.snapshot()).state).toBe("failed");
  } finally {
    x.finish.release();
    await x.store.close();
  }
});
