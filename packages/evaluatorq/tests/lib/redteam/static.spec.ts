import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OpenAI from "openai";

import { Orq } from "@orq-ai/node";

import * as judgeModule from "../../../src/lib/common/judge.js";
import {
  EvaluatorResponsePayload,
  type JudgeOutcome,
} from "../../../src/lib/common/judge.js";
import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import {
  hasMeaningfulOutput,
  outputToMessages,
} from "../../../src/lib/common/output-adapters.js";
import {
  currentThreadId,
  evaluatorqPipeline,
  evaluatorqRunId,
} from "../../../src/lib/common/thread-context.js";
import type { FetchLike } from "../../../src/lib/common/trace-input.js";
import {
  AgentResponse,
  AgentTarget,
  LLMCallConfig,
  type Message,
  parseJuryResult,
  parseUsage,
} from "../../../src/lib/contracts.js";
import {
  buildStaticMessages,
  createDeploymentJob,
  createOwaspEvaluator,
  createStaticJobForAgentTarget,
  extractStaticPrompt,
  LLMConfig,
  loadOwaspAgenticDataset,
  parseHfSource,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/static-python-goldens.json" with {
  type: "json",
};

let warnings: ReturnType<typeof spyOn<typeof console, "warn">>,
  errorLog: ReturnType<typeof spyOn<typeof console, "error">>,
  oldTracing: string | undefined;
beforeEach(() => {
  oldTracing = process.env.ORQ_DISABLE_TRACING;
  process.env.ORQ_DISABLE_TRACING = "1";
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnings.mockRestore();
  errorLog.mockRestore();
  clearModelOverrides();
  if (oldTracing === undefined) delete process.env.ORQ_DISABLE_TRACING;
  else process.env.ORQ_DISABLE_TRACING = oldTracing;
});
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function expectedScore(value: unknown): unknown {
  const raw = structuredClone(value) as Record<string, unknown>;
  raw.pass = raw.pass_ ?? null;
  delete raw.pass_;
  const metadata = raw.rawOutput as Record<string, unknown> | null;
  if (metadata?.jury) metadata.jury = parseJuryResult(metadata.jury);
  if (metadata?.evaluation_error) {
    const aliases = (value: unknown) =>
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
          value,
        ]),
      );
    const error = aliases(metadata.evaluation_error);
    if (error.details) error.details = aliases(error.details);
    metadata.evaluation_error = error;
  }
  if (typeof raw.explanation === "string")
    raw.explanation = raw.explanation.replace(/^\[TIE - /, "[TIE: ");
  if (metadata && typeof metadata.explanation === "string")
    metadata.explanation = metadata.explanation.replace(/^\[TIE - /, "[TIE: ");
  return plain(raw);
}
for (const [index, fixture] of goldens.prompts.entries())
  it(`matches pinned static prompt flattening ${index}`, () => {
    const data = { inputs: { messages: fixture.messages } };
    expect(buildStaticMessages(data)).toEqual(fixture.normalized);
    expect(extractStaticPrompt(data)).toBe(fixture.prompt);
  });
for (const fixture of goldens.hf)
  it(`matches pinned hf source parsing ${fixture.value}`, () => {
    if ("error" in fixture)
      expect(() => parseHfSource(fixture.value)).toThrow();
    else
      expect(parseHfSource(fixture.value)).toEqual(
        fixture.expected as [string, string],
      );
  });
for (const fixture of goldens.jobs)
  it(`matches pinned static target job ${fixture.label}`, async () => {
    let created = 0,
      closed = 0;
    const calls: Message[][] = [],
      threads: (string | null)[] = [];
    class Target extends AgentTarget {
      override async respond(messages: Message[]) {
        calls.push(structuredClone(messages));
        threads.push(currentThreadId());
        return AgentResponse.fromJSON(fixture.response);
      }
      override newInstance() {
        return new Target();
      }
      async close() {
        closed++;
      }
    }
    const run = createStaticJobForAgentTarget(
      () => {
        created++;
        return new Target();
      },
      "agent/key",
      { pipelineConfig: new LLMConfig({ maxTargetRetries: 0 }), runId: "run" },
    );
    if ("error" in fixture)
      await expect(run({ inputs: fixture.inputs }, 2)).rejects.toThrow(
        "empty prompt",
      );
    else {
      const actual = await run({ inputs: fixture.inputs }, 2),
        expected = structuredClone(fixture.expected);
      const details = expected.output.errorDetails as Record<
        string,
        unknown
      > | null;
      if (details)
        for (const key of ["raw_message", "response_error_type"]) {
          const camel = key.replace(/_([a-z])/g, (_, c: string) =>
            c.toUpperCase(),
          );
          details[camel] = details[key];
          delete details[key];
        }
      expect(plain(actual)).toEqual(expected);
      expect(plain(calls)).toEqual(fixture.calls);
      expect(threads).toEqual(["run:agent-key:2"]);
    }
    expect(created).toBe(fixture.created);
    expect(closed).toBe(fixture.closed);
  });
for (const fixture of goldens.filters)
  it(`filters saved static datasets before cap: ${JSON.stringify([fixture.categories, fixture.deliveryMethods, fixture.numSamples])}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "res1863-static-")),
      path = join(dir, "dataset.json");
    try {
      await writeFile(path, JSON.stringify({ samples: goldens.samples }));
      const data = await loadOwaspAgenticDataset(path, fixture);
      expect(plain(data)).toEqual(fixture.expected);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
for (const fixture of goldens.scorers)
  it(`matches pinned static single scorer ${fixture.label}`, async () => {
    const outcome = fixture.outcome;
    const runJudge = spyOn(judgeModule, "runJudge").mockResolvedValue({
      ...outcome,
      rawOutput: null,
      errorExc: null,
      payload:
        outcome.payload === null
          ? null
          : new EvaluatorResponsePayload(outcome.payload),
      tokenUsage: parseUsage(outcome.tokenUsage),
      errorKind: outcome.errorKind as JudgeOutcome["errorKind"],
      endpoint: outcome.endpoint as JudgeOutcome["endpoint"],
    });
    try {
      const scorer = createOwaspEvaluator({
        evaluatorModel: "judge",
        llmClient: {} as OpenAI,
        cfg: new LLMCallConfig({
          model: "judge",
          api: "chat_completions",
          timeoutMs: 5,
          retryCount: 0,
        }),
      });
      const raw = fixture as typeof fixture & {
        category?: string;
        output?: Record<string, unknown>;
      };
      const score = await scorer.scorer({
        data: {
          inputs: {
            category: raw.category ?? "ASI01",
            messages: [{ role: "user", content: "attack" }],
          },
        },
        output: raw.output ?? { response: "mango", tool_calls: [] },
      });
      expect(plain(score)).toEqual(expectedScore(fixture.expected));
      const calls = runJudge.mock.calls.map(([options]) => ({
        model: options.model,
        prompt: options.promptTemplate,
        replacements: options.replacements,
      }));
      expect(calls).toEqual(fixture.calls);
      expect(scorer.evaluatorType).toBe("llm_eval");
    } finally {
      runJudge.mockRestore();
    }
  });
for (const fixture of goldens.panels)
  it(`matches pinned static panel scorer ${fixture.label}`, async () => {
    const pending: Record<string, (boolean | string)[] | undefined> =
      structuredClone(fixture.results);
    const runJudge = spyOn(judgeModule, "runJudge").mockImplementation(
      async ({ model }) => {
        const value = pending[model]?.shift(),
          error = typeof value === "string";
        const payload = error
          ? null
          : new EvaluatorResponsePayload({
              explanation: "Synthetic verdict",
              value,
              abstain: false,
            });
        return {
          payload,
          tokenUsage: parseUsage({
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
            calls: 1,
            total_cost: 0.01,
            priced_calls: 1,
          }),
          rawContent:
            payload === null
              ? ""
              : JSON.stringify({
                  explanation: payload.explanation,
                  abstain: payload.abstain,
                  value: payload.value,
                }),
          errorKind: error ? (value as JudgeOutcome["errorKind"]) : null,
          errorMessage: error ? `synthetic ${value}` : null,
          timeoutMs: null,
          rawOutput: null,
          errorExc: null,
          endpoint: error ? null : "chat",
        };
      },
    );
    try {
      const scorer = createOwaspEvaluator({
        evaluatorModel: "judge",
        llmClient: {} as OpenAI,
        cfg: new LLMCallConfig({
          model: "judge",
          api: "chat_completions",
          timeoutMs: 5,
          retryCount: 0,
        }),
        judges: fixture.judges,
        judgeRepetitions: fixture.repetitions,
        replacementJudges: fixture.replacements,
        minSuccessfulJudges: fixture.quorum,
      });
      const score = await scorer.scorer({
        data: {
          inputs: {
            category: "ASI01",
            messages: [{ role: "user", content: "attack" }],
          },
        },
        output: "mango",
      });
      expect(plain(score)).toEqual(expectedScore(fixture.expected));
      expect(runJudge.mock.calls.map(([options]) => options.model)).toEqual(
        fixture.calls,
      );
    } finally {
      runJudge.mockRestore();
    }
  });
it("downloads the selected hf JSON without cutting its samples before filtering", async () => {
  const requests: string[] = [];
  const data = await loadOwaspAgenticDataset("hf:org/repo/sub/file.json", {
    categories: ["LLM01"],
    numSamples: 1,
    fetch: (async (url) => {
      requests.push(String(url));
      return Response.json({ samples: goldens.samples });
    }) as FetchLike,
  });
  expect(requests).toEqual([
    "https://huggingface.co/datasets/org/repo/resolve/main/sub/file.json",
  ]);
  expect(data[0]?.inputs.category).toBe("LLM01");
});
it("rejects malformed files and download failures with dataset errors", async () => {
  await expect(
    loadOwaspAgenticDataset("hf:org/repo", {
      fetch: (async () => new Response("denied", { status: 403 })) as FetchLike,
    }),
  ).rejects.toThrow("HTTP 403");
  await expect(
    loadOwaspAgenticDataset("hf:org/repo", {
      fetch: (async () => Response.json({ samples: [] })) as FetchLike,
    }),
  ).rejects.toThrow("samples");
  await expect(loadOwaspAgenticDataset("orq:")).rejects.toThrow(
    "provide a dataset ID",
  );
});
it("loads every platform page, skips invalid rows and keeps custom inputs", async () => {
  const calls: unknown[] = [],
    first = goldens.samples[0];
  if (!first) throw new Error("Missing fixture");
  const sdk = {
    datasets: {
      listDatapoints: async (request: unknown) => {
        calls.push(request);
        return calls.length === 1
          ? {
              data: [
                { id: "bad", inputs: { id: "bad" } },
                {
                  id: "one",
                  inputs: {
                    ...first.input,
                    messages: first.messages,
                    custom_key: 1,
                  },
                },
              ],
              hasMore: true,
            }
          : {
              data: [
                {
                  id: "two",
                  inputs: { ...first.input, messages: first.messages },
                },
              ],
              hasMore: false,
            };
      },
    },
  } as unknown as Orq;
  const data = await loadOwaspAgenticDataset("orq:dataset", { orqClient: sdk });
  expect(data).toHaveLength(2);
  expect(data[0]?.inputs.custom_key).toBe(1);
  expect(calls).toEqual([
    { datasetId: "dataset", limit: 100, startingAfter: undefined },
    { datasetId: "dataset", limit: 100, startingAfter: "one" },
  ]);
});
it("refuses repeated or empty platform cursors instead of returning a partial import", async () => {
  for (const data of [[], [{ id: "repeat", inputs: {} }]]) {
    const sdk = {
      datasets: { listDatapoints: async () => ({ data, hasMore: true }) },
    } as unknown as Orq;
    await expect(
      loadOwaspAgenticDataset("orq:dataset", { orqClient: sdk }),
    ).rejects.toThrow("refusing a partial import");
  }
});
it("preserves canonical tool output evidence without requiring text", () => {
  const output = {
    response: "",
    toolCalls: [
      {
        type: "function_call" as const,
        id: "fc",
        call_id: "call",
        name: "lookup",
        arguments: "{}",
        status: "completed" as const,
        result: null,
      },
    ],
  };
  expect(hasMeaningfulOutput(output)).toBe(true);
  expect(outputToMessages(output)).toEqual(output.toolCalls);
});
it("uses actual deployment SDK wire names, metadata and one retry owner", async () => {
  const requests: { body: Record<string, unknown>; path: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ body, path: new URL(request.url).pathname });
      return Response.json({
        id: "completion",
        created: "2026-11-10T12:30:00Z",
        object: "chat",
        telemetry: { trace_id: "trace", span_id: "span" },
        model: "served",
        provider: "openai",
        is_final: true,
        choices: [
          {
            index: 0,
            message: { type: "content", role: "assistant", content: "mango" },
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          total_cost: 0.01,
        },
      });
    },
  });
  try {
    const sdk = new Orq({
      apiKey: "synthetic-key",
      serverURL: server.url.toString(),
      retryConfig: {
        strategy: "backoff",
        backoff: {
          initialInterval: 1,
          maxInterval: 1,
          exponent: 1,
          maxElapsedTime: 100,
        },
      },
    });
    const run = createDeploymentJob("echo", {
      orqClient: sdk,
      pipelineConfig: new LLMConfig({ maxTargetRetries: 0 }),
      runId: "run",
    });
    const actual = await evaluatorqPipeline("redteam", () =>
      evaluatorqRunId("run", () =>
        run(
          {
            inputs: {
              category: "ASI01",
              messages: [
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call",
                      type: "function",
                      function: { name: "lookup", arguments: "{}" },
                    },
                  ],
                },
                { role: "tool", tool_call_id: "call", content: "found" },
                { role: "user", content: "Reply mango" },
              ],
            },
          },
          2,
        ),
      ),
    );
    expect((actual.output as Record<string, unknown>).response).toBe("mango");
    expect((actual.output as Record<string, unknown>).threadId).toBe(
      "run:echo:2",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toContain("deployments");
    expect(requests[0]?.body.thread).toEqual({ id: "run:echo:2" });
    expect(requests[0]?.body.metadata).toEqual({
      evaluatorq_pipeline: "redteam",
      evaluatorq_run_id: "run",
    });
    expect(requests[0]?.body.messages).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "call" }] },
      { role: "tool", tool_call_id: "call" },
      { role: "user", content: "Reply mango" },
    ]);
  } finally {
    server.stop(true);
  }
});
it("uses shared retry limits despite a retrying SDK and propagates cancellation to its request", async () => {
  let calls = 0,
    aborted = false;
  const sdk = {
    deployments: {
      invoke: async (
        _body: unknown,
        options: { retries: unknown; signal: AbortSignal },
      ) => {
        calls++;
        expect(options.retries).toEqual({ strategy: "none" });
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          ),
        );
      },
    },
  } as unknown as Orq;
  const run = createDeploymentJob("echo", {
    orqClient: sdk,
    pipelineConfig: new LLMConfig({
      targetAgentTimeoutMs: 5,
      maxTargetRetries: 0,
    }),
  });
  await expect(
    run({ inputs: { messages: [{ role: "user", content: "hello" }] } }, 0),
  ).rejects.toThrow("timed out");
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
});

it("prices deployment usage against the served model rather than its key alias", async () => {
  registerModel(
    "served",
    new ModelInfo({
      inputCostPer1k: 0.1,
      outputCostPer1k: 0.2,
      provider: "test",
      supportsResponses: false,
    }),
  );
  const sdk = {
    deployments: {
      invoke: async () => ({
        model: "served",
        choices: [{ message: { content: "mango" } }],
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      }),
    },
  } as unknown as Orq;
  const result = await createDeploymentJob("key-alias", { orqClient: sdk })(
    { inputs: { messages: [{ role: "user", content: "hi" }] } },
    0,
  );
  const usage = (result.output as Record<string, unknown>).tokenUsage as {
    totalCost: number;
    pricedCalls: number;
  };
  expect(usage.totalCost).toBeCloseTo((3 / 1000) * 0.1 + (2 / 1000) * 0.2, 14);
  expect(usage.pricedCalls).toBe(1);
});

it("does not multiply real SDK retries with the shared deployment retry budget", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      calls++;
      return Response.json({ message: "temporary failure" }, { status: 503 });
    },
  });
  try {
    const sdk = new Orq({
      apiKey: "synthetic-key",
      serverURL: server.url.toString(),
      retryConfig: {
        strategy: "backoff",
        backoff: {
          initialInterval: 1,
          maxInterval: 1,
          exponent: 1,
          maxElapsedTime: 500,
        },
      },
    });
    const run = createDeploymentJob("echo", {
      orqClient: sdk,
      pipelineConfig: new LLMConfig({ maxTargetRetries: 1 }),
    });
    await expect(
      run({ inputs: { messages: [{ role: "user", content: "hi" }] } }, 0),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
  }
});
