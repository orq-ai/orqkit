import { afterAll, beforeEach, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import { InsightsCache } from "../../../src/lib/insights/cache.js";
import {
  buildSummaryPromptWithCoverage,
  summarizeTraces,
} from "../../../src/lib/insights/summarize.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const model = "test/summary";
let requests: Record<string, unknown>[] = [],
  invalid = false,
  active = 0,
  maxActive = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const text = invalid
        ? "not valid json"
        : JSON.stringify({
            summary: "Fixed test",
            request: "Fix test",
            task: "Fix test",
            topic: "Tests",
            assistant_errors: [],
            sentiment_explanation: "Neutral",
            languages: ["English"],
          });
      return Response.json({
        id: "c",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: text },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      });
    } finally {
      active--;
    }
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests = [];
  invalid = false;
  active = 0;
  maxActive = 0;
  clearModelOverrides();
  registerModel(
    model,
    new ModelInfo({
      provider: "test",
      supportsClassify: false,
      supportsResponses: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    }),
  );
});
const client = () =>
  new OpenAI({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });
const trace = (id: string) =>
  new TraceRecord({
    schemaVersion: 1,
    traceId: id,
    spanId: "s",
    timestamp: "2026-11-10T00:00:00Z",
    project: "p",
    model: "m",
    provider: "p",
    status: "ok",
    product: "agents",
    traceType: "agent",
    messages: [
      { role: "user", content: "fix the test" },
      { role: "assistant", content: "fixed" },
    ],
  });

test("summary calls stay bounded, count usage and reuse cache", async () => {
  const cache = await InsightsCache.open({ path: ":memory:" });
  try {
    const traces = [trace("a"), trace("b"), trace("c")],
      usage = new UsageLedger(),
      progress: number[] = [];
    const result = await summarizeTraces(traces, {
      client: client(),
      model,
      cache,
      parallelism: 2,
      inputCharCap: 4096,
      usage,
      onProgress: (done) => {
        progress.push(done);
      },
    });
    expect(Object.keys(result).sort()).toEqual(["a", "b", "c"]);
    expect(result.a).toMatchObject({
      summary: "Fixed test",
      assistantErrors: [],
      sentimentExplanation: "Neutral",
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(progress).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(3);
    expect(usage.totals().summary?.calls).toBe(3);
    for (const body of requests) {
      const messages = body.messages as { content: string }[];
      expect(messages[0]?.content).toContain("fix the test");
      expect(Array.from(messages[0]?.content ?? "").length).toBeLessThanOrEqual(
        4096,
      );
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(4096);
    }
    expect(
      buildSummaryPromptWithCoverage(traces[0] as TraceRecord, 4096)[1],
    ).toBe(false);
    await summarizeTraces(traces, {
      client: client(),
      model,
      cache,
      inputCharCap: 4096,
      usage,
    });
    expect(requests).toHaveLength(3);
    expect(usage.totals().summary?.calls).toBe(3);
  } finally {
    cache.close();
  }
});

test("unparseable summaries fail per trace without caching", async () => {
  const cache = await InsightsCache.open({ path: ":memory:" });
  try {
    invalid = true;
    const result = await summarizeTraces([trace("a")], {
      client: client(),
      model,
      cache,
      inputCharCap: 4096,
    });
    expect(
      typeof result.a === "string" && result.a.startsWith("summary:"),
    ).toBe(true);
    const failedCalls = requests.length;
    expect(failedCalls).toBeGreaterThan(0);
    invalid = false;
    const retried = await summarizeTraces([trace("a")], {
      client: client(),
      model,
      cache,
      inputCharCap: 4096,
    });
    expect(retried.a).toMatchObject({ summary: "Fixed test" });
    expect(requests.length).toBeGreaterThan(failedCalls);
  } finally {
    cache.close();
  }
});

test("duplicate trace IDs are rejected before model calls", async () => {
  const cache = await InsightsCache.open({ enabled: false });
  try {
    await expect(
      summarizeTraces([trace("a"), trace("a")], {
        client: client(),
        model,
        cache,
        inputCharCap: 4096,
      }),
    ).rejects.toThrow("trace_id values must be unique");
    expect(requests).toHaveLength(0);
  } finally {
    cache.close();
  }
});
