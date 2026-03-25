/**
 * Adapter to use Vercel AI SDK agents as simulation targets.
 *
 * Converts an AI SDK Agent into a `targetCallback` compatible with
 * the simulation framework's `simulate()` and `wrapSimulationAgent()`.
 */

import type { Agent, ModelMessage, ToolSet } from "ai";

import type { ChatMessage } from "../simulation/types.js";

/**
 * Options for the AI SDK simulation adapter.
 */
export interface AISdkSimulationAdapterOptions {
  /**
   * System instructions to prepend to every call.
   * If omitted, no system message is added — the agent uses its own defaults.
   */
  instructions?: string;
}

/**
 * Wraps a Vercel AI SDK Agent as a simulation `targetCallback`.
 *
 * The returned function accepts `ChatMessage[]` (the simulation's message format)
 * and returns the agent's text response as a string.
 *
 * @example
 * ```typescript
 * import { ToolLoopAgent, tool } from "ai";
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { toSimulationCallback } from "@orq-ai/evaluatorq/ai-sdk";
 * import { simulate } from "@orq-ai/evaluatorq/simulation";
 *
 * const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
 * const agent = new ToolLoopAgent({
 *   model: openai("gpt-4o"),
 *   tools: { ... },
 * });
 *
 * const results = await simulate({
 *   evaluationName: "my-agent-sim",
 *   targetCallback: toSimulationCallback(agent),
 *   personas: [...],
 *   scenarios: [...],
 * });
 * ```
 */
export function toSimulationCallback<TOOLS extends ToolSet>(
  agent: Agent<never, TOOLS, never>,
  options: AISdkSimulationAdapterOptions = {},
): (messages: ChatMessage[]) => Promise<string> {
  const { instructions } = options;

  return async (messages: ChatMessage[]): Promise<string> => {
    const modelMessages: ModelMessage[] = [];

    if (instructions) {
      modelMessages.push({
        role: "system",
        content: instructions,
      } as ModelMessage);
    }

    for (const msg of messages) {
      modelMessages.push({
        role: msg.role,
        content: msg.content,
      } as ModelMessage);
    }

    const result = await agent.generate({ messages: modelMessages });
    return result.text;
  };
}
