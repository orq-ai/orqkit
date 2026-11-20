import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as setup from "../../../src/lib/tracing/setup.js";
import {
  withEvaluationRunSpan,
  withEvaluationSpan,
  withJobSpan,
} from "../../../src/lib/tracing/spans.js";

const fakeSpan = {
  setAttribute: () => undefined,
  setStatus: () => undefined,
  recordException: () => undefined,
  end: () => undefined,
};
const fakeTracer = {
  startActiveSpan: (...args: unknown[]) =>
    (args.at(-1) as (span: unknown) => unknown)(fakeSpan),
};

describe("span helpers", () => {
  afterEach(() => {
    (
      setup.getTracer as unknown as { mockRestore?: () => void }
    ).mockRestore?.();
  });

  test.each([
    ["run", withEvaluationRunSpan],
    ["job", withJobSpan],
    ["evaluation", withEvaluationSpan],
  ] as const)("a throwing %s function runs once", async (_name, helper) => {
    spyOn(setup, "getTracer").mockReturnValue(fakeTracer as never);
    let calls = 0;
    const run = helper as unknown as (
      options: unknown,
      fn: () => Promise<void>,
    ) => Promise<void>;
    await expect(
      run({ runId: "r", rowIndex: 0, evaluatorName: "e" }, async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});

describe("typed evaluator result spans", () => {
  test("keeps a bounded explanation attribute and the full verdict payload", async () => {
    const { setEvaluationAttributes } = await import(
      "../../../src/lib/tracing/spans.js"
    );
    const previous = process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT;
    process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT = "true";
    const attributes: Record<string, unknown> = {};
    const span = {
      setAttribute: (key: string, value: unknown) => {
        attributes[key] = value;
      },
    };
    try {
      const explanation = "😀".repeat(600);
      setEvaluationAttributes(span as never, false, explanation, false, {
        evaluatorName: "judge",
        evaluatorType: "llm_eval",
        rawOutput: { provider_key: "retained" },
      });
      expect(Array.from(String(attributes["orq.explanation"]))).toHaveLength(
        512,
      );
      expect(attributes["gen_ai.evaluation.explanation"]).toBe(
        attributes["orq.explanation"],
      );
      expect(attributes["orq.span_type"]).toBe("span.evaluator");
      expect(attributes["orq.evaluator.output_type"]).toBe("boolean");
      expect(attributes["gen_ai.evaluation.score.value"]).toBe(0);
      expect(attributes["gen_ai.evaluation.score.label"]).toBe("fail");
      expect(JSON.parse(String(attributes["orq.evaluation.output"]))).toEqual({
        passed: false,
        value: false,
        type: "llm_eval",
        reason: explanation,
        raw_output: { provider_key: "retained" },
      });
    } finally {
      if (previous === undefined)
        delete process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT;
      else process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT = previous;
    }
  });
  test("records numeric and inconclusive string scores without inventing pass labels", async () => {
    const { setEvaluationAttributes } = await import(
      "../../../src/lib/tracing/spans.js"
    );
    for (const score of [0.75, "inconclusive"]) {
      const attributes: Record<string, unknown> = {};
      setEvaluationAttributes(
        {
          setAttribute: (key: string, value: unknown) => {
            attributes[key] = value;
          },
        } as never,
        score,
        undefined,
        undefined,
        { evaluatorType: "llm_eval" },
      );
      expect(attributes["orq.evaluator.output_type"]).toBe(
        typeof score === "number" ? "number" : "string",
      );
      expect(attributes["gen_ai.evaluation.score.value"]).toBe(
        typeof score === "number" ? score : undefined,
      );
      expect(attributes["gen_ai.evaluation.score.label"]).toBeUndefined();
    }
  });
});
