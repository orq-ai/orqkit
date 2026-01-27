/**
 * Conversion functions from LangChain messages to OpenResponses format.
 */

import type {
  FunctionCall,
  FunctionCallOutput,
  FunctionTool,
  ItemField,
  Message,
  ResponseResource,
  Usage,
} from "../../../generated/openresponses/index.js";
import { generateItemId, serializeArgs } from "../common/index.js";
import type {
  ContentBlock,
  LangChainMessage,
  ResponseMetadata,
  ToolCall,
  ToolDefinition,
  UsageMetadata,
} from "./types.js";

/**
 * Converts LangChain agent messages to OpenResponses format.
 *
 * This function handles both LangChain message objects and dict representations.
 *
 * @param messages - List of LangChain messages from agent execution
 * @param tools - Optional list of tool definitions used by the agent
 * @returns A ResponseResource in OpenResponses format
 */
export function convertToOpenResponses(
  messages: LangChainMessage[],
  tools?: ToolDefinition[],
): ResponseResource {
  const now = Math.floor(Date.now() / 1000);

  const inputItems: Array<Message | FunctionCall | FunctionCallOutput> = [];
  const outputItems: Array<Message | FunctionCall | FunctionCallOutput> = [];

  // Track usage across all messages
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let modelName = "unknown";
  let lastFinishReason = "stop";

  for (const msg of messages) {
    // Handle both message objects and dict format
    const msgType = getMessageType(msg);
    const msgData = getMessageData(msg);

    if (msgType === "human") {
      // User message goes into input
      const contentText = getContent(msgData);
      const inputMessage: Message = {
        type: "message",
        id: generateItemId("msg"),
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: contentText }],
      };
      inputItems.push(inputMessage);
    } else if (msgType === "ai") {
      // Extract usage metadata
      const usage = extractUsage(msgData);
      if (usage) {
        totalInputTokens += usage.input_tokens ?? 0;
        totalOutputTokens += usage.output_tokens ?? 0;
        totalTokens += usage.total_tokens ?? 0;
        cachedTokens += usage.input_token_details?.cache_read ?? 0;
        reasoningTokens += usage.output_token_details?.reasoning ?? 0;
      }

      // Extract model name from response metadata
      const responseMetadata = getResponseMetadata(msgData);
      if (responseMetadata?.model_name) {
        modelName = responseMetadata.model_name;
      }
      if (responseMetadata?.finish_reason) {
        lastFinishReason = responseMetadata.finish_reason;
      }

      // Check for tool calls
      const toolCalls = getToolCalls(msgData);
      if (toolCalls.length > 0) {
        // AI message with tool calls -> function_call items
        for (const tc of toolCalls) {
          const callId = tc.id ?? generateItemId("call");
          const functionCall: FunctionCall = {
            type: "function_call",
            id: generateItemId("fc"),
            call_id: callId,
            name: tc.name ?? "unknown",
            arguments: serializeArgs(tc.args ?? {}),
            status: "completed",
          };
          outputItems.push(functionCall);
        }
      } else {
        // Final AI message with text content -> output message
        const contentText = getContent(msgData);
        if (contentText) {
          const outputMessage: Message = {
            type: "message",
            id: generateItemId("msg"),
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: contentText,
                annotations: [],
                logprobs: [],
              },
            ],
          };
          outputItems.push(outputMessage);
        }
      }
    } else if (msgType === "tool") {
      // Tool output -> function_call_output
      const toolCallId = getToolCallId(msgData);
      const outputContent = getContent(msgData);

      const functionCallOutput: FunctionCallOutput = {
        type: "function_call_output",
        id: generateItemId("fco"),
        call_id: toolCallId,
        output: outputContent,
        status: "completed",
      };
      outputItems.push(functionCallOutput);
    } else if (msgType === "system") {
      // System message goes into input
      const contentText = getContent(msgData);
      const systemMessage: Message = {
        type: "message",
        id: generateItemId("msg"),
        role: "system" as Message["role"],
        status: "completed",
        content: [{ type: "input_text", text: contentText }],
      };
      inputItems.push(systemMessage);
    }
  }

  // Build tools array
  const toolsArray: FunctionTool[] = [];
  if (tools) {
    for (const toolDef of tools) {
      const tool: FunctionTool = {
        type: "function",
        name: toolDef.name ?? "unknown",
        description: toolDef.description ?? null,
        parameters: toolDef.parameters ?? null,
        strict: null,
      };
      toolsArray.push(tool);
    }
  }

  // Determine status from finish reason
  let status: ResponseResource["status"] = "completed";
  let incompleteDetails: ResponseResource["incomplete_details"] = null;
  if (lastFinishReason === "error") {
    status = "failed";
  } else if (
    lastFinishReason === "length" ||
    lastFinishReason === "content-filter"
  ) {
    status = "incomplete";
    incompleteDetails = { reason: lastFinishReason };
  }

  // Build usage
  let usageData: Usage | null = null;
  if (totalTokens > 0) {
    usageData = {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalTokens,
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens_details: { reasoning_tokens: reasoningTokens },
    };
  }

  return {
    id: generateItemId("resp"),
    object: "response",
    created_at: now,
    completed_at: status === "completed" ? now : null,
    status,
    incomplete_details: incompleteDetails,
    model: modelName,
    previous_response_id: null,
    instructions: null,
    input: inputItems as ItemField[],
    output: outputItems as ItemField[],
    error: status === "failed" ? { message: "Agent execution failed" } : null,
    tools: toolsArray,
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: true,
    text: {
      format: { type: "text" },
    },
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    temperature: 1,
    reasoning: null,
    user: null,
    usage: usageData,
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
 * Extract message type from message object or dict.
 */
function getMessageType(msg: LangChainMessage): string {
  // Dict format (from messages_to_dict)
  if (typeof msg === "object" && msg !== null) {
    // Check explicit type property
    if (msg.type) {
      return msg.type;
    }

    // Check for nested data.type in dict format
    const msgDict = msg as Record<string, unknown>;
    if (
      msgDict.data &&
      typeof msgDict.data === "object" &&
      msgDict.data !== null
    ) {
      const data = msgDict.data as Record<string, unknown>;
      if (typeof data.type === "string") {
        return data.type;
      }
    }
  }

  return "unknown";
}

/**
 * Extract message data from message object or dict.
 */
function getMessageData(msg: LangChainMessage): LangChainMessage {
  // Dict format (from messages_to_dict) has nested "data" property
  const msgDict = msg as Record<string, unknown>;
  if (
    msgDict.data &&
    typeof msgDict.data === "object" &&
    msgDict.data !== null
  ) {
    return msgDict.data as LangChainMessage;
  }

  // LangChain message object - use directly
  return msg;
}

/**
 * Extract content from message data.
 */
function getContent(msgData: LangChainMessage): string {
  const content = msgData.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    // Handle content blocks
    const textParts: string[] = [];
    for (const item of content) {
      if (
        typeof item === "object" &&
        item !== null &&
        (item as ContentBlock).type === "text"
      ) {
        textParts.push((item as ContentBlock).text ?? "");
      } else if (typeof item === "string") {
        textParts.push(item);
      }
    }
    return textParts.join("");
  }

  return content ? String(content) : "";
}

/**
 * Extract tool calls from AI message data.
 */
function getToolCalls(msgData: LangChainMessage): ToolCall[] {
  const toolCalls = msgData.tool_calls;

  if (!toolCalls || !Array.isArray(toolCalls)) {
    return [];
  }

  const result: ToolCall[] = [];
  for (const tc of toolCalls) {
    if (typeof tc === "object" && tc !== null) {
      result.push({
        id: (tc as ToolCall).id,
        name: (tc as ToolCall).name ?? "unknown",
        args: (tc as ToolCall).args ?? {},
      });
    }
  }

  return result;
}

/**
 * Extract tool call ID from tool message data.
 */
function getToolCallId(msgData: LangChainMessage): string {
  return msgData.tool_call_id ?? generateItemId("call");
}

/**
 * Extract response metadata from message data.
 */
function getResponseMetadata(
  msgData: LangChainMessage,
): ResponseMetadata | undefined {
  return msgData.response_metadata;
}

/**
 * Extract usage metadata from message data.
 */
function extractUsage(msgData: LangChainMessage): UsageMetadata | undefined {
  return msgData.usage_metadata;
}
