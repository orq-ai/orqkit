import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";

import { evaluatorq } from "@orq-ai/evaluatorq";
import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";
import type {
  Message,
  OutputTextContent,
  ResponseResource,
} from "@orq-ai/evaluatorq/openresponses";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const weatherAgent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  maxOutputTokens: 2500,
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
});

// ============================================================
// Usage Example — Dataset-based evaluation
// ============================================================
// Upload examples/src/lib/integrations/datasets/vercel_ai_sdk_dataset_example.csv to the Orq platform, then
// replace the datasetId below with the ID from the platform.
// Also ensure the ORQ_API_KEY environment variable is set to authenticate with the platform.
await evaluatorq("weather-agent-dataset-eval", {
  description: "Weather agent evaluation using a dataset",
  parallelism: 2,
  data: {
    datasetId: process.env.DATASET_ID ?? "", // Replace with your actual dataset ID
  },
  jobs: [wrapAISdkAgent(weatherAgent, { promptKey: "input" })],
  evaluators: [
    {
      name: "has-temperature",
      scorer: async ({ output }) => {
        const result = output as unknown as ResponseResource;
        const message = result.output.find(
          (item): item is Message => item.type === "message",
        );
        const textContent = message?.content.find(
          (c): c is OutputTextContent & { type: "output_text" } =>
            c.type === "output_text",
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
    {
      name: "matches-expected",
      scorer: async ({ data, output }) => {
        const result = output as unknown as ResponseResource;
        const message = result.output.find(
          (item): item is Message => item.type === "message",
        );
        const textContent = message?.content.find(
          (c): c is OutputTextContent & { type: "output_text" } =>
            c.type === "output_text",
        );
        const text = textContent?.text ?? "";
        const expected =
          (data.inputs as Record<string, string>).expected_output ?? "";
        if (!expected)
          return { value: 0, explanation: "No expected output provided" };
        const matches = text.toLowerCase().includes(expected.toLowerCase());
        return {
          value: matches ? 1 : 0,
          explanation: matches
            ? "Response matches expected output"
            : `Expected "${expected}" but got "${text.slice(0, 100)}"`,
        };
      },
    },
    {
      name: "mentions-city",
      scorer: async ({ data, output }) => {
        const result = output as unknown as ResponseResource;
        const message = result.output.find(
          (item): item is Message => item.type === "message",
        );
        const textContent = message?.content.find(
          (c): c is OutputTextContent & { type: "output_text" } =>
            c.type === "output_text",
        );
        const text = textContent?.text ?? "";

        // Extract the city name from the input query
        const input = (data.inputs as Record<string, string>).input ?? "";
        const cityMatch = input.match(/in\s+(.+?)(?:\s+in\s+|\?|$)/i);
        const city = cityMatch?.[1] ?? "";

        const mentionsCity =
          city.length > 0 && text.toLowerCase().includes(city.toLowerCase());
        return {
          value: mentionsCity ? 1 : 0,
          explanation: mentionsCity
            ? `Response mentions "${city}"`
            : `Response does not mention "${city}"`,
        };
      },
    },
  ],
});
