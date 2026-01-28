import {tool, ToolLoopAgent, type ToolSet, type Agent} from 'ai';
import {z} from 'zod';

import {createOpenAI} from '@ai-sdk/openai';

import {promises as fs} from 'fs';
import {evaluatorq} from "@orq-ai/evaluatorq";

// Import generated OpenResponses types
import type {
  ResponseResource,
  ItemField,
  FunctionCall,
  FunctionCallOutput,
  Message,
  OutputTextContent,
  FunctionTool,
  Usage,
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

const result = await weatherAgent.generate({
  prompt: 'What is the weather in San Francisco in celsius?',
});

await fs.writeFile('./steps.json', JSON.stringify(result.steps, null, 2), 'utf-8');



// ============================================================
// Agent Job Helper for evaluatorq
// ============================================================

// These types would come from @orq-ai/evaluatorq
// import type { DataPoint, Job, Output } from "@orq-ai/evaluatorq";

type Output = string | number | boolean | Record<string, unknown> | null;

interface DataPoint {
  inputs: Record<string, unknown>;
  expectedOutput?: Output;
}

type Job = (
  data: DataPoint,
  row: number,
) => Promise<{
  name: string;
  output: Output;
}>;

interface AgentJobOptions {
  /** The name of the job (defaults to agent.id or "agent") */
  name?: string;
  /** The key in data.inputs to use as the prompt (defaults to "prompt") */
  promptKey?: string;
}

// ============================================================
// OpenResponses Conversion Helper
// Types are generated from https://github.com/openresponses/openresponses
// ============================================================

/**
 * Generates a unique ID for OpenResponses items.
 */
function generateItemId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Type definition for step data extracted from AI SDK results.
 */
interface StepData {
  // Content array contains tool-call and tool-result items
  content?: Array<{
    type: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
  }>;
  // Alternative: some AI SDK versions use toolCalls/toolResults arrays
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
  }>;
  request?: {
    body?: {
      input?: unknown[];
      tools?: FunctionTool[];
    };
  };
  response?: {
    body?: ResponseResource;
    messages?: Array<{
      role: string;
      content: Array<{
        type: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
        text?: string;
        providerOptions?: {
          openai?: {
            itemId?: string;
          };
        };
      }>;
    }>;
  };
  providerMetadata?: {
    openai?: {
      itemId?: string;
    };
  };
}

/**
 * Builds the input array for OpenResponses format.
 *
 * Resolves item_reference entries to actual function_call items using data from steps.
 * The input should contain:
 * - User message
 * - All function calls made during the conversation
 * - All function call outputs returned
 */
function buildInputFromSteps<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  prompt: string | undefined
): unknown[] {
  const input: unknown[] = [];

  // Add the initial user message
  if (prompt) {
    input.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: prompt,
        },
      ],
    });
  }

  // Collect all function calls and outputs from steps
  for (const step of result.steps) {
    const stepData = step as unknown as StepData;

    // Primary: Extract from content array (ToolLoopAgent format)
    if (stepData.content && stepData.content.length > 0) {
      for (const item of stepData.content) {
        if (item.type === "tool-call" && item.toolCallId && item.toolName) {
          input.push({
            type: "function_call",
            id: generateItemId("fc"),
            call_id: item.toolCallId,
            name: item.toolName,
            arguments: typeof item.input === "string"
              ? item.input
              : JSON.stringify(item.input),
          });
        }
        if (item.type === "tool-result" && item.toolCallId) {
          input.push({
            type: "function_call_output",
            call_id: item.toolCallId,
            output: typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output),
          });
        }
      }
    }
    // Fallback: Extract from toolCalls/toolResults arrays (alternative AI SDK format)
    else {
      if (stepData.toolCalls && stepData.toolCalls.length > 0) {
        for (const toolCall of stepData.toolCalls) {
          input.push({
            type: "function_call",
            id: generateItemId("fc"),
            call_id: toolCall.toolCallId,
            name: toolCall.toolName,
            arguments: typeof toolCall.args === "string"
              ? toolCall.args
              : JSON.stringify(toolCall.args),
          });
        }
      }

      if (stepData.toolResults && stepData.toolResults.length > 0) {
        for (const toolResult of stepData.toolResults) {
          input.push({
            type: "function_call_output",
            call_id: toolResult.toolCallId,
            output: typeof toolResult.result === "string"
              ? toolResult.result
              : JSON.stringify(toolResult.result),
          });
        }
      }
    }
  }

  return input;
}

/**
 * Converts Vercel AI SDK agent result to OpenResponses format.
 *
 * This converter uses a smart approach:
 * - For OpenAI Responses API: extracts the native response.body from the last step
 *   which already contains the full OpenResponses format with all data
 * - Builds the input array by collecting all function calls and outputs from steps
 *   (resolving item_reference entries to actual function_call items)
 */
function convertToOpenResponses<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  _agent: Agent<never, TOOLS, never>,
  prompt?: string
): ResponseResource {
  // Get the last step which contains the final response
  const lastStep = result.steps[result.steps.length - 1] as unknown as StepData;

  // Check if we have a native OpenResponses body from OpenAI Responses API
  if (lastStep?.response?.body && typeof lastStep.response.body === "object") {
    const responseBody = lastStep.response.body as ResponseResource;

    // Build the input array from steps (resolves item_reference to actual function_call items)
    const input = buildInputFromSteps(result, prompt);

    return {
      ...responseBody,
      input,
    } as ResponseResource;
  }

  // Fallback: manually construct for non-Responses API (e.g., Chat Completions)
  return buildOpenResponsesFromSteps(result, _agent, prompt);
}

/**
 * Fallback function to manually build OpenResponses format from steps.
 * Used when the provider doesn't return native OpenResponses format.
 */
function buildOpenResponsesFromSteps<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  agent: Agent<never, TOOLS, never>,
  prompt?: string
): ResponseResource {
  const now = Math.floor(Date.now() / 1000);

  // Convert tools from agent configuration
  const tools: FunctionTool[] = [];
  if (agent.tools) {
    for (const [toolName, toolDef] of Object.entries(agent.tools)) {
      const toolConfig = toolDef as { description?: string; parameters?: unknown };
      tools.push({
        type: "function",
        name: toolName,
        description: toolConfig.description ?? null,
        parameters: (toolConfig.parameters as Record<string, unknown>) ?? null,
        strict: null,
      });
    }
  }

  // Build output items from steps
  const output: ItemField[] = [];
  let callIdCounter = 0;

  for (const step of result.steps) {
    const stepData = step as unknown as {
      text?: string;
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        args: unknown;
      }>;
      toolResults?: Array<{
        toolCallId: string;
        toolName: string;
        result: unknown;
      }>;
    };

    // Add function calls from this step
    if (stepData.toolCalls && stepData.toolCalls.length > 0) {
      for (const toolCall of stepData.toolCalls) {
        const functionCall: FunctionCall = {
          type: "function_call",
          id: generateItemId("fc"),
          call_id: toolCall.toolCallId || `call_${callIdCounter++}`,
          name: toolCall.toolName,
          arguments: typeof toolCall.args === "string"
            ? toolCall.args
            : JSON.stringify(toolCall.args),
          status: "completed",
        };
        output.push(functionCall);
      }
    }

    // Add function call outputs from this step
    if (stepData.toolResults && stepData.toolResults.length > 0) {
      for (const toolResult of stepData.toolResults) {
        const functionCallOutput: FunctionCallOutput = {
          type: "function_call_output",
          id: generateItemId("fco"),
          call_id: toolResult.toolCallId,
          output: typeof toolResult.result === "string"
            ? toolResult.result
            : JSON.stringify(toolResult.result),
          status: "completed",
        };
        output.push(functionCallOutput);
      }
    }
  }

  // Add final message with text response
  if (result.text) {
    const message: Message = {
      type: "message",
      id: generateItemId("msg"),
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: result.text,
          annotations: [],
          logprobs: [],
        },
      ],
    };
    output.push(message);
  }

  // Convert usage
  const usage: Usage | null = result.totalUsage
    ? {
        input_tokens: result.totalUsage.inputTokens ?? 0,
        output_tokens: result.totalUsage.outputTokens ?? 0,
        total_tokens: result.totalUsage.totalTokens ?? 0,
        input_tokens_details: {
          cached_tokens: (result.totalUsage as { cachedInputTokens?: number }).cachedInputTokens ?? 0,
        },
        output_tokens_details: {
          reasoning_tokens: (result.totalUsage as { reasoningTokens?: number }).reasoningTokens ?? 0,
        },
      }
    : null;

  // Determine status from finish reason
  const status: ResponseResource["status"] =
    result.finishReason === "stop" || result.finishReason === "tool-calls"
      ? "completed"
      : result.finishReason === "error"
        ? "failed"
        : result.finishReason === "length" || result.finishReason === "content-filter"
          ? "incomplete"
          : "completed";

  return {
    id: result.response.id || generateItemId("resp"),
    object: "response",
    created_at: now,
    completed_at: status === "completed" ? now : null,
    status,
    incomplete_details: status === "incomplete" ? { reason: result.finishReason } : null,
    model: result.response.modelId,
    previous_response_id: null,
    instructions: null,
    input: buildInputFromSteps(result, prompt),
    output,
    error: status === "failed" ? { message: "Agent execution failed" } : null,
    tools,
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: true,
    text: {
      format: {
        type: "text",
      },
    },
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    temperature: 1,
    reasoning: null,
    user: null,
    usage,
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: "default",
    metadata: {},
    safety_identifier: null,
    prompt_cache_key: null,
  } as ResponseResource;
}

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
 * await evaluatorq("agent-evaluation", {
 *   data: [
 *     { inputs: { prompt: "What is the weather in SF?" } },
 *     { inputs: { prompt: "What is the weather in NYC?" } },
 *   ],
 *   jobs: [agentJob(weatherAgent)],
 *   evaluators: [
 *     {
 *       name: "response-quality",
 *       scorer: async ({ output }) => {
 *         const result = output as unknown as ResponseResource;
 *         // Access the final message text
 *         const lastMessage = result.output.find(
 *           (item) => item.type === "message"
 *         ) as Message | undefined;
 *         const text = lastMessage?.content[0]?.text ?? "";
 *         return {
 *           value: text.length > 0 ? 1 : 0,
 *           explanation: `Response: ${text}`,
 *         };
 *       },
 *     },
 *   ],
 * });
 * ```
 */
function wrapAISdkAgent<TOOLS extends ToolSet>(
  agent: Agent<never, TOOLS, never>,
  options: AgentJobOptions = {}
): Job {
  const {
    name = agent.id ?? "agent",
    promptKey = "prompt"
  } = options;

  return async (data: DataPoint, _row: number) => {
    const prompt = data.inputs[promptKey];

    if (typeof prompt !== "string") {
      throw new Error(
        `Expected data.inputs.${promptKey} to be a string, got ${typeof prompt}`
      );
    }

    const result = await agent.generate({ prompt });

    // Convert to OpenResponses format
    const openResponsesOutput = convertToOpenResponses(result, agent, prompt);

    return {
      name,
      output: openResponsesOutput as unknown as Output,
    };
  };
}

// ============================================================
// Usage Example
// ============================================================
//
// Now users can simply do:
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