import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type { FetchLike } from "../../src/lib/common/trace-input.js";
import {
  AgentResponse,
  MessageSchema,
  UsageSchema,
} from "../../src/lib/contracts.js";
import {
  SendResultsError,
  type SendResultsOptions,
  sendResultsToOrq,
  serializeResultsPayload,
  UPLOAD_TIMEOUT_MS,
} from "../../src/lib/send-results.js";
import type { EvaluatorqResult } from "../../src/lib/types.js";

let warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  log: ReturnType<typeof spyOn<typeof console, "log">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  log = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
});
function base(results?: EvaluatorqResult): SendResultsOptions {
  return {
    apiKey: "synthetic-key",
    evaluationName: "synthetic-upload",
    startTime: new Date("2026-11-10T00:00:00Z"),
    endTime: new Date("2026-11-10T00:01:00Z"),
    baseUrl: "https://upload.test",
    results: results ?? [
      {
        dataPoint: { inputs: { prompt: "synthetic" } },
        jobResults: [
          {
            jobName: "target",
            output: null,
            evaluatorScores: [
              {
                evaluatorName: "judge",
                score: {
                  value: null,
                  pass: null,
                  tokenUsage: UsageSchema.parse({ inputTokens: 999 }),
                  rawOutput: { private_local_context: "omit" },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
const response = (rows = 1) =>
  Response.json({
    sheet_id: "sheet",
    manifest_id: "manifest",
    experiment_name: "synthetic-upload",
    rows_created: rows,
    experiment_url: "https://upload.test/experiment",
  });
it("preserves nullable wire fields and strips local judge usage/raw metadata without mutating the local score", () => {
  const options = base(),
    payload = serializeResultsPayload(options),
    job = payload.results[0]?.jobResults?.[0],
    score = job?.evaluatorScores?.[0]?.score;
  expect(job?.output).toBeNull();
  expect(job?.error).toBe("");
  expect(score).toEqual({ value: null, explanation: "" });
  expect(job?.evaluatorScores?.[0]?.error).toBe("");
  expect(JSON.stringify(payload)).not.toContain("private_local_context");
  expect(
    options.results[0]?.jobResults?.[0]?.evaluatorScores?.[0]?.score.rawOutput,
  ).toEqual({ private_local_context: "omit" });
  expect(payload._evaluationDuration).toBe(60000);
});
it("sends AgentResponse and recorded message arrays as structured outputs, preserving wire tool ids", () => {
  const agent = AgentResponse.fromJSON({
    text: "mango",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  const messages = [
    MessageSchema.parse({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call", function: { name: "lookup", arguments: "{}" } },
      ],
    }),
    MessageSchema.parse({
      role: "tool",
      tool_call_id: "call",
      content: "found",
    }),
  ];
  const results: EvaluatorqResult = [
    {
      dataPoint: { inputs: { recordedOutput: messages } },
      jobResults: [
        { jobName: "agent", output: agent },
        { jobName: "messages", output: messages },
        { jobName: "record", output: { text: "plain record" } },
        { jobName: "responses", output: { object: "response", output: [] } },
      ],
    },
  ];
  const payload = JSON.parse(
    JSON.stringify(serializeResultsPayload(base(results))),
  );
  expect(payload.results[0].jobResults[0].output.output[0].text).toBe("mango");
  expect(payload.results[0].jobResults[1].output[1].tool_call_id).toBe("call");
  expect(payload.results[0].jobResults[2].output).toBe(
    '{"text":"plain record"}',
  );
  expect(payload.results[0].jobResults[3].output.object).toBe("response");
  expect(payload.results[0].dataPoint.inputs.recordedOutput).toHaveLength(2);
});
it("returns the full upload diagnostics and warns when the server creates fewer rows", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return response(0);
  };
  const result = await sendResultsToOrq({ ...base(), fetch });
  expect(result?.rows_created).toBe(0);
  expect(result?.experiment_url).toBe("https://upload.test/experiment");
  expect(warn.mock.calls.some((call) => String(call[0]).includes("0/1"))).toBe(
    true,
  );
  expect(requests[0]?.url).toBe(
    "https://upload.test/v2/spreadsheets/evaluations/receive",
  );
  expect(requests[0]?.init.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer synthetic-key",
  });
});
it("never retries a 5xx that might have created the experiment", async () => {
  let calls = 0;
  const result = await sendResultsToOrq({
    ...base(),
    fetch: async () => {
      calls++;
      return new Response("server failed after accepting", { status: 503 });
    },
  });
  expect(result).toBeNull();
  expect(calls).toBe(1);
  await expect(
    sendResultsToOrq({
      ...base(),
      raiseOnError: true,
      fetch: async () => new Response("bad", { status: 500 }),
    }),
  ).rejects.toBeInstanceOf(SendResultsError);
});
it("limits rejected 429 uploads to three attempts without changing their payload", async () => {
  const bodies: unknown[] = [];
  const result = await sendResultsToOrq({
    ...base(),
    fetch: async (_url, init) => {
      bodies.push(init.body);
      return new Response("rate limit", { status: 429 });
    },
  });
  expect(result).toBeNull();
  expect(bodies).toHaveLength(3);
  expect(new Set(bodies).size).toBe(1);
}, 15_000);
it("aborts the fixed read deadline and never repeats a timed-out upload", async () => {
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) =>
    original(
      handler,
      timeout === UPLOAD_TIMEOUT_MS ? 5 : timeout,
      ...args,
    )) as typeof setTimeout);
  let calls = 0,
    aborted = false;
  try {
    const result = await sendResultsToOrq({
      ...base(),
      fetch: async (_url, init) => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.error(new Error("read timed out"));
                },
                { once: true },
              );
            },
          }),
        );
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("may still finish"),
      ),
    ).toBe(true);
  } finally {
    timer.mockRestore();
  }
});
it("propagates caller cancellation before sending anything", async () => {
  const controller = new AbortController();
  controller.abort(
    Object.assign(new Error("cancelled"), { name: "AbortError" }),
  );
  let calls = 0;
  await expect(
    sendResultsToOrq({
      ...base(),
      signal: controller.signal,
      fetch: async () => {
        calls++;
        return response();
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});
