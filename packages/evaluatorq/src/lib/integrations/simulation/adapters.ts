/**
 * Convenience adapters for creating simulation targetCallbacks.
 *
 * These helpers create `targetCallback` functions from common agent sources,
 * so users don't need to wire the plumbing themselves.
 */

import type { ChatMessage } from "./types.js";

/**
 * Creates a simulation `targetCallback` from an Orq deployment key.
 *
 * This is the same bridge that `simulate()` and `wrapSimulationAgent()` use
 * internally when you pass `agentKey`, but exposed as a standalone function
 * so you can compose it freely.
 *
 * @example
 * ```typescript
 * import { fromOrqDeployment, simulate } from "@orq-ai/evaluatorq/simulation";
 *
 * const callback = fromOrqDeployment("my-agent-deployment-key");
 *
 * const results = await simulate({
 *   evaluationName: "my-sim",
 *   targetCallback: callback,
 *   personas: [...],
 *   scenarios: [...],
 * });
 * ```
 */
export function fromOrqDeployment(
  agentKey: string,
): (messages: ChatMessage[]) => Promise<string> {
  if (!agentKey.trim()) {
    throw new Error("agentKey must be a non-empty string");
  }

  return async (messages: ChatMessage[]): Promise<string> => {
    const { invoke } = await import("../../deployment-helper.js");
    return invoke(agentKey, { messages });
  };
}

/**
 * Creates a simulation `targetCallback` from a plain function that calls
 * an OpenAI-compatible chat completions API.
 *
 * Useful for raw OpenAI SDK, Azure OpenAI, or any OpenAI-compatible provider.
 *
 * @example
 * ```typescript
 * import OpenAI from "openai";
 * import { fromChatCompletions, simulate } from "@orq-ai/evaluatorq/simulation";
 *
 * const client = new OpenAI();
 * const callback = fromChatCompletions(async (messages) => {
 *   const res = await client.chat.completions.create({
 *     model: "gpt-4o",
 *     messages,
 *   });
 *   return res.choices[0]?.message.content ?? "";
 * });
 *
 * await simulate({ targetCallback: callback, ... });
 * ```
 */
export function fromChatCompletions(
  fn: (
    messages: Array<{ role: string; content: string }>,
  ) => string | Promise<string>,
): (messages: ChatMessage[]) => Promise<string> {
  return async (messages: ChatMessage[]): Promise<string> => {
    return fn(messages.map((m) => ({ role: m.role, content: m.content })));
  };
}
