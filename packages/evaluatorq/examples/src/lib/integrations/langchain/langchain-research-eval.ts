/**
 * LangChain Agent — Dataset-Driven Research Evaluation Example
 *
 * Demonstrates a dataset-driven evaluation scenario with:
 *   - LangChain createReactAgent with multiple tools
 *   - Dataset with structured inputs: { city, data }, messages, expected_output
 *   - System instructions built from dataset inputs (city + data)
 *   - User prompt extracted from dataset messages
 *   - OpenResponses output with input: [system, user] messages
 *   - Multiple evaluators: correctness, tool-usage, quality rubric,
 *     completeness, and city-relevance
 *   - Path-based organization for the Orq dashboard
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
 *   ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/langchain/langchain-research-eval.ts
 */

import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { z } from "zod";

import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapLangChainAgent } from "@orq-ai/evaluatorq/langchain";

import {
  buildResearchInstructions,
  cityRelevanceEvaluator,
  completenessEvaluator,
  correctnessEvaluator,
  qualityRubricEvaluator,
  toolUsageEvaluator,
} from "../../utils/agent-eval-helpers.js";

// ────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────

const searchTool = tool(
  async ({ query }) => ({
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
  {
    name: "search",
    description: "Search the web for information on a topic",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

const calculatorTool = tool(
  async ({ expression }) => {
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
  {
    name: "calculator",
    description: "Evaluate a mathematical expression",
    schema: z.object({
      expression: z.string().describe("Math expression to evaluate"),
    }),
  },
);

const factCheckTool = tool(
  async ({ claim }) => {
    const confidence = 0.85;
    return {
      claim,
      verdict: confidence >= 0.85 ? "supported" : "partially_supported",
      confidence: Math.round(confidence * 100) / 100,
      sources: [
        `https://example.com/fact-check/${encodeURIComponent(claim.slice(0, 30))}`,
      ],
    };
  },
  {
    name: "fact_check",
    description: "Verify a factual claim against known sources",
    schema: z.object({
      claim: z.string().describe("The claim to fact-check"),
    }),
  },
);

// ────────────────────────────────────────────────
// LangChain agent — createAgent (langchain 1.x convenience wrapper)
// ────────────────────────────────────────────────

const tools = [searchTool, calculatorTool, factCheckTool];

const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });

const agent = createAgent({
  model,
  tools,
});

// ────────────────────────────────────────────────
// Run the evaluation
// ────────────────────────────────────────────────
const DATASET_ID = process.env.DATASET_ID;

await evaluatorq("langchain-research-eval", {
  description:
    "LangChain research agent evaluation with structured dataset input (city + data), custom instructions, and OpenResponses output",
  path: "Integrations/LangChain",
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
    wrapLangChainAgent(agent, {
      name: "langchain-research-agent",
      instructions: (data) =>
        buildResearchInstructions(
          data.inputs.city as string,
          data.inputs.data as string,
        ),
    }),
  ],
  evaluators: [
    correctnessEvaluator,
    toolUsageEvaluator,
    qualityRubricEvaluator,
    completenessEvaluator,
    cityRelevanceEvaluator,
  ],
});
