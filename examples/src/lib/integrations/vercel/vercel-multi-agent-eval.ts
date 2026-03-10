/**
 * Vercel AI SDK — Multi-Agent Evaluation Example
 *
 * Demonstrates a multi-agent, dataset-driven evaluation scenario with:
 *   - Multiple ToolLoopAgents (research + math) with custom jobs
 *   - Dataset with structured input: { city, data }, message, expected_output
 *   - System instructions built from dataset `input` (city + data)
 *   - User prompt from the `message` column
 *   - OpenResponses output with input: [instruction, user] messages
 *   - Custom evaluators: correctness, tool-usage, quality rubric, city-relevance
 *   - Parallel processing
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY and ORQ_API_KEY environment variables
 *   - Upload a dataset to Orq with columns:
 *       "city"            — city name (string)
 *       "data"            — contextual data about the city (string)
 *       "messages"        — conversation messages (the user prompt as a message)
 *       "expected_output" — the expected answer (string, optional)
 *
 * Usage:
 *   ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/vercel/vercel-multi-agent-eval.ts
 */

import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";

import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";

import {
	buildResearchInstructions,
	cityRelevanceEvaluator,
	correctnessEvaluator,
	qualityRubricEvaluator,
	toolUsageEvaluator,
} from "../../utils/agent-eval-helpers.js";

// ────────────────────────────────────────────────
// OpenAI provider
// ────────────────────────────────────────────────
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ────────────────────────────────────────────────
// Agent 1 — Research assistant (web-search + knowledge-base)
// ────────────────────────────────────────────────
const researchAgent = new ToolLoopAgent({
	model: openai("gpt-4o"),
	maxOutputTokens: 3000,
	tools: {
		webSearch: tool({
			description: "Search the web for information on a topic",
			inputSchema: z.object({
				query: z.string().describe("The search query"),
			}),
			execute: async ({ query }) => ({
				results: [
					{
						title: `Top result for: ${query}`,
						snippet: `Comprehensive information about ${query}. According to recent studies, this topic has significant implications in multiple domains.`,
						url: `https://example.com/search?q=${encodeURIComponent(query)}`,
					},
					{
						title: `Academic paper: ${query}`,
						snippet: `A peer-reviewed analysis of ${query} published in 2024 found that the key factors include scalability, reliability, and cost-effectiveness.`,
						url: `https://example.com/papers/${encodeURIComponent(query)}`,
					},
				],
			}),
		}),
		knowledgeBase: tool({
			description: "Look up facts from the internal knowledge base",
			inputSchema: z.object({
				topic: z.string().describe("The topic to look up"),
			}),
			execute: async ({ topic }) => ({
				topic,
				facts: [
					`${topic} was first documented in the early 20th century.`,
					`Current research on ${topic} focuses on practical applications.`,
					`The global market for ${topic}-related products is estimated at $50B.`,
				],
				confidence: 0.92,
			}),
		}),
	},
});

// ────────────────────────────────────────────────
// Agent 2 — Math & data analyst
// ────────────────────────────────────────────────
const mathAgent = new ToolLoopAgent({
	model: openai("gpt-4o"),
	maxOutputTokens: 2000,
	tools: {
		calculator: tool({
			description: "Perform a mathematical calculation",
			inputSchema: z.object({
				expression: z.string().describe("Math expression to evaluate"),
			}),
			execute: async ({ expression }) => {
				// NOTE: Uses a hard-coded lookup for demo purposes.
				// In production, use a dedicated math expression library instead.
				const knownExpressions: Record<string, number> = {
					"2 + 2": 4,
					"10 * 5": 50,
					"100 / 4": 25,
					"3.14 * 2": 6.28,
					"2 ** 10": 1024,
					"(5 + 3) * 2": 16,
					"1000 - 750": 250,
				};
				const result = knownExpressions[expression.trim()];
				if (result !== undefined) {
					return { expression, result, error: null };
				}
				return {
					expression,
					result: null,
					error: "Expression not in demo lookup table",
				};
			},
		}),
		statisticalSummary: tool({
			description: "Compute statistical summary of a dataset",
			inputSchema: z.object({
				values: z.array(z.number()).describe("Array of numbers to summarize"),
			}),
			execute: async ({ values }) => {
				const sorted = [...values].sort((a, b) => a - b);
				const sum = values.reduce((a, b) => a + b, 0);
				const mean = sum / values.length;
				const median =
					values.length % 2 === 0
						? (sorted[values.length / 2 - 1] + sorted[values.length / 2]) / 2
						: sorted[Math.floor(values.length / 2)];
				const variance =
					values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
				return {
					count: values.length,
					sum,
					mean: Math.round(mean * 100) / 100,
					median,
					stdDev: Math.round(Math.sqrt(variance) * 100) / 100,
					min: sorted[0],
					max: sorted[sorted.length - 1],
				};
			},
		}),
		unitConverter: tool({
			description: "Convert a value between units",
			inputSchema: z.object({
				value: z.number(),
				fromUnit: z.string(),
				toUnit: z.string(),
			}),
			execute: async ({ value, fromUnit, toUnit }) => {
				const from = fromUnit.toLowerCase();
				const to = toUnit.toLowerCase();
				// Celsius conversions use formulas, not simple multipliers
				if (from === "celsius" && to === "fahrenheit")
					return { result: (value * 9) / 5 + 32, from: fromUnit, to: toUnit };
				if (from === "celsius" && to === "kelvin")
					return { result: value + 273.15, from: fromUnit, to: toUnit };
				const conversions: Record<string, Record<string, number>> = {
					km: { miles: 0.621371, meters: 1000, feet: 3280.84 },
					miles: { km: 1.60934, meters: 1609.34, feet: 5280 },
					kg: { lbs: 2.20462, grams: 1000, oz: 35.274 },
					lbs: { kg: 0.453592, grams: 453.592, oz: 16 },
				};
				const factor = conversions[from]?.[to];
				if (!factor) return { error: `Unsupported: ${fromUnit} → ${toUnit}` };
				return {
					result: Math.round(value * factor * 1000) / 1000,
					from: fromUnit,
					to: toUnit,
				};
			},
		}),
	},
});

// ────────────────────────────────────────────────
// Run the evaluation
// ────────────────────────────────────────────────
const DATASET_ID = process.env.DATASET_ID;

await evaluatorq("vercel-multi-agent-eval", {
	description:
		"Multi-agent evaluation with structured dataset input (city + data), custom instructions, and OpenResponses output",
	path: "Integrations/VercelAI",
	parallelism: 3,
	data: {
		datasetId: (() => {
			if (!DATASET_ID)
				throw new Error("DATASET_ID environment variable is required");
			return DATASET_ID;
		})(),
		includeMessages: true,
	},
	jobs: [
		wrapAISdkAgent(researchAgent, {
			name: "research-agent",
			instructions: (data) =>
				buildResearchInstructions(
					data.inputs.city as string,
					data.inputs.data as string,
					"search, knowledge base, or calculator",
				),
		}),
		wrapAISdkAgent(mathAgent, {
			name: "math-agent",
			instructions: (data) =>
				buildResearchInstructions(
					data.inputs.city as string,
					data.inputs.data as string,
					"calculator, statistical summary, or unit converter",
				),
		}),
	],
	evaluators: [
		correctnessEvaluator,
		toolUsageEvaluator,
		qualityRubricEvaluator,
		cityRelevanceEvaluator,
	],
});
