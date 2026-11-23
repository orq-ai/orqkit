import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  FINDER_EXPORT_REFERENCE_DIR,
  pruneFinderExports,
  saveFinderExport,
} from "../../../src/lib/dashboard/trace-finder/routes.js";

const SCRATCH = join(process.env.HOME ?? ".", "finder-lease-tests");
let root: string;
let exportDir: string;
let runsDir: string;
const previousDir = process.env.EVALUATORQ_DIR;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  chmodSync(root, 0o700);
  process.env.EVALUATORQ_DIR = root;
  exportDir = join(root, "finder-exports");
  runsDir = join(root, "insights-runs");
  mkdirSync(exportDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.EVALUATORQ_DIR;
  else process.env.EVALUATORQ_DIR = previousDir;
});

function exports(count: number, dated = true): string[] {
  return Array.from({ length: count }, (_, index) => {
    const path = join(exportDir, `trace-finder-${index}.json`);
    writeFileSync(path, "{}");
    if (dated) utimesSync(path, index + 1, index + 1);
    return path;
  });
}

function lease(runId: string, body: string): string {
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  chmodSync(runsDir, 0o700);
  const dir = join(runsDir, FINDER_EXPORT_REFERENCE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const marker = join(dir, `${runId}.json`);
  writeFileSync(marker, body);
  chmodSync(marker, 0o600);
  return marker;
}

function manifest(runId: string, status: string): string {
  const dir = join(runsDir, ".manifests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  writeFileSync(path, JSON.stringify({ run_id: runId, status }));
  return path;
}

test("pruning skips when a lease is malformed", async () => {
  const files = exports(51);
  const marker = lease("malformed-lease", "{invalid JSON");
  await pruneFinderExports(exportDir);
  expect(files.every((path) => existsSync(path))).toBe(true);
  expect(existsSync(marker)).toBe(true);
});

test("pruning recovers after a malformed lease expires", async () => {
  const files = exports(51);
  const marker = lease("malformed-lease", "{invalid JSON");
  utimesSync(marker, 1, 1);
  await pruneFinderExports(exportDir);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(files[0] as string)).toBe(false);
  expect(files.slice(1).every((path) => existsSync(path))).toBe(true);
});

test("pruning skips when the lease directory is not private", async () => {
  const files = exports(51);
  lease("x", "{}");
  chmodSync(join(runsDir, FINDER_EXPORT_REFERENCE_DIR), 0o755);
  await pruneFinderExports(exportDir);
  expect(files.every((path) => existsSync(path))).toBe(true);
});

test("pruning is normal when no lease directory exists", async () => {
  const files = exports(51);
  await pruneFinderExports(exportDir);
  expect(existsSync(files[0] as string)).toBe(false);
  expect(files.slice(1).every((path) => existsSync(path))).toBe(true);
});

test("retention keeps recent exports and saved Insights references", async () => {
  const files = exports(52);
  mkdirSync(runsDir, { mode: 0o700 });
  writeFileSync(
    join(runsDir, "insights_saved.json"),
    JSON.stringify({ population: { finder_export: files[0] } }),
  );
  await pruneFinderExports(exportDir);
  const remaining = new Set(
    readdirSync(exportDir).filter((name) => name.startsWith("trace-finder-")),
  );
  expect(remaining.size).toBe(51);
  expect(remaining.has("trace-finder-0.json")).toBe(true);
  for (const path of files.slice(-50))
    expect(remaining.has(path.split("/").pop() as string)).toBe(true);
});

test("retention keeps recent handoff exports over the limit", async () => {
  exports(51, false);
  await pruneFinderExports(exportDir);
  expect(
    readdirSync(exportDir).filter((name) => name.startsWith("trace-finder-")),
  ).toHaveLength(51);
});

test("retention pins an in-flight Insights source until the run finishes", async () => {
  const files = exports(51);
  manifest("active-run", "running");
  const marker = lease(
    "active-run",
    JSON.stringify({ finder_export: "trace-finder-0.json" }),
  );
  await pruneFinderExports(exportDir);
  expect(existsSync(files[0] as string)).toBe(true);
  expect(existsSync(marker)).toBe(true);
  manifest("active-run", "completed");
  await pruneFinderExports(exportDir);
  expect(existsSync(files[0] as string)).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

test("retention expires an abandoned in-flight reference", async () => {
  const files = exports(51);
  const path = manifest("abandoned-run", "running");
  const marker = lease(
    "abandoned-run",
    JSON.stringify({ finder_export: files[0] }),
  );
  const old = Date.now() / 1000 - 31 * 86_400;
  utimesSync(path, old, old);
  await pruneFinderExports(exportDir);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(files[0] as string)).toBe(false);
});

test("export survives a non-object manifest during retention", async () => {
  mkdirSync(join(runsDir, ".manifests"), { recursive: true });
  writeFileSync(join(runsDir, ".manifests", "malformed-run.json"), "[]");
  const marker = lease(
    "malformed-run",
    JSON.stringify({ finder_export: "trace-finder-old.json" }),
  );
  await saveFinderExport(exportDir, "trace-finder-new.json", '{"a":1}');
  expect(
    JSON.parse(readFileSync(join(exportDir, "trace-finder-new.json"), "utf8")),
  ).toEqual({ a: 1 });
  expect(existsSync(marker)).toBe(true);
});

test("a save waits for a running prune and replaces its target", async () => {
  const files = exports(51);
  const target = files[0] as string;
  const prune = pruneFinderExports(exportDir);
  const save = saveFinderExport(
    exportDir,
    "trace-finder-0.json",
    '{"replacement": true}',
  );
  await Promise.all([prune, save]);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
    replacement: true,
  });
});
