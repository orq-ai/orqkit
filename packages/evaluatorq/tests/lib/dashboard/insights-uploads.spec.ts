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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getFinderExportsDir } from "../../../src/lib/dashboard/insights-launch.js";
import {
  cleanupExpiredUploads,
  cleanupSessionUpload,
  MAX_FINDER_EXPORT_BYTES,
  readUploadedSource,
  receiveUpload,
  recentTraceFiles,
  retainUploadedSource,
  storeUpload,
  UPLOAD_RETENTION_SECONDS,
  UploadTooLargeError,
  uploadsDir,
  validateUpload,
} from "../../../src/lib/dashboard/insights-uploads.js";
import { finishConsumedUpload } from "../../../src/lib/dashboard/insights-worker.js";
import { getInsightsRunsDir } from "../../../src/lib/insights/store.js";
import goldens from "../fixtures/insights-uploads-python-goldens.json" with {
  type: "json",
};

const SCRATCH = join(process.env.HOME ?? ".", "insights-upload-tests");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const meta = (path: string) => `${path}.meta.json`;
let root: string;
const previousDir = process.env.EVALUATORQ_DIR;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  chmodSync(root, 0o700);
  process.env.EVALUATORQ_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.EVALUATORQ_DIR;
  else process.env.EVALUATORQ_DIR = previousDir;
});

test("validate accepts a documents-only snapshot and rejects an empty one", () => {
  expect(validateUpload(bytes(goldens.snapshot_documents))).toBe("snapshot");
  expect(() => validateUpload(bytes(goldens.snapshot_empty))).toThrow(
    "contains no traces",
  );
});

test("validate classifies by content and rejects invalid bodies", () => {
  expect(validateUpload(bytes(goldens.export_one))).toBe("finder");
  expect(validateUpload(bytes(goldens.snapshot_one))).toBe("snapshot");
  for (const body of ["{}", "[1]", "not json", '{"traces": []}'])
    expect(() => validateUpload(Buffer.from(body))).toThrow();
  expect(() => validateUpload(Buffer.from("{}"))).toThrow(
    "neither a Finder export nor a trace snapshot",
  );
});

test("a Finder export over 10 MiB is too large while a snapshot keeps the 100 MB limit", async () => {
  const pad = (value: unknown) => {
    const body = bytes(value);
    return Buffer.concat([
      body,
      Buffer.alloc(MAX_FINDER_EXPORT_BYTES + 1 - body.length, " "),
    ]);
  };
  expect(() => validateUpload(pad(goldens.export_one))).toThrow(
    UploadTooLargeError,
  );
  expect(() => validateUpload(pad(goldens.export_one))).toThrow(
    "10 MiB size limit",
  );
  const snapshot = pad(goldens.snapshot_one);
  const stored = await storeUpload(root, snapshot, "snapshot");
  expect(readFileSync(stored).equals(snapshot)).toBe(true);
});

test("receive rejects a body over 100 MB before validation", async () => {
  const large = new Blob([new Uint8Array(100 * 1024 * 1024 + 1)]);
  await expect(receiveUpload(large)).rejects.toThrow(UploadTooLargeError);
  const [kind] = await receiveUpload(new Blob([bytes(goldens.export_one)]));
  expect(kind).toBe("finder");
});

test("store writes private files and display metadata", async () => {
  const stored = await storeUpload(
    getInsightsRunsDir(),
    bytes(goldens.snapshot_one),
    "snapshot",
    { displayName: "C:\\fakepath\\<session>.json" },
  );
  expect(stored.startsWith(join(root, "insights-runs", ".uploads"))).toBe(true);
  const metadata = JSON.parse(readFileSync(meta(stored), "utf8"));
  expect(metadata.display_name).toBe("<session>.json");
  expect(metadata.trace_count).toBe(1);
  expect(metadata.kind).toBe("snapshot");
  expect(metadata.modified_at).toBeTruthy();
  expect(statSync(stored).mode & 0o777).toBe(0o600);
  expect(statSync(meta(stored)).mode & 0o777).toBe(0o600);
  expect(statSync(uploadsDir(getInsightsRunsDir())).mode & 0o777).toBe(0o700);
});

test("expired uploads and their metadata are removed safely", async () => {
  const runsDir = join(root, "runs");
  const live = await storeUpload(
    runsDir,
    bytes(goldens.snapshot_one),
    "snapshot",
  );
  const stale = await storeUpload(
    runsDir,
    bytes(goldens.snapshot_two),
    "snapshot",
  );
  utimesSync(stale, 100, 100);
  const unrelated = join(uploadsDir(runsDir), "keep-me.txt");
  writeFileSync(unrelated, "keep");
  expect(
    await cleanupExpiredUploads(runsDir, {
      now: 100 + UPLOAD_RETENTION_SECONDS + 1,
    }),
  ).toBe(1);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(meta(stale))).toBe(false);
  expect(existsSync(meta(live))).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
});

test("recent files hide frozen session snapshots", async () => {
  const contents = bytes(goldens.snapshot_documents);
  const frozen = await storeUpload(root, contents, "snapshot", {
    source: "sessions",
  });
  const reusable = await storeUpload(root, contents, "snapshot", {
    displayName: "sessions.json",
  });
  const entries = await recentTraceFiles(root, join(root, "exports"));
  expect(entries.map((entry) => entry.path)).toEqual([reusable]);
  expect(entries[0]?.traceCount).toBe(1);
  expect(existsSync(frozen)).toBe(true);
});

test("recent files list original names, counts and kinds, newest first", async () => {
  const runsDir = getInsightsRunsDir();
  const snapshot = await storeUpload(
    runsDir,
    bytes(goldens.snapshot_two),
    "snapshot",
    {
      displayName: "sessions.json",
    },
  );
  const uploaded = await storeUpload(
    runsDir,
    bytes(goldens.export_one),
    "finder",
    {
      displayName: "upload-export.json",
    },
  );
  const finderDir = getFinderExportsDir();
  mkdirSync(finderDir, { recursive: true });
  const finder = join(finderDir, "finder-export.json");
  writeFileSync(finder, JSON.stringify(goldens.export_three));
  const now = Date.now() / 1000;
  for (const [path, age] of [
    [snapshot, 300],
    [uploaded, 200],
    [finder, 100],
  ] as const) {
    const modified = now - age;
    utimesSync(path, modified, modified);
    if (path !== finder) {
      const data = JSON.parse(readFileSync(meta(path), "utf8"));
      data.modified_at = new Date(modified * 1000).toISOString();
      writeFileSync(meta(path), JSON.stringify(data));
    }
  }
  const entries = await recentTraceFiles(runsDir, finderDir);
  expect(entries.map((entry) => entry.displayName)).toEqual([
    "finder-export.json",
    "upload-export.json",
    "sessions.json",
  ]);
  expect(entries.map((entry) => entry.traceCount)).toEqual([3, 1, 2]);
  expect(entries.map((entry) => entry.kind)).toEqual([
    "finder",
    "finder",
    "snapshot",
  ]);
  expect(entries[0]?.date).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
});

test("recent files prune expired uploads but keep Finder exports", async () => {
  const upload = await storeUpload(
    getInsightsRunsDir(),
    bytes(goldens.snapshot_one),
    "snapshot",
    { displayName: "expired.json" },
  );
  const finderDir = getFinderExportsDir();
  mkdirSync(finderDir, { recursive: true });
  const finder = join(finderDir, "older-finder.json");
  writeFileSync(finder, JSON.stringify(goldens.export_one));
  const old = Date.now() / 1000 - UPLOAD_RETENTION_SECONDS - 1;
  for (const path of [upload, finder]) utimesSync(path, old, old);
  const names = (await recentTraceFiles(getInsightsRunsDir(), finderDir)).map(
    (entry) => entry.displayName,
  );
  expect(names).toEqual(["older-finder.json"]);
  expect(existsSync(upload)).toBe(false);
  expect(existsSync(meta(upload))).toBe(false);
  expect(existsSync(finder)).toBe(true);
});

test("worker retention extends seven days from the run finish", async () => {
  const source = await storeUpload(
    root,
    bytes(goldens.snapshot_one),
    "snapshot",
  );
  const old = Date.now() / 1000 - UPLOAD_RETENTION_SECONDS + 10;
  utimesSync(source, old, old);
  await finishConsumedUpload(root, "snapshot", "", source);
  const finished = statSync(source).mtimeMs / 1000;
  expect(finished).toBeGreaterThan(old);
  const metadata = JSON.parse(readFileSync(meta(source), "utf8"));
  expect(
    Math.abs(Date.parse(metadata.modified_at) / 1000 - finished),
  ).toBeLessThan(1);
  expect(
    await cleanupExpiredUploads(root, {
      now: finished + UPLOAD_RETENTION_SECONDS + 1,
    }),
  ).toBe(1);
});

test("a frozen session copy is removed after its run, a reusable file is kept", async () => {
  const contents = bytes(goldens.snapshot_documents);
  const frozen = await storeUpload(root, contents, "snapshot", {
    source: "sessions",
  });
  const reusable = await storeUpload(root, contents, "snapshot");
  expect(await cleanupSessionUpload(root, frozen)).toBe(true);
  expect(existsSync(frozen)).toBe(false);
  expect(existsSync(meta(frozen))).toBe(false);
  expect(await cleanupSessionUpload(root, reusable)).toBe(false);
  await retainUploadedSource(root, reusable);
  expect(existsSync(reusable)).toBe(true);
});

test("recent files skip symlinks, unsafe metadata and foreign paths", async () => {
  const runsDir = getInsightsRunsDir();
  const contents = bytes(goldens.snapshot_one);
  const source = await storeUpload(runsDir, contents, "snapshot", {
    displayName: "hidden.json",
  });
  const outside = join(root, "outside.json");
  writeFileSync(outside, contents);
  const link = join(uploadsDir(runsDir), `snapshot-${"a".repeat(32)}.json`);
  symlinkSync(outside, link);
  unlinkSync(meta(source));
  symlinkSync(outside, meta(source));
  const finderDir = getFinderExportsDir();
  mkdirSync(finderDir, { recursive: true });
  symlinkSync(outside, join(finderDir, "linked.json"));
  expect(await recentTraceFiles(runsDir, finderDir)).toEqual([]);
  await expect(readUploadedSource(runsDir, link, "snapshot")).rejects.toThrow();
  await expect(
    readUploadedSource(runsDir, outside, "snapshot"),
  ).rejects.toThrow();
});

test("recent files skip a non-private upload", async () => {
  const source = await storeUpload(
    getInsightsRunsDir(),
    bytes(goldens.snapshot_one),
    "snapshot",
    { displayName: "unsafe.json" },
  );
  chmodSync(source, 0o644);
  expect(await recentTraceFiles(getInsightsRunsDir(), join(root, "x"))).toEqual(
    [],
  );
});

test("reading an upload replaced by a symlink fails", async () => {
  const runsDir = getInsightsRunsDir();
  const contents = bytes(goldens.snapshot_one);
  const source = await storeUpload(runsDir, contents, "snapshot");
  const outside = join(root, "outside.json");
  writeFileSync(outside, contents);
  unlinkSync(source);
  symlinkSync(outside, source);
  await expect(readUploadedSource(runsDir, source, "snapshot")).rejects.toThrow(
    "inside private Insights upload storage",
  );
});

test("reading an upload checks its kind and validates it", async () => {
  const runsDir = getInsightsRunsDir();
  const source = await storeUpload(
    runsDir,
    bytes(goldens.export_one),
    "finder",
  );
  expect(
    JSON.parse((await readUploadedSource(runsDir, source, "finder")).toString())
      .matched_trace_ids,
  ).toEqual(["one"]);
  await expect(readUploadedSource(runsDir, source, "snapshot")).rejects.toThrow(
    "wrong file type",
  );
});
