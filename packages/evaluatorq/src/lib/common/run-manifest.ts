import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ManifestStatus,
  type ManifestSurface,
  RUN_SUMMARY_VERSION,
  type RunManifest,
  RunManifestSchema,
  type RunSummary,
  type StageRecord,
  StageRecordSchema,
} from "../contracts.js";
import { withFileLock } from "./file-lock.js";

export const MANIFESTS_DIR_NAME = ".manifests";

const ARTIFACT_PREFIXES = ["01_", "02_", "03_"];
const PROGRESS_FLUSH_MS = 1000;

const isMissing = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "ENOENT";

const manifestsDir = (runsDir: string): string =>
  join(runsDir, MANIFESTS_DIR_NAME);

async function withManifestLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(`${path}.lock`, fn);
}

// The temp file and rename keep a mid-write kill from leaving truncated JSON,
// since surfacing crashed runs is the whole point of the manifest.
async function writeAtomic(
  manifest: RunManifest,
  path: string,
): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
    await rename(temporary, path);
    return true;
  } catch (error) {
    console.warn(
      `Failed to write run manifest ${path}: ${error}; later transitions will retry`,
    );
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

async function readManifestFile(path: string): Promise<RunManifest | null> {
  try {
    return RunManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!isMissing(error)) {
      console.warn(`Could not read run manifest ${path}: ${error}`);
    }
    return null;
  }
}

function applyFail(
  manifest: RunManifest,
  error: string,
  stage: string | null | undefined,
): void {
  const now = new Date();
  let anyOpen = false;
  for (const record of manifest.stages) {
    if (record.endedAt === null) {
      record.status = ManifestStatus.ERROR;
      record.endedAt = now;
      anyOpen = true;
    }
  }
  if (!anyOpen && stage !== null && stage !== undefined) {
    manifest.stage = stage;
  }
  manifest.status = ManifestStatus.ERROR;
  manifest.error = error;
  manifest.endedAt = now;
}

/**
 * Reads, mutates and rewrites a manifest under the cross-process lock. Returns
 * null when the file is missing, unreadable or the write failed.
 */
export async function updateManifest(
  path: string,
  mutate: (manifest: RunManifest) => void,
): Promise<RunManifest | null> {
  return withManifestLock(path, async () => {
    const manifest = await readManifestFile(path);
    if (manifest === null) {
      return null;
    }
    mutate(manifest);
    manifest.updatedAt = new Date();
    return (await writeAtomic(manifest, path)) ? manifest : null;
  });
}

/** Marks a manifest errored unless another writer already finished it. */
export async function failIfRunning(
  path: string,
  error: string,
  stage?: string | null,
): Promise<boolean> {
  let failed = false;
  const written = await updateManifest(path, (manifest) => {
    if (manifest.status === ManifestStatus.RUNNING) {
      applyFail(manifest, error, stage);
      failed = true;
    }
  });
  return written !== null && failed;
}

/**
 * Holds one manifest and flushes it on each transition. Build one with
 * `startManifest`. A disk failure is logged, never raised.
 */
export class ManifestWriter {
  manifest: RunManifest;
  readonly path: string;
  private persisted: RunManifest;
  private readonly clock: () => number;
  private readonly lastProgressFlush = new WeakMap<StageRecord, number>();

  constructor(
    manifest: RunManifest,
    path: string,
    options: { clock?: () => number } = {},
  ) {
    this.manifest = manifest;
    this.path = path;
    this.persisted = structuredClone(manifest);
    this.clock = options.clock ?? (() => performance.now());
  }

  /**
   * Merges changes made since the last flush onto the disk view, so a long-lived
   * writer cannot replace newer fields. The first terminal status on disk wins.
   */
  async flush(): Promise<boolean> {
    return withManifestLock(this.path, async () => {
      const onDisk = await readManifestFile(this.path);
      if (onDisk !== null) {
        if (
          this.persisted.status === ManifestStatus.RUNNING &&
          onDisk.status !== ManifestStatus.RUNNING
        ) {
          console.warn(
            `Run manifest ${this.path} was already finished as ${onDisk.status} by another writer; keeping it`,
          );
          this.manifest = onDisk;
          this.persisted = structuredClone(onDisk);
          return true;
        }
        const merged: Record<string, unknown> = structuredClone(onDisk);
        const local = this.manifest as Record<string, unknown>;
        const base = this.persisted as Record<string, unknown>;
        for (const field of Object.keys(RunManifestSchema.shape)) {
          if (!isDeepStrictEqual(local[field], base[field])) {
            merged[field] = local[field];
          }
        }
        this.manifest = merged as RunManifest;
      }
      this.manifest.updatedAt = new Date();
      // A transition can land while the write is pending: the snapshot leaves it
      // unpersisted, so the flush that follows it still sees the change.
      const snapshot = structuredClone(this.manifest);
      if (!(await writeAtomic(snapshot, this.path))) {
        return false;
      }
      this.persisted = snapshot;
      return true;
    });
  }

  private openStage(
    name: string | null,
    target: string | null,
  ): StageRecord | undefined {
    return [...this.manifest.stages]
      .reverse()
      .find(
        (record) =>
          record.endedAt === null &&
          (name === null || record.name === name) &&
          record.target === target,
      );
  }

  private get running(): boolean {
    return this.manifest.status === ManifestStatus.RUNNING;
  }

  async startStage(
    stage: string | null | undefined,
    options: { target?: string | null } = {},
  ): Promise<void> {
    if (stage === null || stage === undefined || !this.running) {
      return;
    }
    const target = options.target ?? null;
    const now = new Date();
    const previous = this.openStage(null, target);
    if (previous) {
      previous.status = ManifestStatus.COMPLETED;
      previous.endedAt = now;
    }
    this.manifest.stages.push(
      StageRecordSchema.parse({
        name: stage,
        target,
        status: ManifestStatus.RUNNING,
        startedAt: now,
      }),
    );
    this.manifest.stage = stage;
    await this.flush();
  }

  async endStage(
    stage: string | null | undefined,
    options: { target?: string | null; error?: unknown } = {},
  ): Promise<void> {
    if (!this.running) {
      return;
    }
    const record = this.openStage(stage ?? null, options.target ?? null);
    if (!record) {
      return;
    }
    record.status = options.error
      ? ManifestStatus.ERROR
      : ManifestStatus.COMPLETED;
    record.endedAt = new Date();
    await this.flush();
  }

  /** Throttled to one write a second; a failed write retries on the next call. */
  async stageProgress(
    stage: string,
    completed: number,
    total: number,
    options: { target?: string | null } = {},
  ): Promise<void> {
    if (
      !Number.isInteger(completed) ||
      !Number.isInteger(total) ||
      completed < 0 ||
      total < 0 ||
      completed > total
    ) {
      console.warn(
        `Ignoring invalid progress for stage ${stage}: completed=${completed}, total=${total}`,
      );
      return;
    }
    const record = this.openStage(stage, options.target ?? null);
    if (!record || !this.running) {
      return;
    }
    record.completed = completed;
    record.total = total;
    const now = this.clock();
    const last = this.lastProgressFlush.get(record);
    if (
      completed >= total ||
      last === undefined ||
      now - last >= PROGRESS_FLUSH_MS
    ) {
      if (await this.flush()) {
        this.lastProgressFlush.set(record, now);
      } else {
        this.lastProgressFlush.delete(record);
      }
    }
  }

  async complete(
    reportPath?: string | null,
    summary?: RunSummary | null,
  ): Promise<void> {
    if (!this.running) {
      return;
    }
    const now = new Date();
    for (const record of this.manifest.stages) {
      if (record.endedAt === null) {
        record.status = ManifestStatus.COMPLETED;
        record.endedAt = now;
      }
    }
    this.manifest.status = ManifestStatus.COMPLETED;
    this.manifest.endedAt = now;
    if (reportPath !== null && reportPath !== undefined) {
      this.manifest.reportPath = reportPath;
    }
    if (summary !== null && summary !== undefined) {
      this.manifest.summary = summary;
      this.manifest.summaryVersion = RUN_SUMMARY_VERSION;
    }
    await this.flush();
  }

  /** A declined run: cancellation happens outside a stage, so stages stay as they are. */
  async cancel(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.manifest.status = ManifestStatus.CANCELLED;
    this.manifest.endedAt = new Date();
    await this.flush();
  }

  async fail(error: string, stage?: string | null): Promise<void> {
    if (!this.running) {
      return;
    }
    applyFail(this.manifest, error, stage);
    await this.flush();
  }
}

export async function startManifest(options: {
  runId: string;
  surface: ManifestSurface | string;
  runName: string;
  runsDir: string;
  plannedStages?: string[] | null;
  stageLabels?: Record<string, string> | null;
  parallelism?: number | null;
}): Promise<ManifestWriter> {
  const now = new Date();
  const manifest = RunManifestSchema.parse({
    runId: options.runId,
    surface: options.surface,
    runName: options.runName,
    status: ManifestStatus.RUNNING,
    plannedStages: options.plannedStages ?? [],
    stageLabels: options.stageLabels ?? {},
    parallelism: options.parallelism ?? null,
    startedAt: now,
    updatedAt: now,
  });
  const writer = new ManifestWriter(
    manifest,
    join(manifestsDir(options.runsDir), `${options.runId}.json`),
  );
  await writer.flush();
  return writer;
}

async function jsonNames(directory: string): Promise<string[] | null> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
}

/** Newest first; bad files are logged and skipped. */
export async function listManifests(runsDir: string): Promise<RunManifest[]> {
  const directory = manifestsDir(runsDir);
  const names = (await jsonNames(directory)) ?? [];
  const manifests: RunManifest[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      manifests.push(
        RunManifestSchema.parse(JSON.parse(await readFile(path, "utf8"))),
      );
    } catch (error) {
      console.warn(`Skipping unreadable manifest ${path}: ${error}`);
    }
  }
  return manifests.sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  );
}

export function readManifest(
  runsDir: string,
  runId: string,
): Promise<RunManifest | null> {
  return readManifestFile(join(manifestsDir(runsDir), `${runId}.json`));
}

/** Whether the manifest's summary was written in today's `RUN_SUMMARY_VERSION`. */
export function summaryIsCurrent(manifest: RunManifest): boolean {
  return (
    manifest.summary !== null &&
    Object.keys(manifest.summary).length > 0 &&
    manifest.summaryVersion === RUN_SUMMARY_VERSION
  );
}

/** The one definition of "is a report": `*.json` here, minus stage artifacts. */
export async function iterReportFiles(runsDir: string): Promise<string[]> {
  const names = (await jsonNames(runsDir)) ?? [];
  return names
    .filter((name) => !ARTIFACT_PREFIXES.some((p) => name.startsWith(p)))
    .sort()
    .map((name) => join(runsDir, name));
}

const canonical = (path: string): Promise<string> =>
  realpath(path).catch(() => resolve(path));

export interface RunRecord {
  manifest: RunManifest | null;
  reportPath: string | null;
}

/**
 * Manifest-first run listing, newest first. A completed manifest with a stale
 * summary gives way to its report; a report with no manifest is a legacy row.
 */
export async function listRunRecords(runsDir: string): Promise<RunRecord[]> {
  const records: Array<RunRecord & { sortKey: number }> = [];
  const covered = new Set<string>();
  for (const manifest of await listManifests(runsDir)) {
    const reportPath = manifest.reportPath || null;
    if (
      manifest.status === ManifestStatus.COMPLETED &&
      reportPath !== null &&
      !summaryIsCurrent(manifest)
    ) {
      continue;
    }
    if (reportPath !== null) {
      covered.add(await canonical(reportPath));
    }
    records.push({
      manifest,
      reportPath,
      sortKey: manifest.startedAt.getTime(),
    });
  }
  for (const path of await iterReportFiles(runsDir)) {
    try {
      if (covered.has(await canonical(path))) {
        continue;
      }
      const { mtimeMs } = await stat(path);
      records.push({ manifest: null, reportPath: path, sortKey: mtimeMs });
    } catch (error) {
      console.warn(`Skipping unreadable legacy report ${path}: ${error}`);
    }
  }
  return records
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(({ manifest, reportPath }) => ({ manifest, reportPath }));
}
