import {tool, ToolLoopAgent} from 'ai';
import {z} from 'zod';

import {createOpenAI} from '@ai-sdk/openai';

import {evaluatorq} from "@orq-ai/evaluatorq";
import {wrapAISdkAgent} from "@orq-ai/evaluatorq/ai-sdk";

// Import generated OpenResponses types
import type {
  ResponseResource,
  Message,
  OutputTextContent,
} from "@orq-ai/evaluatorq/generated/openresponses/types";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const weatherAgent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  maxOutputTokens: 2500,
  tools: {
    weather: tool({
      description: 'Get the weather in a location (in Fahrenheit)',
      inputSchema: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => ({
        location,
        temperature: 72 + Math.floor(Math.random() * 21) - 10,
      }),
    }),
    convertFahrenheitToCelsius: tool({
      description: 'Convert temperature from Fahrenheit to Celsius',
      inputSchema: z.object({
        temperature: z.number().describe('Temperature in Fahrenheit'),
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
    { inputs: { prompt: "What is the weather in San Francisco?" } },
    { inputs: { prompt: "What is the weather in New York?" } },
  ],
  jobs: [wrapAISdkAgent(weatherAgent)],
  evaluators: [
    {
      name: "has-temperature",
      scorer: async ({ output }) => {
        const result = output as unknown as ResponseResource;
        // Find the final assistant message in the output
        const message = result.output.find(
          (item): item is Message => item.type === "message"
        );
        // Get text from the first output_text content item
        const textContent = message?.content.find(
          (c): c is OutputTextContent & { type: "output_text" } => c.type === "output_text"
        );
        const text = textContent?.text ?? "";
        const hasTemp = /\d+/.test(text);
        return {
          value: hasTemp ? 1 : 0,
          explanation: hasTemp
            ? "Response contains temperature"
            : "No temperature found in response",
        };
      },
    },
  ],
});