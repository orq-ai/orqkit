import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
  resetCatalogueCache,
} from "../../../src/lib/common/model-catalogue.js";
import {
  buildClassifierEvaluator,
  buildDatapoint,
  classifierQuestions,
  parseDatapointResult,
  runClassifier,
} from "../../../src/lib/trace-finder/classifier.js";
import { dimensionToDomain } from "../../../src/lib/trace-finder/compiler.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";
import { projectTraceWithCap } from "../../../src/lib/trace-finder/projection.js";

const model = "acme/trace-classifier";
let requests: Record<string, unknown>[] = [],
  omit = false;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json([]);
    requests.push((await request.json()) as Record<string, unknown>);
    const answers: Record<string, unknown> = {
      d0: {
        type: "noul",
        noul: 0.8,
        confidence: 0.9,
        probabilities: { true: 0.8, false: 0.2 },
      },
    };
    if (!omit)
      answers.d1 = {
        type: "choice",
        choice: "yes",
        confidence: 0.7,
        probabilities: { yes: 0.7, no: 0.3 },
      };
    return Response.json({
      answers,
      model,
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  },
});
afterAll(() => server.stop(true));
let warning: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>;
beforeEach(() => {
  requests = [];
  omit = false;
  resetCatalogueCache();
  clearModelOverrides();
  registerModel(
    model,
    new ModelInfo({
      provider: "acme",
      supportsClassify: true,
      supportsResponses: false,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    }),
  );
  warning = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warning.mockRestore();
  error.mockRestore();
  clearModelOverrides();
});
const client = () =>
  new OpenAI({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });
const dimensions = ["noul", "choice"].map((kind) =>
  dimensionToDomain({
    name: kind,
    task: {
      kind,
      instructions: "Judge",
      choice_criteria:
        kind === "choice"
          ? [
              { label: "yes", description: "yes" },
              { label: "no", description: "no" },
            ]
          : null,
      score_criteria: null,
      noul_threshold: 0.5,
    },
    selection: { kind: "values", values: kind === "choice" ? ["yes"] : [true] },
  }),
);
const source = () =>
  new TraceRecord({
    schemaVersion: 1,
    traceId: "t",
    spanId: "s",
    timestamp: "2026-11-10T00:00:00Z",
    project: "p",
    model: "m",
    provider: "p",
    status: "ok",
    product: "agents",
    traceType: "agent",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ],
  });
test("one classify request returns every dimension and bills shared usage once", async () => {
  const trace = source(),
    projection = projectTraceWithCap(trace, {
      traceInputChars: 4096,
      questionPayloads: classifierQuestions(dimensions),
    }),
    data = buildDatapoint(trace, projection),
    evaluator = await buildClassifierEvaluator(dimensions, {
      model,
      client: client(),
      globalCharCap: 4096,
    }),
    score = await evaluator.scorer({ data, output: "ignored" });
  expect(score.value).toEqual({ d0: true, d1: "yes" });
  expect(score.tokenUsage?.totalTokens).toBe(18);
  expect(score.tokenUsage?.calls).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.questions).toHaveProperty("d0");
  expect(requests[0]?.questions).toHaveProperty("d1");
  expect(data.inputs.messages).toEqual([
    { role: "assistant", content: "classifier state prepared" },
  ]);
  const parsed = parseDatapointResult(
    {
      dataPoint: data,
      jobResults: [
        {
          jobName: "recorded",
          output: "prepared",
          evaluatorScores: [{ evaluatorName: evaluator.name, score }],
        },
      ],
    },
    dimensions,
  );
  expect(parsed.matched).toBe(true);
  expect(parsed.answers.map((answer) => answer.value)).toEqual([true, "yes"]);
  expect(parsed.answers.map((answer) => answer.confidence)).toEqual([0.9, 0.7]);
  expect(parsed.error).toBeNull();
});
test("missing classifier answers keep the successful dimension and fail the trace", async () => {
  omit = true;
  const trace = source(),
    data = buildDatapoint(
      trace,
      projectTraceWithCap(trace, { traceInputChars: 4096 }),
    ),
    evaluator = await buildClassifierEvaluator(dimensions, {
      model,
      client: client(),
      globalCharCap: 4096,
    }),
    score = await evaluator.scorer({ data, output: null }),
    parsed = parseDatapointResult(
      {
        dataPoint: data,
        jobResults: [
          {
            jobName: "recorded",
            output: "prepared",
            evaluatorScores: [{ evaluatorName: evaluator.name, score }],
          },
        ],
      },
      dimensions,
    );
  expect(requests).toHaveLength(1);
  expect(parsed.matched).toBe(false);
  expect(parsed.answers[0]?.matched).toBe(true);
  expect(parsed.answers[1]?.error).toBeTruthy();
  expect(parsed.error).toContain("choice:");
  expect(score.tokenUsage?.totalTokens).toBe(18);
});
test("empty dimensions produce no requests and do not invent usage", async () => {
  const trace = source(),
    data = buildDatapoint(
      trace,
      projectTraceWithCap(trace, { traceInputChars: 4096 }),
    ),
    evaluator = await buildClassifierEvaluator([], {
      model,
      client: client(),
      globalCharCap: 4096,
    }),
    score = await evaluator.scorer({ data, output: null });
  expect(score.value).toEqual({});
  expect(score.tokenUsage).toBeNull();
  expect(requests).toHaveLength(0);
});
test("classifier runner forwards each trace exactly once through the shared engine", async () => {
  const traces = Array.from(
      { length: 4 },
      (_, index) => new TraceRecord({ ...source(), traceId: `t${index}` }),
    ),
    projections = Object.fromEntries(
      traces.map((trace) => [
        trace.traceId,
        projectTraceWithCap(trace, { traceInputChars: 4096 }),
      ]),
    ),
    completed: string[] = [];
  const classifications = await runClassifier(traces, projections, dimensions, {
    model,
    client: client(),
    parallelism: 2,
    traceInputChars: 4096,
    onComplete: async (result) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed.push(result.traceId);
    },
  });
  expect(classifications).toHaveLength(4);
  expect(classifications.every((result) => result.matched)).toBe(true);
  expect(completed.sort()).toEqual(["t0", "t1", "t2", "t3"]);
  expect(requests).toHaveLength(4);
});
test("classifier runner applies a filter-only plan without projections or model calls", async () => {
  const traces = [source(), new TraceRecord({ ...source(), traceId: "u" })],
    completed: string[] = [];
  const results = await runClassifier(traces, {}, [], {
    model,
    client: client(),
    parallelism: 2,
    onComplete: async (result) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed.push(result.traceId);
    },
  });
  expect(completed).toEqual(["t", "u"]);
  expect(
    results.every((result) => result.matched && result.answers.length === 0),
  ).toBe(true);
  expect(requests).toHaveLength(0);
});
test("classifier runner propagates completion failure and rejects missing projections", async () => {
  const trace = source();
  await expect(
    runClassifier([trace], {}, dimensions, {
      model,
      client: client(),
      parallelism: 1,
      traceInputChars: 4096,
      onComplete: () => {},
    }),
  ).rejects.toThrow("Missing trace projection");
  expect(requests).toHaveLength(0);
  await expect(
    runClassifier(
      [trace],
      { t: projectTraceWithCap(trace, { traceInputChars: 4096 }) },
      dimensions,
      {
        model,
        client: client(),
        parallelism: 1,
        traceInputChars: 4096,
        onComplete: () => {
          throw new Error("classification completion failed");
        },
      },
    ),
  ).rejects.toThrow("classification completion failed");
  expect(requests).toHaveLength(1);
});

test("classifier cancellation aborts the active model request and settles", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let observed = false;
  const fakeFetch: NonNullable<
    NonNullable<ConstructorParameters<typeof OpenAI>[0]>["fetch"]
  > = async (_url, init) =>
    new Promise((_resolve, reject) => {
      entered();
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing request signal"));
        return;
      }
      const abort = () => {
        observed = true;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  const openai = new OpenAI({
    apiKey: "synthetic",
    baseURL: "http://localhost/v3/router",
    maxRetries: 0,
    fetch: fakeFetch,
  });
  const trace = source(),
    controller = new AbortController();
  let completed = 0;
  const work = runClassifier(
    [trace],
    { t: projectTraceWithCap(trace, { traceInputChars: 4096 }) },
    dimensions,
    {
      model,
      client: openai,
      parallelism: 1,
      traceInputChars: 4096,
      signal: controller.signal,
      onComplete: () => {
        completed++;
      },
    },
  ).then(
    () => null,
    (error) => error,
  );
  await started;
  controller.abort();
  expect(await work).not.toBeNull();
  expect(observed).toBe(true);
  expect(completed).toBe(0);
});

test("filter-only classification stops when its callback cancels the run", async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  const traces = [source(), new TraceRecord({ ...source(), traceId: "u" })];
  await expect(
    runClassifier(traces, {}, [], {
      model,
      client: client(),
      parallelism: 1,
      signal: controller.signal,
      onComplete: (result) => {
        seen.push(result.traceId);
        controller.abort();
      },
    }),
  ).rejects.toBeDefined();
  expect(seen).toEqual(["t"]);
  expect(requests).toHaveLength(0);
});
