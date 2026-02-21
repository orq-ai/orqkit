import { describe, expect, mock, test } from "bun:test";

import { Effect } from "effect";

import { sendResultsToOrqEffect } from "../../src/lib/send-results.js";
import type { EvaluatorqResult, Output } from "../../src/lib/types.js";

describe("sendResultsToOrqEffect serialization", () => {
  const apiKey = "test-key";
  const evalName = "test-eval";
  const startTime = new Date("2025-01-01T00:00:00Z");
  const endTime = new Date("2025-01-01T00:01:00Z");

  function buildResults(
    scoreValue:
      | number
      | boolean
      | string
      | Record<string, unknown>
      | { type: string; value: Record<string, unknown> },
    error?: Error,
    output: Output = "result",
  ): EvaluatorqResult {
    return [
      {
        dataPoint: { inputs: { text: "hello" } },
        jobResults: [
          {
            jobName: "job1",
            output,
            evaluatorScores: [
              {
                evaluatorName: "eval1",
                score: { value: scoreValue, explanation: "test" },
                error,
              },
            ],
          },
        ],
      },
    ];
  }

  function capturePayload(
    results: EvaluatorqResult,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(init?.body as string);
          resolve(body);
          return new Response(
            JSON.stringify({
              sheet_id: "s1",
              manifest_id: "m1",
              experiment_name: "test",
              rows_created: 1,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      ) as unknown as typeof fetch;

      Effect.runPromise(
        sendResultsToOrqEffect(
          apiKey,
          evalName,
          undefined,
          undefined,
          results,
          startTime,
          endTime,
        ),
      ).finally(() => {
        globalThis.fetch = originalFetch;
      });
    });
  }

  // Extract the first evaluator score entry from a captured payload
  function extractFirstEvalScore(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const results = payload.results as Array<Record<string, unknown>>;
    const jobResults = results[0].jobResults as Array<Record<string, unknown>>;
    const evalScores = jobResults[0].evaluatorScores as Array<
      Record<string, unknown>
    >;
    return evalScores[0];
  }

  test("serializes number score value as-is", async () => {
    const payload = await capturePayload(buildResults(0.85));
    const score = extractFirstEvalScore(payload).score as Record<
      string,
      unknown
    >;
    expect(score.value).toBe(0.85);
  });

  test("serializes boolean score value as-is", async () => {
    const payload = await capturePayload(buildResults(true));
    const score = extractFirstEvalScore(payload).score as Record<
      string,
      unknown
    >;
    expect(score.value).toBe(true);
  });

  test("serializes string score value as-is", async () => {
    const payload = await capturePayload(buildResults("good"));
    const score = extractFirstEvalScore(payload).score as Record<
      string,
      unknown
    >;
    expect(score.value).toBe("good");
  });

  test("serializes EvaluationResultCell value correctly", async () => {
    const cell = {
      type: "bert_score",
      value: { precision: 0.9, recall: 0.8, f1: 0.85 },
    };
    const payload = await capturePayload(buildResults(cell));
    const score = extractFirstEvalScore(payload).score as Record<
      string,
      unknown
    >;
    expect(score.value).toEqual(cell);
  });

  test("serializes arbitrary object score values as JSON strings", async () => {
    const payload = await capturePayload(
      buildResults({ reason: "too long", tokens: 120 }),
    );
    const score = extractFirstEvalScore(payload).score as Record<
      string,
      unknown
    >;
    expect(score.value).toBe('{"reason":"too long","tokens":120}');
  });

  test("serializes object job outputs as JSON strings", async () => {
    const payload = await capturePayload(
      buildResults(0.9, undefined, { answer: "hello", confidence: 0.9 }),
    );
    const results = payload.results as Array<Record<string, unknown>>;
    const jobResults = results[0].jobResults as Array<Record<string, unknown>>;
    expect(jobResults[0].output).toBe('{"answer":"hello","confidence":0.9}');
  });

  test("serializes Error objects to strings", async () => {
    const payload = await capturePayload(
      buildResults(0.5, new Error("eval failed")),
    );
    const evalScore = extractFirstEvalScore(payload);
    expect(evalScore.error).toBe("Error: eval failed");
  });
});
