import type { Agent, ModelMessage, ToolSet } from "ai";

import type { DataPoint, Job, Output } from "../../types.js";
import {
  extractMessagesFromData,
  extractPromptFromData,
} from "../common/utils.js";
import { convertToOpenResponses } from "./convert.js";
import type { AgentJobOptions } from "./types.js";

/**
 * Creates an evaluatorq Job from any AI SDK Agent.
 *
 * Supports:
 * - `Agent` (base interface)
 * - `ToolLoopAgent`
 * - `Experimental_Agent` (deprecated alias for ToolLoopAgent)
 *
 * The job will:
 * - Execute the agent with the prompt from data.inputs
 * - Convert the result to OpenResponses format (industry standard)
 * - Return the OpenResponses resource for backend integration
 *
 * @example
 * ```typescript
 * import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";
 * import { ToolLoopAgent, tool } from "ai";
 *
 * const weatherAgent = new ToolLoopAgent({
 *   model: openai("gpt-4o"),
 *   tools: {
 *     weather: tool({
 *       description: "Get the weather in a location",
 *       inputSchema: z.object({ location: z.string() }),
 *       execute: async ({ location }) => ({ location, temperature: 72 }),
 *     }),
 *   },
 * });
 *
 * await evaluatorq("weather-agent-eval", {
 *   data: [
 *     { inputs: { prompt: "What is the weather in SF?" } },
 *   ],
 *   jobs: [wrapAISdkAgent(weatherAgent)],
 *   evaluators: [
 *     {
 *       name: "response-quality",
 *       scorer: async ({ output }) => {
 *         const result = output as unknown as ResponseResource;
 *         // Access the final message text
 *         const lastMessage = result.output.find(
 *           (item) => item.type === "message"
 *         );
 *         return {
 *           value: lastMessage ? 1 : 0,
 *           explanation: "Agent produced a response",
 *         };
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export function wrapAISdkAgent<TOOLS extends ToolSet>(
  agent: Agent<never, TOOLS, never>,
  options: AgentJobOptions = {},
): Job {
  const {
    name = agent.id ?? "agent",
    promptKey = "prompt",
    instructions,
  } = options;

  return async (data: DataPoint, _row: number) => {
    const inputMessages = extractMessagesFromData(data);
    const hasMessages = inputMessages !== undefined;
    const hasPrompt =
      typeof data.inputs[promptKey] === "string" && data.inputs[promptKey];

    let result: Awaited<ReturnType<typeof agent.generate>>;

    if (instructions) {
      // Resolve instructions (static string or dynamic function)
      const resolvedInstructions =
        typeof instructions === "function" ? instructions(data) : instructions;
      const systemMessage: ModelMessage = {
        role: "system",
        content: resolvedInstructions,
      } as ModelMessage;

      if (hasMessages && hasPrompt) {
        const messages: ModelMessage[] = [
          systemMessage,
          ...(inputMessages as ModelMessage[]),
          {
            role: "user",
            content: data.inputs[promptKey] as string,
          } as ModelMessage,
        ];
        result = await agent.generate({ messages });
      } else if (hasPrompt) {
        const messages: ModelMessage[] = [
          systemMessage,
          {
            role: "user",
            content: data.inputs[promptKey] as string,
          } as ModelMessage,
        ];
        result = await agent.generate({ messages });
      } else if (hasMessages) {
        const messages: ModelMessage[] = [
          systemMessage,
          ...(inputMessages as ModelMessage[]),
        ];
        result = await agent.generate({ messages });
      } else {
        throw new Error(
          "Expected data.inputs.messages (array) or data.inputs.prompt (string), but neither was provided",
        );
      }
    } else if (hasMessages && hasPrompt) {
      // Both exist — merge messages + prompt appended as user message
      const messages: ModelMessage[] = [
        ...(inputMessages as ModelMessage[]),
        {
          role: "user",
          content: data.inputs[promptKey] as string,
        } as ModelMessage,
      ];
      result = await agent.generate({ messages });
    } else if (hasPrompt) {
      // Prompt only — use native single-turn API
      const prompt = extractPromptFromData(data, promptKey);
      result = await agent.generate({ prompt });
    } else if (hasMessages) {
      // Messages only — pass directly
      result = await agent.generate({
        messages: inputMessages as ModelMessage[],
      });
    } else {
      throw new Error(
        "Expected data.inputs.messages (array) or data.inputs.prompt (string), but neither was provided",
      );
    }

    // Convert to OpenResponses format
    const openResponsesOutput = convertToOpenResponses(result, agent);

    return {
      name,
      output: openResponsesOutput as unknown as Output,
    };
  };
}
