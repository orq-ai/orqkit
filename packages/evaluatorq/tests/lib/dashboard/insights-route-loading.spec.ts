import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startManifest } from "../../../src/lib/common/run-manifest.js";
import * as launch from "../../../src/lib/dashboard/insights-launch.js";
import { insightsRoutes } from "../../../src/lib/dashboard/insights-routes.js";
import * as uploads from "../../../src/lib/dashboard/insights-uploads.js";
import * as views from "../../../src/lib/dashboard/insights-views.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";
import { InsightsRunSchema } from "../../../src/lib/insights/models.js";
import * as store from "../../../src/lib/insights/store.js";
import { RunExport } from "../../../src/lib/trace-finder/export.js";

let root: string;
let runs: string;
let finder: string;
let routes: ReturnType<typeof insightsRoutes>;
const restores: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eq-insights-loading-"));
  runs = join(root, "runs");
  finder = join(root, "finder");
  mkdirSync(runs, { mode: 0o700 });
  mkdirSync(finder, { mode: 0o700 });
  routes = insightsRoutes({ runsDir: () => runs, finderDir: () => finder });
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  rmSync(root, { recursive: true, force: true });
});

function savedRun(id: string, name = id) {
  return InsightsRunSchema.parse({
    runId: id,
    runName: name,
    createdAt: "2026-11-23T12:00:00Z",
    status: "completed",
    stageFailures: [],
    population: { mode: "snapshot", privatePayload: "sensitive" },
    config: { labels: [], dimensions: [] },
    traces: [
      {
        traceId: "trace",
        spanId: null,
        timestamp: "2026-11-23T12:00:00Z",
        labels: {},
        summary: null,
        toolStats: null,
        assignments: {},
      },
    ],
    dimensions: {},
    labels: {},
    priority: null,
    priorityReason: null,
    counts: { n_traces: 1 },
    warnings: [],
  });
}

function writeRun(id: string, name = id) {
  const path = join(runs, `insights_20261123-${id}.json`);
  writeFileSync(path, store.insightsRunJson(savedRun(id, name)), {
    mode: 0o600,
  });
  return path;
}

async function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost");
  return (await routes(new Request(url.toString(), init), url)) as Response;
}

test("a manifested run reads only its report and reconciles no unrelated worker", async () => {
  const path = writeRun("wanted");
  writeRun("unrelated");
  const writer = await startManifest({
    runsDir: runs,
    runId: "wanted",
    surface: "insights",
    runName: "Wanted",
  });
  await writer.complete(path);
  await startManifest({
    runsDir: runs,
    runId: "unrelated",
    surface: "insights",
    runName: "Unrelated",
  });
  const load = spyOn(store, "loadRun");
  const reconcile = spyOn(launch, "reconcileStaleWorker");
  restores.push(
    () => load.mockRestore(),
    () => reconcile.mockRestore(),
  );
  const response = await request("/insights/wanted/review-data.json");
  expect(response.status).toBe(200);
  expect(load.mock.calls).toEqual([[path]]);
  expect(reconcile).not.toHaveBeenCalled();
});

test("home polling caches only overview metadata and refreshes changed or deleted reports", async () => {
  const path = writeRun("legacy", "Original");
  const load = spyOn(store, "loadRun");
  const overview = spyOn(views, "overviewPage");
  restores.push(
    () => load.mockRestore(),
    () => overview.mockRestore(),
  );
  expect(await (await request("/insights")).text()).toContain("Original");
  expect(load).toHaveBeenCalledTimes(1);
  const retained = overview.mock.calls[0]?.[1].get("legacy");
  expect(retained).toEqual({
    createdAt: "2026-11-23T12:00:00Z",
    counts: { n_traces: 1 },
    traces: [],
    dimensions: {},
  });
  expect(await (await request("/insights")).text()).toContain("Original");
  expect(load).toHaveBeenCalledTimes(1);
  writeRun("legacy", "Changed report name");
  expect(await (await request("/insights")).text()).toContain(
    "Changed report name",
  );
  expect(load).toHaveBeenCalledTimes(2);
  unlinkSync(path);
  expect(await (await request("/insights")).text()).not.toContain(
    "Changed report name",
  );
});

test("legacy ID and filename aliases remain available after the overview cache warms", async () => {
  writeRun("legacy");
  await request("/insights");
  for (const id of ["legacy", "insights_20261123-legacy"])
    expect((await request(`/insights/${id}/review-data.json`)).status).toBe(
      200,
    );
  expect((await request("/insights/missing/review-data.json")).status).toBe(
    404,
  );
});

test.skipIf(process.platform === "win32")(
  "Finder preview reports oversize rejection from the approved reader",
  async () => {
    const path = join(finder, "large.json");
    const fd = openSync(path, "w", 0o600);
    try {
      ftruncateSync(fd, uploads.MAX_FINDER_EXPORT_BYTES + 1);
    } finally {
      closeSync(fd);
    }
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    const response = await request("/insights/finder-preview", {
      method: "POST",
      body: new URLSearchParams({ csrf: csrfToken(), finder_path: path }),
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("10 MiB size limit");
    expect(warn).toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "Finder preview canonicalizes the approved directory like launch",
  async () => {
    const exportFile = join(finder, "valid.json");
    writeFileSync(
      exportFile,
      JSON.stringify(
        new RunExport({
          query: "fixture",
          dimensions: [],
          generatedFilters: {},
          filters: {},
          generatedNumeric: {},
          numeric: {},
          limit: 1,
          parallelism: 1,
          times: { elapsed: 0, rate: 0 },
          counts: {
            total: 0,
            completed: 0,
            failed: 0,
            matched: 0,
            active: 0,
            queued: 0,
            percent: 0,
          },
          traces: [],
          matchedTraceIds: [],
        }),
      ),
      { mode: 0o600 },
    );
    const alias = join(root, "finder-alias");
    symlinkSync(finder, alias);
    routes = insightsRoutes({ runsDir: () => runs, finderDir: () => alias });
    const response = await request("/insights/finder-preview", {
      method: "POST",
      body: new URLSearchParams({ csrf: csrfToken(), finder_path: exportFile }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("0 matched traces");
  },
);

for (const [label, headers] of [
  [
    "cross-site",
    { "Sec-Fetch-Site": "cross-site", "X-CSRF-Token": csrfToken() },
  ],
  ["stale token", { "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": "stale" }],
  ["missing token", { "Sec-Fetch-Site": "same-origin" }],
] as const)
  test(`upload rejects ${label} before reading or sweeping`, async () => {
    let pulled = false;
    const cleanup = spyOn(uploads, "cleanupExpiredUploads");
    restores.push(() => cleanup.mockRestore());
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
          throw new Error("Body must not be read");
        },
      },
      { highWaterMark: 0 },
    );
    const url = new URL("http://localhost/insights/uploads");
    const req = new Request(url.toString(), {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    const response = (await routes(req, url)) as Response;
    expect(response.status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(pulled).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });
