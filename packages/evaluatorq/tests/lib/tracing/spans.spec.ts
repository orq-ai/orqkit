import { describe, expect, mock, test } from "bun:test";

import { setEvaluationAttributes } from "../../../src/lib/tracing/spans.js";

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
		const cell = { type: "bert_score", value: { precision: 0.9, recall: 0.8, f1: 0.85 } };
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
