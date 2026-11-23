import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenAI from "openai";
import { UMAP } from "umap-js";

import {
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import { InsightsCache } from "../../../src/lib/insights/cache.js";
import { TraceInsightSchema } from "../../../src/lib/insights/models.js";
import { buildDimension } from "../../../src/lib/insights/pipeline.js";

const requests: { path: string; body: Record<string, unknown> }[] = [];
let multi = false;
let descriptionFailure: "partial" | "top" | "all" | null = null;
let baseDescriptions = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname,
      body = (await request.json()) as Record<string, unknown>;
    requests.push({ path, body });
    if (path.endsWith("/embeddings")) {
      const input = body.input as string[];
      return Response.json({
        object: "list",
        model: "test/embed-dimension",
        data: input.map((_, index) => ({
          object: "embedding",
          index,
          embedding: multi
            ? index < 15
              ? [10, 1 + index / 100, 1]
              : [1, 10, 1 + index / 100]
            : [index + 1, 1 + ((index * index) % 7), 2 + (index % 3)],
        })),
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      });
    }
    if (path.endsWith("/decisions"))
      return Response.json({
        answers: { same: { type: "noul", noul: 0.9 } },
        model: "test/classify-dimension",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    const prompt = String(
      ((body.messages as { content?: string }[]) ?? [])[0]?.content ?? "",
    );
    const baseDescription = prompt.includes("<examples>"),
      topDescription = prompt.includes("<children>");
    if (
      (baseDescription &&
        (descriptionFailure === "all" ||
          (descriptionFailure === "partial" && baseDescriptions++ === 0))) ||
      (topDescription && descriptionFailure === "top")
    )
      return Response.json(
        {
          error: {
            message: "synthetic description failure",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    const reply = prompt.includes("<conversation>")
      ? {
          summary: "Test conversation",
          request: `fix test ${requests.length}`,
          task: "fix test",
          topic: "tests",
          assistant_errors: [],
          sentiment_explanation: "neutral",
          languages: ["English"],
        }
      : { name: "Fix tests", description: "Users fixed tests." };
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "test/describe-dimension",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(reply),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  },
});
afterAll(() => server.stop(true));
beforeAll(() => {
  registerModel(
    "test/classify-dimension",
    new ModelInfo({
      provider: "test",
      supportsResponses: false,
      supportsClassify: true,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    }),
  );
  registerModel(
    "test/embed-dimension",
    new ModelInfo({
      provider: "test",
      supportsResponses: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      modelType: "embedding",
    }),
  );
  registerModel(
    "test/describe-dimension",
    new ModelInfo({
      provider: "test",
      supportsResponses: false,
      supportsClassify: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    }),
  );
});
const client = new OpenAI({
  apiKey: "synthetic",
  baseURL: `http://127.0.0.1:${server.port}/v3/router`,
  maxRetries: 0,
});
const trace = (index: number) =>
  TraceInsightSchema.parse({
    traceId: `t${index}`,
    summary: {
      summary: "summary",
      request: `fix test ${index}`,
      task: null,
      topic: null,
      assistantErrors: [],
      sentimentExplanation: null,
      languages: [],
    },
  });
test("a complete synthetic dimension embeds, clusters, describes and maps every trace", async () => {
  const cache = await InsightsCache.open({ enabled: false });
  try {
    const traces = Array.from({ length: 8 }, (_, i) => trace(i));
    const result = await buildDimension("intent", traces, {
      client,
      cache,
      embeddingModel: "test/embed-dimension",
      summaryModel: "test/describe-dimension",
      classifierModel: "test/describe-dimension",
      maxClusters: 1,
      maxSubclusters: 1,
      outlierZscore: null,
      parallelism: 2,
    });
    expect(
      result.clusters.filter((cluster) => cluster.level === "base"),
    ).toHaveLength(1);
    expect(
      result.clusters.filter((cluster) => cluster.level === "top"),
    ).toHaveLength(1);
    expect(result.clusters[0]?.size).toBe(8);
    expect(
      traces.every(
        (item) =>
          item.assignments.intent &&
          item.coords.intent?.length === 3 &&
          item.coords2d?.intent?.length === 2,
      ),
    ).toBe(true);
    const embedding = requests.find((request) =>
      request.path.endsWith("/embeddings"),
    );
    expect(embedding?.body.input).toEqual(
      traces.map((item) => item.summary?.request),
    );
    const prompts = requests.filter((request) =>
      request.path.endsWith("/chat/completions"),
    );
    expect(prompts).toHaveLength(2);
    for (const { body } of prompts)
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(4096);
  } finally {
    cache.close();
  }
}, 15000);
test("too few signals skip without model calls", async () => {
  const cache = await InsightsCache.open({ enabled: false });
  try {
    const before = requests.length;
    const result = await buildDimension("intent", [trace(1)], {
      client,
      cache,
      embeddingModel: "test/embed-dimension",
      summaryModel: "test/describe-dimension",
      classifierModel: "test/describe-dimension",
      maxClusters: 1,
      maxSubclusters: 1,
      outlierZscore: null,
      parallelism: 1,
    });
    expect(result.clusters).toEqual([]);
    expect(result.warnings[0]).toContain("need at least 5");
    expect(requests).toHaveLength(before);
  } finally {
    cache.close();
  }
});

test("sibling clusters remain distinct when a merge would erase their split", async () => {
  const cache = await InsightsCache.open({ enabled: false });
  multi = true;
  try {
    const traces = Array.from({ length: 30 }, (_, i) => trace(i));
    const before = requests.length;
    const result = await buildDimension("intent", traces, {
      client,
      cache,
      embeddingModel: "test/embed-dimension",
      summaryModel: "test/describe-dimension",
      classifierModel: "test/classify-dimension",
      maxClusters: 2,
      maxSubclusters: 2,
      outlierZscore: null,
      parallelism: 2,
    });
    const base = result.clusters.filter((cluster) => cluster.level === "base");
    expect(base).toHaveLength(2);
    expect(base.map((cluster) => cluster.size).sort((a, b) => a - b)).toEqual([
      15, 15,
    ]);
    expect(
      new Set(traces.map((item) => item.assignments.intent?.base)).size,
    ).toBe(2);
    expect(
      requests
        .slice(before)
        .filter((request) => request.path.endsWith("/decisions")),
    ).toHaveLength(1);
  } finally {
    multi = false;
    cache.close();
  }
}, 15000);

test.each(["partial", "top", "all"] as const)(
  "%s cluster description failures remain visible",
  async (failure) => {
    const cache = await InsightsCache.open({ enabled: false });
    descriptionFailure = failure;
    baseDescriptions = 0;
    multi = failure === "partial";
    try {
      const result = buildDimension(
        "intent",
        Array.from({ length: multi ? 30 : 8 }, (_, i) => trace(i)),
        {
          client,
          cache,
          embeddingModel: "test/embed-dimension",
          summaryModel: "test/describe-dimension",
          classifierModel: "test/classify-dimension",
          maxClusters: multi ? 2 : 1,
          maxSubclusters: multi ? 2 : 1,
          outlierZscore: null,
          parallelism: 2,
        },
      );
      if (failure === "all") {
        await expect(result).rejects.toThrow(
          "describe failed for every base cluster",
        );
      } else {
        const dimension = await result;
        expect(
          dimension.warnings.some(
            (warning) =>
              warning.includes(
                `${failure === "partial" ? "base" : "top"} cluster`,
              ) && warning.includes("synthetic description failure"),
          ),
        ).toBe(true);
        expect(
          dimension.clusters.some(
            (cluster) =>
              cluster.name ===
              (failure === "partial"
                ? "Unlabeled cluster"
                : "Conversation group"),
          ),
        ).toBe(true);
      }
    } finally {
      descriptionFailure = null;
      multi = false;
      cache.close();
    }
  },
  15000,
);

test.each(["3D", "2D"] as const)(
  "%s UMAP errors are included in dimension warnings",
  async (stage) => {
    let calls = 0;
    const fit = spyOn(UMAP.prototype, "fitAsync").mockImplementation(
      async (rows) => {
        if (stage === "3D" || calls++ > 0)
          throw new Error("synthetic layout failure");
        return rows.map((_, index) => [index, index % 3, index % 5]);
      },
    );
    const cache = await InsightsCache.open({ enabled: false });
    try {
      const result = await buildDimension(
        "intent",
        Array.from({ length: 8 }, (_, i) => trace(i)),
        {
          client,
          cache,
          embeddingModel: "test/embed-dimension",
          summaryModel: "test/describe-dimension",
          classifierModel: "test/classify-dimension",
          maxClusters: 1,
          maxSubclusters: 1,
          outlierZscore: null,
          parallelism: 2,
        },
      );
      expect(
        result.warnings.some(
          (warning) =>
            warning.includes(
              stage === "3D"
                ? "UMAP unavailable"
                : "2D review layout unavailable",
            ) && warning.includes("synthetic layout failure"),
        ),
      ).toBe(true);
    } finally {
      fit.mockRestore();
      cache.close();
    }
  },
  15000,
);

test("complete snapshot run persists its report and terminal manifest", async () => {
  const { insights } = await import("../../../src/lib/insights/pipeline.js");
  const { InsightsPopulation } = await import(
    "../../../src/lib/insights/models.js"
  );
  const { loadRun } = await import("../../../src/lib/insights/store.js");
  const { listManifests } = await import(
    "../../../src/lib/common/run-manifest.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "insights-run-"));
  try {
    const path = join(directory, "snapshot.json");
    const records = Array.from({ length: 8 }, (_, i) => ({
      schemaVersion: 1,
      traceId: `t${i}`,
      spanId: `s${i}`,
      timestamp: "2026-11-10T00:00:00Z",
      project: "p",
      model: "m",
      provider: "p",
      status: "ok",
      product: "agents",
      traceType: "agent",
      messages: [{ role: "user", content: `fix test ${i}` }],
    }));
    await writeFile(path, JSON.stringify({ traces: records, documents: [] }));
    let savedPath = "";
    const firstRequest = requests.length;
    const result = await insights(InsightsPopulation.fromSnapshot(path), {
      dimensions: ["intent"],
      summaryModel: "test/describe-dimension",
      classifierModel: "test/classify-dimension",
      embeddingModel: "test/embed-dimension",
      maxClusters: 1,
      maxSubclusters: 1,
      traceInputChars: 10000,
      runsDir: directory,
      cache: false,
      llmClient: client,
      onSaved: (value) => {
        savedPath = value;
      },
    });
    expect(result.status).toBe("completed");
    expect(result.traces).toHaveLength(8);
    expect(result.dimensions.intent?.clusters.length).toBe(2);
    expect(
      result.traces.every(
        (item) => item.assignments.intent && item.coords2d?.intent,
      ),
    ).toBe(true);
    const calls = requests
      .slice(firstRequest)
      .filter((entry) => entry.path.endsWith("/chat/completions"));
    const summaryPrompts = calls
      .map(({ body }) =>
        String((body.messages as { content?: string }[])[0]?.content ?? ""),
      )
      .filter((prompt) => prompt.includes("<conversation>"));
    expect(summaryPrompts).toHaveLength(8);
    for (let i = 0; i < 8; i++)
      expect(
        summaryPrompts.some((prompt) => prompt.includes(`fix test ${i}`)),
      ).toBe(true);
    for (const { body } of calls)
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(4096);
    expect((await loadRun(savedPath)).runId).toBe(result.runId);
    expect((await listManifests(directory))[0]?.status).toBe("completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

test("failed population leaves an error report and terminal manifest", async () => {
  const { insights } = await import("../../../src/lib/insights/pipeline.js");
  const { InsightsPopulation } = await import(
    "../../../src/lib/insights/models.js"
  );
  const { listRuns } = await import("../../../src/lib/insights/store.js");
  const { listManifests } = await import(
    "../../../src/lib/common/run-manifest.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "insights-fail-"));
  try {
    const result = await insights(
      InsightsPopulation.fromSnapshot(join(directory, "missing.json")),
      {
        dimensions: [],
        traceInputChars: 10000,
        runsDir: directory,
        cache: false,
      },
    );
    expect(result.status).toBe("error");
    expect(result.stageFailures[0]?.stage).toBe("population");
    expect(await listRuns(directory)).toHaveLength(1);
    expect((await listManifests(directory))[0]?.status).toBe("error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
