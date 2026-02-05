/**
 * LangChain/LangGraph integration for evaluatorq.
 *
 * This module provides wrappers to convert LangChain agent outputs
 * to OpenResponses format for use with the evaluatorq framework.
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
 * await evaluatorq("langchain-agent-eval", {
 *   data: [{ inputs: { prompt: "What's the weather in SF?" } }],
 *   jobs: [wrapLangChainAgent(agent, { name: "weather-agent" })],
 *   evaluators: [...],
 * });
 * ```
 */

export { convertToOpenResponses } from "./convert.js";
export type {
  AgentJobOptions,
  ContentBlock,
  LangChainInvocable,
  LangChainMessage,
  LangChainResult,
  ResponseMetadata,
  ToolCall,
  ToolDefinition,
  UsageMetadata,
} from "./types.js";
export {
  extractToolsFromAgent,
  wrapLangChainAgent,
  wrapLangGraphAgent,
} from "./wrap-agent.js";
