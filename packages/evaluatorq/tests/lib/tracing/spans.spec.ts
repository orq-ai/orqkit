import { describe, expect, mock, test } from "bun:test";

import {
  setEvaluationAttributes,
  withEvaluationRunSpan,
  withEvaluationSpan,
  withJobSpan,
} from "../../../src/lib/tracing/spans.js";

function createMockSpan() {
  const attributes: Record<string, unknown> = {};
  return {
    setAttribute: mock((key: string, value: unknown) => {
      attributes[key] = value;
    }),
    attributes,
  };
}

describe("setEvaluationAttributes", () => {
  test("sets number score directly as string", () => {
    const span = createMockSpan();
    setEvaluationAttributes(span as never, 0.85, "good score", true);

    expect(span.attributes["orq.score"]).toBe("0.85");
    expect(span.attributes["orq.explanation"]).toBe("good score");
    expect(span.attributes["orq.pass"]).toBe(true);
  });

  test("sets boolean score as string", () => {
    const span = createMockSpan();
    setEvaluationAttributes(span as never, true);

    expect(span.attributes["orq.score"]).toBe("true");
  });

  test("sets string score directly", () => {
    const span = createMockSpan();
    setEvaluationAttributes(span as never, "excellent");

    expect(span.attributes["orq.score"]).toBe("excellent");
  });

  test("JSON.stringifies object/EvaluationResultCell score", () => {
    const span = createMockSpan();
    const cell = {
      type: "bert_score",
      value: { precision: 0.9, recall: 0.8, f1: 0.85 },
    };
    setEvaluationAttributes(span as never, cell);

    expect(span.attributes["orq.score"]).toBe(JSON.stringify(cell));
  });

  test("does not set optional attributes when undefined", () => {
    const span = createMockSpan();
    setEvaluationAttributes(span as never, 1.0);

    expect(span.setAttribute).toHaveBeenCalledTimes(1);
    expect(span.attributes["orq.explanation"]).toBeUndefined();
    expect(span.attributes["orq.pass"]).toBeUndefined();
  });

  test("handles undefined span gracefully", () => {
    // Should not throw
    setEvaluationAttributes(undefined, 1.0, "test", true);
  });
});

describe("withEvaluationRunSpan", () => {
  test("calls callback with undefined when tracer is unavailable", async () => {
    // getTracer() returns null when OTEL is not set up
    const result = await withEvaluationRunSpan(
      {
        runId: "run-123",
        runName: "test-run",
        dataPointsCount: 5,
        jobsCount: 2,
        evaluatorsCount: 1,
      },
      async (span) => {
        // In test env without OTEL, span should be undefined
        expect(span).toBeUndefined();
        return "callback-result";
      },
    );

    expect(result).toBe("callback-result");
  });

  test("executes callback and returns its result", async () => {
    const result = await withEvaluationRunSpan(
      {
        runId: "run-456",
        runName: "my-eval",
        dataPointsCount: 10,
        jobsCount: 3,
        evaluatorsCount: 2,
      },
      async () => {
        return { data: [1, 2, 3] };
      },
    );

    expect(result).toEqual({ data: [1, 2, 3] });
  });

  test("propagates errors from callback", async () => {
    await expect(
      withEvaluationRunSpan(
        {
          runId: "run-789",
          runName: "error-run",
          dataPointsCount: 0,
          jobsCount: 0,
          evaluatorsCount: 0,
        },
        async () => {
          throw new Error("callback error");
        },
      ),
    ).rejects.toThrow("callback error");
  });

  test("passes span options through correctly", async () => {
    // Even without OTEL, the function should accept all option fields
    const options = {
      runId: "run-full-opts",
      runName: "full-options-test",
      dataPointsCount: 42,
      jobsCount: 7,
      evaluatorsCount: 3,
    };

    let receivedSpan: unknown = "not-set";
    await withEvaluationRunSpan(options, async (span) => {
      receivedSpan = span;
      return null;
    });

    // Without OTEL installed, span is undefined
    expect(receivedSpan).toBeUndefined();
  });

  test("supports async operations in callback", async () => {
    const events: string[] = [];

    await withEvaluationRunSpan(
      {
        runId: "run-async",
        runName: "async-test",
        dataPointsCount: 0,
        jobsCount: 0,
        evaluatorsCount: 0,
      },
      async () => {
        events.push("start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push("middle");
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push("end");
        return events;
      },
    );

    expect(events).toEqual(["start", "middle", "end"]);
  });
});

describe("withJobSpan", () => {
  test("calls callback and returns result regardless of tracer state", async () => {
    const result = await withJobSpan(
      { runId: "run-1", rowIndex: 0 },
      async () => {
        return "job-done";
      },
    );
    expect(result).toBe("job-done");
  });

  test("propagates errors from callback", async () => {
    await expect(
      withJobSpan({ runId: "run-err", rowIndex: 0 }, async () => {
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
  });
});

describe("withEvaluationSpan", () => {
  test("calls callback and returns result regardless of tracer state", async () => {
    const result = await withEvaluationSpan(
      { runId: "run-1", evaluatorName: "test-eval" },
      async () => {
        return "eval-done";
      },
    );
    expect(result).toBe("eval-done");
  });

  test("propagates errors from callback", async () => {
    await expect(
      withEvaluationSpan(
        { runId: "run-err", evaluatorName: "test-eval" },
        async () => {
          throw new Error("eval failed");
        },
      ),
    ).rejects.toThrow("eval failed");
  });
});

describe("rootSpan option", () => {
  test("when rootSpan is false, jobs execute without a run span wrapper", async () => {
    // Simulates what evaluatorq() does when rootSpan=false:
    // it skips withEvaluationRunSpan and calls processDataPoints directly.
    const executionOrder: string[] = [];

    // Without withEvaluationRunSpan, jobs should still work independently
    const jobResult = await withJobSpan(
      { runId: "run-no-root", rowIndex: 0 },
      async () => {
        executionOrder.push("job-0");
        const evalResult = await withEvaluationSpan(
          { runId: "run-no-root", evaluatorName: "test-eval" },
          async () => {
            executionOrder.push("eval-0");
            return { value: 1.0 };
          },
        );
        return { output: "test", evalResult };
      },
    );

    expect(executionOrder).toEqual(["job-0", "eval-0"]);
    expect(jobResult.output).toBe("test");
  });

  test("when rootSpan is true, jobs execute inside a run span", async () => {
    const executionOrder: string[] = [];

    await withEvaluationRunSpan(
      {
        runId: "run-with-root",
        runName: "root-test",
        dataPointsCount: 1,
        jobsCount: 1,
        evaluatorsCount: 1,
      },
      async () => {
        executionOrder.push("run-start");
        await withJobSpan({ runId: "run-with-root", rowIndex: 0 }, async () => {
          executionOrder.push("job-0");
          return "done";
        });
        executionOrder.push("run-end");
        return null;
      },
    );

    expect(executionOrder).toEqual(["run-start", "job-0", "run-end"]);
  });
});

describe("span hierarchy (without OTEL)", () => {
  test("nested spans all execute callbacks correctly", async () => {
    const executionOrder: string[] = [];

    const result = await withEvaluationRunSpan(
      {
        runId: "run-nested",
        runName: "nested-test",
        dataPointsCount: 1,
        jobsCount: 1,
        evaluatorsCount: 1,
      },
      async () => {
        executionOrder.push("run-start");

        const jobResult = await withJobSpan(
          { runId: "run-nested", rowIndex: 0 },
          async () => {
            executionOrder.push("job-start");

            const evalResult = await withEvaluationSpan(
              { runId: "run-nested", evaluatorName: "test-eval" },
              async () => {
                executionOrder.push("eval");
                return { value: 0.95 };
              },
            );

            executionOrder.push("job-end");
            return { output: "test", evalResult };
          },
        );

        executionOrder.push("run-end");
        return [jobResult];
      },
    );

    expect(executionOrder).toEqual([
      "run-start",
      "job-start",
      "eval",
      "job-end",
      "run-end",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe("test");
    expect(result[0].evalResult).toEqual({ value: 0.95 });
  });

  test("multiple parallel jobs inside run span all complete", async () => {
    const completedJobs: number[] = [];

    await withEvaluationRunSpan(
      {
        runId: "run-parallel",
        runName: "parallel-test",
        dataPointsCount: 5,
        jobsCount: 1,
        evaluatorsCount: 0,
      },
      async () => {
        const jobs = Array.from({ length: 5 }, (_, i) =>
          withJobSpan({ runId: "run-parallel", rowIndex: i }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            completedJobs.push(i);
            return i;
          }),
        );

        return Promise.all(jobs);
      },
    );

    expect(completedJobs).toHaveLength(5);
    // All indices should be present (order may vary due to parallel execution)
    expect(completedJobs.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test("error in one job does not affect run span error propagation", async () => {
    await expect(
      withEvaluationRunSpan(
        {
          runId: "run-job-err",
          runName: "error-test",
          dataPointsCount: 1,
          jobsCount: 1,
          evaluatorsCount: 0,
        },
        async () => {
          await withJobSpan({ runId: "run-job-err", rowIndex: 0 }, async () => {
            throw new Error("job-level error");
          });
        },
      ),
    ).rejects.toThrow("job-level error");
  });
});
