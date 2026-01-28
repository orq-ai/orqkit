/**
 * Type definitions for LangChain/LangGraph integration.
 */

/**
 * Protocol for LangChain/LangGraph invocable objects.
 *
 * Compatible with:
 * - LangChain ReactAgent (from createAgent in langchain 1.x)
 * - LangGraph compiled graphs (CompiledStateGraph from StateGraph.compile())
 * - Any runnable with an invoke() method returning {"messages": [...]}
 *
 * Note: Using permissive types to accommodate different LangChain versions.
 */
export interface LangChainInvocable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(input: any, config?: any): Promise<any>;
  /** Optional tools property that some agents expose */
  tools?: unknown[];
  /** Optional bound property for accessing nested tools */
  bound?: { tools?: unknown[] };
}

/**
 * Result from a LangChain agent invocation.
 */
export interface LangChainResult {
  messages: LangChainMessage[];
}

/**
 * LangChain message type that handles both object and dict formats.
 */
export interface LangChainMessage {
  /** Message type: "human", "ai", "tool", "system" */
  type?: string;
  /** Message content - can be string or array of content blocks */
  content?: string | ContentBlock[];
  /** Tool calls made by AI messages */
  tool_calls?: ToolCall[];
  /** Tool call ID for tool response messages */
  tool_call_id?: string;
  /** Response metadata from the model */
  response_metadata?: ResponseMetadata;
  /** Token usage metadata */
  usage_metadata?: UsageMetadata;
}

/**
 * Content block within a message (for structured content).
 */
export interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Tool call definition from an AI message.
 */
export interface ToolCall {
  /** Unique identifier for the tool call */
  id?: string;
  /** Name of the tool to call */
  name: string;
  /** Arguments to pass to the tool */
  args: unknown;
}

/**
 * Response metadata from the model.
 */
export interface ResponseMetadata {
  /** Model name that generated the response */
  model_name?: string;
  /** Finish reason (stop, length, etc.) */
  finish_reason?: string;
}

/**
 * Token usage metadata from the model.
 */
export interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { cache_read?: number };
  output_token_details?: { reasoning?: number };
}

/**
 * Options for creating an evaluatorq Job from a LangChain agent.
 */
export interface AgentJobOptions {
  /** The name of the job (defaults to "agent") */
  name?: string;
  /** The key in data.inputs to use as the prompt (defaults to "prompt") */
  promptKey?: string;
}

/**
 * Tool definition for OpenResponses output.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
