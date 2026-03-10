import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";

import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";
import type {
  FunctionCall,
  ResponseResource,
} from "@orq-ai/evaluatorq/openresponses";
import { extractText } from "@orq-ai/evaluatorq/openresponses";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const weatherAgent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  maxOutputTokens: 2500,
  system:
    "You are a weather assistant. You MUST always use your tools to look up the weather and convert temperatures. Never answer from memory — always call the weather tool first, then convert the result to Celsius using the conversion tool. Report both Fahrenheit and Celsius in your final answer.",
  tools: {
    weather: tool({
      description: "Get the weather in a location (in Fahrenheit)",
      inputSchema: z.object({
        location: z.string().describe("The location to get the weather for"),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
    convertFahrenheitToCelsius: tool({
      description: "Convert temperature from Fahrenheit to Celsius",
      inputSchema: z.object({
        temperature: z.number().describe("Temperature in Fahrenheit"),
      }),
      execute: async ({ temperature }) => {
        const celsius = Math.round((temperature - 32) * (5 / 9));
        return { celsius };
      },
    }),
  },
  // Agent's default behavior is to stop after a maximum of 20 steps
  // stopWhen: stepCountIs(20),
});

// ============================================================
// Usage Example
// ============================================================
await evaluatorq("weather-agent-eval", {
  description: "Zonneplan test experiment",
  parallelism: 2,
  data: [
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
  ],
  jobs: [wrapAISdkAgent(weatherAgent)],
  evaluators: [
    {
      name: "has-temperature",
      scorer: async ({ output }) => {
        const text = extractText(output);
        const hasTemp = /\d+/.test(text);
        return {
          value: hasTemp ? 1 : 0,
          explanation: hasTemp
            ? "Response contains temperature"
            : "No temperature found in response",
        };
      },
    },
    {
      name: "used-tools",
      scorer: async ({ output }) => {
        const res = output as ResponseResource;
        const calls =
          res.output?.filter(
            (item): item is FunctionCall => item.type === "function_call",
          ) ?? [];
        const toolNames = [...new Set(calls.map((c) => c.name))];
        const usedWeather = toolNames.includes("weather");
        const usedConvert = toolNames.includes("convertFahrenheitToCelsius");
        const score = (usedWeather ? 0.5 : 0) + (usedConvert ? 0.5 : 0);
        return {
          value: score,
          pass: usedWeather && usedConvert,
          explanation: `Used tools: ${toolNames.join(", ") || "none"}`,
        };
      },
    },
  ],
});
