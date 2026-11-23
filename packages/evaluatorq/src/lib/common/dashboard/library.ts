import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

import {
  ManifestStatus,
  ManifestSurface,
  RUN_SUMMARY_VERSION,
  type RunManifest,
  RunManifestSchema,
  type RunSummary,
} from "../../contracts.js";
import { getSimulationRunsDir } from "../../integrations/simulation/run-store.js";
import { getPairwiseRunsDir } from "../../pairwise-run.js";
import { getRedteamRunsDir } from "../../redteam/run-store.js";
import {
  iterReportFiles,
  listManifests,
  listRunRecords,
  MANIFESTS_DIR_NAME,
  ManifestWriter,
  summaryIsCurrent,
} from "../run-manifest.js";

export type ReportSurface = "sim" | "redteam" | "pairwise";

export interface ReportData {
  [key: string]: unknown;
}

export interface ReportCard {
  id: string;
  surface: string;
  name: string;
  createdAt: Date;
  headline: string;
  path: string | null;
  error: string | null;
  status: ManifestStatus | null;
  stage: string | null;
}

export function reportId(path: string): string {
  return createHash("sha256")
    .update(canonicalPath(path))
    .digest()
    .subarray(0, 12)
    .toString("base64url");
}

// Like Python's Path.resolve(): symlinks in the existing prefix still resolve
// after the file itself is gone, so a deleted report keeps its id.
function canonicalPath(path: string): string {
  const absolute = resolvePath(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : join(canonicalPath(parent), basename(absolute));
  }
}

export function defaultRoots(): string[] {
  return [getRedteamRunsDir(), getSimulationRunsDir(), getPairwiseRunsDir()];
}

const JSON_CACHE_SIZE = 64;
const jsonCache = new Map<string, { mtimeNs: bigint; data: unknown }>();

export async function readJsonCached(path: string): Promise<unknown> {
  const key = canonicalPath(path);
  const { mtimeNs } = await stat(key, { bigint: true });
  const hit = jsonCache.get(key);
  if (hit && hit.mtimeNs === mtimeNs) {
    jsonCache.delete(key);
    jsonCache.set(key, hit);
    return structuredClone(hit.data);
  }
  const data: unknown = JSON.parse(await readFile(key, "utf8"));
  jsonCache.set(key, { mtimeNs, data });
  if (jsonCache.size > JSON_CACHE_SIZE) {
    const oldest = jsonCache.keys().next().value;
    if (oldest !== undefined) jsonCache.delete(oldest);
  }
  return structuredClone(data);
}

export function manifestCardId(runId: string): string {
  const digest = createHash("sha256")
    .update(`manifest:${runId}`)
    .digest()
    .subarray(0, 12);
  return digest.toString("base64url");
}

export function sniffKind(data: ReportData): ReportSurface | null {
  if ("mode" in data) {
    return "sim";
  }
  if ("pipeline" in data) {
    return "redteam";
  }
  if ("judging" in data) {
    return "pairwise";
  }
  return null;
}

const isReportObject = (parsed: unknown): parsed is ReportData =>
  typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);

export async function loadSurface(
  path: string,
): Promise<[ReportSurface | null, ReportData]> {
  try {
    const parsed = await readJsonCached(path);
    if (!isReportObject(parsed)) {
      return [null, {}];
    }
    return [sniffKind(parsed), parsed];
  } catch {
    return [null, {}];
  }
}

export async function loadSurfaceStrict(
  path: string,
): Promise<[ReportSurface | null, ReportData]> {
  const parsed = await readJsonCached(path);
  if (!isReportObject(parsed)) {
    throw new Error(`${path}: report is not a JSON object`);
  }
  return [sniffKind(parsed), parsed];
}

const stringOr = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
};

function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) {
    return 0;
  }
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return Math.max(0, centre - half);
}

function pairwiseHeadline(data: ReportData): string {
  const rawEntries = data.entries;
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  let headline = `${entries.length} comparison${entries.length !== 1 ? "s" : ""}`;
  let aWins = 0;
  let bWins = 0;
  for (const entry of entries) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof (entry as ReportData).comparison === "object" &&
      (entry as ReportData).comparison !== null &&
      !Array.isArray((entry as ReportData).comparison)
    ) {
      const comparison = (entry as ReportData).comparison as ReportData;
      if (comparison.winner === "A") {
        aWins++;
      } else if (comparison.winner === "B") {
        bWins++;
      }
    }
  }
  const decided = aWins + bWins;
  if (decided === 0) {
    return headline;
  }
  if (aWins === bWins) {
    headline += " · even";
    return headline;
  }
  const bLeads = bWins > aWins;
  const label =
    stringOr(
      data[bLeads ? "labelB" : "labelA"],
      data[bLeads ? "label_b" : "label_a"],
    ) ?? (bLeads ? "B" : "A");
  const low = wilsonLower(Math.max(aWins, bWins), decided);
  const tooClose = low > 0.5 ? "" : " · too close";
  const share = Math.round((Math.max(aWins, bWins) / decided) * 100);
  headline += ` · ${label} leads ${share}%${tooClose}`;
  return headline;
}

export function cardFromManifest(manifest: RunManifest): ReportCard {
  const surface = manifest.surface;
  const createdAt = manifest.startedAt;
  const path = manifest.reportPath || null;
  const summary = manifest.summary ?? {};
  const status = manifest.status;
  let headline: string;
  if (status === "completed" && Object.keys(summary).length > 0) {
    const noun =
      surface === ManifestSurface.REDTEAM ? "attacks" : "conversations";
    headline = `${summary.totalResults ?? 0} ${noun}`;
  } else if (status === "running") {
    headline = manifest.stage ? `running · ${manifest.stage}` : "running";
  } else {
    headline = status;
  }
  return {
    id: path !== null ? reportId(path) : manifestCardId(manifest.runId),
    surface,
    name: manifest.runName,
    createdAt,
    headline,
    path,
    error: null,
    status,
    stage: manifest.stage,
  };
}

async function card(path: string): Promise<ReportCard | null> {
  const [surface, data] = await loadSurface(path);
  if (surface === null) {
    return null;
  }
  const rawCreated = data.created_at ?? data.createdAt;
  let createdAt: Date;
  if (
    typeof rawCreated === "string" ||
    rawCreated instanceof Date ||
    typeof rawCreated === "number"
  ) {
    const parsed = new Date(rawCreated);
    createdAt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    createdAt = new Date();
  }
  const stem = basename(path).replace(/\.json$/, "");
  const nameValue = [data.run_name, data.runName, data.description].find(
    (value) =>
      (typeof value === "string" && value.length > 0) ||
      (typeof value === "number" && value !== 0) ||
      value === true,
  );
  const name =
    nameValue === undefined
      ? stem
      : String(nameValue === true ? "True" : nameValue);
  let error: string | null = null;
  if (surface === "redteam" && !("summary" in data)) {
    error = "missing required field: summary";
  } else if (
    surface === "sim" &&
    !("scorerAverages" in data || "scorer_averages" in data)
  ) {
    error = "missing required field: scorerAverages";
  } else if (surface === "pairwise" && !("entries" in data)) {
    error = "missing required field: entries";
  }
  let headline = "";
  if (error === null) {
    if (surface === "pairwise") {
      headline = pairwiseHeadline(data);
    } else {
      const noun = surface === "redteam" ? "attacks" : "conversations";
      headline = `${data.totalResults ?? data.total_results ?? 0} ${noun}`;
    }
  }
  return {
    id: reportId(path),
    surface,
    name,
    createdAt,
    headline,
    path,
    error,
    status: null,
    stage: null,
  };
}

async function backfillManifest(path: string, c: ReportCard): Promise<void> {
  if (
    c.error ||
    (c.surface !== ManifestSurface.SIM && c.surface !== ManifestSurface.REDTEAM)
  ) {
    return;
  }
  const stem = basename(path).replace(/\.json$/, "");
  const mpath = join(dirname(path), MANIFESTS_DIR_NAME, `${stem}.json`);
  let existing: RunManifest | null = null;
  let raw: string | null = null;
  try {
    raw = await readFile(mpath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`Rewriting unreadable run manifest ${mpath}: ${error}`);
  }
  if (raw !== null) {
    try {
      existing = RunManifestSchema.parse(JSON.parse(raw));
    } catch (error) {
      console.warn(`Rewriting unreadable run manifest ${mpath}: ${error}`);
    }
    if (existing !== null && summaryIsCurrent(existing)) {
      return;
    }
  }
  const summary = await reportSummary(path, c.surface);
  if (summary === null) {
    return;
  }
  const manifest =
    existing ??
    RunManifestSchema.parse({
      runId: stem,
      surface: c.surface,
      runName: c.name,
      status: ManifestStatus.COMPLETED,
      startedAt: c.createdAt,
      updatedAt: c.createdAt,
      endedAt: c.createdAt,
      reportPath: path,
    });
  const writer = new ManifestWriter(manifest, mpath);
  writer.manifest.summary = summary;
  writer.manifest.summaryVersion = RUN_SUMMARY_VERSION;
  await writer.flush();
}

async function reportSummary(
  path: string,
  surface: string,
): Promise<RunSummary | null> {
  try {
    const { ADAPTERS } = await import("../../dashboard/surfaces.js");
    const report = (await ADAPTERS[surface]?.load(path)) as {
      manifestSummary(): RunSummary;
    };
    return report.manifestSummary();
  } catch (error) {
    console.warn(`Skipping manifest backfill for ${path}: ${error}`);
    return null;
  }
}

export async function scan(
  runsDirs: string | string[] = [],
): Promise<ReportCard[]> {
  const given = Array.isArray(runsDirs) ? runsDirs : [runsDirs];
  const roots = given.length > 0 ? given : defaultRoots();
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const root of roots) {
    const resolved = canonicalPath(root);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      deduped.push(root);
    }
  }
  const cards: ReportCard[] = [];
  for (const runsDir of deduped) {
    for (const record of await listRunRecords(runsDir)) {
      if (record.manifest !== null) {
        cards.push(cardFromManifest(record.manifest));
      } else if (record.reportPath !== null) {
        const cardOrNull = await card(record.reportPath);
        if (cardOrNull !== null) {
          cards.push(cardOrNull);
          await backfillManifest(record.reportPath, cardOrNull);
        }
      }
    }
  }
  return cards.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface Fingerprint {
  count: number;
  newestMtimeNs: bigint;
  identity: string;
}

export async function fingerprint(
  runsDirs: string | string[] = [],
): Promise<Fingerprint> {
  const given = Array.isArray(runsDirs) ? runsDirs : [runsDirs];
  const roots = given.length > 0 ? given : defaultRoots();
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const root of roots) {
    const resolved = canonicalPath(root);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      deduped.push(root);
    }
  }
  let count = 0;
  let newest = 0n;
  const stamps: Array<[bigint, bigint]> = [];
  for (const runsDir of deduped) {
    const reportPaths = await iterReportFiles(runsDir);
    const manifestPaths = await jsonManifestPaths(runsDir);
    for (const path of [...reportPaths, ...manifestPaths]) {
      count++;
      try {
        const stats = await stat(path, { bigint: true });
        if (stats.mtimeNs > newest) newest = stats.mtimeNs;
        stamps.push([stats.ino, stats.size]);
      } catch {}
    }
  }
  return { count, newestMtimeNs: newest, identity: hashStamps(stamps) };
}

async function jsonManifestPaths(runsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(runsDir, MANIFESTS_DIR_NAME));
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(runsDir, MANIFESTS_DIR_NAME, name));
  } catch {
    return [];
  }
}

function hashStamps(stamps: Array<[bigint, bigint]>): string {
  const hash = createHash("sha256");
  for (const [ino, size] of stamps.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  )) {
    hash.update(`${ino}:${size};`);
  }
  return hash.digest("hex");
}

export async function resolve(
  rid: string,
  roots: string[] = defaultRoots(),
): Promise<string | null> {
  for (const root of roots) {
    for (const path of await iterReportFiles(root)) {
      if (reportId(path) === rid) {
        return path;
      }
    }
  }
  return null;
}

export async function resolveManifest(
  rid: string,
  roots: string[] = defaultRoots(),
): Promise<RunManifest | null> {
  for (const root of roots) {
    for (const m of await listManifests(root)) {
      if (!m.reportPath && manifestCardId(m.runId) === rid) {
        return m;
      }
    }
  }
  return null;
}

export type TypedReportResult<T> =
  | readonly ["ok", T]
  | readonly ["missing" | "error", null];
export async function loadTypedReport<T>(
  rid: string,
  roots: readonly string[],
  surface: string,
): Promise<TypedReportResult<T>> {
  const path = await resolve(rid, [...roots]);
  if (path === null) return ["missing", null];
  try {
    const [found] = await loadSurfaceStrict(path);
    if (found !== surface) return ["missing", null];
    const { ADAPTERS } = await import("../../dashboard/surfaces.js");
    const adapter = ADAPTERS[surface];
    if (!adapter) return ["missing", null];
    return ["ok", (await adapter.load(path)) as T];
  } catch (error) {
    console.warn(`Could not load ${surface} report ${rid}`, error);
    return ["error", null];
  }
}
