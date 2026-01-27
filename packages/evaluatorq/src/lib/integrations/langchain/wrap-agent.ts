/**
 * Wrapper functions for LangChain/LangGraph agents to integrate with evaluatorq.
 */

import type { DataPoint, Job, Output } from "../../types.js";
import { convertToOpenResponses } from "./convert.js";
import type {
  AgentJobOptions,
  LangChainInvocable,
  ToolDefinition,
} from "./types.js";

/**
 * Creates an evaluatorq Job from a LangChain agent.
 *
 * The job will:
 * - Execute the agent with the prompt from data.inputs[promptKey]
 * - Convert the result to OpenResponses format (industry standard)
 * - Return the OpenResponses resource for backend integration
 *
 * @example
 * ```typescript
 * import { evaluatorq } from "@orq-ai/evaluatorq";
 * import { wrapLangChainAgent } from "@orq-ai/evaluatorq/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 *
 * const model = new ChatOpenAI({ model: "gpt-4o" });
 * const agent = createReactAgent({ llm: model, tools: [weatherTool] });
 *
 * await evaluatorq("weather-agent-eval", {
 *   data: [{ inputs: { prompt: "What is the weather in SF?" } }],
 *   jobs: [wrapLangChainAgent(agent, { name: "weather-agent" })],
 *   evaluators: [
 *     {
 *       name: "response-quality",
 *       scorer: async ({ output }) => {
 *         const result = output as Record<string, unknown>;
 *         const outputItems = (result.output as unknown[]) ?? [];
 *         const hasMessage = outputItems.some(
 *           (item) => (item as Record<string, unknown>).type === "message"
 *         );
 *         return {
 *           value: hasMessage ? 1 : 0,
 *           explanation: "Agent produced a response",
 *         };
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @param agent - A LangChain agent or runnable with an invoke() method
 * @param options - Configuration options for the job
 * @returns An evaluatorq Job function
 */
export function wrapLangChainAgent(
  agent: LangChainInvocable,
  options: AgentJobOptions & { tools?: ToolDefinition[] } = {},
): Job {
  const { name = "agent", promptKey = "prompt", tools } = options;

  return async (data: DataPoint, _row: number) => {
    const prompt = data.inputs[promptKey];

    if (typeof prompt !== "string") {
      throw new Error(
        `Expected data.inputs.${promptKey} to be a string, got ${typeof prompt}`,
      );
    }

    // Invoke the LangChain agent with messages format
    const result = await agent.invoke({
      messages: [{ role: "user", content: prompt }],
    });

    // Extract messages from result
    const messages = result.messages ?? [];

    // Get tools from agent if not provided explicitly
    const resolvedTools = tools ?? extractToolsFromAgent(agent);

    // Convert to OpenResponses format
    const openResponsesOutput = convertToOpenResponses(messages, resolvedTools);

    return {
      name,
      output: openResponsesOutput as unknown as Output,
    };
  };
}

/**
 * Extract tool definitions from a LangChain agent.
 *
 * This is a helper function to automatically extract tool schemas
 * from a LangChain agent for use in the OpenResponses output.
 *
 * @param agent - A LangChain agent with tools
 * @returns A list of tool definitions in OpenResponses format
 */
export function extractToolsFromAgent(
  agent: LangChainInvocable,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // Try to access tools from common LangChain agent attributes
  let agentTools: unknown[] | undefined = agent.tools;
  if (!agentTools && agent.bound) {
    agentTools = agent.bound.tools;
  }

  if (!agentTools || !Array.isArray(agentTools)) {
    return tools;
  }

  for (const tool of agentTools) {
    const toolObj = tool as Record<string, unknown>;
    const toolSchema: ToolDefinition = {
      name: (toolObj.name as string) ?? "unknown",
      description: toolObj.description as string | undefined,
    };

    // Try to get the input schema
    const inputSchema = toolObj.args_schema as
      | {
          model_json_schema?: () => Record<string, unknown>;
          schema?: () => Record<string, unknown>;
        }
      | undefined;

    if (inputSchema) {
      if (typeof inputSchema.model_json_schema === "function") {
        toolSchema.parameters = inputSchema.model_json_schema();
      } else if (typeof inputSchema.schema === "function") {
        toolSchema.parameters = inputSchema.schema();
      }
    }

    tools.push(toolSchema);
  }

  return tools;
}

/**
 * Alias for wrapLangChainAgent for LangGraph users.
 *
 * LangGraph graphs and LangChain agents both implement the same
 * invoke() interface, so this is just an alias for convenience.
 */
export const wrapLangGraphAgent = wrapLangChainAgent;
