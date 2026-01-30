/**
 * Wrapper functions for LangChain/LangGraph agents to integrate with evaluatorq.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { DataPoint, Job, Output } from "../../types.js";
import { convertToOpenResponses } from "./convert.js";
import type {
  AgentJobOptions,
  LangChainInvocable,
  ToolDefinition,
} from "./types.js";

/**
 * Extract JSON schema parameters from a schema object.
 * Handles Zod schemas and plain JSON schema objects.
 */
function extractSchemaParameters(
  inputSchema: unknown,
): Record<string, unknown> | null {
  if (!inputSchema) return null;

  try {
    // Use toJsonSchema to convert Zod schemas to JSON Schema
    // This handles both Zod schemas and plain JSON Schema objects
    const jsonSchema = toJsonSchema(
      inputSchema as Parameters<typeof toJsonSchema>[0],
    );
    return jsonSchema as Record<string, unknown>;
  } catch {
    // If conversion fails, check if it's already a plain object
    if (typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
      return inputSchema as Record<string, unknown>;
    }
    return null;
  }
}

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

  // 1. Try ReactAgent pattern: agent.options.tools (langchain createAgent)
  const agentWithOptions = agent as {
    options?: { tools?: unknown[]; middleware?: Array<{ tools?: unknown[] }> };
  };
  if (agentWithOptions.options?.tools) {
    const allTools = [
      ...(agentWithOptions.options.tools ?? []),
      ...(agentWithOptions.options.middleware
        ?.filter((m) => m.tools)
        .flatMap((m) => m.tools ?? []) ?? []),
    ];

    for (const tool of allTools) {
      const toolObj = tool as StructuredToolInterface<unknown, unknown, unknown>;
      if (!toolObj.name) continue;

      const toolSchema: ToolDefinition = {
        name: toolObj.name,
        description: toolObj.description,
      };

      const parameters = extractSchemaParameters(toolObj.schema);
      if (parameters) {
        toolSchema.parameters = parameters;
      }

      tools.push(toolSchema);
    }

    if (tools.length > 0) {
      return tools;
    }
  }

  // 2. Try CompiledStateGraph pattern: agent.nodes -> ToolNode
  const agentWithNodes = agent as {
    nodes?: Record<string, { bound?: unknown }>;
  };
  if (agentWithNodes.nodes) {
    for (const node of Object.values(agentWithNodes.nodes)) {
      if (!node.bound) continue;

      // Duck-typing: check if bound has a 'tools' array property (ToolNode or compatible)
      const boundWithTools = node.bound as { tools?: unknown[] };
      if (Array.isArray(boundWithTools.tools)) {
        for (const tool of boundWithTools.tools) {
          const toolInterface = tool as StructuredToolInterface<
            unknown,
            unknown,
            unknown
          >;
          if (!toolInterface.name) continue;

          const toolSchema: ToolDefinition = {
            name: toolInterface.name,
            description: toolInterface.description,
          };

          const parameters = extractSchemaParameters(toolInterface.schema);
          if (parameters) {
            toolSchema.parameters = parameters;
          }

          tools.push(toolSchema);
        }
        // Found tools, can break
        if (tools.length > 0) break;
      }
    }

    if (tools.length > 0) {
      return tools;
    }
  }

  // 3. Fallback: direct tools property
  let agentTools: unknown[] | undefined = agent.tools;
  if (!agentTools && agent.bound) {
    agentTools = agent.bound.tools;
  }

  if (agentTools && Array.isArray(agentTools)) {
    for (const tool of agentTools) {
      const toolObj = tool as StructuredToolInterface<unknown, unknown, unknown>;
      if (!toolObj.name) continue;

      const toolSchema: ToolDefinition = {
        name: toolObj.name,
        description: toolObj.description,
      };

      const parameters = extractSchemaParameters(toolObj.schema);
      if (parameters) {
        toolSchema.parameters = parameters;
      }

      tools.push(toolSchema);
    }
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
