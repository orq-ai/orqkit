import type { Agent, ToolSet } from "ai";

import { generateItemId } from "../common/index.js";
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
            arguments:
              typeof item.input === "string"
                ? item.input
                : JSON.stringify(item.input),
          });
        }
        if (item.type === "tool-result" && item.toolCallId) {
          input.push({
            type: "function_call_output",
            call_id: item.toolCallId,
            output:
              typeof item.output === "string"
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
            arguments:
              typeof toolCall.args === "string"
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
            output:
              typeof toolResult.result === "string"
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
export function convertToOpenResponses<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  _agent: Agent<never, TOOLS, never>,
  prompt?: string,
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
export function buildOpenResponsesFromSteps<TOOLS extends ToolSet>(
  result: Awaited<ReturnType<Agent<never, TOOLS, never>["generate"]>>,
  agent: Agent<never, TOOLS, never>,
  prompt?: string,
): ResponseResource {
  const now = Math.floor(Date.now() / 1000);

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
          arguments:
            typeof toolCall.args === "string"
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
          output:
            typeof toolResult.result === "string"
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
          cached_tokens:
            (result.totalUsage as { cachedInputTokens?: number })
              .cachedInputTokens ?? 0,
        },
        output_tokens_details: {
          reasoning_tokens:
            (result.totalUsage as { reasoningTokens?: number })
              .reasoningTokens ?? 0,
        },
      }
    : null;

  // Determine status from finish reason
  const status: ResponseResource["status"] =
    result.finishReason === "stop" || result.finishReason === "tool-calls"
      ? "completed"
      : result.finishReason === "error"
        ? "failed"
        : result.finishReason === "length" ||
            result.finishReason === "content-filter"
          ? "incomplete"
          : "completed";

  return {
    id: result.response.id || generateItemId("resp"),
    object: "response",
    created_at: now,
    completed_at: status === "completed" ? now : null,
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
