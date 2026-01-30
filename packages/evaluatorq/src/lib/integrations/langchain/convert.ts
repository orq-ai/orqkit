/**
 * Conversion functions from LangChain messages to OpenResponses format.
 */

import type { BaseMessage } from "@langchain/core/messages";

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
import type {
  ContentBlock,
  LangChainMessage,
  ResponseMetadata,
  ToolCall,
  ToolDefinition,
  UsageMetadata,
} from "./types.js";

/**
 * Union type for message input - accepts both BaseMessage from @langchain/core
 * and the local LangChainMessage interface for flexibility.
 */
export type MessageInput = BaseMessage | LangChainMessage;

/**
 * Type guard to check if a message is a BaseMessage from @langchain/core.
 */
function isBaseMessage(msg: MessageInput): msg is BaseMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "_getType" in msg &&
    typeof (msg as BaseMessage)._getType === "function"
  );
}

/**
 * Type guard to check if an object has a specific property.
 */
function hasProperty<K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> {
  return typeof obj === "object" && obj !== null && key in obj;
}

/**
 * Converts LangChain agent messages to OpenResponses format.
 *
 * This function handles both LangChain message objects (BaseMessage) and dict representations.
 *
 * @param messages - List of LangChain messages from agent execution (supports BaseMessage or LangChainMessage)
 * @param tools - Optional list of tool definitions used by the agent
 * @returns A ResponseResource in OpenResponses format
 */
export function convertToOpenResponses(
  messages: MessageInput[],
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
  let lastAIMessageId: string | undefined;
  let modelProvider: string | undefined;
  let systemFingerprint: string | undefined;

  for (const msg of messages) {
    // Handle both message objects and dict format
    const msgType = getMessageType(msg);
    const msgData = getMessageData(msg);

    if (msgType === "human") {
      // User message goes into input
      const contentText = getContent(msgData);
      const inputMessage: Message = {
        type: "message",
        id: msg.id ?? generateItemId("msg"),
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: contentText }],
      };
      inputItems.push(inputMessage);
    } else if (msgType === "ai") {
      // Extract usage metadata
      const usage = msgData.usage_metadata;
      if (usage) {
        totalInputTokens += usage.input_tokens ?? 0;
        totalOutputTokens += usage.output_tokens ?? 0;
        totalTokens += usage.total_tokens ?? 0;
        cachedTokens += usage.input_token_details?.cache_read ?? 0;
        reasoningTokens += usage.output_token_details?.reasoning ?? 0;
      }

      // Extract model name and other metadata from response metadata
      const responseMetadata = msgData.response_metadata;
      if (responseMetadata?.model_name) {
        modelName = responseMetadata.model_name;
      }
      if (responseMetadata?.finish_reason) {
        lastFinishReason = responseMetadata.finish_reason;
      }
      if (responseMetadata?.model_provider) {
        modelProvider = responseMetadata.model_provider;
      }
      if (responseMetadata?.system_fingerprint) {
        systemFingerprint = responseMetadata.system_fingerprint;
      }

      // Extract message ID (e.g., chatcmpl-... from OpenAI)
      if (msgData.id) {
        lastAIMessageId = msgData.id;
      }

      // Check for tool calls
      const toolCalls = getToolCalls(msgData);
      if (toolCalls.length > 0) {
        // AI message with tool calls -> function_call items
        for (const tc of toolCalls) {
          const callId = tc.id ?? generateItemId("call");
          const functionCall: FunctionCall = {
            type: "function_call",
            id: tc.id ?? generateItemId("fc"),
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
            id: msg.id ?? generateItemId("msg"),
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
      const toolCallId = msgData.tool_call_id ?? generateItemId("call");
      const outputContent = getContent(msgData);

      const functionCallOutput: FunctionCallOutput = {
        type: "function_call_output",
        id: msg.id ?? generateItemId("fco"),
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
        id: msg.id ?? generateItemId("msg"),
        role: "system" as Message["role"],
        status: "completed",
        content: [{ type: "input_text", text: contentText }],
      };
      inputItems.push(systemMessage);
    }
  }

  // Build tools array
  const toolsArray: FunctionTool[] =
    tools?.map((toolDef) => ({
      type: "function" as const,
      name: toolDef.name ?? "unknown",
      description: toolDef.description ?? null,
      parameters: toolDef.parameters ?? null,
      strict: null,
    })) ?? [];

  // Determine status from finish reason
  const status = getResponseStatus(lastFinishReason);
  const incompleteDetails: ResponseResource["incomplete_details"] =
    status === "incomplete" ? { reason: lastFinishReason } : null;

  // Build usage
  let usageData: Usage | null = null;
  if (totalTokens > 0) {
    usageData = {
      input_tokens: totalInputTokens,
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens: totalOutputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: totalTokens,
    };
  }

  // Use the last AI message ID as the response ID if available
  const responseId = lastAIMessageId ?? generateItemId("resp");

  return {
    id: responseId,
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
    metadata: {
      framework: "langchain",
      ...(modelProvider && { model_provider: modelProvider }),
      ...(systemFingerprint && { system_fingerprint: systemFingerprint }),
    },
    safety_identifier: null,
    prompt_cache_key: null,
  } as ResponseResource;
}

/**
 * Map constructor ID to message type.
 */
const CONSTRUCTOR_TYPE_MAP: Record<string, string> = {
  HumanMessage: "human",
  AIMessage: "ai",
  ToolMessage: "tool",
  SystemMessage: "system",
};

/**
 * Extract message type from message object or dict.
 */
function getMessageType(msg: MessageInput): string {
  // Handle BaseMessage from @langchain/core (has _getType() method)
  if (isBaseMessage(msg)) {
    return msg._getType();
  }

  // Dict format (from messages_to_dict)
  if (typeof msg === "object" && msg !== null) {
    // Check for constructor format (lc serialization)
    // Format: { lc: 1, type: "constructor", id: ["langchain_core", "messages", "HumanMessage"], kwargs: {...} }
    if (
      hasProperty(msg, "type") &&
      msg.type === "constructor" &&
      hasProperty(msg, "id") &&
      Array.isArray(msg.id)
    ) {
      const idArray = msg.id as string[];
      // The message type is the last element in the id array (e.g., "HumanMessage")
      const constructorName = idArray[idArray.length - 1];
      if (constructorName && CONSTRUCTOR_TYPE_MAP[constructorName]) {
        return CONSTRUCTOR_TYPE_MAP[constructorName];
      }
    }

    // Check explicit type property (direct message format)
    const localMsg = msg as LangChainMessage;
    if (localMsg.type && localMsg.type !== "constructor") {
      return localMsg.type;
    }

    // Check for nested data.type in dict format
    if (
      hasProperty(msg, "data") &&
      typeof msg.data === "object" &&
      msg.data !== null
    ) {
      const data = msg.data as Record<string, unknown>;
      if (typeof data.type === "string") {
        return data.type;
      }
    }
  }

  return "unknown";
}

/**
 * Extract message data from message object or dict.
 * Returns a LangChainMessage-compatible object for uniform processing.
 */
function getMessageData(msg: MessageInput): LangChainMessage {
  // Handle BaseMessage from @langchain/core
  if (isBaseMessage(msg)) {
    // BaseMessage properties map directly to LangChainMessage
    return {
      type: msg._getType(),
      content: msg.content as string | ContentBlock[],
      tool_calls: hasProperty(msg, "tool_calls")
        ? (msg.tool_calls as ToolCall[])
        : undefined,
      tool_call_id: hasProperty(msg, "tool_call_id")
        ? (msg.tool_call_id as string)
        : undefined,
      response_metadata: hasProperty(msg, "response_metadata")
        ? (msg.response_metadata as ResponseMetadata)
        : undefined,
      usage_metadata: hasProperty(msg, "usage_metadata")
        ? (msg.usage_metadata as UsageMetadata)
        : undefined,
      id: msg.id,
    };
  }

  // Constructor format (lc serialization) has data in "kwargs" property
  // Format: { lc: 1, type: "constructor", id: [...], kwargs: { content, response_metadata, ... } }
  if (
    hasProperty(msg, "type") &&
    msg.type === "constructor" &&
    hasProperty(msg, "kwargs")
  ) {
    return msg.kwargs as LangChainMessage;
  }

  // Dict format (from messages_to_dict) has nested "data" property
  if (
    hasProperty(msg, "data") &&
    typeof msg.data === "object" &&
    msg.data !== null
  ) {
    return msg.data as LangChainMessage;
  }

  // LangChain message object - use directly
  return msg as LangChainMessage;
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
