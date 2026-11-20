import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  conversationRereadable,
  conversationUnavailableReason,
  loadOrqRecord,
  loadSnapshotRecord,
  ORQ_SPAN_CHANGED,
  ORQ_WINDOW_MISSING,
  SNAPSHOT_UNREADABLE,
  sourceNotRereadable,
  UPLOAD_DELETED,
} from "../../../src/lib/dashboard/insights-trace-source.js";
import { uploadsDir } from "../../../src/lib/dashboard/insights-uploads.js";
import {
  populationSource,
  readsOrq,
  readsSnapshot,
  type TraceInsight,
  TraceInsightSchema,
} from "../../../src/lib/insights/models.js";
import { getInsightsRunsDir } from "../../../src/lib/insights/store.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";
import { OrqSpanMismatchError } from "../../../src/lib/trace-finder/orq-source-data.js";

const SCRATCH = join(process.env.HOME ?? ".", "insights-trace-source-tests");
const previous = process.env.EVALUATORQ_DIR;
let root: string;
let warn: ReturnType<typeof spyOn<Console, "warn">>;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "case-"));
  process.env.EVALUATORQ_DIR = root;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.EVALUATORQ_DIR;
  else process.env.EVALUATORQ_DIR = previous;
});

const warnings = () => warn.mock.calls.map((call) => String(call[0]));

function makeTrace(traceId: string, spanId: string, content: string) {
  return {
    schema_version: 1,
    trace_id: traceId,
    span_id: spanId,
    timestamp: "2026-09-01T00:00:00Z",
    messages: [{ role: "user", content }],
    project: "default",
    model: "gpt-5",
    provider: "openai",
    status: "completed",
    product: "chat",
    trace_type: "conversation",
  };
}

function writeSnapshot(path: string, traces: unknown[]): string {
  const body = JSON.stringify({ traces, documents: [], capture_metadata: {} });
  writeFileSync(path, body);
  return createHash("sha256").update(body).digest("hex");
}

const trace: TraceInsight = TraceInsightSchema.parse({
  trace_id: "trace-1",
  span_id: "span-1",
  timestamp: "2026-08-30T12:00:00Z",
});

function snapshotRun(path: string, digest: string | null) {
  return {
    population: {
      mode: "snapshot",
      snapshot_path: path,
      ...(digest === null ? {} : { snapshot_sha256: digest }),
    },
  };
}

const orqRun = {
  population: {
    mode: "query",
    start: "2026-08-25T00:00:00+00:00",
    end: "2026-09-01T00:00:00+00:00",
  },
};

function opened(loadTrace: (...args: never[]) => Promise<TraceRecord | null>) {
  const state = { closed: false };
  return {
    state,
    openSource: async () => ({
      source: { loadTrace } as never,
      close: async () => {
        state.closed = true;
      },
    }),
  };
}

test("a snapshot run returns the record with the analysed span", async () => {
  const path = join(root, "snap.json");
  const digest = writeSnapshot(path, [
    makeTrace("trace-1", "span-0", "other span"),
    makeTrace("trace-1", "span-1", "analysed span"),
  ]);
  const result = await loadSnapshotRecord(snapshotRun(path, digest), trace);
  expect(result).toBeInstanceOf(TraceRecord);
  const record = result as TraceRecord;
  expect(record.spanId).toBe("span-1");
  expect(record.messages[0]?.content).toBe("analysed span");
});

test("a deleted snapshot gives a reason without the path and logs it once", async () => {
  const result = await loadSnapshotRecord(
    snapshotRun(join(root, "gone.json"), "abc"),
    trace,
  );
  expect(result).toBe(SNAPSHOT_UNREADABLE);
  expect(result as string).not.toContain(root);
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0]).toContain(root);
});

test("a snapshot rewritten after the run is reported", async () => {
  const path = join(root, "snap.json");
  const digest = writeSnapshot(path, [
    makeTrace("trace-1", "span-1", "before"),
  ]);
  writeSnapshot(path, [makeTrace("trace-1", "span-1", "after")]);
  expect(await loadSnapshotRecord(snapshotRun(path, digest), trace)).toBe(
    "The snapshot file changed after this run, so it may not match the analysis.",
  );
});

test("a trace absent from the snapshot is reported", async () => {
  const path = join(root, "snap.json");
  const digest = writeSnapshot(path, [
    makeTrace("trace-2", "span-2", "only other"),
  ]);
  expect(await loadSnapshotRecord(snapshotRun(path, digest), trace)).toBe(
    "This trace is not in the snapshot file.",
  );
});

test("a snapshot run without a recorded path is reported", async () => {
  expect(
    await loadSnapshotRecord({ population: { mode: "snapshot" } }, trace),
  ).toBe("This run does not record where its snapshot was read from.");
});

test("an Orq source that could not open returns its reason without logging again", async () => {
  const reason =
    "Connect an Orq account in Settings to load this conversation.";
  expect(
    await loadOrqRecord(orqRun, trace, { openSource: async () => reason }),
  ).toBe(reason);
  expect(warnings()).toEqual([]);
});

test("an Orq run queries with the recorded window and filters, then closes the source", async () => {
  const calls: unknown[] = [];
  const record = new TraceRecord(
    makeTrace("trace-1", "span-1", "hello from orq"),
  );
  const source = opened((async (id: string, options: unknown) => {
    calls.push([id, options]);
    return record;
  }) as never);
  const run = {
    population: {
      ...orqRun.population,
      mode: "filter",
      facets: { status: ["error"] },
    },
  };
  expect(await loadOrqRecord(run, trace, source)).toBe(record);
  const [[id, options]] = calls as [[string, Record<string, unknown>]];
  expect(id).toBe("trace-1");
  expect(options.expectedSpanId).toBe("span-1");
  expect(new Date(String(options.start)).toISOString()).toBe(
    "2026-08-25T00:00:00.000Z",
  );
  expect(new Date(String(options.end)).toISOString()).toBe(
    "2026-09-01T00:00:00.000Z",
  );
  expect([...(options.facets as { status: Set<string> }).status]).toEqual([
    "error",
  ]);
  expect(source.state.closed).toBe(true);
});

test("a changed Orq span is reported without its conversation", async () => {
  const source = opened(async () => {
    throw new OrqSpanMismatchError(
      "trace trace-1 reloaded as span 'span-current'",
    );
  });
  expect(await loadOrqRecord(orqRun, trace, source)).toBe(ORQ_SPAN_CHANGED);
  expect(
    warnings().filter((m: string) => m.includes("conversation unavailable")),
  ).toHaveLength(1);
  expect(source.state.closed).toBe(true);
});

test("an Orq failure gives the could-not-load reason and logs the cause", async () => {
  const source = opened(async () => {
    throw new Error("orq is down");
  });
  expect(await loadOrqRecord(orqRun, trace, source)).toBe(
    "Could not load the conversation from Orq. Open it in Orq instead.",
  );
  expect(
    warnings().some(
      (m) =>
        m.includes("conversation unavailable") && m.includes("orq is down"),
    ),
  ).toBe(true);
});

test("an Orq trace without a conversation is reported", async () => {
  expect(
    await loadOrqRecord(
      orqRun,
      trace,
      opened(async () => null),
    ),
  ).toBe(
    "Orq did not return this trace in the workspace used for this request. " +
      "Check that the account has access to that workspace and that the trace still exists.",
  );
});

test("a legacy Orq run without a saved window never opens Orq", async () => {
  const result = await loadOrqRecord({ population: { mode: "query" } }, trace, {
    openSource: async () => {
      throw new Error("must not open Orq");
    },
  });
  expect(result).toBe(ORQ_WINDOW_MISSING);
});

test("an Orq trace without an analysed time is reported before opening a source", async () => {
  const result = await loadOrqRecord(
    orqRun,
    { ...trace, timestamp: null },
    {
      openSource: async () => {
        throw new Error(
          "a trace without a timestamp must not look up credentials",
        );
      },
    },
  );
  expect(result).toBe(
    "This run did not record when the trace ran, so its conversation cannot be re-read from Orq.",
  );
  expect(warnings()).toHaveLength(1);
});

test.each([
  [{ mode: "snapshot" }, true],
  [{ mode: "export", snapshot_path: "/x" }, true],
  [{ mode: "query" }, false],
])("readsSnapshot(%j) is %p", (population, expected) => {
  expect(readsSnapshot(population)).toBe(expected);
});

test.each([
  [{ mode: "query" }, true],
  [{ mode: "export" }, true],
  [{ mode: "filter" }, true],
  [{ mode: "export", snapshot_path: "/x" }, false],
  [{ mode: "snapshot" }, false],
  [{ mode: "dataset" }, false],
  [{ request: null, query: null }, false],
])("readsOrq(%j) is %p", (population, expected) => {
  expect(readsOrq(population)).toBe(expected);
});

test.each([
  [{ mode: "snapshot" }, "snapshot"],
  [{ mode: "export", snapshot_path: "/x" }, "snapshot"],
  [{ mode: "query" }, "query"],
  [{ mode: "export", finder_export: "/x" }, "export"],
  [{ mode: "filter" }, "filter"],
  [{ mode: "dataset" }, "unknown"],
  [{ mode: "finder", finder_export: "/x" }, "unknown"],
  [{}, "unknown"],
])("populationSource(%j) is %p", (population, expected) => {
  expect(populationSource(population)).toBe(expected as never);
});

test("a run from an unknown source is not re-read", async () => {
  const run = { population: { mode: "dataset" } };
  expect(sourceNotRereadable(run, trace)).toBe(
    "This run's trace source cannot be re-read.",
  );
  expect(warnings()).toHaveLength(1);
  expect(await conversationRereadable(run)).toBe(false);
  expect(await conversationUnavailableReason(run)).toBe(
    "This run's trace source cannot be re-read.",
  );
});

function uploadedSnapshotPath(): string {
  const directory = uploadsDir(getInsightsRunsDir());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `snapshot-${"0".repeat(32)}.json`);
}

test("an uploaded snapshot still on disk is read", async () => {
  const path = uploadedSnapshotPath();
  const digest = writeSnapshot(path, [
    makeTrace("trace-1", "span-1", "still here"),
  ]);
  const run = snapshotRun(path, digest);
  const result = (await loadSnapshotRecord(run, trace)) as TraceRecord;
  expect(result.messages[0]?.content).toBe("still here");
  expect(await conversationRereadable(run)).toBe(true);
});

test("a deleted uploaded snapshot says the dashboard deleted the file", async () => {
  const run = snapshotRun(uploadedSnapshotPath(), "abc");
  expect(await loadSnapshotRecord(run, trace)).toBe(UPLOAD_DELETED);
  expect(warnings()).toHaveLength(1);
  expect(await conversationRereadable(run)).toBe(false);
  expect(await conversationUnavailableReason(run)).toBe(UPLOAD_DELETED);
});

test("Orq runs and existing snapshot files are re-readable", async () => {
  const kept = join(root, "snap.json");
  writeSnapshot(kept, []);
  expect(await conversationRereadable(orqRun)).toBe(true);
  expect(await conversationRereadable(snapshotRun(kept, null))).toBe(true);
  const gone = snapshotRun(join(root, "gone.json"), null);
  expect(await conversationRereadable(gone)).toBe(false);
  expect(await conversationUnavailableReason(gone)).toBe(SNAPSHOT_UNREADABLE);
  expect(
    await conversationRereadable({ population: { mode: "snapshot" } }),
  ).toBe(false);
});
