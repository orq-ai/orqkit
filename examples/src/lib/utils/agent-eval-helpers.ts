/**
 * Shared helpers and evaluators for agent integration examples.
 *
 * Used by LangChain, LangGraph, and Vercel AI SDK evaluation examples
 * to avoid duplicating common patterns.
 */

import type { Evaluator, Output } from "@orq-ai/evaluatorq";
import type {
	FunctionCall,
	ResponseResource,
} from "@orq-ai/evaluatorq/openresponses";
import { extractText } from "@orq-ai/evaluatorq/openresponses";

// ────────────────────────────────────────────────
// Helper — extract tool calls from OpenResponses output
// ────────────────────────────────────────────────

export function extractToolCalls(output: Output): FunctionCall[] {
	const res = output as ResponseResource;
	return (
		res.output?.filter(
			(item): item is FunctionCall => item.type === "function_call",
		) ?? []
	);
}

// ────────────────────────────────────────────────
// Build system instructions from dataset inputs
// ────────────────────────────────────────────────

export function buildResearchInstructions(
	city: string,
	data: string,
	toolList = "search, calculator, or fact_check",
): string {
	return [
		`You are an expert analyst for the city of ${city}.`,
		`Use the following context data to inform your answers:\n${data}`,
		"Always ground your response in the provided data.",
		`You MUST use your tools (${toolList}) at least once before answering. Search for additional information to supplement the provided data, verify claims with the fact-checker, or use the calculator for any numerical analysis.`,
	].join("\n\n");
}

// ────────────────────────────────────────────────
// Reusable evaluators
// ────────────────────────────────────────────────

/** Checks correctness against expected output when available. */
export const correctnessEvaluator: Evaluator = {
	name: "correctness",
	scorer: async ({ data, output }) => {
		const text = extractText(output).toLowerCase();
		const expected = data.expectedOutput as string | undefined;
		if (!expected) {
			return {
				value: text.length > 20 ? 1 : 0.5,
				explanation: "No expected output — scored on response substance",
			};
		}
		const expectedStr = expected.toLowerCase();
		const contains = text.includes(expectedStr);
		return {
			value: contains ? 1 : 0,
			pass: contains,
			explanation: contains
				? `Output contains expected answer "${expected}"`
				: `Expected "${expected}" not found in output`,
		};
	},
};

/** Validates that the agent actually used its tools. */
export const toolUsageEvaluator: Evaluator = {
	name: "tool-usage",
	scorer: async ({ output }) => {
		const calls = extractToolCalls(output);
		const toolNames = [...new Set(calls.map((c) => c.name))];
		const score = Math.min(toolNames.length / 2, 1);
		return {
			value: score,
			explanation: `Used ${calls.length} tool call(s) across ${toolNames.length} distinct tool(s): ${toolNames.join(", ") || "none"}`,
		};
	},
};

/** Multi-criteria quality rubric (structured result). */
export const qualityRubricEvaluator: Evaluator = {
	name: "quality-rubric",
	scorer: async ({ output }) => {
		const text = extractText(output);
		const words = text.split(/\s+/).filter(Boolean);
		const sentences = text.split(/[.!?]+/).filter(Boolean);

		const completeness = Math.min(words.length / 50, 1);

		const avgSentenceLen =
			sentences.length > 0 ? words.length / sentences.length : 0;
		const clarity =
			avgSentenceLen >= 10 && avgSentenceLen <= 25
				? 0.95
				: avgSentenceLen > 0
					? 0.5
					: 0.1;

		const hasStructure = /(\n[-•*]|\n\d+\.|\n\n)/.test(text) ? 0.9 : 0.5;

		return {
			value: {
				type: "rubric",
				value: {
					completeness: Math.round(completeness * 100) / 100,
					clarity: Math.round(clarity * 100) / 100,
					structure: Math.round(hasStructure * 100) / 100,
				},
			},
			explanation:
				"Multi-criteria quality rubric (completeness, clarity, structure)",
		};
	},
};

/** Boolean pass/fail — the response must not be empty or a refusal. */
export const completenessEvaluator: Evaluator = {
	name: "completeness",
	scorer: async ({ output }) => {
		const text = extractText(output);
		const words = text.split(/\s+/).filter(Boolean).length;
		const isRefusal = /i (can't|cannot|am unable to)/i.test(text);
		const isComplete = words >= 10 && !isRefusal;
		return {
			value: isComplete,
			pass: isComplete,
			explanation: isComplete
				? `Complete response (${words} words)`
				: isRefusal
					? "Agent refused to answer"
					: `Incomplete response (only ${words} words)`,
		};
	},
};

/** Checks that the response references the city from the dataset input. */
export const cityRelevanceEvaluator: Evaluator = {
	name: "city-relevance",
	scorer: async ({ data, output }) => {
		const text = extractText(output).toLowerCase();
		const city = data.inputs.city as string;
		const mentionsCity = text.includes(city.toLowerCase());
		return {
			value: mentionsCity ? 1 : 0,
			pass: mentionsCity,
			explanation: mentionsCity
				? `Response references the target city "${city}"`
				: `Response does not mention "${city}"`,
		};
	},
};
