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

import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { z } from "zod";

import type { DataPoint, Evaluator, Output } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";
import {
  convertToOpenResponses,
  extractToolsFromAgent,
} from "@orq-ai/evaluatorq/langchain";
import type {
  FunctionCall,
  Message,
  OutputTextContent,
  ResponseResource,
} from "@orq-ai/evaluatorq/openresponses";

// ────────────────────────────────────────────────
// Helpers — extract text and tool calls from OpenResponses output
// ────────────────────────────────────────────────
function extractText(output: Output): string {
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

function extractToolCalls(output: Output): FunctionCall[] {
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
function buildSystemInstructions(city: string, data: string): string {
  return [
    `You are an expert analyst for the city of ${city}.`,
    `Use the following context data to inform your answers:\n${data}`,
    "Always ground your response in the provided data.",
    "You MUST use your tools (search, calculator, or fact_check) at least once before answering. Search for additional information to supplement the provided data, verify claims with the fact-checker, or use the calculator for any numerical analysis.",
  ].join("\n\n");
}

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
// LangChain agent — createReactAgent
// ────────────────────────────────────────────────

const tools = [searchTool, calculatorTool, factCheckTool];

const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });

const agent = createAgent({
  model,
  tools,
});

// ────────────────────────────────────────────────
// Custom job — extract inputs, build instructions, run agent
// ────────────────────────────────────────────────

const researchJob = job("langchain-research-agent", async (data: DataPoint) => {
  const city = data.inputs.city as string;
  const cityData = data.inputs.data as string;

  // Messages come from the dataset's "messages" column (included via includeMessages)
  const messages = data.inputs.messages as
    | Array<{ role: string; content: string }>
    | undefined;
  const userMessage = messages?.find((m) => m.role === "user")?.content ?? "";

  const instructions = buildSystemInstructions(city, cityData);

  // Invoke the agent with system instructions + user message
  const result = await agent.invoke({
    messages: [new SystemMessage(instructions), new HumanMessage(userMessage)],
  });

  // Extract messages from result and convert to OpenResponses format
  const resultMessages = (result.messages ?? []) as BaseMessage[];
  const resolvedTools = extractToolsFromAgent(agent);
  return convertToOpenResponses(resultMessages, resolvedTools);
});

// ────────────────────────────────────────────────
// Evaluators
// ────────────────────────────────────────────────

/** Checks correctness against expected output when available. */
const correctnessEvaluator: Evaluator = {
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
const toolUsageEvaluator: Evaluator = {
  name: "tool-usage",
  scorer: async ({ output }) => {
    const calls = extractToolCalls(output);
    const toolNames = [...new Set(calls.map((c) => c.name as string))];
    const score = Math.min(toolNames.length / 2, 1);
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
const completenessEvaluator: Evaluator = {
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
const cityRelevanceEvaluator: Evaluator = {
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
  jobs: [researchJob],
  evaluators: [
    correctnessEvaluator,
    toolUsageEvaluator,
    qualityRubricEvaluator,
    completenessEvaluator,
    cityRelevanceEvaluator,
  ],
});
