import { stat } from "node:fs/promises";

import type { InsightsRunFields, TraceInsight } from "../insights/models.js";
import { populationSource, readsOrq } from "../insights/models.js";
import { PopulationError, readSnapshot } from "../insights/population.js";
import { getInsightsRunsDir } from "../insights/store.js";
import {
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  type TraceRecord,
} from "../trace-finder/models.js";
import type { OrqTraceSource } from "../trace-finder/orq-source.js";
import { OrqSpanMismatchError } from "../trace-finder/orq-source-data.js";
import { isUploadedSource } from "./insights-uploads.js";

export const SOURCE_NOT_REREADABLE =
  "This run's trace source cannot be re-read.";
export const SNAPSHOT_PATH_MISSING =
  "This run does not record where its snapshot was read from.";
export const SNAPSHOT_UNREADABLE =
  "The snapshot file this run read is no longer available or could not be read.";
export const UPLOAD_DELETED =
  "The dashboard deletes uploaded snapshot files after the run, so this conversation is no longer available.";
export const ORQ_SPAN_CHANGED =
  "The conversation span analyzed by this run is no longer the span returned by Orq.";
export const ORQ_WINDOW_MISSING =
  "This run does not record the Orq time window it analyzed, so its conversation cannot be re-read safely.";

type Run = Pick<InsightsRunFields, "population">;
type Population = Readonly<Record<string, unknown>>;

function field(population: Population, camel: string, snake: string): unknown {
  return population[camel] ?? population[snake] ?? null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function goneSnapshotReason(path: string): Promise<string> {
  return (await isUploadedSource(getInsightsRunsDir(), path))
    ? UPLOAD_DELETED
    : SNAPSHOT_UNREADABLE;
}

/** Why the Trace tab cannot re-read this run's conversations, or null when it can; a snapshot costs one stat. */
export async function conversationUnavailableReason(
  run: Run,
): Promise<string | null> {
  if (populationSource(run.population) === "snapshot") {
    const path = field(run.population, "snapshotPath", "snapshot_path");
    if (!path) return SNAPSHOT_PATH_MISSING;
    return (await isFile(String(path)))
      ? null
      : goneSnapshotReason(String(path));
  }
  return readsOrq(run.population) ? null : SOURCE_NOT_REREADABLE;
}

export async function conversationRereadable(run: Run): Promise<boolean> {
  return (await conversationUnavailableReason(run)) === null;
}

function unavailable(
  trace: TraceInsight,
  reason: string,
  cause: unknown = null,
): string {
  console.warn(
    `Insights trace ${trace.traceId} conversation unavailable: ${cause ? String(cause) : reason}`,
  );
  return reason;
}

export function sourceNotRereadable(run: Run, trace: TraceInsight): string {
  const mode = run.population.mode;
  return unavailable(
    trace,
    SOURCE_NOT_REREADABLE,
    `population mode ${mode === undefined || mode === null ? "None" : `'${String(mode)}'`}`,
  );
}

/**
 * Re-run the pipeline's query for this one trace, keeping the run's filters and time window.
 * A changed span selection becomes an unavailable reason. `openSource` runs only once the trace
 * has a timestamp; it returns a source plus a close function, or a reason string it has logged.
 */
export async function loadOrqRecord(
  run: Run,
  trace: TraceInsight,
  options: {
    openSource: () => Promise<
      | string
      | { source: Pick<OrqTraceSource, "loadTrace">; close(): Promise<void> }
    >;
  },
): Promise<TraceRecord | string> {
  if (trace.timestamp === null)
    return unavailable(
      trace,
      "This run did not record when the trace ran, so its conversation cannot be re-read from Orq.",
    );
  let window: PopulationRequest;
  try {
    const { start, end } = run.population;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null
    )
      throw new Error(
        "the saved population is missing its original time window",
      );
    window = new PopulationRequest({ start, end });
    if (window.start === null || window.end === null)
      throw new Error(
        "the saved population is missing its original time window",
      );
  } catch (error) {
    return unavailable(trace, ORQ_WINDOW_MISSING, error);
  }
  const opened = await options.openSource();
  if (typeof opened === "string") return opened;
  let record: TraceRecord | null;
  try {
    record = await opened.source.loadTrace(trace.traceId, {
      expectedSpanId: trace.spanId,
      start: window.start,
      end: window.end,
      facets: new FacetSelection(run.population.facets ?? {}),
      numeric: new NumericFilters(run.population.numeric ?? {}),
    } as Parameters<OrqTraceSource["loadTrace"]>[1]);
  } catch (error) {
    if (error instanceof OrqSpanMismatchError)
      return unavailable(trace, ORQ_SPAN_CHANGED, error);
    return unavailable(
      trace,
      "Could not load the conversation from Orq. Open it in Orq instead.",
      `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await opened.close();
  }
  if (record === null)
    return unavailable(
      trace,
      "Orq did not return this trace in the workspace used for this request. " +
        "Check that the account has access to that workspace and that the trace still exists.",
    );
  return record;
}

/** Read the trace's record from the snapshot file the run analysed, or a user-facing reason it cannot. */
export async function loadSnapshotRecord(
  run: Run,
  trace: TraceInsight,
): Promise<TraceRecord | string> {
  const raw = field(run.population, "snapshotPath", "snapshot_path");
  if (!raw) return unavailable(trace, SNAPSHOT_PATH_MISSING);
  const path = String(raw);
  let loaded: Awaited<ReturnType<typeof readSnapshot>>;
  try {
    loaded = await readSnapshot(path);
  } catch (error) {
    if (!(error instanceof PopulationError)) throw error;
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    return unavailable(
      trace,
      exists ? SNAPSHOT_UNREADABLE : await goneSnapshotReason(path),
      error,
    );
  }
  const saved = field(run.population, "snapshotSha256", "snapshot_sha256");
  if (saved && saved !== loaded.sha256)
    return unavailable(
      trace,
      "The snapshot file changed after this run, so it may not match the analysis.",
      `${path} has sha256 ${loaded.sha256}, the run read ${String(saved)}`,
    );
  const record = loaded.snapshot.traces.find(
    (item) => item.traceId === trace.traceId && item.spanId === trace.spanId,
  );
  return (
    record ??
    unavailable(
      trace,
      "This trace is not in the snapshot file.",
      `not in ${path}`,
    )
  );
}
