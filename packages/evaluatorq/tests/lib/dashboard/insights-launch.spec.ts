import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  listManifests,
  startManifest,
} from "../../../src/lib/common/run-manifest.js";
import {
  cleanupSnapshot,
  ensurePrivateFinderReferenceDir,
  finderExportReferencePath,
  InsightsLaunchSpec,
  launchInsights,
  MANIFEST_ENV,
  REQUEST_ENV,
  readLaunchPayload,
  readPrivateFinderReference,
  readPrivateSnapshot,
  reconcileStaleWorker,
  SNAPSHOT_DIR_PREFIX,
  SOURCE_BY_MODE,
  workerProcessIdentity,
  workerStatePath,
} from "../../../src/lib/dashboard/insights-launch.js";
import { storeUpload } from "../../../src/lib/dashboard/insights-uploads.js";
import { snapshotCandidateFromRequest } from "../../../src/lib/dashboard/insights-worker.js";
import { InsightsPopulation } from "../../../src/lib/insights/models.js";
import {
  CUSTOMER_SATISFACTION,
  SENTIMENT,
} from "../../../src/lib/insights/presets.js";
import { stagePlan } from "../../../src/lib/insights/progress.js";
import { FacetSelection } from "../../../src/lib/trace-finder/models.js";
import goldens from "../fixtures/insights-uploads-python-goldens.json" with {
  type: "json",
};

const SCRATCH = join(process.env.HOME ?? ".", "insights-launch-tests");
const DEAD_PID = 4_194_000;
let root: string;
const previous = {
  dir: process.env.EVALUATORQ_DIR,
  tmp: process.env.TMPDIR,
};

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  chmodSync(root, 0o700);
  process.env.EVALUATORQ_DIR = root;
  process.env.TMPDIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["EVALUATORQ_DIR", previous.dir],
    ["TMPDIR", previous.tmp],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  delete process.env[REQUEST_ENV];
  delete process.env[MANIFEST_ENV];
});

/** A stand-in worker that records the handshake byte it receives, then exits. */
function fakeWorker(): { entry: string; record: string } {
  const record = join(root, "handshake.txt");
  const entry = join(root, "fake-worker.mjs");
  writeFileSync(
    entry,
    `import { writeFileSync } from "node:fs";
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => writeFileSync(${JSON.stringify(record)}, data || "EOF"));`,
  );
  return { entry, record };
}

async function waitFor(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function snapshotFile(): { directory: string; path: string } {
  const directory = mkdtempSync(join(root, SNAPSHOT_DIR_PREFIX));
  chmodSync(directory, 0o700);
  const path = join(directory, "finder-export.json");
  writeFileSync(path, "{}");
  chmodSync(path, 0o600);
  return { directory, path };
}

function writeState(path: string, state: Record<string, unknown>) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  chmodSync(join(path, ".."), 0o700);
  writeFileSync(path, JSON.stringify(state));
  chmodSync(path, 0o600);
}

async function finderLease(runsDir: string, runId: string): Promise<string> {
  const reference = finderExportReferencePath(runsDir, runId);
  await ensurePrivateFinderReferenceDir(join(reference, ".."));
  writeFileSync(
    reference,
    JSON.stringify({ finder_export: "/private/export.json" }),
  );
  chmodSync(reference, 0o600);
  return reference;
}

test("stage plan follows source, labels and dimensions", () => {
  const query = Object.fromEntries(
    stagePlan(
      new InsightsPopulation({ query: "refunds" }),
      [SENTIMENT],
      ["intent", "failure"],
    ),
  );
  const finder = Object.fromEntries(
    stagePlan(
      InsightsPopulation.fromFinderExport("finder.json"),
      [],
      ["sentiment"],
    ),
  );
  const snapshot = Object.fromEntries(
    stagePlan(InsightsPopulation.fromSnapshot("traces.json"), [], ["intent"]),
  );
  const priority = Object.fromEntries(
    stagePlan(new InsightsPopulation(), [CUSTOMER_SATISFACTION], ["intent"]),
  );
  expect(query.population).toBe("Find matching traces");
  expect(query.label).toBe("Match and classify traces");
  expect(query["dimension:failure"]).toBeDefined();
  expect(query["dimension:sentiment"]).toBeUndefined();
  expect(finder.population).toBe("Load Finder matches");
  expect(finder.label).toBe("Classify traces");
  expect(snapshot.population).toBe("Load local traces");
  expect(priority.priority).toBe("Build priority matrix");
  expect(SOURCE_BY_MODE).toEqual({
    filter: "recent",
    query: "query",
    export: "finder",
    snapshot: "snapshot",
  });
});

test("wizard validates the source before launch", async () => {
  await expect(
    InsightsLaunchSpec.create({ source: "query", query: "  " }),
  ).rejects.toThrow("Enter a question");
  await expect(
    InsightsLaunchSpec.create({ labels: [], dimensions: [] }),
  ).rejects.toThrow("Select at least one");
  await expect(
    InsightsLaunchSpec.create({
      source: "finder",
      facets: new FacetSelection({ status: ["error"] }),
    }),
  ).rejects.toThrow("Finder export already fixes");
  await expect(
    InsightsLaunchSpec.create({ source: "snapshot" }),
  ).rejects.toThrow("Browse to choose a trace file first");
  await expect(
    InsightsLaunchSpec.create({ labels: ["sentiment", "sentiment"] }),
  ).rejects.toThrow("Select each label and dimension once.");
  await expect(InsightsLaunchSpec.create({ labels: ["nope"] })).rejects.toThrow(
    "available Insights label presets",
  );
});

test("wizard accepts a local snapshot and rejects raw sessions and empty files", async () => {
  const path = join(root, "traces.json");
  writeFileSync(path, JSON.stringify(goldens.snapshot_one));
  const spec = await InsightsLaunchSpec.create({
    source: "snapshot",
    snapshot_path: path,
  });
  expect(spec.population().snapshotPath).toBe(path);
  writeFileSync(path, JSON.stringify(goldens.snapshot_documents));
  await InsightsLaunchSpec.create({ source: "snapshot", snapshotPath: path });
  writeFileSync(path, JSON.stringify(goldens.snapshot_empty));
  await expect(
    InsightsLaunchSpec.create({ source: "snapshot", snapshotPath: path }),
  ).rejects.toThrow("contains no traces");
  writeFileSync(path, '[{"session_id": "one", "thread": []}]');
  await expect(
    InsightsLaunchSpec.create({ source: "snapshot", snapshotPath: path }),
  ).rejects.toThrow("valid local trace snapshot");
});

test("an uploaded snapshot removed before launch is revalidated", async () => {
  const path = await storeUpload(
    join(root, "insights-runs"),
    Buffer.from(JSON.stringify(goldens.snapshot_one)),
    "snapshot",
  );
  await InsightsLaunchSpec.create({ source: "snapshot", snapshotPath: path });
  rmSync(path);
  await expect(
    InsightsLaunchSpec.create({ source: "snapshot", snapshotPath: path }),
  ).rejects.toThrow("Could not read a valid local trace snapshot");
});

test("Finder exports must be in the approved directory", async () => {
  const allowedDir = join(root, "finder-exports");
  mkdirSync(allowedDir);
  const allowed = join(allowedDir, "finder.json");
  const outside = join(root, "outside.json");
  const payload = JSON.stringify(goldens.export_one);
  writeFileSync(allowed, payload);
  writeFileSync(outside, payload);
  symlinkSync(outside, join(allowedDir, "link.json"));
  const relative = await InsightsLaunchSpec.create({
    source: "finder",
    finderExport: "finder.json",
  });
  expect(relative.finderExport).toBe(allowed);
  expect(relative.validatedFinderExportSnapshot()).toBe(payload);
  for (const path of [outside, "../outside.json", "link.json"])
    await expect(
      InsightsLaunchSpec.create({ source: "finder", finderExport: path }),
    ).rejects.toThrow("Finder exports must be in");
});

test("launch persists the plan, then releases the worker after recording its PID", async () => {
  const { entry, record } = fakeWorker();
  const spec = await InsightsLaunchSpec.create({
    source: "query",
    query: "refunds",
    labels: ["sentiment"],
    dimensions: ["intent", "failure"],
  });
  const runId = await launchInsights(spec, root, { entry });
  const [manifest] = await listManifests(root);
  expect(manifest?.runId).toBe(runId);
  expect(manifest?.status).toBe("running");
  expect(manifest?.plannedStages).toEqual([
    "population",
    "label",
    "summary",
    "dimension:intent",
    "dimension:failure",
    "priority",
    "write",
  ]);
  expect(manifest?.stageLabels.label).toBe("Match and classify traces");
  expect(manifest?.parallelism).toBe(spec.parallelism);
  expect(await waitFor(record)).toBe("1");
  const state = JSON.parse(readFileSync(workerStatePath(root, runId), "utf8"));
  expect(state.pid).toBeGreaterThan(0);
  expect(state.launcher_pid).toBe(process.pid);
  expect(existsSync(join(root, ".logs", `${runId}.log`))).toBe(true);
});

test("a spawn failure is visible in the manifest and cleans worker state", async () => {
  const spec = await InsightsLaunchSpec.create({});
  const runId = await launchInsights(spec, root, {
    entry: join(root, "missing-worker.mjs"),
  });
  // The child starts but exits on the missing script; force a real spawn failure instead.
  expect(runId).toBeTruthy();
  const original = process.execPath;
  Object.defineProperty(process, "execPath", {
    value: join(root, "no-such-runtime"),
    configurable: true,
  });
  try {
    const failed = await launchInsights(spec, root, { entry: "x" });
    const manifest = (await listManifests(root)).find(
      (item) => item.runId === failed,
    );
    expect(manifest?.status).toBe("error");
    expect(manifest?.error).toContain("Could not start Insights worker");
    expect(existsSync(workerStatePath(root, failed))).toBe(false);
  } finally {
    Object.defineProperty(process, "execPath", {
      value: original,
      configurable: true,
    });
  }
});

test("a Finder launch records its source lease and a private snapshot", async () => {
  const { entry } = fakeWorker();
  const exportDir = join(root, "finder-exports");
  mkdirSync(exportDir);
  const exportPath = join(exportDir, "trace-finder-source.json");
  writeFileSync(exportPath, JSON.stringify(goldens.export_one));
  const spec = await InsightsLaunchSpec.create({
    source: "finder",
    finderExport: "trace-finder-source.json",
  });
  const runsDir = join(root, "insights-runs");
  const runId = await launchInsights(spec, runsDir, { entry });
  const reference = finderExportReferencePath(runsDir, runId);
  expect(JSON.parse(readFileSync(reference, "utf8"))).toEqual({
    finder_export: exportPath,
  });
  expect(statSync(reference).mode & 0o777).toBe(0o600);
  expect(statSync(join(reference, "..")).mode & 0o777).toBe(0o700);
  expect(await readPrivateFinderReference(reference)).toEqual({
    finder_export: exportPath,
  });
  const state = JSON.parse(
    readFileSync(workerStatePath(runsDir, runId), "utf8"),
  );
  const snapshot = await readPrivateSnapshot(state.snapshot_path, 1 << 20);
  expect(JSON.parse(snapshot.toString())).toEqual(goldens.export_one);
});

test("a Finder lease rejects shared directory and file modes", async () => {
  const reference = finderExportReferencePath(
    join(root, "runs"),
    "private-run",
  );
  await ensurePrivateFinderReferenceDir(join(reference, ".."));
  writeFileSync(reference, '{"finder_export":"/x/export.json"}');
  chmodSync(reference, 0o644);
  await expect(readPrivateFinderReference(reference)).rejects.toThrow(
    "not private",
  );
  chmodSync(reference, 0o600);
  chmodSync(join(reference, ".."), 0o755);
  await expect(readPrivateFinderReference(reference)).rejects.toThrow(
    "not private",
  );
});

test("the worker payload neutralizes the Finder path during validation", () => {
  process.env[REQUEST_ENV] = JSON.stringify({
    run_id: "run-1",
    run_name: "demo",
    runs_dir: root,
    spec: { source: "finder", finder_export: "/gone/export.json" },
    finder_export_snapshot: "/x/finder-export.json",
    finder_export_snapshot_sha256: "abc",
    auth_method: null,
    auth_identity: null,
  });
  expect(snapshotCandidateFromRequest()).toBe("/x/finder-export.json");
  const payload = readLaunchPayload();
  expect(payload.spec.source).toBe("finder");
  expect(payload.spec.finderExport).toBe("/gone/export.json");
  expect(process.env[REQUEST_ENV]).toBeUndefined();
  expect(() => readLaunchPayload()).toThrow("Missing Insights launch request");
});

test("stale reconciliation fails a dead worker and releases its Finder files", async () => {
  const runsDir = join(root, "insights-runs");
  await startManifest({
    runId: "worker-killed",
    surface: "insights",
    runName: "demo",
    runsDir,
  });
  const reference = await finderLease(runsDir, "worker-killed");
  const { directory, path } = snapshotFile();
  const statePath = workerStatePath(runsDir, "worker-killed");
  writeState(statePath, {
    pid: DEAD_PID,
    heartbeat_at: Date.now() / 1000 - 120,
    snapshot_path: path,
  });
  expect(await reconcileStaleWorker(runsDir, "worker-killed")).toBe(true);
  const [manifest] = await listManifests(runsDir);
  expect(manifest?.status).toBe("error");
  expect(manifest?.error).toContain("stopped before completing");
  expect(existsSync(reference)).toBe(false);
  expect(existsSync(statePath)).toBe(false);
  expect(existsSync(directory)).toBe(false);
});

test("stale reconciliation leaves a live worker and its Finder files", async () => {
  const runsDir = join(root, "runs");
  await startManifest({
    runId: "paused-worker",
    surface: "insights",
    runName: "demo",
    runsDir,
  });
  const reference = await finderLease(runsDir, "paused-worker");
  const { directory, path } = snapshotFile();
  const statePath = workerStatePath(runsDir, "paused-worker");
  writeState(statePath, {
    pid: process.pid,
    process_identity: workerProcessIdentity(process.pid),
    heartbeat_at: Date.now() / 1000 - 120,
    snapshot_path: path,
  });
  expect(await reconcileStaleWorker(runsDir, "paused-worker")).toBe(false);
  expect((await listManifests(runsDir))[0]?.status).toBe("running");
  expect(existsSync(reference)).toBe(true);
  expect(existsSync(statePath)).toBe(true);
  expect(existsSync(directory)).toBe(true);
});

test("stale reconciliation detects a reused PID", async () => {
  const runsDir = join(root, "runs");
  await startManifest({
    runId: "reused",
    surface: "insights",
    runName: "d",
    runsDir,
  });
  writeState(workerStatePath(runsDir, "reused"), {
    pid: process.pid,
    process_identity: "darwin:not the same process",
    heartbeat_at: Date.now() / 1000 - 120,
  });
  expect(await reconcileStaleWorker(runsDir, "reused")).toBe(true);
});

test("stale reconciliation keeps a live launcher with an unpublished worker PID", async () => {
  const runsDir = join(root, "runs");
  await startManifest({
    runId: "starting",
    surface: "insights",
    runName: "d",
    runsDir,
  });
  writeState(workerStatePath(runsDir, "starting"), {
    pid: null,
    launcher_pid: process.pid,
    launcher_process_identity: workerProcessIdentity(process.pid),
    heartbeat_at: Date.now() / 1000 - 120,
  });
  expect(await reconcileStaleWorker(runsDir, "starting")).toBe(false);
  writeState(workerStatePath(runsDir, "starting"), {
    pid: null,
    launcher_pid: DEAD_PID,
    heartbeat_at: Date.now() / 1000 - 120,
  });
  expect(await reconcileStaleWorker(runsDir, "starting")).toBe(true);
});

test("a fresh heartbeat or a non-private state file is left alone", async () => {
  const runsDir = join(root, "runs");
  await startManifest({
    runId: "fresh",
    surface: "insights",
    runName: "d",
    runsDir,
  });
  const statePath = workerStatePath(runsDir, "fresh");
  writeState(statePath, { pid: DEAD_PID, heartbeat_at: Date.now() / 1000 });
  expect(await reconcileStaleWorker(runsDir, "fresh")).toBe(false);
  writeState(statePath, {
    pid: DEAD_PID,
    heartbeat_at: Date.now() / 1000 - 120,
  });
  chmodSync(statePath, 0o644);
  expect(await reconcileStaleWorker(runsDir, "fresh")).toBe(false);
});

test("process identity reads this process and fails conservatively for a missing one", () => {
  expect(workerProcessIdentity(process.pid)).toMatch(/^(darwin|linux):/);
  expect(workerProcessIdentity(DEAD_PID)).toBeNull();
});

test("snapshot cleanup refuses paths outside its private temporary directory", async () => {
  const { directory, path } = snapshotFile();
  const extra = join(directory, "other.txt");
  writeFileSync(extra, "x");
  await cleanupSnapshot(path);
  expect(existsSync(path)).toBe(true);
  rmSync(extra);
  const foreign = join(root, "elsewhere", "finder-export.json");
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(foreign, "{}");
  await cleanupSnapshot(foreign);
  expect(existsSync(foreign)).toBe(true);
  await cleanupSnapshot(path);
  expect(existsSync(directory)).toBe(false);
});
