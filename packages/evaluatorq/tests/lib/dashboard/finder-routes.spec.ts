import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CSRF_FIELD, csrfToken } from "../../../src/lib/dashboard/security.js";
import {
  FinderState,
  finderRoutes,
  withFinderSessions,
} from "../../../src/lib/dashboard/trace-finder/routes.js";
import {
  type CompiledQuery,
  CompiledQuerySchema,
  FacetCatalogueSchema,
  type RunRequest,
  RunSnapshot,
  TraceClassificationSchema,
  TraceDetail,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";
import { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";
import views from "../fixtures/finder-views-python-goldens.json" with {
  type: "json",
};
import forms from "../fixtures/route-forms-python-goldens.json" with {
  type: "json",
};

const trace = new TraceRecord(views.trace);
const classification = TraceClassificationSchema.parse(
  views.classifications.ok,
);
const compiled = CompiledQuerySchema.parse(forms.current.choice);

class FakeStore {
  snapshotValue = new RunSnapshot();
  explorer = null;
  compileRequest: RunRequest | null = null;
  started: { request: RunRequest; dimensions: CompiledQuery[] } | null = null;

  async compile(request: RunRequest): Promise<RunSnapshot> {
    this.compileRequest = request;
    const classifying = request.mode !== "review";
    this.snapshotValue = new RunSnapshot({
      generation: 1,
      state: classifying ? "classifying" : "awaiting_review",
      request,
      dimensions: [compiled],
      explicitFilters: request.population.facets,
      explicitNumeric: request.population.numeric,
      traceIds: [trace.traceId],
      traces: [trace],
      total: 1,
      active: classifying ? 1 : 0,
      createdAt: "2026-09-01T00:00:00+00:00",
    });
    return this.snapshotValue;
  }

  async start(
    request: RunRequest,
    dimensions: CompiledQuery[],
  ): Promise<RunSnapshot> {
    this.started = { request, dimensions };
    this.complete(dimensions);
    return this.snapshotValue;
  }

  complete(dimensions: readonly CompiledQuery[] | null = null): void {
    this.snapshotValue = new RunSnapshot({
      ...this.snapshotValue,
      state: "completed",
      dimensions: dimensions ?? this.snapshotValue.dimensions ?? [compiled],
      results: { [trace.traceId]: classification },
      completed: 1,
      matched: 1,
      active: 0,
      finishedAt: "2026-09-01T00:01:00+00:00",
    });
  }

  async snapshot() {
    return this.snapshotValue;
  }
  async snapshotForRender() {
    return this.snapshotValue;
  }
  async cancel() {
    this.snapshotValue = new RunSnapshot({
      ...this.snapshotValue,
      state: "cancelled",
    });
    return this.snapshotValue;
  }
  async reset() {
    this.snapshotValue = new RunSnapshot({
      generation: this.snapshotValue.generation + 1,
    });
    return this.snapshotValue;
  }
  async traceDetail(traceId: string) {
    if (traceId !== trace.traceId) return null;
    return new TraceDetail(
      trace,
      null,
      Object.values(this.snapshotValue.results)[0] ?? null,
    );
  }
  async close() {}
}

const SCRATCH = join(process.env.HOME ?? ".", "finder-route-tests");
let root: string;
let store: FakeStore;
let catalogueLoads: number[];
let handle: (req: Request) => Promise<Response>;
const previous = {
  dir: process.env.EVALUATORQ_DIR,
  key: process.env.ORQ_API_KEY,
};

function app(
  options: { apiKey?: string | null; settings?: DashboardSettings } = {},
) {
  if (options.apiKey === null) delete process.env.ORQ_API_KEY;
  else process.env.ORQ_API_KEY = options.apiKey ?? "test-key";
  const state = new FinderState(
    options.settings ??
      new DashboardSettings({ windowDays: 7, orqAuthMethod: "environment" }),
    {
      buildStore: async () => store as never,
      loadCatalogue: async (_state, windowDays) => {
        catalogueLoads.push(windowDays);
        return FacetCatalogueSchema.parse({ project: ["support-agent"] });
      },
    },
  );
  const routes = finderRoutes(state);
  handle = withFinderSessions(state, async (req) => {
    const response = await routes(req, new URL(req.url));
    return response ?? new Response("Not found", { status: 404 });
  });
  return state;
}

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  chmodSync(root, 0o700);
  process.env.EVALUATORQ_DIR = root;
  store = new FakeStore();
  catalogueLoads = [];
  app();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["EVALUATORQ_DIR", previous.dir],
    ["ORQ_API_KEY", previous.key],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

const get = (path: string) => handle(new Request(`http://localhost${path}`));
const post = (path: string, values: Record<string, string> = {}) =>
  handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      body: new URLSearchParams({ [CSRF_FIELD]: csrfToken(), ...values }),
    }),
  );

test("compiling state shows the planning indicator", async () => {
  store.snapshotValue = new RunSnapshot({
    state: "compiling",
    phase: "planning",
  });
  const response = await get("/find");
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("finder-compiling");
  expect(html).toContain("Planning the search");
  expect(html).not.toContain("No traces loaded.");
});

test("facet menu loads itself after the page renders, then is cached", async () => {
  let page = await (await get("/find")).text();
  expect(catalogueLoads).toEqual([]);
  expect(page).toContain(
    'hx-get="/find/facets?form_id=finder-query-form" hx-trigger="load, refreshFacets" hx-include="#finder-controls"',
  );
  expect(page).toContain(
    'class="finder-facet-loading" role="status">Loading filters…',
  );
  const menu = await (
    await get("/find/facets?form_id=finder-query-form&window_days=7")
  ).text();
  expect(catalogueLoads).toEqual([7]);
  expect(menu).not.toContain('hx-trigger="load"');
  expect(menu).toContain("support-agent");
  page = await (await get("/find")).text();
  expect(page).toContain("support-agent");
  expect(catalogueLoads).toEqual([7]);
});

test("search page defaults to immediate mode and stays separate from traces", async () => {
  const html = await (await get("/find")).text();
  expect(html).toContain('value="immediate" form="finder-query-form" checked');
  expect(html).toContain("Find the signal.");
  expect(html).toContain('id="finder-controls"');
  expect(html).not.toContain('id="explorer-results-slot"');
  expect(html).toContain(`hx-vals='{"surface":"search"}'`);
});

test("traces page without an API key shows the auth error", async () => {
  const state = app({ apiKey: null });
  state.unavailableReason = "stale resolver error from another surface";
  const response = await get("/traces");
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("ORQ_API_KEY is not set");
  expect(html).not.toContain("stale resolver error");
  expect(response.headers.get("set-cookie")).toContain(
    "evaluatorq_dashboard_session",
  );
});

test("run starts polling, and the completed poll shows the match", async () => {
  const response = await post("/find/run", {
    query: "frustrated customers",
    mode: "immediate",
    surface: "search",
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('hx-get="/find/poll?surface=search"');
  expect(store.compileRequest?.query).toBe("frustrated customers");
  store.complete();
  const poll = await get("/find/poll?surface=search");
  expect(poll.status).toBe(200);
  expect(await poll.text()).not.toContain('hx-trigger="every 1s"');
});

for (const windowDays of ["0", "91", "abc"])
  test(`run rejects window_days=${windowDays}`, async () => {
    const response = await post("/find/run", {
      query: "q",
      window_days: windowDays,
      surface: "search",
    });
    expect(response.status).toBe(422);
    expect(store.compileRequest).toBeNull();
  });

test("run rejects a missing form token", async () => {
  const response = await handle(
    new Request("http://localhost/find/run", {
      method: "POST",
      body: new URLSearchParams({ query: "q" }),
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Stale or missing form token");
});

test("review start moves the plan to classification", async () => {
  await post("/find/run", { query: "q", mode: "review", surface: "search" });
  expect(store.snapshotValue.state).toBe("awaiting_review");
  const response = await post("/find/start", { query: "q", surface: "search" });
  expect(response.status).toBe(200);
  expect(store.started?.dimensions).toHaveLength(1);
  expect(store.snapshotValue.state).toBe("completed");
});

test("start without a waiting plan is a 409", async () => {
  const response = await post("/find/start", { query: "q", surface: "search" });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain(
    "There is no plan waiting for review.",
  );
});

test("export is 404 until completed, then downloads and saves JSON", async () => {
  expect((await get("/find/export.json?surface=search")).status).toBe(404);
  await post("/find/run", { query: "q", surface: "search" });
  store.complete();
  const response = await get("/find/export.json?surface=search");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="trace-finder-.*\.json"$/,
  );
  expect(JSON.parse(await response.text()).counts.matched).toBe(1);
});

test("export link for an older run is a 409", async () => {
  await post("/find/run", { query: "q", surface: "search" });
  store.complete();
  const response = await get(
    "/find/export.json?surface=search&export=trace-finder-old.json",
  );
  expect(response.status).toBe(409);
});

test("trace drawer renders a known trace and explains a missing one", async () => {
  await post("/find/run", { query: "q", surface: "search" });
  store.complete();
  const found = await get(
    `/find/trace/${encodeURIComponent(trace.traceId)}?surface=search`,
  );
  expect(found.status).toBe(200);
  const missing = await get("/find/trace/nope?surface=search");
  expect(missing.status).toBe(200);
  expect(await missing.text()).toContain("nope");
});

test("cancel and reset update the run", async () => {
  await post("/find/run", { query: "q", surface: "search" });
  await post("/find/cancel", { surface: "search" });
  expect(store.snapshotValue.state).toBe("cancelled");
  await post("/find/reset", { surface: "search" });
  expect(store.snapshotValue.state).toBe("idle");
});

test("facets keep a valid numeric filter and drop an inverted maximum", async () => {
  const html = await (
    await get(
      "/find/facets?form_id=finder-query-form&window_days=7&tokens_min=10&tokens_max=5&duration_ms_min=bad",
    )
  ).text();
  expect(html).toContain('value="10"');
  expect(html).not.toContain('value="5"');
});

test("dismiss returns an empty body and unknown paths fall through", async () => {
  expect(await (await get("/find/dismiss")).text()).toBe("");
  expect((await get("/find/unknown")).status).toBe(404);
});
