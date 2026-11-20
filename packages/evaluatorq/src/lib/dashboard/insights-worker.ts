/** Detached worker for Insights runs started from the dashboard. */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { failIfRunning } from "../common/run-manifest.js";
import { RunManifestSchema } from "../contracts.js";
import { InsightsPopulation } from "../insights/models.js";
import { insights } from "../insights/pipeline.js";
import { RunExport } from "../trace-finder/export.js";
import { effectiveDashboardSettings } from "../trace-finder/settings.js";
import {
  accountIdentity,
  accountLabel,
  authIdentity,
  buildAuthClients,
  resolveDashboardAuth,
  verifiedAccountIdentity,
} from "./auth.js";
import {
  cleanupSnapshot,
  FINDER_EXPORT_REFERENCE_DIR,
  finderExportReferencePath,
  INSIGHTS_WORKER_STATE_DIR,
  type InsightsLaunchPayload,
  MANIFEST_ENV,
  REQUEST_ENV,
  readLaunchPayload,
  readPrivateSnapshot,
  SNAPSHOT_ENV,
  startWorkerHeartbeat,
  validatePrivateFinderReference,
  workerStatePath,
} from "./insights-launch.js";
import {
  cleanupSessionUpload,
  MAX_INSIGHTS_UPLOAD_BYTES,
  retainUploadedSource,
} from "./insights-uploads.js";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const warn = (message: string) => console.warn(message);
const sha256 = (contents: Uint8Array) =>
  createHash("sha256").update(contents).digest("hex");

/** Recover a private Finder snapshot path when payload decoding fails; cleanup re-verifies it. */
export function snapshotCandidateFromRequest(): string | null {
  const raw = process.env[REQUEST_ENV];
  let request: unknown = null;
  try {
    request = raw !== undefined ? JSON.parse(raw) : null;
  } catch {
    request = null;
  }
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const { spec, finder_export_snapshot: snapshot } = request as Record<
      string,
      unknown
    >;
    if (
      spec &&
      typeof spec === "object" &&
      (spec as Record<string, unknown>).source === "finder" &&
      typeof snapshot === "string"
    )
      return snapshot;
  }
  return process.env[SNAPSHOT_ENV] || null;
}

/** Release a Finder export after its Insights worker reaches a terminal state. */
export async function cleanupFinderReference(
  runsDir: string,
  runId: string,
): Promise<void> {
  try {
    const reference = finderExportReferencePath(runsDir, runId);
    if (existsSync(reference)) {
      await validatePrivateFinderReference(reference);
      await unlink(reference).catch(() => {});
    }
  } catch (error) {
    warn(
      `Could not remove Finder export reference for run ${runId}: ${errorText(error)}`,
    );
  }
}

/** Release a Finder lease when a launch payload could not be decoded. */
export async function cleanupFinderReferenceForManifest(
  manifestPath: string,
): Promise<void> {
  try {
    if (basename(dirname(manifestPath)) !== ".manifests") return;
    const manifest = RunManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    if (
      manifest.surface !== "insights" ||
      basename(manifestPath) !== `${manifest.runId}.json`
    )
      return;
    await cleanupFinderReference(
      dirname(dirname(manifestPath)),
      manifest.runId,
    );
  } catch (error) {
    warn(
      `Could not recover Finder export reference from manifest ${manifestPath}: ${errorText(error)}`,
    );
  }
}

/** Run Insights with the clients of the auth the dashboard had selected at launch. */
async function runWithSelectedAuth(
  payload: InsightsLaunchPayload,
  population: InsightsPopulation,
  extra: {
    finderExportSource?: string;
    finderExportSha256?: string;
    sourceName?: string | null;
  },
): Promise<boolean> {
  const spec = payload.spec;
  const settings = await effectiveDashboardSettings();
  if (
    payload.authMethod !== null &&
    settings.orqAuthMethod !== payload.authMethod
  )
    throw new Error(
      "Dashboard authentication changed after this run started. Start the run again.",
    );
  const auth = await resolveDashboardAuth(settings);
  const account = accountIdentity(auth);
  if (
    payload.authIdentity !== null &&
    authIdentity(auth, settings) !== payload.authIdentity
  )
    throw new Error(
      "Dashboard authentication or scope changed after this run started. Start the run again.",
    );
  const [orq, llm] = await buildAuthClients(auth, {
    workspace: settings.orqWorkspace,
    project: settings.orqProjectId,
  });
  try {
    let verified: string | null = null;
    if (spec.source !== "snapshot") {
      try {
        verified = await verifiedAccountIdentity(auth, orq as never);
      } catch (error) {
        warn(
          `Could not verify the Orq account for this Insights run; retaining legacy credential identity: ${errorText(error)}`,
        );
      }
    }
    const orqScope =
      spec.source !== "snapshot"
        ? {
            account: verified ?? account,
            account_version: verified ? "2" : null,
            account_label: accountLabel(auth),
            workspace: settings.orqWorkspace,
            project: settings.orqProjectId,
          }
        : null;
    const run = await insights(population, {
      labels: spec.labelSpecs(),
      dimensions: spec.dimensionNames(),
      parallelism: spec.parallelism,
      traceInputChars: spec.traceInputChars,
      codingLabels: [...spec.codingLabels],
      runName: payload.runName,
      runsDir: payload.runsDir,
      ...spec.modelOverrides(),
      runId: payload.runId,
      orqScope,
      llmClient: llm as never,
      orqClient: orq as never,
      ...extra,
    });
    return run.status === "completed";
  } finally {
    const closable = llm as { close?: () => unknown } | null;
    await closable?.close?.();
  }
}

/** Remove ephemeral session copies and retain reusable uploads after either run outcome. */
export async function finishConsumedUpload(
  runsDir: string,
  source: string,
  finderExport: string,
  snapshotPath: string,
): Promise<void> {
  const value = source === "finder" ? finderExport : snapshotPath;
  if (!value) return;
  try {
    if (!(await cleanupSessionUpload(runsDir, value)))
      await retainUploadedSource(runsDir, value);
  } catch {
    warn(
      "Could not finish cleanup or retention of an Insights uploaded source.",
    );
  }
}

export async function main(): Promise<number> {
  const manifestEnv = process.env[MANIFEST_ENV];
  const stopHeartbeat = manifestEnv
    ? await startWorkerHeartbeat(manifestEnv)
    : null;
  let payload: InsightsLaunchPayload | null = null;
  const unvalidatedSnapshot = snapshotCandidateFromRequest();
  let completed = false;
  try {
    payload = readLaunchPayload();
    const spec = payload.spec;
    if (spec.source === "finder") {
      const snapshot = payload.finderExportSnapshot;
      if (snapshot === null)
        throw new Error(
          "Missing or oversized validated Finder export snapshot",
        );
      const raw = await readPrivateSnapshot(
        snapshot,
        MAX_INSIGHTS_UPLOAD_BYTES,
      );
      if (
        payload.finderExportSnapshotSha256 === null ||
        sha256(raw) !== payload.finderExportSnapshotSha256
      )
        throw new Error("Finder export snapshot changed after launch");
      const validated = new RunExport(JSON.parse(raw.toString("utf8")));
      completed = await runWithSelectedAuth(
        payload,
        InsightsPopulation.fromFinderExport(snapshot, { export: validated }),
        {
          finderExportSource: spec.finderExport,
          finderExportSha256: sha256(raw),
          sourceName: spec.sourceName || null,
        },
      );
    } else
      completed = await runWithSelectedAuth(payload, spec.population(), {
        sourceName: spec.sourceName || null,
      });
  } catch (error) {
    console.error("Dashboard Insights worker failed", error);
    const manifestPath =
      payload !== null
        ? join(payload.runsDir, ".manifests", `${payload.runId}.json`)
        : manifestEnv;
    if (manifestPath)
      await failIfRunning(manifestPath, errorText(error), "setup");
    return 1;
  } finally {
    await stopHeartbeat?.();
    if (payload?.finderExportSnapshot)
      await cleanupSnapshot(payload.finderExportSnapshot);
    else if (unvalidatedSnapshot !== null)
      await cleanupSnapshot(unvalidatedSnapshot);
    if (payload?.spec.source === "finder")
      await cleanupFinderReference(payload.runsDir, payload.runId);
    if (payload !== null)
      await finishConsumedUpload(
        payload.runsDir,
        payload.spec.source,
        payload.spec.finderExport,
        payload.spec.snapshotPath,
      );
    else if (manifestEnv) await cleanupFinderReferenceForManifest(manifestEnv);
    const runId =
      payload?.runId ?? (manifestEnv ? basename(manifestEnv, ".json") : null);
    if (runId !== null) {
      try {
        const runsDir =
          payload?.runsDir ?? dirname(dirname(manifestEnv as string));
        await unlink(workerStatePath(runsDir, runId)).catch(() => {});
      } catch (error) {
        warn(
          `Could not remove Insights worker state for run ${runId}: ${errorText(error)}`,
        );
      }
    }
  }
  return completed ? 0 : 1;
}

const RUN_ID = /^[A-Za-z0-9_-]+$/;

/** Run identity of the manifest the launcher named, or null when it is not a plain manifest path. */
function manifestRunId(manifest: string | undefined): string | null {
  if (!manifest || basename(dirname(manifest)) !== ".manifests") return null;
  const name = basename(manifest);
  const runId = name.endsWith(".json") ? name.slice(0, -5) : "";
  return RUN_ID.test(runId) ? runId : null;
}

/** Bootstrap failure cleanup: snapshot, Finder lease and worker state, then mark the manifest failed. */
export async function cleanupAfterBootstrapFailure(
  error: unknown,
): Promise<void> {
  const manifest = process.env[MANIFEST_ENV];
  const snapshot = snapshotCandidateFromRequest();
  if (snapshot) await cleanupSnapshot(snapshot);
  const runId = manifestRunId(manifest);
  if (manifest && runId) {
    const runsDir = dirname(dirname(manifest));
    try {
      const reference = join(
        runsDir,
        FINDER_EXPORT_REFERENCE_DIR,
        `${runId}.json`,
      );
      await validatePrivateFinderReference(reference);
      await unlink(reference);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== "ENOENT")
        console.error(
          `Could not remove Finder export reference: ${errorText(cleanupError)}`,
        );
    }
    try {
      const stateDir = join(runsDir, INSIGHTS_WORKER_STATE_DIR);
      if (!(await lstat(stateDir)).isSymbolicLink())
        await unlink(join(stateDir, `${runId}.json`));
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== "ENOENT")
        console.error(
          `Could not remove Insights worker state: ${errorText(cleanupError)}`,
        );
    }
  }
  if (manifest)
    try {
      await failIfRunning(
        manifest,
        `Could not start Insights worker: ${errorText(error)}`,
        "setup",
      );
    } catch (recoveryError) {
      console.error(
        `Could not mark Insights manifest failed: ${errorText(recoveryError)}`,
      );
    }
}

/** Wait for the launcher's single release byte; anything else (or EOF) means do not start. */
export function awaitHandshake(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<boolean> {
  return new Promise((resolveHandshake) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      input.removeAllListeners("data");
      input.pause();
      resolveHandshake(value);
    };
    input.once("data", (chunk: Buffer | string) =>
      finish(String(chunk).startsWith("1")),
    );
    input.once("end", () => finish(false));
    input.once("error", () => finish(false));
  });
}

async function bootstrap(): Promise<void> {
  if (!(await awaitHandshake())) process.exit(0);
  let code: number;
  try {
    code = await main();
  } catch (error) {
    await cleanupAfterBootstrapFailure(error);
    throw error;
  }
  process.exit(code);
}

const invoked = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invoked) void bootstrap();
