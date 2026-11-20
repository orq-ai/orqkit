import { afterAll, beforeEach, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import {
  serializedChars,
  serializedQuestionChars,
} from "../../../src/lib/common/model-input.js";
import { LLMCallConfig } from "../../../src/lib/contracts.js";
import { labelTraces } from "../../../src/lib/insights/labeling.js";
import { LabelSpec } from "../../../src/lib/insights/models.js";
import { TASK_TYPE, UNFIXED_ERROR } from "../../../src/lib/insights/presets.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";
import {
  CompiledQuerySchema,
  TraceRecord,
} from "../../../src/lib/trace-finder/models.js";

const model = "typesafe/jev-latest";
let requests: Record<string, unknown>[] = [],
  gate = true,
  fail = false,
  active = 0,
  maxActive = 0;
let held: Promise<void> | null = null;
let markEntered: (() => void) | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      markEntered?.();
      if (held) await held;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail)
        return Response.json(
          { error: { message: "bad request" } },
          { status: 400 },
        );
      const questions = body.questions as Record<
        string,
        { type: string; criteria?: Record<string, unknown> }
      >;
      const answers = Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [
          key,
          q.type === "noul"
            ? {
                type: "noul",
                noul: key === "coding_agent" && !gate ? 0.1 : 0.9,
                confidence: 0.8,
              }
            : q.type === "choice"
              ? {
                  type: "choice",
                  choice: Object.keys(q.criteria ?? {})[0],
                  confidence: 0.8,
                }
              : { type: "score", score: 1, confidence: 0.8 },
        ]),
      );
      return Response.json({
        answers,
        model,
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    } finally {
      active--;
    }
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests = [];
  gate = true;
  fail = false;
  active = 0;
  maxActive = 0;
  held = null;
  markEntered = null;
  clearModelOverrides();
  registerModel(
    model,
    new ModelInfo({
      provider: "test",
      supportsClassify: true,
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
      {
        role: "assistant",
        content: "running",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({ command: "pytest -q" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "c", content: "1 failed" },
    ],
  });
const sentiment = new LabelSpec({
  name: "custom",
  kind: "noul",
  instructions: "Good?",
});
const dimension = CompiledQuerySchema.parse({
  name: "Match",
  task: { kind: "noul", instructions: "Match?", state: {} },
  selection: { kind: "values", values: [true] },
});
const options = () => ({
  client: client(),
  model,
  cfg: new LLMCallConfig({ model, retryCount: 0 }),
  traceInputChars: 4096,
});

test("coding gate, selected labels and population match use bounded calls", async () => {
  const usage = new UsageLedger(),
    progress: number[] = [];
  const [result] = await labelTraces([trace("t")], {
    ...options(),
    labels: [sentiment],
    compiled: [dimension],
    coding: true,
    codingLabels: [TASK_TYPE, UNFIXED_ERROR],
    usage,
    onProgress: (done) => {
      progress.push(done);
    },
  });
  expect(result?.error).toBeNull();
  expect(result?.matched).toBe(true);
  expect(Object.keys(result?.answers ?? {}).sort()).toEqual([
    "coding_agent",
    "custom",
    "task_type",
    "unfixed_error",
  ]);
  expect(result?.answers.unfixed_error?.value).toBe(true);
  expect(progress).toEqual([1]);
  expect(requests).toHaveLength(3);
  expect(usage.totals().label?.calls).toBe(3);
  for (const body of requests) {
    expect(
      serializedChars(body.state) +
        serializedQuestionChars(body.questions as Record<string, unknown>),
    ).toBeLessThanOrEqual(4096);
  }
  expect(JSON.stringify(requests)).toContain("fix the test");
  expect(JSON.stringify(requests)).toContain("pytest -q");
});

test("negative coding gate leaves coding labels unasked", async () => {
  gate = false;
  const [result] = await labelTraces([trace("t")], {
    ...options(),
    labels: [sentiment],
    coding: true,
  });
  expect(Object.keys(result?.answers ?? {}).sort()).toEqual([
    "coding_agent",
    "custom",
  ]);
  expect(result?.answers.coding_agent?.value).toBe(false);
  expect(requests).toHaveLength(2);
});

test("worker concurrency and progress are bounded", async () => {
  const progress: number[] = [];
  const result = await labelTraces(
    Array.from({ length: 5 }, (_, i) => trace(String(i))),
    {
      ...options(),
      labels: [sentiment],
      parallelism: 2,
      onProgress: (done) => {
        progress.push(done);
      },
    },
  );
  expect(result.map((item) => item.trace.traceId)).toEqual([
    "0",
    "1",
    "2",
    "3",
    "4",
  ]);
  expect(maxActive).toBeLessThanOrEqual(2);
  expect(progress).toEqual([1, 2, 3, 4, 5]);
  expect(requests).toHaveLength(5);
});

test("failed labels are returned per trace and no-label runs avoid requests", async () => {
  fail = true;
  const [result] = await labelTraces([trace("t")], {
    ...options(),
    labels: [sentiment],
  });
  expect(result?.error).not.toBeNull();
  expect(result?.answers.custom?.error).not.toBeNull();
  fail = false;
  requests = [];
  const [empty] = await labelTraces([trace("t")], { ...options(), labels: [] });
  expect(empty?.error).toBeNull();
  expect(empty?.answers).toEqual({});
  expect(requests).toHaveLength(0);
});

test("cancellation stops active label requests", async () => {
  let release!: () => void;
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  markEntered = entered;
  const controller = new AbortController();
  try {
    const pending = labelTraces([trace("t")], {
      ...options(),
      labels: [sentiment],
      signal: controller.signal,
    }).then(
      () => false,
      () => true,
    );
    await started;
    controller.abort();
    expect(await pending).toBe(true);
  } finally {
    release();
    held = null;
  }
});
