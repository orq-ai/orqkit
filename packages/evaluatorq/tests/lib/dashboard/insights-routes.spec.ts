import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DashboardAuth } from "../../../src/lib/dashboard/auth.js";
import { insightsRoutes } from "../../../src/lib/dashboard/insights-routes.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";

type Row = Record<string, unknown>;
const SCRATCH = join(process.env.HOME ?? ".", "insights-routes-tests");
const previous = process.env.EVALUATORQ_DIR;
let root: string;
let runsDir: string;
let warn: ReturnType<typeof spyOn<Console, "warn">>;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  runsDir = join(root, "insights");
  mkdirSync(runsDir, { recursive: true });
  process.env.EVALUATORQ_DIR = root;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.EVALUATORQ_DIR;
  else process.env.EVALUATORQ_DIR = previous;
});

const frustration = {
  name: "user_frustration",
  kind: "score",
  instructions: "Rate frustration.",
  criteria: ["1 calm", "2 mild", "3 irritated", "4 frustrated", "5 angry"],
};

function trace(spanId: string | null, update: Row = {}): Row {
  return {
    trace_id: "t1",
    span_id: spanId,
    timestamp: "2026-09-01T09:30:00",
    labels: {
      user_frustration: {
        value: 0,
        confidence: null,
        probabilities: null,
        error: null,
      },
    },
    summary: null,
    tool_stats: null,
    assignments: {},
    ...update,
  };
}

function writeRun(update: Row = {}): void {
  const traces = [trace("s1")];
  const run = {
    run_id: "route-test",
    run_name: "Route test",
    created_at: "2026-09-01T12:00:00+00:00",
    status: "completed",
    stage_failures: [],
    population: { mode: "snapshot", limit: 1 },
    config: { labels: [frustration], dimensions: [] },
    traces,
    dimensions: {},
    labels: {
      user_frustration: {
        spec: frustration,
        counts: { "1": 1 },
        mean_confidence: null,
        n_low_confidence: 0,
        n_failed: 0,
      },
    },
    priority: null,
    priority_reason: null,
    counts: { n_traces: 1 },
    warnings: [],
    ...update,
  };
  writeFileSync(
    join(runsDir, "insights_20260901-120000_route-test.json"),
    JSON.stringify(run),
  );
}

const auth = new DashboardAuth(
  "stored_api_key",
  "sk-test",
  "https://my.orq.ai",
);
const handler = (extra: Parameters<typeof insightsRoutes>[0] = {}) =>
  insightsRoutes({
    runsDir: () => runsDir,
    finderDir: () => join(root, "finder-exports"),
    selectedAuth: async () => auth,
    ...extra,
  });

async function get(path: string, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost${path}`);
  return handler()(new Request(url.href, { headers }), url);
}

async function post(
  path: string,
  fields: [string, string][],
  options: { csrf?: string | null; routes?: ReturnType<typeof handler> } = {},
) {
  const url = new URL(`http://localhost${path}`);
  const body = new URLSearchParams(fields);
  const token = options.csrf === undefined ? csrfToken() : options.csrf;
  if (token !== null) body.set("csrf", token);
  return (options.routes ?? handler())(
    new Request(url.href, { method: "POST", body }),
    url,
  );
}

test("paths outside /insights fall through", async () => {
  expect(await get("/r/abc")).toBeNull();
  expect(await get("/insightsx")).toBeNull();
});

test("the home page lists a saved run", async () => {
  writeRun();
  const response = (await get("/insights")) as Response;
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Route test");
});

test("unknown runs return 404 on every run route", async () => {
  expect((await get("/insights/missing"))?.status).toBe(404);
  const data = (await get("/insights/missing/review-data.json")) as Response;
  expect(data.status).toBe(404);
  expect(data.headers.get("cache-control")).toBe("no-store");
  expect(await data.json()).toEqual({ error: "Insights run not found" });
  expect((await get("/insights/missing/map.json"))?.status).toBe(404);
  expect((await get("/insights/missing/export.json"))?.status).toBe(404);
  expect((await get("/insights/missing/rerun"))?.status).toBe(404);
  expect((await get("/insights/route-test/tab/nope"))?.status).toBe(404);
});

test("a run resolves by its id and by its file stem", async () => {
  writeRun();
  const byId = (await get("/insights/route-test/review-data.json")) as Response;
  expect(byId.status).toBe(200);
  expect(((await byId.json()) as Row).run).toBeDefined();
  const byStem = await get(
    "/insights/insights_20260901-120000_route-test/review-data.json",
  );
  expect(byStem?.status).toBe(200);
});

test("trace signals need both locator fields and match an empty span to none", async () => {
  writeRun({ traces: [trace(null)] });
  const missing = (await get(
    "/insights/route-test/trace-signals.json?trace_id=t1",
  )) as Response;
  expect(missing.status).toBe(400);
  const found = await get(
    "/insights/route-test/trace-signals.json?trace_id=t1&span_id=",
  );
  expect(found?.status).toBe(200);
  const absent = await get(
    "/insights/route-test/trace-signals.json?trace_id=other&span_id=",
  );
  expect(absent?.status).toBe(404);
});

test("a full-page tab request redirects to the review hash", async () => {
  writeRun();
  const response = (await get(
    "/insights/route-test/tab/map?label=user_frustration&value=1",
  )) as Response;
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "/insights/route-test#view=map&f=l%3Auser_frustration%3A1",
  );
  const rerun = (await get("/insights/route-test/rerun")) as Response;
  expect(rerun.headers.get("location")).toBe("/insights/route-test?rerun=1");
});

test("export downloads the run as an attachment", async () => {
  writeRun();
  const response = (await get("/insights/route-test/export.json")) as Response;
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="route-test.json"',
  );
  expect(((await response.json()) as Row).runId ?? "").toBeTruthy();
});

test("a missing trace renders a 404 fragment", async () => {
  writeRun();
  const response = (await get(
    "/insights/route-test/trace?trace_id=nope&span_id=s1",
  )) as Response;
  expect(response.status).toBe(404);
  expect(await response.text()).toContain(
    "Trace not found in this Insights run.",
  );
});

test("span loading is unavailable for a snapshot run", async () => {
  writeRun();
  const response = await get(
    "/insights/route-test/trace-spans?trace_id=t1&span_id=s1",
  );
  expect(response?.status).toBe(404);
});

test("facet windows outside 1 to 90 days are rejected", async () => {
  expect((await get("/insights/facets?window_days=x"))?.status).toBe(422);
  expect((await get("/insights/facets?window_days=91"))?.status).toBe(422);
});

test("facet catalogues are cached per credential and window", async () => {
  let calls = 0;
  const routes = handler({
    loadCatalogue: async () => {
      calls++;
      return {
        project: [],
        status: [],
        product: [],
      } as never;
    },
  });
  for (let i = 0; i < 2; i++) {
    const url = new URL("http://localhost/insights/facets?window_days=7");
    expect((await routes(new Request(url.href), url))?.status).toBe(200);
  }
  expect(calls).toBe(1);
  const retry = new URL(
    "http://localhost/insights/facets?window_days=7&retry=1",
  );
  await routes(new Request(retry.href), retry);
  expect(calls).toBe(2);
});

test("unknown model fields render nothing", async () => {
  const response = (await get("/insights/models?field=nope")) as Response;
  expect(await response.text()).toBe("");
});

test("session routes reject a missing CSRF token", async () => {
  const search = await post(
    "/insights/sessions/search",
    [["session_source", "codex"]],
    { csrf: null },
  );
  expect(search?.status).toBe(403);
  const snapshot = await post("/insights/sessions/snapshot", [], {
    csrf: null,
  });
  expect(snapshot?.status).toBe(403);
});

test("session search validates sources, dates and text", async () => {
  const bad = async (fields: [string, string][]) =>
    (await (
      (await post("/insights/sessions/search", fields)) as Response
    ).text()) as string;
  expect(await bad([["session_source", "nope"]])).toContain(
    "Choose at least one valid session source.",
  );
  expect(
    await bad([
      ["session_source", "codex"],
      ["session_from", "2026-13-01"],
      ["tz_offset", "0"],
    ]),
  ).toContain("From and To must be dates like 2026-10-07.");
  expect(
    await bad([
      ["session_source", "codex"],
      ["session_from", "2026-10-07"],
      ["tz_offset", "abc"],
    ]),
  ).toContain("The browser timezone offset is not usable.");
  expect(
    await bad([
      ["session_source", "codex"],
      ["session_project_dir", "relative/dir"],
    ]),
  ).toContain("Enter an absolute project directory");
  expect(
    await bad([
      ["session_source", "codex"],
      ["session_text", "x".repeat(501)],
    ]),
  ).toContain("Search text is limited to 500 characters.");
});

test("session snapshots need valid selections", async () => {
  const none = (await post("/insights/sessions/snapshot", [])) as Response;
  expect(none.status).toBe(422);
  expect(await none.json()).toEqual({ error: "Select at least one session." });
  const bad = (await post("/insights/sessions/snapshot", [
    ["session", "nope:/x.jsonl"],
  ])) as Response;
  expect(await bad.json()).toEqual({
    error: "A selected session is not valid.",
  });
});

test("the directory browser rejects a negative offset", async () => {
  const response = (await post("/insights/sessions/directories", [
    ["path", root],
    ["offset", "-1"],
  ])) as Response;
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    error: "Directory page offset must be a nonnegative integer.",
  });
});

test("previews reject a missing path and an unapproved Finder export", async () => {
  expect((await post("/insights/snapshot-preview", []))?.status).toBe(422);
  const finder = (await post("/insights/finder-preview", [
    ["finder_path", join(root, "elsewhere.json")],
  ])) as Response;
  expect(finder.status).toBe(422);
  expect(await finder.text()).toContain(
    "Could not read a valid Finder export.",
  );
});

test("uploads need a CSRF token and a file", async () => {
  const url = new URL("http://localhost/insights/uploads");
  const form = new FormData();
  const rejected = (await handler()(
    new Request(url.href, { method: "POST", body: form }),
    url,
  )) as Response;
  expect(rejected.status).toBe(403);
  form.set("csrf", csrfToken());
  const empty = (await handler()(
    new Request(url.href, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken() },
      body: form,
    }),
    url,
  )) as Response;
  expect(empty.status).toBe(422);
  expect(await empty.json()).toEqual({
    error: "Choose a JSON file to upload.",
  });
});

test("starting a run without a token re-renders the form with 403", async () => {
  const response = (await post("/insights/runs", [], {
    csrf: null,
  })) as Response;
  expect(response.status).toBe(403);
});
