/**
 * LangChain Agent Evaluation Example
 *
 * This example demonstrates how to evaluate a LangChain agent using evaluatorq.
 * It creates an agent with weather tools and validates that responses contain
 * temperature information.
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY environment variable
 *
 * Usage:
 *   OPENAI_API_KEY=your-key bun examples/src/lib/integrations/langchain/langchain-agent-eval.ts
 */

import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { z } from "zod";

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapLangChainAgent } from "@orq-ai/evaluatorq/langchain";
import type {
  FunctionCall,
  ResponseResource,
} from "@orq-ai/evaluatorq/openresponses";
import { extractText } from "@orq-ai/evaluatorq/openresponses";

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

// Create the agent using LangGraph's createReactAgent
const model = new ChatOpenAI({ model: "gpt-4o" });
const agent = createAgent({
  model,
  tools: [weatherTool, convertTool],
});

// Evaluator that checks if the response contains a temperature number
const hasTemperature: Evaluator = {
  name: "has-temperature",
  scorer: async ({ output }) => {
    const text = extractText(output);

    // Check if the text contains a number (temperature)
    const hasTemp = /\d+/.test(text);

    return {
      value: hasTemp ? 1 : 0,
      pass: hasTemp,
      explanation: hasTemp
        ? "Response contains temperature"
        : "No temperature found",
    };
  },
};

// Evaluator that checks if the agent used its tools
const usedTools: Evaluator = {
  name: "used-tools",
  scorer: async ({ output }) => {
    const res = output as ResponseResource;
    const calls =
      res.output?.filter(
        (item): item is FunctionCall => item.type === "function_call",
      ) ?? [];
    const toolNames = [...new Set(calls.map((c) => c.name))];
    const usedWeather = toolNames.includes("weather");
    const usedConvert = toolNames.includes("convert_fahrenheit_to_celsius");
    const score = (usedWeather ? 0.5 : 0) + (usedConvert ? 0.5 : 0);
    return {
      value: score,
      pass: usedWeather && usedConvert,
      explanation: `Used tools: ${toolNames.join(", ") || "none"}`,
    };
  },
};

// Test data — prompts that require multi-step tool usage
const dataPoints: DataPoint[] = [
  {
    inputs: {
      prompt:
        "Look up the current weather in San Francisco and convert the temperature to Celsius.",
    },
  },
  {
    inputs: {
      prompt:
        "Look up the current weather in New York and convert the temperature to Celsius.",
    },
  },
];

async function run() {
  console.log("\n🌤️  LangChain Agent Evaluation\n");
  console.log("Testing weather agent responses...\n");
  console.log("------------------------------------------\n");

  const results = await evaluatorq("langchain-agent-test", {
    data: dataPoints,
    jobs: [
      wrapLangChainAgent(agent, {
        name: "weather-agent",
        instructions:
          "You are a weather assistant. You MUST always use your tools to look up the weather and convert temperatures. Never answer from memory — always call the weather tool first, then convert the result to Celsius using the conversion tool. Report both Fahrenheit and Celsius in your final answer.",
      }),
    ],
    evaluators: [hasTemperature, usedTools],
    parallelism: 2,
    print: true,
  });

  console.log("\n✅ Evaluation complete!");
  return results;
}

run().catch(console.error);
