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
 *   OPENAI_API_KEY=your-key bun examples/src/lib/langchain-agent-eval.ts
 */

import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { z } from "zod";

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapLangChainAgent } from "@orq-ai/evaluatorq/langchain";

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

// Create the agent using the modern createAgent API
const model = new ChatOpenAI({ model: "gpt-4o" });
const agent = createAgent({
  model,
  tools: [weatherTool, convertTool],
});

// Evaluator that checks if the response contains a temperature number
const hasTemperature: Evaluator = {
  name: "has-temperature",
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

// Test data
const dataPoints: DataPoint[] = [
  { inputs: { prompt: "What is the weather in San Francisco?" } },
  { inputs: { prompt: "What is the weather in New York?" } },
];

async function run() {
  console.log("\n🌤️  LangChain Agent Evaluation\n");
  console.log("Testing weather agent responses...\n");
  console.log("------------------------------------------\n");

  const results = await evaluatorq("langchain-agent-test", {
    data: dataPoints,
    jobs: [wrapLangChainAgent(agent, { name: "weather-agent" })],
    evaluators: [hasTemperature],
    parallelism: 2,
    print: true,
  });

  console.log("\n✅ Evaluation complete!");
  return results;
}

run().catch(console.error);
