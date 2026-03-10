/**
 * Complex LangGraph Agent Evaluation Example
 *
 * Demonstrates a sophisticated evaluation scenario with:
 *   - Multi-node StateGraph with branching logic and specialized tool nodes
 *   - Dataset with structured inputs: { city, data }, messages, expected_output
 *   - System instructions built from dataset inputs (city + data)
 *   - User prompt extracted from dataset messages
 *   - OpenResponses output with input: [system, user] messages
 *   - Multiple evaluators: correctness, tool chain, quality rubric,
 *     completeness, efficiency, and city-relevance
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
 *   ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/langchain/langgraph-research-eval.ts
 */

import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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
    `You are an expert research analyst for the city of ${city}.`,
    `Use the following context data to inform your answers:\n${data}`,
    "Always ground your response in the provided data. Use your tools to search, verify, and summarize when appropriate.",
  ].join("\n\n");
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
      return { expression, result };
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
    // Simulated stub — replace with a real fact-checking API in production.
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
// Custom job — extract inputs, build instructions, run graph
// ────────────────────────────────────────────────

const researchJob = job("research-graph-agent", async (data: DataPoint) => {
  const city = data.inputs.city as string;
  const cityData = data.inputs.data as string;

  // Messages come from the dataset's "messages" column (included via includeMessages)
  const messages = data.inputs.messages as
    | Array<{ role: string; content: string }>
    | undefined;
  const userMessage = messages?.find((m) => m.role === "user")?.content ?? "";

  const instructions = buildSystemInstructions(city, cityData);

  // Invoke the graph with system instructions + user message
  const result = await compiledGraph.invoke({
    messages: [new SystemMessage(instructions), new HumanMessage(userMessage)],
  });

  // Extract messages from result and convert to OpenResponses format
  const resultMessages = (result.messages ?? []) as BaseMessage[];
  const resolvedTools = extractToolsFromAgent(compiledGraph);
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

await evaluatorq("langgraph-complex-research-eval", {
  description:
    "Complex LangGraph research agent evaluation with structured dataset input (city + data), custom instructions, and OpenResponses output",
  path: "Integrations/LangGraph",
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
    toolChainEvaluator,
    responseQualityEvaluator,
    completenessEvaluator,
    efficiencyEvaluator,
    cityRelevanceEvaluator,
  ],
});
