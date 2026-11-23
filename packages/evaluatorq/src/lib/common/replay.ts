import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, parse } from "node:path";

import { listManifests } from "./run-manifest.js";

export const MIN_RUN_ID_PREFIX = 8;
export const REPLAY_VERSION_KEY = "replay_version";
export const REPLAY_VERSION = 1;

const SUGGEST_LIMIT = 5;

export class ReplayError extends Error {
  override name = "ReplayError";
}

export function checkReplayVersion(
  payload: Record<string, unknown>,
  path: string,
  options: { surface: string },
): void {
  const legacy = payload[REPLAY_VERSION_KEY];
  const camel = payload.replayVersion;
  if (legacy !== undefined && camel !== undefined && legacy !== camel)
    throw new ReplayError(
      `${basename(path)} has conflicting replay version fields.`,
    );
  const stored = camel ?? legacy;
  if (
    typeof stored === "number" &&
    Number.isInteger(stored) &&
    stored > REPLAY_VERSION
  ) {
    throw new ReplayError(
      `${basename(path)} was saved by a newer version of evaluatorq (replay format v${stored}; this build reads v${REPLAY_VERSION}). Upgrade evaluatorq to replay this ${options.surface} run.`,
    );
  }
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

async function reportsNewestFirst(runsDir: string): Promise<string[]> {
  const names = await readdir(runsDir).catch(() => [] as string[]);
  const reports: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const path = join(runsDir, name);
    const info = await stat(path).catch(() => null);
    if (info) {
      reports.push({ path, mtimeMs: info.mtimeMs });
    }
  }
  return reports.sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ path }) => path);
}

async function resolveViaManifest(
  reference: string,
  runsDir: string,
): Promise<string | null> {
  const manifests = (await listManifests(runsDir)).filter((m) => m.reportPath);
  const exact = manifests.find((m) => m.runId === reference);
  if (exact) {
    return exact.reportPath;
  }
  if (Array.from(reference).length < MIN_RUN_ID_PREFIX) {
    return null;
  }
  const matches = new Set(
    manifests
      .filter((m) => m.runId.startsWith(reference))
      .map((m) => m.reportPath as string),
  );
  if (matches.size > 1) {
    throw new ReplayError(
      `Run reference '${reference}' is ambiguous: it matches ${matches.size} runs. Use a longer id.`,
    );
  }
  return [...matches][0] ?? null;
}

// Names repeat by design (`--from-run nightly` wants the latest nightly), so
// unlike an ambiguous id this picks the newest and says which one.
async function resolveViaName(
  reference: string,
  runsDir: string,
): Promise<string | null> {
  const matches = (await reportsNewestFirst(runsDir)).filter((path) => {
    const stem = parse(path).name;
    return stem === reference || stem.startsWith(`${reference}_`);
  });
  const newest = matches[0];
  if (newest === undefined) {
    return null;
  }
  if (matches.length > 1) {
    console.error(
      `Run name '${reference}' matches ${matches.length} runs; using the most recent: ${basename(newest)}`,
    );
  }
  return newest;
}

/**
 * First match wins: `latest`, an existing path, a file in `runsDir`, a manifest
 * run id (exact or a unique prefix of at least 8), then a report name, newest first.
 */
export async function resolveRunPath(
  reference: string,
  runsDir: string,
  options: { surface: string },
): Promise<string> {
  const { surface } = options;
  const ref = reference.trim();
  if (!ref) {
    throw new ReplayError(`Empty previous ${surface} run reference.`);
  }
  if (ref.toLowerCase() === "latest") {
    const latest = (await reportsNewestFirst(runsDir))[0];
    if (latest === undefined) {
      throw new ReplayError(
        `No saved ${surface} runs found in ${runsDir}: nothing to replay.`,
      );
    }
    return latest;
  }
  for (const candidate of [
    ref,
    join(runsDir, ref),
    join(runsDir, `${ref}.json`),
  ]) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  // A manifest can outlive its report, so a stale one must not mask a name match.
  for (const resolve of [resolveViaManifest, resolveViaName]) {
    const resolved = await resolve(ref, runsDir);
    if (resolved !== null && (await isFile(resolved))) {
      return resolved;
    }
  }
  const recent = (await reportsNewestFirst(runsDir))
    .slice(0, SUGGEST_LIMIT)
    .map((path) => basename(path));
  const hint =
    recent.length > 0
      ? ` Recent runs: ${recent.join(", ")}.`
      : ` No runs found in ${runsDir}.`;
  throw new ReplayError(
    `Could not resolve previous ${surface} run '${ref}' in ${runsDir}. Pass a run file name, a run id, a path to a saved run, or "latest".${hint}`,
  );
}

export async function loadRunPayload(
  reference: string,
  runsDir: string,
  options: { surface: string },
): Promise<{ payload: Record<string, unknown>; path: string }> {
  const { surface } = options;
  const path = await resolveRunPath(reference, runsDir, options);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ReplayError(
      `Could not read previous ${surface} run ${path}: ${error}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new ReplayError(
      `Previous ${surface} run ${path} is not valid JSON: ${error}`,
    );
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new ReplayError(
      `Previous ${surface} run ${path} does not contain a run object.`,
    );
  }
  checkReplayVersion(payload as Record<string, unknown>, path, options);
  return { payload: payload as Record<string, unknown>, path };
}
