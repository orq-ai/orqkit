import type { Agent, StepResult, ToolSet } from "ai";

import {
  generateItemId,
  getResponseStatus,
  serializeArgs,
} from "../common/index.js";
import type {
  FunctionCall,
  FunctionCallOutput,
  FunctionTool,
  ItemField,
  Message,
  ResponseResource,
  Usage,
} from "../openresponses/index.js";
import type { StepData } from "./types.js";

/**
 * Type alias for a step from an Agent result.
 * Uses the AI SDK's StepResult type with our extended StepData fields.
 */
type AgentStep = StepResult<ToolSet> & StepData;

/**
 * Builds the input array for OpenResponses format.
 *
 * Resolves item_reference entries to actual function_call items using data from steps.
 * The input should contain:
 * - User message
 * - All function calls made during the conversation
 * - All function call outputs returned
 */
export function buildInputFromSteps<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  prompt: string | undefined,
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
    const stepData = step as AgentStep;

    // Primary: Extract from content array (ToolLoopAgent format)
    if (stepData.content && stepData.content.length > 0) {
      for (const item of stepData.content) {
        if (item.type === "tool-call" && item.toolCallId && item.toolName) {
          input.push({
            type: "function_call",
            id: generateItemId("fc"),
            call_id: item.toolCallId,
            name: item.toolName,
            arguments: serializeArgs(item.input),
          });
        }
        if (item.type === "tool-result" && item.toolCallId) {
          input.push({
            type: "function_call_output",
            call_id: item.toolCallId,
            output: serializeArgs(item.output),
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
            arguments: serializeArgs(toolCall.input),
          });
        }
      }

      if (stepData.toolResults && stepData.toolResults.length > 0) {
        for (const toolResult of stepData.toolResults) {
          input.push({
            type: "function_call_output",
            call_id: toolResult.toolCallId,
            output: serializeArgs(toolResult.output),
          });
        }
      }
    }
  }

  return input;
}

/**
 * Converts Vercel AI SDK agent result to OpenResponses format.
 */
export function convertToOpenResponses<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  agent: Agent<never, TOOLS, never>,
  prompt?: string,
): ResponseResource {
  return buildOpenResponsesFromSteps(result, agent, prompt);
}

/**
 * Extended step data type for extracting additional fields from AI SDK.
 * Uses intersection type to include StepResult properties and additional provider-specific fields.
 */
interface ExtendedStepData {
  text?: string;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    output: unknown;
  }>;
  request?: {
    body?: {
      max_output_tokens?: number;
      tool_choice?: string;
      temperature?: number;
      top_p?: number;
      presence_penalty?: number;
      frequency_penalty?: number;
    };
  };
  response?: {
    timestamp?: Date | string;
    id?: string;
    modelId?: string;
  };
  providerMetadata?: {
    openai?: {
      serviceTier?: string;
    };
  };
}

/**
 * Fallback function to manually build OpenResponses format from steps.
 * Used when the provider doesn't return native OpenResponses format.
 */
export function buildOpenResponsesFromSteps<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  agent: Agent<never, TOOLS, never>,
  prompt?: string,
): ResponseResource {
  const now = Math.floor(Date.now() / 1000);

  // Extract configuration from first step's request body
  const firstStep = result.steps[0] as ExtendedStepData;
  const lastStep = result.steps[result.steps.length - 1] as ExtendedStepData;
  const requestBody = firstStep?.request?.body;

  // Extract timestamps from response (handle both Date and string formats)
  const getTimestamp = (ts: Date | string | undefined): number => {
    if (!ts) return now;
    return Math.floor(
      (ts instanceof Date ? ts : new Date(ts)).getTime() / 1000,
    );
  };
  const createdAt = getTimestamp(firstStep?.response?.timestamp);
  const completedAt = getTimestamp(lastStep?.response?.timestamp);

  // Extract service tier from provider metadata
  const serviceTier =
    lastStep?.providerMetadata?.openai?.serviceTier ?? "default";

  // Convert tools from agent configuration
  const tools: FunctionTool[] = [];
  if (agent.tools) {
    for (const [toolName, toolDef] of Object.entries(agent.tools)) {
      const toolConfig = toolDef as {
        description?: string;
        parameters?: unknown;
      };
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
    const stepData = step as ExtendedStepData;

    // Add function calls from this step
    if (stepData.toolCalls && stepData.toolCalls.length > 0) {
      for (const toolCall of stepData.toolCalls) {
        const functionCall: FunctionCall = {
          type: "function_call",
          id: generateItemId("fc"),
          call_id: toolCall.toolCallId || `call_${callIdCounter++}`,
          name: toolCall.toolName,
          arguments: serializeArgs(toolCall.input),
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
          output: serializeArgs(toolResult.output),
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
        input_tokens_details: {
          cached_tokens:
            (result.totalUsage as { cachedInputTokens?: number })
              .cachedInputTokens ?? 0,
        },
        output_tokens: result.totalUsage.outputTokens ?? 0,
        output_tokens_details: {
          reasoning_tokens:
            (result.totalUsage as { reasoningTokens?: number })
              .reasoningTokens ?? 0,
        },
        total_tokens: result.totalUsage.totalTokens ?? 0,
      }
    : null;

  const status = getResponseStatus(result.finishReason);

  return {
    id: result.response.id || generateItemId("resp"),
    object: "response",
    created_at: createdAt,
    completed_at: status === "completed" ? completedAt : null,
    status,
    incomplete_details:
      status === "incomplete" ? { reason: result.finishReason } : null,
    model: result.response.modelId,
    previous_response_id: null,
    instructions: null,
    input: buildInputFromSteps(result, prompt),
    output,
    error: status === "failed" ? { message: "Agent execution failed" } : null,
    tools,
    tool_choice: requestBody?.tool_choice ?? "auto",
    truncation: "disabled",
    parallel_tool_calls: true,
    text: {
      format: {
        type: "text",
      },
    },
    top_p: requestBody?.top_p ?? 1,
    presence_penalty: requestBody?.presence_penalty ?? 0,
    frequency_penalty: requestBody?.frequency_penalty ?? 0,
    top_logprobs: 0,
    temperature: requestBody?.temperature ?? 1,
    reasoning: null,
    user: null,
    usage,
    max_output_tokens: requestBody?.max_output_tokens ?? null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: serviceTier,
    metadata: { framework: "vercel-ai-sdk" },
    safety_identifier: null,
    prompt_cache_key: null,
  } as ResponseResource;
}
