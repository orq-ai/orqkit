/**
 * Adapter to use LangChain/LangGraph agents as simulation targets.
 *
 * Converts a LangChain invocable into a `targetCallback` compatible with
 * the simulation framework's `simulate()` and `wrapSimulationAgent()`.
 */

import type { ChatMessage } from "../simulation/types.js";
import type { ContentBlock, LangChainInvocable } from "./types.js";

/**
 * Options for the LangChain simulation adapter.
 */
export interface LangChainSimulationAdapterOptions {
  /**
   * System instructions to prepend to every call.
   * If omitted, no system message is added — the agent uses its own defaults.
   */
  instructions?: string;
}

/**
 * Extract text content from a LangChain message's content field.
 * Handles both string content and ContentBlock[] arrays.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (
        typeof block === "object" &&
        block !== null &&
        (block as ContentBlock).type === "text"
      ) {
        parts.push((block as ContentBlock).text ?? "");
      }
    }
    return parts.join("");
  }

  return content ? String(content) : "";
}

/**
 * Wraps a LangChain/LangGraph agent as a simulation `targetCallback`.
 *
 * The returned function accepts `ChatMessage[]` (the simulation's message format)
 * and returns the agent's text response as a string.
 *
 * Compatible with:
 * - LangChain agents created via `createAgent()` (langchain 1.x)
 * - LangGraph compiled graphs (`StateGraph.compile()`)
 * - Any object with an `invoke({ messages })` method
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from "@langchain/openai";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 * import { fromLangChainAgent } from "@orq-ai/evaluatorq/langchain";
 * import { simulate } from "@orq-ai/evaluatorq/simulation";
 *
 * const model = new ChatOpenAI({ model: "gpt-4o" });
 * const agent = createReactAgent({ llm: model, tools: [...] });
 *
 * const results = await simulate({
 *   evaluationName: "my-agent-sim",
 *   targetCallback: fromLangChainAgent(agent),
 *   personas: [...],
 *   scenarios: [...],
 * });
 * ```
 */
export function fromLangChainAgent(
  agent: LangChainInvocable,
  options: LangChainSimulationAdapterOptions = {},
): (messages: ChatMessage[]) => Promise<string> {
  const { instructions } = options;

  return async (messages: ChatMessage[]): Promise<string> => {
    const langchainMessages: Array<{ role: string; content: string }> = [];

    if (instructions) {
      langchainMessages.push({ role: "system", content: instructions });
    }

    for (const msg of messages) {
      langchainMessages.push({ role: msg.role, content: msg.content });
    }

    const result = await agent.invoke({ messages: langchainMessages });

    // Handle agents that return a plain string directly
    if (typeof result === "string") return result;
    if (typeof (result as { output?: unknown }).output === "string") {
      return (result as { output: string }).output;
    }

    // Extract the last AI/assistant message from the result
    const resultMessages = (result as { messages?: unknown[] }).messages;

    if (!resultMessages || resultMessages.length === 0) {
      console.warn(
        "LangChain fromLangChainAgent: agent result contained no messages — returning empty string. " +
          "Ensure the agent returns a state with a `messages` array, or return a string directly.",
      );
      return "";
    }

    // Walk backwards to find the last AI message
    for (let i = resultMessages.length - 1; i >= 0; i--) {
      const msg = resultMessages[i] as Record<string, unknown>;

      // Check for BaseMessage with _getType()
      if (typeof msg._getType === "function") {
        if ((msg._getType as () => string)() === "ai") {
          return extractTextContent(msg.content);
        }
        continue;
      }

      // Check for dict format with type field
      if (msg.type === "ai" || msg.role === "assistant") {
        return extractTextContent(msg.content);
      }

      // Check for constructor format (lc serialization)
      if (
        msg.type === "constructor" &&
        Array.isArray(msg.id) &&
        (msg.id as string[]).includes("AIMessage")
      ) {
        const kwargs = msg.kwargs as Record<string, unknown> | undefined;
        return extractTextContent(kwargs?.content);
      }
    }

    // Fallback: return the content of the last message regardless of type
    const lastMsg = resultMessages[resultMessages.length - 1] as Record<
      string,
      unknown
    >;
    return extractTextContent(lastMsg?.content);
  };
}
