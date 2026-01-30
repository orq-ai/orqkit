import { describe, expect, test } from "bun:test";

import { calculateEvaluatorAverages } from "../../src/lib/table-display.js";
import type { EvaluatorqResult } from "../../src/lib/types.js";

function makeResult(
	jobName: string,
	scores: Array<{
		evaluatorName: string;
		value: number | boolean | string | { type: string; value: Record<string, unknown> };
		explanation?: string;
		pass?: boolean;
		error?: Error;
	}>,
): EvaluatorqResult[number] {
	return {
		dataPoint: { inputs: { text: "test" } },
		jobResults: [
			{
				jobName,
				output: "output",
				evaluatorScores: scores.map((s) => ({
					evaluatorName: s.evaluatorName,
					score: {
						value: s.value,
						explanation: s.explanation,
						pass: s.pass,
					},
					error: s.error,
				})),
			},
		],
	};
}

describe("calculateEvaluatorAverages", () => {
	test("calculates average for number scores", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{ evaluatorName: "accuracy", value: 0.5 },
			]),
			makeResult("job1", [
				{ evaluatorName: "accuracy", value: 1.0 },
			]),
		];

		const { averages } = calculateEvaluatorAverages(results);
		const avg = averages.get("accuracy")?.get("job1");
		expect(avg?.value).toBe("0.75");
	});

	test("calculates pass rate for boolean scores", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{ evaluatorName: "pass_check", value: true },
			]),
			makeResult("job1", [
				{ evaluatorName: "pass_check", value: false },
			]),
		];

		const { averages } = calculateEvaluatorAverages(results);
		const avg = averages.get("pass_check")?.get("job1");
		expect(avg?.value).toBe("50.0%");
	});

	test("renders string scores as [string]", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{ evaluatorName: "quality", value: "good" },
			]),
		];

		const { averages } = calculateEvaluatorAverages(results);
		const avg = averages.get("quality")?.get("job1");
		expect(avg?.value).toBe("[string]");
	});

	test("renders EvaluationResultCell scores as [structured]", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{
					evaluatorName: "bert_score",
					value: {
						type: "bert_score",
						value: { precision: 0.9, recall: 0.8, f1: 0.85 },
					},
				},
			]),
		];

		const { averages } = calculateEvaluatorAverages(results);
		const avg = averages.get("bert_score")?.get("job1");
		expect(avg?.value).toBe("[structured]");
	});

	test("handles mixed evaluator types across results", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{ evaluatorName: "accuracy", value: 0.8 },
				{ evaluatorName: "pass_check", value: true },
				{ evaluatorName: "quality", value: "excellent" },
				{
					evaluatorName: "bert",
					value: { type: "bert_score", value: { f1: 0.9 } },
				},
			]),
			makeResult("job1", [
				{ evaluatorName: "accuracy", value: 0.6 },
				{ evaluatorName: "pass_check", value: false },
				{ evaluatorName: "quality", value: "good" },
				{
					evaluatorName: "bert",
					value: { type: "bert_score", value: { f1: 0.7 } },
				},
			]),
		];

		const { averages, evaluatorNames } = calculateEvaluatorAverages(results);

		expect(evaluatorNames).toContain("accuracy");
		expect(evaluatorNames).toContain("pass_check");
		expect(evaluatorNames).toContain("quality");
		expect(evaluatorNames).toContain("bert");

		expect(averages.get("accuracy")?.get("job1")?.value).toBe("0.70");
		expect(averages.get("pass_check")?.get("job1")?.value).toBe("50.0%");
		expect(averages.get("quality")?.get("job1")?.value).toBe("[string]");
		expect(averages.get("bert")?.get("job1")?.value).toBe("[structured]");
	});

	test("handles empty results without crashing", () => {
		const { jobNames, evaluatorNames, averages } =
			calculateEvaluatorAverages([]);

		expect(jobNames).toEqual([]);
		expect(evaluatorNames).toEqual([]);
		expect(averages.size).toBe(0);
	});

	test("shows dash for evaluator with no scores (error case)", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{
					evaluatorName: "failing",
					value: 0,
					error: new Error("evaluator failed"),
				},
			]),
		];

		const { averages } = calculateEvaluatorAverages(results);
		const avg = averages.get("failing")?.get("job1");
		expect(avg?.value).toBe("-");
	});

	test("100% boolean pass rate uses correct value", () => {
		const results: EvaluatorqResult = [
			makeResult("job1", [
				{ evaluatorName: "check", value: true },
			]),
			makeResult("job1", [
				{ evaluatorName: "check", value: true },
			]),
		];

		const { averages } = calculateEvaluatorAverages(results);
		expect(averages.get("check")?.get("job1")?.value).toBe("100.0%");
	});
});
