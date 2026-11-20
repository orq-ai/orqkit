import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeLocalSend,
  formatSize,
  PopulationError,
  projectionCoverage,
  resolveSnapshot,
} from "../../../src/lib/insights/population.js";

test("local snapshot resolves complete traces and records the raw file hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insights-snapshot-"));
  try {
    const path = join(directory, "snapshot.json");
    const raw = JSON.stringify({
      traces: [
        {
          schema_version: 1,
          trace_id: "trace-a",
          span_id: "span-a",
          timestamp: "2026-11-10T00:00:00Z",
          project: "p",
          model: "m",
          provider: "p",
          status: "ok",
          product: "agents",
          trace_type: "agent",
          messages: [{ role: "user", content: "full example" }],
        },
      ],
      documents: [],
    });
    await writeFile(path, raw);
    const population = await resolveSnapshot(path);
    const { InsightsPopulation } = await import(
      "../../../src/lib/insights/models.js"
    );
    const { resolvePopulation } = await import(
      "../../../src/lib/insights/population.js"
    );
    const full = await resolvePopulation(
      InsightsPopulation.fromSnapshot(path),
      {
        compilerModel: "c",
        classifierModel: "c",
        labelClassifierModel: "test/model",
        traceInputChars: 10000,
      },
    );
    expect(full.echo).toMatchObject({
      mode: "snapshot",
      nTraces: 1,
      nProjectionTruncated: 0,
    });
    await expect(
      resolvePopulation(new InsightsPopulation(), {
        compilerModel: "c",
        classifierModel: "c",
      }),
    ).rejects.toThrow("requires an Orq client");
    expect(population.nScanned).toBe(1);
    expect(population.traces[0]?.traceId).toBe("trace-a");
    expect(JSON.stringify(population.traces)).toContain("full example");
    expect(population.echo).toMatchObject({
      mode: "snapshot",
      snapshotPath: path,
      snapshotSha256: createHash("sha256").update(raw).digest("hex"),
      limit: 1,
    });
    expect(population.compiled).toBeNull();
    const coverage = await projectionCoverage(population.traces, {
      traceInputChars: 10000,
      classifierModel: "test/model",
      classifierQuestions: {
        question: { kind: "noul", instructions: "Check?" },
      },
    });
    expect(coverage.nTraces).toBe(1);
    expect(coverage.nSourceMessages).toBe(1);
    expect(coverage.nProjectionTruncated).toBe(0);
    const jevCoverage = await projectionCoverage(population.traces, {
      traceInputChars: 10000,
      classifierModel: "typesafe/jev-test",
    });
    expect(jevCoverage.nOmittedMessages).toBe(0);
    expect(jevCoverage.classifierStateFormat).toBe("jev");
    expect(coverage.classifierQuestionChars).toBeGreaterThan(0);
    expect(coverage.classifierRequestChars).toBeLessThanOrEqual(10000);
    const largeRaw = raw.replace("full example", "x".repeat(15000));
    await writeFile(path, largeRaw);
    const large = await resolveSnapshot(path);
    const shortened = await projectionCoverage(large.traces, {
      traceInputChars: 10000,
      classifierModel: "test/model",
      classifierQuestions: {
        question: { kind: "noul", instructions: "Check?" },
      },
    });
    expect(shortened.nProjectionTruncated).toBe(1);
    expect(shortened.nSummaryTruncated).toBe(1);
    expect(shortened.nClassifierTruncated).toBe(1);
    expect(shortened.classifierRequestChars).toBeLessThanOrEqual(10000);
    await writeFile(path, "{");
    await expect(resolveSnapshot(path)).rejects.toBeInstanceOf(PopulationError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("snapshot send preview reports size, count and all models", () => {
  expect(formatSize(1048576)).toBe("1.0 MB");
  expect(
    describeLocalSend({
      nTraces: 1,
      nBytes: 1024,
      fileName: "a.json",
      models: { summary: "s", classifier: "c", embedding: "e" },
      preview: true,
    }),
  ).toBe(
    "A run would send 1 trace (1.0 KB) from a.json to models: summary s, classifier c, embedding e.",
  );
});

test("filter populations apply the selected window to the v3 source", async () => {
  const { InsightsPopulation } = await import(
    "../../../src/lib/insights/models.js"
  );
  const { resolveFilterPopulation } = await import(
    "../../../src/lib/insights/population.js"
  );
  const queries: unknown[] = [];
  const client = {
    _options: {},
    _baseURL: null,
    projects: { list: async () => ({ data: [], has_more: false }) },
    traces: {
      query: async (request: unknown) => {
        queries.push(request);
        return { search: { data: [], has_more: false } };
      },
      listSpans: async () => ({ data: [], has_more: false }),
      getSpan: async () => ({}),
    },
  } as unknown as import("../../../src/lib/trace-finder/orq-source.js").OrqSourceClient;
  const pop = new InsightsPopulation({ windowDays: 3, limit: 20 });
  const result = await resolveFilterPopulation(pop, client, {
    now: new Date("2026-11-10T12:00:00Z"),
  });
  expect(result.echo).toMatchObject({
    mode: "filter",
    start: "2026-11-07T12:00:00.000Z",
    end: "2026-11-10T12:00:00.000Z",
    limit: 20,
  });
  expect(result.nScanned).toBe(0);
  expect(queries).toHaveLength(1);
});

test("Finder exports preserve pinned population and reject missing windows", async () => {
  const { InsightsPopulation } = await import(
    "../../../src/lib/insights/models.js"
  );
  const { resolveExportPopulation } = await import(
    "../../../src/lib/insights/population.js"
  );
  const { RunExport } = await import("../../../src/lib/trace-finder/export.js");
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/trace-export-python-goldens.json", import.meta.url),
      "utf8",
    ),
  ) as {
    models: { model: string; input: Record<string, unknown>; ok: boolean }[];
  };
  const original = fixture.models.find(
    (item) => item.model === "RunExport" && item.ok,
  )?.input;
  if (!original) throw new Error("missing export fixture");
  let calls = 0;
  const client = {
    _options: {},
    _baseURL: null,
    projects: { list: async () => ({ data: [], has_more: false }) },
    traces: {
      query: async () => {
        calls++;
        return { search: { data: [], has_more: false } };
      },
      listSpans: async () => ({ data: [], has_more: false }),
      getSpan: async () => ({}),
    },
  } as unknown as import("../../../src/lib/trace-finder/orq-source.js").OrqSourceClient;
  const empty = InsightsPopulation.fromFinderExport("finder.json", {
    export: new RunExport(original),
  });
  const resolved = await resolveExportPopulation(empty, client);
  expect(resolved.traces).toEqual([]);
  expect(resolved.echo).toMatchObject({
    mode: "export",
    nMatchedIds: 0,
    nMissingExportIds: 0,
  });
  expect(calls).toBe(0);
  const missingWindow = InsightsPopulation.fromFinderExport("finder.json", {
    export: new RunExport({ ...original, matched_trace_ids: ["trace-1"] }),
  });
  await expect(resolveExportPopulation(missingWindow, client)).rejects.toThrow(
    "original time window",
  );
  const pinned = InsightsPopulation.fromFinderExport("finder.json", {
    export: new RunExport({
      ...original,
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-10T00:00:00Z",
      matched_trace_ids: ["trace-1"],
    }),
  });
  const absent = await resolveExportPopulation(pinned, client);
  expect(absent.echo).toMatchObject({ nMatchedIds: 1, nMissingExportIds: 1 });
  expect(calls).toBe(1);
});
