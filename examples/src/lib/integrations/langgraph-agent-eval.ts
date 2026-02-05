/**
 * LangGraph Agent Evaluation Example
 *
 * This example demonstrates how to evaluate a LangGraph agent using evaluatorq
 * with the StateGraph pattern and custom middleware.
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY environment variable
 *
 * Usage:
 *   OPENAI_API_KEY=your-key bun examples/src/lib/langgraph-agent-eval.ts
 */

import type { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapLangGraphAgent } from "@orq-ai/evaluatorq/langchain";

// Define tools
const weatherTool = tool(
  async ({ location }) => {
    // Simulated weather data
    const temperature = 72 + Math.floor(Math.random() * 20 - 10);
    return { location, temperature };
  },
  {
    name: "weather",
    description: "Get the weather in a location (in Fahrenheit)",
    schema: z.object({
      location: z.string().describe("The city to get weather for"),
    }),
  },
);

const convertTool = tool(
  async ({ temperature }) => {
    const celsius = Math.round((temperature - 32) * (5 / 9));
    return { celsius };
  },
  {
    name: "convert_fahrenheit_to_celsius",
    description: "Convert temperature from Fahrenheit to Celsius",
    schema: z.object({
      temperature: z.number().describe("Temperature in Fahrenheit"),
    }),
  },
);

const tools = [weatherTool, convertTool];

// Create model with tools bound
const model = new ChatOpenAI({ model: "gpt-4o" }).bindTools(tools);

// Create tool node
const toolNode = new ToolNode(tools);

// Define the agent node that calls the model
async function callModel(state: typeof MessagesAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

// Define the router function
function shouldContinue({
  messages,
}: typeof MessagesAnnotation.State): "tools" | typeof END {
  const lastMessage = messages[messages.length - 1] as AIMessage;
  if (lastMessage.tool_calls?.length) {
    return "tools";
  }
  return END;
}

// Build the graph
const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue, {
    tools: "tools",
    [END]: END,
  })
  .addEdge("tools", "agent");

// Compile the graph
const agent = graph.compile();

// Evaluator that checks if the response contains temperature in both F and C
const hasTemperatureInBothUnits: Evaluator = {
  name: "has-both-units",
  scorer: async ({ output }) => {
    const result = output as Record<string, unknown>;
    const outputItems = (result.output as Array<Record<string, unknown>>) ?? [];

    // Find the final message in the output
    const message = outputItems.find((item) => item.type === "message");

    let text = "";
    if (message) {
      const contentArray = message.content as Array<Record<string, unknown>>;
      const textContent = contentArray?.find((c) => c.type === "output_text");
      text = (textContent?.text as string) ?? "";
    }

    // Check if text contains both Fahrenheit and Celsius
    const hasFahrenheit = /\d+°?F/.test(text);
    const hasCelsius = /\d+°?C/.test(text);
    const hasBoth = hasFahrenheit && hasCelsius;

    return {
      value: hasBoth ? 1 : hasFahrenheit || hasCelsius ? 0.5 : 0,
      pass: hasBoth,
      explanation: hasBoth
        ? "Response contains both °F and °C"
        : hasFahrenheit
          ? "Only Fahrenheit"
          : hasCelsius
            ? "Only Celsius"
            : "No temperature units found",
    };
  },
};

// Evaluator that checks if the agent used the expected tools
const usedWeatherTools: Evaluator = {
  name: "used-weather-tools",
  scorer: async ({ output }) => {
    const result = output as Record<string, unknown>;
    const outputItems = (result.output as Array<Record<string, unknown>>) ?? [];

    // Find all function calls
    const functionCalls = outputItems.filter(
      (item) => item.type === "function_call",
    );

    const usedWeather = functionCalls.some((fc) => fc.name === "weather");
    const usedConvert = functionCalls.some(
      (fc) => fc.name === "convert_fahrenheit_to_celsius",
    );

    const score = (usedWeather ? 0.5 : 0) + (usedConvert ? 0.5 : 0);

    return {
      value: score,
      pass: usedWeather && usedConvert,
      explanation: `Used ${functionCalls.length} tools: ${functionCalls.map((fc) => fc.name).join(", ") || "none"}`,
    };
  },
};

// Test data
const dataPoints: DataPoint[] = [
  { inputs: { prompt: "What is the weather in San Francisco?" } },
  { inputs: { prompt: "What is the weather in New York?" } },
  { inputs: { prompt: "Tell me the temperature in Tokyo" } },
];

async function run() {
  console.log("\n🔄 LangGraph Agent Evaluation\n");
  console.log("Testing multi-step weather agent with tool chain...\n");
  console.log("------------------------------------------\n");

  const results = await evaluatorq("langgraph-agent-test", {
    data: dataPoints,
    jobs: [wrapLangGraphAgent(agent, { name: "langgraph-weather" })],
    evaluators: [hasTemperatureInBothUnits, usedWeatherTools],
    parallelism: 2,
    print: true,
  });

  console.log("\n✅ Evaluation complete!");
  return results;
}

run().catch(console.error);
