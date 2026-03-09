/**
 * Vercel AI SDK — Multi-Agent Evaluation Example
 *
 * Demonstrates a multi-agent, dataset-driven evaluation scenario with:
 *   - Multiple ToolLoopAgents (research + math) wrapped via wrapAISdkAgent
 *   - Dataset pulled from the Orq platform
 *   - Custom evaluators: correctness, tool-usage, response quality rubric
 *   - Structured EvaluationResultCell scores
 *   - Path-based organization for the Orq dashboard
 *   - Parallel processing
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY and ORQ_API_KEY environment variables
 *   - Upload a dataset to Orq with columns: "input" (the user prompt)
 *     and optionally "expected_output" (the expected answer)
 *
 * Usage:
 *   ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/vercel-multi-agent-eval.ts
 */

import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";

import type { Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";
import type {
  FunctionCall,
  Message,
  OutputTextContent,
  ResponseResource,
} from "@orq-ai/evaluatorq/openresponses";

// ────────────────────────────────────────────────
// Helpers — extract text and tool calls from agent output
// ────────────────────────────────────────────────
function extractText(output: unknown): string {
  const res = output as ResponseResource;
  const message = res.output?.find(
    (item): item is Message => item.type === "message",
  );
  const textContent = message?.content.find(
    (c): c is OutputTextContent & { type: "output_text" } =>
      c.type === "output_text",
  );
  return textContent?.text ?? "";
}

function extractFunctionCalls(output: unknown): FunctionCall[] {
  const res = output as ResponseResource;
  return (
    res.output?.filter(
      (item): item is FunctionCall => item.type === "function_call",
    ) ?? []
  );
}

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
        // Simple hard-coded lookup for demo purposes.
        // In production, use a dedicated math expression library instead of eval.
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
        const conversions: Record<string, Record<string, number>> = {
          km: { miles: 0.621371, meters: 1000, feet: 3280.84 },
          miles: { km: 1.60934, meters: 1609.34, feet: 5280 },
          kg: { lbs: 2.20462, grams: 1000, oz: 35.274 },
          lbs: { kg: 0.453592, grams: 453.592, oz: 16 },
          // celsius conversions are handled by the explicit checks above
        };
        const from = fromUnit.toLowerCase();
        const to = toUnit.toLowerCase();
        if (from === "celsius" && to === "fahrenheit")
          return { result: (value * 9) / 5 + 32, from: fromUnit, to: toUnit };
        if (from === "celsius" && to === "kelvin")
          return { result: value + 273.15, from: fromUnit, to: toUnit };
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
// Evaluators
// ────────────────────────────────────────────────

/** Checks if the response matches the expected output (when present). */
const correctnessEvaluator: Evaluator = {
  name: "correctness",
  scorer: async ({ data, output }) => {
    const text = extractText(output).toLowerCase();
    const expected = (data.inputs as Record<string, string>).expected_output;
    if (!expected) {
      return {
        value: text.length > 20 ? 1 : 0.5,
        explanation: "No expected output — scored on response substance",
      };
    }
    const expectedStr = String(expected).toLowerCase();
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

/** Validates that the agent actually used its tools and didn't just guess. */
const toolUsageEvaluator: Evaluator = {
  name: "tool-usage",
  scorer: async ({ output }) => {
    const calls = extractFunctionCalls(output);
    const toolNames = [...new Set(calls.map((c) => c.name))];
    const score = Math.min(toolNames.length / 2, 1); // full score at 2+ distinct tools
    return {
      value: score,
      explanation: `Used ${calls.length} tool call(s) across ${toolNames.length} distinct tool(s): ${toolNames.join(", ") || "none"}`,
    };
  },
};

/** Multi-criteria quality rubric (structured result). */
const qualityRubricEvaluator: Evaluator = {
  name: "quality-rubric",
  scorer: async ({ output }) => {
    const text = extractText(output);
    const words = text.split(/\s+/).filter(Boolean);
    const sentences = text.split(/[.!?]+/).filter(Boolean);

    // Completeness — longer, substantive answers score higher
    const completeness = Math.min(words.length / 50, 1);

    // Clarity — average sentence length; prefer 10-25 words per sentence
    const avgSentenceLen =
      sentences.length > 0 ? words.length / sentences.length : 0;
    const clarity =
      avgSentenceLen >= 10 && avgSentenceLen <= 25
        ? 0.95
        : avgSentenceLen > 0
          ? 0.5
          : 0.1;

    // Structure — has it used bullet points, numbers, or paragraphs?
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

/** Detects hedging and uncertainty language in the response. */
const safetyEvaluator: Evaluator = {
  name: "hedge-detection",
  scorer: async ({ output }) => {
    const text = extractText(output).toLowerCase();
    const unsafePatterns = [
      /i('m| am) not sure but/,
      /i (don't|do not) (actually |really )?know/,
      /as an ai/i,
    ];
    const flagged = unsafePatterns.filter((p) => p.test(text));
    return {
      value: flagged.length === 0,
      pass: flagged.length === 0,
      explanation:
        flagged.length === 0
          ? "No unsafe patterns detected"
          : `Detected ${flagged.length} unsafe pattern(s) in response`,
    };
  },
};

// ────────────────────────────────────────────────
// Run the evaluation
// ────────────────────────────────────────────────
const DATASET_ID = process.env.DATASET_ID;

await evaluatorq("vercel-complex-multi-agent-eval", {
  description:
    "Complex multi-agent evaluation: research + math agents scored on correctness, tool usage, quality rubric, and safety",
  path: "Integrations/VercelAI",
  parallelism: 3,
  data: {
    datasetId: (() => {
      if (!DATASET_ID)
        throw new Error("DATASET_ID environment variable is required");
      return DATASET_ID;
    })(),
  },
  jobs: [
    wrapAISdkAgent(researchAgent, {
      name: "research-agent",
      promptKey: "input",
    }),
    wrapAISdkAgent(mathAgent, { name: "math-agent", promptKey: "input" }),
  ],
  evaluators: [
    correctnessEvaluator,
    toolUsageEvaluator,
    qualityRubricEvaluator,
    safetyEvaluator,
  ],
});
