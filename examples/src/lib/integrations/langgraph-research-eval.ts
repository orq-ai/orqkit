/**
 * Complex LangGraph Agent Evaluation Example
 *
 * Demonstrates a sophisticated evaluation scenario with:
 *   - Multi-node StateGraph with branching logic and specialized tool nodes
 *   - Dataset pulled from the Orq platform
 *   - Multiple evaluators: correctness, tool chain validation, structured rubric,
 *     response completeness, and latency-aware scoring
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
 *   ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/langgraph-complex-eval.ts
 */

import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Annotation,
  END,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapLangGraphAgent } from "@orq-ai/evaluatorq/langchain";

// ────────────────────────────────────────────────
// Helpers — extract text and tool calls from OpenResponses output
// ────────────────────────────────────────────────
function extractText(output: unknown): string {
  const res = output as Record<string, unknown>;
  const items = (res.output as Array<Record<string, unknown>>) ?? [];
  const message = items.find((item) => item.type === "message");
  if (!message) return "";
  const contentArray = message.content as Array<Record<string, unknown>>;
  const textContent = contentArray?.find((c) => c.type === "output_text");
  return (textContent?.text as string) ?? "";
}

function extractToolCalls(output: unknown): Array<Record<string, unknown>> {
  const res = output as Record<string, unknown>;
  const items = (res.output as Array<Record<string, unknown>>) ?? [];
  return items.filter((item) => item.type === "function_call");
}

// ────────────────────────────────────────────────
// Tools — a rich set to enable multi-step reasoning
// ────────────────────────────────────────────────

const searchTool = tool(
  async ({ query, maxResults }) => {
    // Simulated search results
    const results = Array.from({ length: maxResults }, (_, i) => ({
      rank: i + 1,
      title: `Result ${i + 1} for "${query}"`,
      snippet: `Relevant information about ${query} — finding #${i + 1} includes important details about the topic.`,
      relevanceScore: Math.round((1 - i * 0.15) * 100) / 100,
    }));
    return { query, totalResults: 42, results };
  },
  {
    name: "search",
    description: "Search for information on a topic, returns ranked results",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe("Max results to return"),
    }),
  },
);

const fetchPageTool = tool(
  async ({ url }) => ({
    url,
    title: `Page content for ${url}`,
    content: `Detailed content from ${url}. This page contains comprehensive information including data tables, citations, and expert analysis. Key takeaway: the subject matter is well-documented with a 95% consensus among experts.`,
    wordCount: 2500,
  }),
  {
    name: "fetch_page",
    description: "Fetch and extract content from a web page URL",
    schema: z.object({
      url: z.string().describe("The URL to fetch"),
    }),
  },
);

const calculatorTool = tool(
  async ({ expression }) => {
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().%^ ]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return { expression, result: Number(result) };
    } catch {
      return { expression, result: null, error: "Could not evaluate" };
    }
  },
  {
    name: "calculator",
    description: "Evaluate a mathematical expression",
    schema: z.object({
      expression: z.string().describe("Math expression to evaluate"),
    }),
  },
);

const summarizeTool = tool(
  async ({ text, maxSentences }) => {
    const sentences = text.split(/[.!?]+/).filter(Boolean);
    const summary = `${sentences.slice(0, maxSentences).join(". ")}.`;
    return {
      summary,
      originalLength: text.length,
      summaryLength: summary.length,
      compressionRatio: Math.round((summary.length / text.length) * 100) / 100,
    };
  },
  {
    name: "summarize",
    description: "Summarize a block of text to a target number of sentences",
    schema: z.object({
      text: z.string().describe("The text to summarize"),
      maxSentences: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe("Max sentences in summary"),
    }),
  },
);

const factCheckTool = tool(
  async ({ claim }) => {
    // Simulated fact-checking
    const confidence = 0.7 + Math.random() * 0.25;
    return {
      claim,
      verdict: confidence > 0.85 ? "supported" : "partially_supported",
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
// LangGraph — multi-node agent graph
// ────────────────────────────────────────────────

const tools = [
  searchTool,
  fetchPageTool,
  calculatorTool,
  summarizeTool,
  factCheckTool,
];

const model = new ChatOpenAI({ model: "gpt-4o", temperature: 0 }).bindTools(
  tools,
);

const toolNode = new ToolNode(tools);

// Custom annotation to track tool usage count
const AgentAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  toolCallCount: Annotation<number>({
    default: () => 0,
    value: (prev, next) => prev + next,
  }),
});

async function callAgent(state: typeof AgentAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

async function callTools(state: typeof AgentAnnotation.State) {
  const toolResult = await toolNode.invoke({
    messages: state.messages,
  });
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  const newCalls = lastMessage.tool_calls?.length ?? 0;
  return {
    messages: toolResult.messages as BaseMessage[],
    toolCallCount: newCalls,
  };
}

function shouldContinue(
  state: typeof AgentAnnotation.State,
): "tools" | typeof END {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

  // Stop if no tool calls or we've exceeded a reasonable limit
  if (!lastMessage.tool_calls?.length || state.toolCallCount > 10) {
    return END;
  }
  return "tools";
}

// Build and compile the graph
const graph = new StateGraph(AgentAnnotation)
  .addNode("agent", callAgent)
  .addNode("tools", callTools)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue, {
    tools: "tools",
    [END]: END,
  })
  .addEdge("tools", "agent");

const compiledGraph = graph.compile();

// ────────────────────────────────────────────────
// Evaluators
// ────────────────────────────────────────────────

/** Checks correctness against expected output when available. */
const correctnessEvaluator: Evaluator = {
  name: "correctness",
  scorer: async ({ data, output }) => {
    const text = extractText(output).toLowerCase();
    const expected = data.expectedOutput;
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

/** Validates that the agent built a proper tool chain. */
const toolChainEvaluator: Evaluator = {
  name: "tool-chain",
  scorer: async ({ output }) => {
    const calls = extractToolCalls(output);
    const toolNames = calls.map((c) => c.name as string);
    const uniqueTools = [...new Set(toolNames)];

    // Did the agent use search before summarize? (good chain)
    const hasSearch = toolNames.includes("search");
    const hasSummarize = toolNames.includes("summarize");
    const hasFactCheck = toolNames.includes("fact_check");

    let chainScore = 0;
    if (hasSearch) chainScore += 0.3;
    if (hasSummarize) chainScore += 0.2;
    if (hasFactCheck) chainScore += 0.2;
    if (uniqueTools.length >= 3) chainScore += 0.3;

    return {
      value: Math.round(chainScore * 100) / 100,
      explanation: `Tool chain: ${toolNames.join(" → ") || "none"} (${uniqueTools.length} distinct)`,
    };
  },
};

/** Multi-criteria response quality rubric (structured result). */
const responseQualityEvaluator: Evaluator = {
  name: "response-quality",
  scorer: async ({ output }) => {
    const text = extractText(output);
    const words = text.split(/\s+/).filter(Boolean);
    const sentences = text.split(/[.!?]+/).filter(Boolean);
    const calls = extractToolCalls(output);

    // Depth — word count relative to a good answer length
    const depth = Math.min(words.length / 80, 1);

    // Accuracy signal — did the agent use fact-checking tools?
    const accuracy = calls.some((c) => c.name === "fact_check") ? 0.95 : 0.6;

    // Coherence — reasonable sentence structure
    const avgSentenceLen =
      sentences.length > 0 ? words.length / sentences.length : 0;
    const coherence =
      avgSentenceLen >= 8 && avgSentenceLen <= 30
        ? 0.9
        : avgSentenceLen > 0
          ? 0.5
          : 0.1;

    // Sourcing — did the agent cite sources or use search?
    const sourcing = calls.some((c) =>
      ["search", "fetch_page"].includes(c.name as string),
    )
      ? 0.9
      : 0.3;

    return {
      value: {
        type: "rubric",
        value: {
          depth: Math.round(depth * 100) / 100,
          accuracy: Math.round(accuracy * 100) / 100,
          coherence: Math.round(coherence * 100) / 100,
          sourcing: Math.round(sourcing * 100) / 100,
        },
      },
      explanation:
        "Multi-criteria quality rubric (depth, accuracy, coherence, sourcing)",
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

/** Checks the efficiency of tool usage — penalizes excessive calls. */
const efficiencyEvaluator: Evaluator = {
  name: "efficiency",
  scorer: async ({ output }) => {
    const calls = extractToolCalls(output);
    const totalCalls = calls.length;
    // Ideal: 2-5 calls for a complex question
    let score: number;
    if (totalCalls >= 2 && totalCalls <= 5) {
      score = 1;
    } else if (totalCalls === 1 || totalCalls === 6) {
      score = 0.7;
    } else if (totalCalls === 0) {
      score = 0.3;
    } else {
      score = Math.max(0.2, 1 - (totalCalls - 5) * 0.1);
    }
    return {
      value: Math.round(score * 100) / 100,
      explanation: `${totalCalls} tool call(s) — ${totalCalls >= 2 && totalCalls <= 5 ? "optimal range" : totalCalls > 5 ? "excessive" : "underutilized"}`,
    };
  },
};

// ────────────────────────────────────────────────
// Run the evaluation
// ────────────────────────────────────────────────
const DATASET_ID = process.env.DATASET_ID;

await evaluatorq("langgraph-complex-research-eval", {
  description:
    "Complex LangGraph research agent evaluation: multi-tool chain scored on correctness, tool chain, response quality, completeness, and efficiency",
  path: "Integrations/LangGraph",
  parallelism: 3,
  data: {
    datasetId: DATASET_ID ?? "",
  },
  jobs: [wrapLangGraphAgent(compiledGraph, { name: "research-graph-agent" })],
  evaluators: [
    correctnessEvaluator,
    toolChainEvaluator,
    responseQualityEvaluator,
    completenessEvaluator,
    efficiencyEvaluator,
  ],
});
