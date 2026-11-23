import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { DEFAULT_ORQ_BASE_URL } from "../common/env-config.js";
import { writePrivateAtomic } from "../common/private-files.js";
import { failIfRunning, startManifest } from "../common/run-manifest.js";
import { getStoreDir } from "../common/run-store-dir.js";
import { ManifestStatus, RunManifestSchema } from "../contracts.js";
import {
  type DimensionName,
  InsightsPopulation,
  LabelSpec,
} from "../insights/models.js";
import { CODING_LABELS, LABEL_PRESETS } from "../insights/presets.js";
import { stagePlan } from "../insights/progress.js";
import { getInsightsRunsDir } from "../insights/store.js";
import { signalModel } from "../signals/models.js";
import { RunExport } from "../trace-finder/export.js";
import { FacetSelection, Snapshot } from "../trace-finder/models.js";
import {
  DEFAULT_TRACE_INPUT_CHARS,
  MAX_TRACE_INPUT_CHARS,
  MIN_TRACE_INPUT_CHARS,
} from "../trace-finder/settings.js";
import {
  isUploadedSource,
  MAX_FINDER_EXPORT_BYTES,
  MAX_INSIGHTS_UPLOAD_BYTES,
  readUploadedSource,
  uploadSizeError,
} from "./insights-uploads.js";

export type Source = "recent" | "query" | "finder" | "snapshot";
/** A source the run form offers: a launch Source, or `sessions`, which the form freezes into a `snapshot`. */
export type FormSource = Source | "sessions";

export interface SourceInfo {
  tab: "orq" | "file" | "sessions";
  mode: string;
  label: string;
}

export const SOURCES: Readonly<Record<FormSource, SourceInfo>> = Object.freeze({
  recent: { tab: "orq", mode: "filter", label: "Orq traces" },
  query: { tab: "orq", mode: "query", label: "Orq traces matching a question" },
  finder: { tab: "file", mode: "export", label: "Trace file (Finder export)" },
  snapshot: { tab: "file", mode: "snapshot", label: "Trace file" },
  sessions: { tab: "sessions", mode: "snapshot", label: "Local sessions" },
});
/** A sessions run launches as a snapshot run, so a stored `snapshot` mode reads back as the `snapshot` source. */
export const SOURCE_BY_MODE: Readonly<Record<string, Source>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(SOURCES) as [FormSource, SourceInfo][])
      .filter(([source]) => source !== "sessions")
      .map(([source, info]) => [info.mode, source as Source]),
  ),
);

const CODING_PRESETS: ReadonlyMap<string, LabelSpec> = new Map(
  CODING_LABELS.slice(1).map((spec) => [spec.name, spec]),
);
export const REQUEST_ENV = "EVALUATORQ_INSIGHTS_LAUNCH_REQUEST";
export const MANIFEST_ENV = "EVALUATORQ_INSIGHTS_MANIFEST";
export const SNAPSHOT_ENV = "EVALUATORQ_INSIGHTS_FINDER_SNAPSHOT";
export const FINDER_EXPORT_REFERENCE_DIR = ".finder-export-leases";
export const INSIGHTS_WORKER_STATE_DIR = ".insights-workers";
export const INSIGHTS_WORKER_STALE_SECONDS = 90;
export const INSIGHTS_WORKER_HEARTBEAT_SECONDS = 10;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_TRACE_LIMIT = 200;
export const SNAPSHOT_DIR_PREFIX = "evaluatorq-finder-snapshot-";
export const SNAPSHOT_FILE_NAME = "finder-export.json";

const RUN_ID = /^[A-Za-z0-9_-]+$/;
const uid = () => process.getuid?.() ?? null;
const windows = process.platform === "win32";
const owned = (info: { uid: number }) => uid() === null || info.uid === uid();
const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
const warn = (message: string) => console.warn(message);
const nowSeconds = () => Date.now() / 1000;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function workerStatePath(runsDir: string, runId: string): string {
  if (!RUN_ID.test(runId))
    throw new Error("Invalid Insights run ID for worker state");
  return join(runsDir, INSIGHTS_WORKER_STATE_DIR, `${runId}.json`);
}

type WorkerState = Record<string, unknown>;

async function writeWorkerState(path: string, state: WorkerState) {
  await writePrivateAtomic(path, JSON.stringify(state));
}

async function readJsonObject(path: string): Promise<WorkerState | null> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as WorkerState)
      : null;
  } catch {
    return null;
  }
}

/** Refresh the detached worker lease independently of its async workload. Returns a stop function. */
export async function startWorkerHeartbeat(
  manifestPath: string,
): Promise<() => Promise<void>> {
  const runId = basename(manifestPath, ".json");
  const path = workerStatePath(dirname(dirname(manifestPath)), runId);
  const state: WorkerState = (await readJsonObject(path)) ?? {};
  Object.assign(state, {
    pid: process.pid,
    process_identity: workerProcessIdentity(process.pid),
    heartbeat_at: nowSeconds(),
  });
  await writeWorkerState(path, state);
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    state.heartbeat_at = nowSeconds();
    pending = writeWorkerState(path, state).catch((error) =>
      warn(
        `Could not refresh Insights worker heartbeat ${path}: ${errorText(error)}`,
      ),
    );
  }, INSIGHTS_WORKER_HEARTBEAT_SECONDS * 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

async function readManifestStatus(path: string): Promise<string | null> {
  try {
    return RunManifestSchema.parse(JSON.parse(await readFile(path, "utf8")))
      .status;
  } catch {
    return null;
  }
}

const isPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Fail a dashboard worker whose startup or heartbeat lease expired. */
export async function reconcileStaleWorker(
  runsDir: string,
  runId: string,
): Promise<boolean> {
  const statePath = workerStatePath(runsDir, runId);
  const manifestPath = join(runsDir, ".manifests", `${runId}.json`);
  let state: WorkerState | null;
  let status: string | null;
  try {
    const directoryInfo = await lstat(dirname(statePath));
    const stateInfo = await lstat(statePath);
    if (
      directoryInfo.isSymbolicLink() ||
      !directoryInfo.isDirectory() ||
      (!windows && (directoryInfo.mode & 0o777) !== 0o700) ||
      !owned(directoryInfo) ||
      !stateInfo.isFile() ||
      (!windows && (stateInfo.mode & 0o777) !== 0o600) ||
      !owned(stateInfo)
    )
      return false;
    status = await readManifestStatus(manifestPath);
    state = await readJsonObject(statePath);
  } catch {
    return false;
  }
  if (status === null || state === null) return false;
  const heartbeatAt = state.heartbeat_at;
  const stale =
    isNumber(heartbeatAt) &&
    nowSeconds() - heartbeatAt > INSIGHTS_WORKER_STALE_SECONDS;
  const workerPid = state.pid;
  const workerIdentity = state.process_identity;
  const launcherPid = state.launcher_pid;
  const launcherIdentity = state.launcher_process_identity;
  // Until the worker PID is published, only the launcher can prove startup is still in progress.
  const checkingLauncher = workerPid === null || workerPid === undefined;
  const pid = checkingLauncher ? launcherPid : workerPid;
  const identity = checkingLauncher ? launcherIdentity : workerIdentity;
  if (status !== ManifestStatus.RUNNING || !stale) return false;
  // A live PID is stronger evidence than an old heartbeat: a paused worker keeps its run.
  if (!isPid(pid) || workerProcessIsAlive(pid, identity)) return false;
  // Re-read the lease right before failing; the worker may have resumed.
  const latest = await readJsonObject(statePath);
  const latestStatus = await readManifestStatus(manifestPath);
  if (
    latestStatus !== ManifestStatus.RUNNING ||
    latest === null ||
    latest.pid !== workerPid ||
    latest.process_identity !== workerIdentity ||
    latest.launcher_pid !== launcherPid ||
    latest.launcher_process_identity !== launcherIdentity ||
    !isNumber(latest.heartbeat_at) ||
    nowSeconds() - latest.heartbeat_at <= INSIGHTS_WORKER_STALE_SECONDS ||
    workerProcessIsAlive(pid, identity)
  )
    return false;
  await failIfRunning(
    manifestPath,
    "Insights worker stopped before completing the run; start a new run to retry.",
    "worker",
  );
  const persisted = await readManifestStatus(manifestPath);
  if (persisted === null || persisted === ManifestStatus.RUNNING) return false;
  if (typeof latest.snapshot_path === "string")
    await cleanupSnapshot(latest.snapshot_path);
  try {
    const reference = finderExportReferencePath(runsDir, runId);
    if (existsSync(reference)) {
      if ((await lstat(dirname(reference))).isSymbolicLink())
        warn(
          `Leaving untrusted Finder export reference directory in place: ${dirname(reference)}`,
        );
      else {
        await validatePrivateFinderReference(reference);
        await unlinkMissingOk(reference);
      }
    }
  } catch (error) {
    warn(
      `Could not release Finder export reference for stale run ${runId}: ${errorText(error)}`,
    );
  }
  try {
    await unlinkMissingOk(statePath);
  } catch (error) {
    warn(
      `Could not remove stale Insights worker state ${statePath}: ${errorText(error)}`,
    );
  }
  return true;
}

async function unlinkMissingOk(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Whether the recorded worker still exists with its original identity. */
export function workerProcessIsAlive(
  pid: unknown,
  expectedIdentity: unknown = null,
): boolean {
  if (!isPid(pid)) return true;
  if (windows) {
    warn(
      `Could not safely verify Insights worker PID ${pid} on Windows; leaving its run active`,
    );
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
  if (typeof expectedIdentity === "string") {
    const observed = readWorkerProcessIdentity(pid);
    if (observed === null) {
      warn(
        `Could not verify Insights worker process identity for PID ${pid}; leaving its run active`,
      );
      return true;
    }
    const [identity, zombie] = observed;
    return identity === expectedIdentity && !zombie;
  }
  warn(
    `Insights worker PID ${pid} has no recorded process identity; leaving its run active`,
  );
  return true;
}

/** Read a process start marker and zombie flag where the OS exposes them. */
export function readWorkerProcessIdentity(
  pid: number,
): [string, boolean] | null {
  if (process.platform === "linux") {
    let contents: string;
    try {
      contents = readFileSync(`/proc/${pid}/stat`, "ascii");
    } catch {
      return null;
    }
    const closing = contents.lastIndexOf(")");
    if (closing < 0) return null;
    const fields = contents
      .slice(closing + 1)
      .trim()
      .split(/\s+/);
    if (fields.length <= 19) return null;
    const startTicks = Number(fields[19]);
    if (!Number.isInteger(startTicks)) return null;
    return [`linux:${startTicks}`, fields[0] === "Z"];
  }
  if (process.platform === "darwin") {
    let stdout: string;
    try {
      stdout = execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-o", "stat=", "-p", String(pid)],
        {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      return null;
    }
    const fields = stdout.trim().split(/\s+/);
    if (fields.length < 6) return null;
    return [
      `darwin:${fields.slice(0, 5).join(" ")}`,
      (fields[5] as string).startsWith("Z"),
    ];
  }
  return null;
}

/** Capture the worker's start marker, if this OS exposes one. */
export function workerProcessIdentity(pid: number): string | null {
  if (!isPid(pid)) return null;
  return readWorkerProcessIdentity(pid)?.[0] ?? null;
}

/** The only directory from which dashboard runs may read Finder exports. */
export function getFinderExportsDir(): string {
  return getStoreDir("finder-exports");
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  limit: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      null,
    );
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

/** Read a bounded export from the approved directory without following symlinks. */
export async function readApprovedFinderExport(
  root: string,
  path: string,
): Promise<Buffer> {
  if (windows)
    throw new Error(
      "Safe Finder export file opening is unavailable on Windows.",
    );
  const directory = await lstat(root);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    !owned(directory) ||
    directory.mode & 0o022
  )
    throw new Error(
      "Finder export directory has unsafe ownership or permissions.",
    );
  if (resolve(dirname(path)) !== resolve(root))
    throw new Error(
      "Finder export must be a safe regular file in the approved directory.",
    );
  // O_NONBLOCK keeps a FIFO named *.json from blocking; the isFile check rejects it.
  const handle = await open(
    join(root, basename(path)),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    const current = await lstat(join(root, basename(path)));
    const reopened = await lstat(root);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      reopened.ino !== directory.ino ||
      reopened.dev !== directory.dev ||
      !owned(opened) ||
      opened.mode & 0o022
    )
      throw new Error(
        "Finder export must be a safe regular file in the approved directory.",
      );
    const contents = await readBounded(handle, MAX_FINDER_EXPORT_BYTES);
    if (contents.length > MAX_FINDER_EXPORT_BYTES)
      throw new Error("Finder export exceeds the 10 MiB size limit.");
    return contents;
  } finally {
    await handle.close();
  }
}

/** The private lease path for a running Finder-sourced Insights run. */
export function finderExportReferencePath(
  runsDir: string,
  runId: string,
): string {
  if (!RUN_ID.test(runId))
    throw new Error("Invalid Insights run ID for Finder export reference");
  return join(runsDir, FINDER_EXPORT_REFERENCE_DIR, `${runId}.json`);
}

/** Create or validate the private Finder lease directory. */
export async function ensurePrivateFinderReferenceDir(
  path: string,
): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  await validatePrivateFinderReferenceDir(path);
}

/** Check an existing Finder lease directory without creating it. */
export async function validatePrivateFinderReferenceDir(
  path: string,
): Promise<void> {
  const parent = await lstat(dirname(path));
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    !owned(parent) ||
    (!windows && parent.mode & 0o022)
  )
    throw new Error(
      `Finder export lease parent is not private from other users: ${dirname(path)}`,
    );
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (!windows && (info.mode & 0o777) !== 0o700) ||
    !owned(info)
  )
    throw new Error(`Finder export lease directory is not private: ${path}`);
}

const privateFile = (info: { mode: number; uid: number; isFile(): boolean }) =>
  info.isFile() && (windows || (info.mode & 0o777) === 0o600) && owned(info);

/** Reject a Finder lease unless its directory and file are private and owned here. */
export async function validatePrivateFinderReference(
  path: string,
): Promise<void> {
  await validatePrivateFinderReferenceDir(dirname(path));
  if (!privateFile(await lstat(path)))
    throw new Error(`Finder export lease file is not private: ${path}`);
}

/** Read a lease only after checking owner, mode, and regular-file type. */
export async function readPrivateFinderReference(
  path: string,
): Promise<Record<string, unknown>> {
  await validatePrivateFinderReference(path);
  if (windows)
    throw new Error(
      "Safe Finder export lease opening is unavailable on Windows.",
    );
  const before = await lstat(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await lstat(dirname(path));
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw new Error(
        `Finder export lease directory changed while opening: ${dirname(path)}`,
      );
    if (!privateFile(await handle.stat()))
      throw new Error(
        `Finder export lease file changed while opening: ${path}`,
      );
    const data: unknown = JSON.parse(await handle.readFile("utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw new TypeError(`Finder export lease is not an object: ${path}`);
    return data as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

/** The private temporary directory that holds validated Finder snapshots. */
export const snapshotRoot = () => tmpdir();

/** Read a private bounded snapshot, rejecting paths outside its private temporary directory. */
export async function readPrivateSnapshot(
  path: string,
  limit: number,
): Promise<Buffer> {
  const expectedRoot = await realpath(snapshotRoot());
  const directory = dirname(path);
  let parent: string;
  try {
    parent = await realpath(dirname(directory));
  } catch {
    parent = "";
  }
  if (
    basename(path) !== SNAPSHOT_FILE_NAME ||
    !basename(directory).startsWith(SNAPSHOT_DIR_PREFIX) ||
    parent !== expectedRoot
  )
    throw new Error(
      "Finder export snapshot is outside its private temporary directory",
    );
  if (windows)
    throw new Error("Safe Finder snapshot opening is unavailable on Windows.");
  const target = join(expectedRoot, basename(directory));
  const directoryInfo = await lstat(target);
  if (
    directoryInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() ||
    !owned(directoryInfo) ||
    (directoryInfo.mode & 0o777) !== 0o700
  )
    throw new Error(
      "Finder export snapshot directory has unsafe ownership or permissions",
    );
  const handle = await open(
    join(target, SNAPSHOT_FILE_NAME),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const reopened = await lstat(target);
    if (
      !opened.isFile() ||
      !owned(opened) ||
      (opened.mode & 0o777) !== 0o600 ||
      reopened.ino !== directoryInfo.ino
    )
      throw new Error("Finder export snapshot must be a private regular file");
    const contents = await readBounded(handle, limit);
    if (contents.length > limit)
      throw new Error("Missing or oversized validated Finder export snapshot");
    return contents;
  } finally {
    await handle.close();
  }
}

/** Remove only the snapshot file from its private directory, then the empty directory. */
export async function cleanupSnapshot(path: string): Promise<void> {
  const { readdir, rmdir } = await import("node:fs/promises");
  const directory = dirname(path);
  try {
    const expectedRoot = await realpath(snapshotRoot());
    let parent = "";
    try {
      parent = await realpath(dirname(directory));
    } catch {}
    if (
      basename(path) !== SNAPSHOT_FILE_NAME ||
      !basename(directory).startsWith(SNAPSHOT_DIR_PREFIX) ||
      parent !== expectedRoot ||
      windows
    ) {
      warn(`Leaving untrusted Finder snapshot path in place: ${path}`);
      return;
    }
    const target = join(expectedRoot, basename(directory));
    const info = await lstat(target);
    const entries = await readdir(target);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !owned(info) ||
      (info.mode & 0o777) !== 0o700 ||
      entries.length !== 1 ||
      entries[0] !== SNAPSHOT_FILE_NAME
    ) {
      warn(`Leaving untrusted Finder snapshot path in place: ${path}`);
      return;
    }
    const file = join(target, SNAPSHOT_FILE_NAME);
    const snapshotInfo = await lstat(file);
    if (
      !snapshotInfo.isFile() ||
      !owned(snapshotInfo) ||
      (snapshotInfo.mode & 0o777) !== 0o600
    ) {
      warn(`Leaving untrusted Finder snapshot path in place: ${path}`);
      return;
    }
    await unlink(file);
    if ((await readdir(target)).length) {
      warn(
        `Leaving non-empty Finder snapshot directory in place: ${directory}`,
      );
      return;
    }
    const current = await lstat(target);
    if (
      !current.isDirectory() ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    ) {
      warn(`Leaving changed Finder snapshot directory in place: ${directory}`);
      return;
    }
    await rmdir(target);
  } catch (error) {
    warn(
      `Could not remove Finder snapshot directory ${directory}: ${errorText(error)}`,
    );
  }
}

const expandUser = (value: string) =>
  value === "~" || value.startsWith("~/")
    ? join(homedir(), value.slice(1))
    : value;

const presetNames = Object.keys(LABEL_PRESETS);
const DIMENSIONS = ["intent", "failure", "sentiment"] as const;

export const InsightsLaunchSpecSchema = signalModel({
  name: z.string().max(80).default(""),
  source: z.enum(["recent", "query", "finder", "snapshot"]).default("recent"),
  query: z.string().max(500).default(""),
  finderExport: z.string().max(4096).default(""),
  snapshotPath: z.string().max(4096).default(""),
  sourceName: z.string().max(255).default(""),
  windowDays: z.number().int().min(1).max(90).default(DEFAULT_WINDOW_DAYS),
  limit: z.number().int().min(1).max(5000).default(DEFAULT_TRACE_LIMIT),
  facets: z
    .unknown()
    .transform((value) =>
      value instanceof FacetSelection ? value : new FacetSelection(value ?? {}),
    )
    .default(() => new FacetSelection()),
  parallelism: z.number().int().min(1).max(200).default(20),
  traceInputChars: z
    .number()
    .int()
    .min(MIN_TRACE_INPUT_CHARS)
    .max(MAX_TRACE_INPUT_CHARS)
    .default(DEFAULT_TRACE_INPUT_CHARS),
  labels: z
    .array(z.string())
    .max(presetNames.length)
    .default(() => []),
  customLabels: z
    .array(
      z
        .unknown()
        .transform((value) =>
          value instanceof LabelSpec ? value : new LabelSpec(value),
        ),
    )
    .max(10)
    .default(() => []),
  codingLabels: z
    .array(z.string())
    .max(CODING_PRESETS.size)
    .default(() => []),
  dimensions: z.array(z.enum(DIMENSIONS)).default(() => ["intent" as const]),
  summaryModel: z.string().max(200).trim().default(""),
  classifierModel: z.string().max(200).trim().default(""),
  embeddingModel: z.string().max(200).trim().default(""),
  compilerModel: z.string().max(200).trim().default(""),
});
export type InsightsLaunchSpecFields = z.infer<typeof InsightsLaunchSpecSchema>;

/** Small, allow-listed subset of the Insights CLI for the dashboard wizard. */
export class InsightsLaunchSpec {
  declare readonly name: string;
  declare readonly source: Source;
  declare readonly query: string;
  declare readonly finderExport: string;
  declare readonly snapshotPath: string;
  declare readonly sourceName: string;
  declare readonly windowDays: number;
  declare readonly limit: number;
  declare readonly facets: FacetSelection;
  declare readonly parallelism: number;
  declare readonly traceInputChars: number;
  declare readonly labels: readonly string[];
  declare readonly customLabels: readonly LabelSpec[];
  declare readonly codingLabels: readonly string[];
  declare readonly dimensions: readonly DimensionName[];
  declare readonly summaryModel: string;
  declare readonly classifierModel: string;
  declare readonly embeddingModel: string;
  declare readonly compilerModel: string;
  #finderExportSnapshot: string | null = null;

  private constructor(fields: InsightsLaunchSpecFields) {
    Object.assign(this, fields);
  }

  /** Parse and validate without touching the source files (for payloads already validated at launch). */
  static parseUnchecked(value: unknown): InsightsLaunchSpec {
    const spec = new InsightsLaunchSpec(InsightsLaunchSpecSchema.parse(value));
    spec.validateSelections();
    return spec;
  }

  /** Parse, read and validate the selected source, then the label and dimension choices. */
  static async create(value: unknown): Promise<InsightsLaunchSpec> {
    const spec = new InsightsLaunchSpec(InsightsLaunchSpecSchema.parse(value));
    await spec.validateSource();
    spec.validateSelections();
    return spec;
  }

  /** A copy with fields replaced and no further validation. */
  withFields(update: Partial<InsightsLaunchSpecFields>): InsightsLaunchSpec {
    const copy = new InsightsLaunchSpec({ ...this.toFields(), ...update });
    copy.#finderExportSnapshot = this.#finderExportSnapshot;
    return copy;
  }

  /** The bounded Finder JSON captured during source validation. */
  validatedFinderExportSnapshot(): string | null {
    return this.#finderExportSnapshot;
  }

  private async validateSnapshotSource(): Promise<void> {
    if (this.source !== "snapshot") return;
    if (!isDeepStrictEqual(this.facets, new FacetSelection()))
      throw new Error(
        "A local trace file already fixes the trace population; remove the facet filters.",
      );
    if (!this.snapshotPath.trim())
      throw new Error("Browse to choose a trace file first.");
    const path = expandUser(this.snapshotPath);
    let snapshot: Snapshot;
    try {
      const runsDir = getInsightsRunsDir();
      let raw: string;
      if (await isUploadedSource(runsDir, path)) {
        raw = (await readUploadedSource(runsDir, path, "snapshot")).toString(
          "utf8",
        );
      } else {
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          const info = await file.stat();
          if (!info.isFile())
            throw new Error("Snapshot must be a regular file");
          if (info.size > MAX_INSIGHTS_UPLOAD_BYTES)
            throw new Error("Snapshot exceeds the 100 MB size limit");
          const contents = await readBounded(file, info.size);
          if (contents.length > info.size)
            throw new Error("Snapshot changed size while reading");
          raw = contents.toString("utf8");
        } finally {
          await file.close();
        }
      }
      snapshot = new Snapshot(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Could not read a valid local trace snapshot: ${errorText(error)}`,
      );
    }
    if (snapshot.isEmpty)
      throw new Error("The local trace snapshot contains no traces.");
  }

  private async validateSource(): Promise<void> {
    if (this.source === "query" && !this.query.trim())
      throw new Error("Enter a question to find matching traces.");
    if (this.source === "finder") {
      if (!isDeepStrictEqual(this.facets, new FacetSelection()))
        throw new Error(
          "A Finder export already fixes the trace population; remove the facet filters.",
        );
      if (!this.finderExport.trim())
        throw new Error("Enter the path to a Finder JSON export.");
      let root: string;
      let path: string;
      try {
        root = await realpath(getFinderExportsDir()).catch(() =>
          resolve(getFinderExportsDir()),
        );
        const requested = expandUser(this.finderExport);
        const joined = isAbsolute(requested)
          ? requested
          : join(root, requested);
        path = await realpath(joined).catch(() => resolve(joined));
      } catch (error) {
        throw new Error(
          `Could not resolve Finder export path: ${errorText(error)}`,
        );
      }
      const runsDir = getInsightsRunsDir();
      const uploaded = await isUploadedSource(runsDir, path);
      if (dirname(path) !== root && !uploaded)
        throw new Error(
          `Finder exports must be in ${root} or use a validated Insights upload.`,
        );
      try {
        const raw = uploaded
          ? await readUploadedSource(runsDir, path, "finder")
          : await readApprovedFinderExport(root, path);
        const tooLarge = uploadSizeError("finder", raw.length);
        if (tooLarge) throw new Error(tooLarge);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        new RunExport(JSON.parse(text));
        this.#finderExportSnapshot = text;
      } catch (error) {
        throw new Error(
          `Could not read a valid Finder export: ${errorText(error)}`,
        );
      }
      (this as { finderExport: string }).finderExport = path;
    }
    await this.validateSnapshotSource();
  }

  private validateSelections(): void {
    if (this.labels.some((name) => !presetNames.includes(name)))
      throw new Error("Select only available Insights label presets.");
    if (this.codingLabels.some((name) => !CODING_PRESETS.has(name)))
      throw new Error("Select only available coding labels.");
    if (
      new Set(this.labels).size !== this.labels.length ||
      new Set(this.dimensions).size !== this.dimensions.length
    )
      throw new Error("Select each label and dimension once.");
    if (new Set(this.codingLabels).size !== this.codingLabels.length)
      throw new Error("Select each coding label once.");
    const customNames = this.customLabels.map((spec) => spec.name);
    for (const spec of this.customLabels) {
      if (spec.instructions.length < 1 || spec.instructions.length > 2000)
        throw new Error(
          "Custom label instructions must contain between 1 and 2000 characters.",
        );
      spec.toQuestion("");
    }
    if (new Set(customNames).size !== customNames.length)
      throw new Error("Custom label names must be unique.");
    const allNames = [...this.labels, ...customNames];
    if (new Set(allNames).size !== allNames.length)
      throw new Error("Preset and custom label names must be unique.");
    const reserved = new Set(CODING_LABELS.map((spec) => spec.name));
    if (allNames.some((name) => reserved.has(name)))
      throw new Error(
        "Custom labels cannot use names reserved for coding analysis.",
      );
    if (
      !this.labels.length &&
      !this.customLabels.length &&
      !this.dimensions.length &&
      !this.codingLabels.length
    )
      throw new Error("Select at least one label or dimension.");
  }

  population(): InsightsPopulation {
    if (this.source === "finder")
      return InsightsPopulation.fromFinderExport(expandUser(this.finderExport));
    if (this.source === "snapshot")
      return InsightsPopulation.fromSnapshot(expandUser(this.snapshotPath));
    return new InsightsPopulation({
      query: this.source === "query" ? this.query.trim() : null,
      facets: this.facets,
      windowDays: this.windowDays,
      limit: this.limit,
    });
  }

  /** The chosen models as `insights()` options; a blank field keeps that function's own default. */
  modelOverrides(): Record<string, string> {
    const chosen = {
      summaryModel: this.summaryModel,
      classifierModel: this.classifierModel,
      embeddingModel: this.embeddingModel,
      compilerModel: this.compilerModel,
    };
    return Object.fromEntries(
      Object.entries(chosen).filter(([, model]) => model),
    );
  }

  labelSpecs(): LabelSpec[] {
    return [
      ...this.labels.map((name) => LABEL_PRESETS[name] as LabelSpec),
      ...this.customLabels,
    ];
  }

  get codingEnabled(): boolean {
    return this.codingLabels.length > 0;
  }

  codingLabelSpecs(): LabelSpec[] {
    return this.codingLabels.map(
      (name) => CODING_PRESETS.get(name) as LabelSpec,
    );
  }

  dimensionNames(): DimensionName[] {
    return [...this.dimensions];
  }

  /** The (stage name, title) plan a run with this spec reports, as `launchInsights` records it. */
  stages(population: InsightsPopulation | null = null): [string, string][] {
    const resolved = population ?? populationForLaunchPlan(this)[0];
    return stagePlan(
      resolved,
      [
        ...this.labelSpecs(),
        ...(this.codingEnabled ? CODING_LABELS.slice(0, 1) : []),
        ...this.codingLabelSpecs(),
      ],
      this.dimensionNames(),
    ) as [string, string][];
  }

  toFields(): InsightsLaunchSpecFields {
    const { ...fields } = this as unknown as InsightsLaunchSpecFields;
    return fields;
  }

  /** The JSON shape the Python worker request used (snake_case keys). */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      source: this.source,
      query: this.query,
      finder_export: this.finderExport,
      snapshot_path: this.snapshotPath,
      source_name: this.sourceName,
      window_days: this.windowDays,
      limit: this.limit,
      facets: this.facets,
      parallelism: this.parallelism,
      trace_input_chars: this.traceInputChars,
      labels: [...this.labels],
      custom_labels: this.customLabels,
      coding_labels: [...this.codingLabels],
      dimensions: [...this.dimensions],
      summary_model: this.summaryModel,
      classifier_model: this.classifierModel,
      embedding_model: this.embeddingModel,
      compiler_model: this.compilerModel,
    };
  }
}

export interface InsightsLaunchPayload {
  runId: string;
  runName: string;
  runsDir: string;
  spec: InsightsLaunchSpec;
  finderExportSnapshot: string | null;
  finderExportSnapshotSha256: string | null;
  authMethod: string | null;
  authIdentity: string | null;
}

/** Plan against the validated Finder bytes, even if their source path changes. */
function populationForLaunchPlan(
  spec: InsightsLaunchSpec,
): [InsightsPopulation, string | null] {
  const finderSnapshot = spec.validatedFinderExportSnapshot();
  if (finderSnapshot === null) return [spec.population(), null];
  return [
    InsightsPopulation.fromFinderExport(spec.finderExport, {
      export: new RunExport(JSON.parse(finderSnapshot)),
    }),
    finderSnapshot,
  ];
}

/** The worker entry: compiled `.js` next to this module, or the `.ts` source under Bun. */
export function workerEntry(): string {
  for (const extension of [".js", ".ts"]) {
    const path = fileURLToPath(
      new URL(`./insights-worker${extension}`, import.meta.url),
    );
    if (existsSync(path)) return path;
  }
  throw new Error("Insights worker entry is missing from this install.");
}

function localRunName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `Insights ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Create a visible manifest, then spawn a worker that survives dashboard reloads. */
export async function launchInsights(
  spec: InsightsLaunchSpec,
  runsDir: string,
  options: {
    profile?: { apiKey: string; server?: string | null } | null;
    authMethod?: string | null;
    authIdentity?: string | null;
    entry?: string;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const runName = spec.name.trim() || localRunName();
  const [population, finderSnapshot] = populationForLaunchPlan(spec);
  const plan = spec.stages(population);
  const writer = await startManifest({
    runId,
    surface: "insights",
    runName,
    runsDir,
    plannedStages: plan.map(([name]) => name),
    stageLabels: Object.fromEntries(plan),
    parallelism: spec.parallelism,
  });
  let snapshotPath: string | null = null;
  let referencePath: string | null = null;
  const statePath = workerStatePath(runsDir, runId);
  try {
    if (finderSnapshot !== null) {
      referencePath = finderExportReferencePath(runsDir, runId);
      await ensurePrivateFinderReferenceDir(dirname(referencePath));
      await writePrivateAtomic(
        referencePath,
        JSON.stringify({ finder_export: spec.finderExport }),
      );
      await validatePrivateFinderReference(referencePath);
      const directory = await mkdtemp(
        join(snapshotRoot(), SNAPSHOT_DIR_PREFIX),
      );
      snapshotPath = join(directory, SNAPSHOT_FILE_NAME);
      await writePrivateAtomic(snapshotPath, finderSnapshot);
    }
    const workerRequest = JSON.stringify({
      run_id: runId,
      run_name: runName,
      runs_dir: runsDir,
      spec: spec.toJSON(),
      auth_method: options.authMethod ?? null,
      auth_identity: options.authIdentity ?? null,
      finder_export_snapshot: snapshotPath,
      finder_export_snapshot_sha256:
        finderSnapshot !== null
          ? createHash("sha256").update(finderSnapshot, "utf8").digest("hex")
          : null,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [REQUEST_ENV]: workerRequest,
      [MANIFEST_ENV]: writer.path,
    };
    if (snapshotPath !== null) env[SNAPSHOT_ENV] = snapshotPath;
    else delete env[SNAPSHOT_ENV];
    await writeWorkerState(statePath, {
      pid: null,
      launcher_pid: process.pid,
      launcher_process_identity: workerProcessIdentity(process.pid),
      heartbeat_at: nowSeconds(),
      snapshot_path: snapshotPath,
    });
    if (options.profile) {
      env.ORQ_API_KEY = options.profile.apiKey;
      env.ORQ_BASE_URL = options.profile.server || DEFAULT_ORQ_BASE_URL;
    }
    const logDir = join(runsDir, ".logs");
    await mkdir(logDir, { recursive: true });
    const log = openSync(join(logDir, `${runId}.log`), "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [options.entry ?? workerEntry()], {
        stdio: ["pipe", log, log],
        env,
        detached: true,
      });
    } finally {
      closeSync(log);
    }
    const spawned = new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    try {
      await spawned;
      const state = (await readJsonObject(statePath)) ?? {};
      state.pid = child.pid ?? null;
      state.process_identity =
        child.pid !== undefined ? workerProcessIdentity(child.pid) : null;
      await writeWorkerState(statePath, state);
      if (!child.stdin)
        throw new Error("Insights worker handshake is unavailable.");
      child.stdin.write("1");
    } catch (error) {
      warn(
        `Could not record or release Insights worker process ${runId}: ${errorText(error)}`,
      );
      throw error;
    } finally {
      // Closing without a release byte stops the child when PID persistence failed.
      child.stdin?.end();
      child.unref();
    }
  } catch (error) {
    try {
      await writer.fail(
        `Could not start Insights worker: ${errorText(error)}`,
        "start",
      );
    } finally {
      if (referencePath !== null)
        await unlinkMissingOk(referencePath).catch((cleanupError) =>
          warn(
            `Could not remove Finder export reference ${referencePath}: ${errorText(cleanupError)}`,
          ),
        );
      await unlinkMissingOk(statePath).catch((cleanupError) =>
        warn(
          `Could not remove Insights worker state ${statePath}: ${errorText(cleanupError)}`,
        ),
      );
      if (snapshotPath !== null) await cleanupSnapshot(snapshotPath);
    }
  }
  return runId;
}

/** Read the worker request from the environment, neutralizing the original Finder path during validation. */
export function readLaunchPayload(): InsightsLaunchPayload {
  const raw = process.env[REQUEST_ENV];
  delete process.env[REQUEST_ENV];
  if (raw === undefined) throw new Error("Missing Insights launch request");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const specData = { ...(data.spec as Record<string, unknown>) };
  const finderSource = specData.source === "finder";
  const finderPath = String(specData.finder_export ?? "");
  if (finderSource) {
    specData.source = "recent";
    specData.finder_export = "";
  }
  let spec = InsightsLaunchSpec.parseUnchecked(specData);
  if (finderSource)
    spec = spec.withFields({ source: "finder", finderExport: finderPath });
  const text = (key: string) =>
    typeof data[key] === "string" ? (data[key] as string) : null;
  const runId = text("run_id"),
    runName = text("run_name"),
    runsDir = text("runs_dir");
  if (runId === null || runName === null || runsDir === null)
    throw new Error("Invalid Insights launch request");
  return {
    runId,
    runName,
    runsDir,
    spec,
    finderExportSnapshot: text("finder_export_snapshot"),
    finderExportSnapshotSha256: text("finder_export_snapshot_sha256"),
    authMethod: text("auth_method"),
    authIdentity: text("auth_identity"),
  };
}
