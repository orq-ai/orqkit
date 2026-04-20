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
 * Uses the deployments API (`client.deployments.invoke()`).
 * For agents, use {@link fromOrqAgent} instead.
 *
 * @example
 * ```typescript
 * import { fromOrqDeployment, simulate } from "@orq-ai/evaluatorq/simulation";
 *
 * const callback = fromOrqDeployment("my-deployment-key");
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
  deploymentKey: string,
): (messages: ChatMessage[]) => Promise<string> {
  if (!deploymentKey.trim()) {
    throw new Error("deploymentKey must be a non-empty string");
  }

  return async (messages: ChatMessage[]): Promise<string> => {
    const { invoke } = await import("../../deployment-helper.js");
    return invoke(deploymentKey, { messages });
  };
}

/**
 * Creates a simulation `targetCallback` from an Orq agent key.
 *
 * Uses the agents streaming API to get synchronous responses.
 * Propagates OTel trace context so agent-side LLM spans appear
 * under the simulation's `target_call` span.
 *
 * This is the adapter used internally when you pass `agentKey` to `simulate()`.
 *
 * @example
 * ```typescript
 * import { fromOrqAgent, simulate } from "@orq-ai/evaluatorq/simulation";
 *
 * const callback = fromOrqAgent("my-agent-key");
 *
 * const results = await simulate({
 *   evaluationName: "my-sim",
 *   targetCallback: callback,
 *   personas: [...],
 *   scenarios: [...],
 * });
 * ```
 */
export function fromOrqAgent(
  agentKey: string,
): (messages: ChatMessage[]) => Promise<string> {
  if (!agentKey.trim()) {
    throw new Error("agentKey must be a non-empty string");
  }

  // Cache client across calls to avoid creating a new one per turn
  // biome-ignore lint: dynamic import type
  let cachedClient: any = null;

  return async (messages: ChatMessage[]): Promise<string> => {
    const apiKey = process.env.ORQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ORQ_API_KEY environment variable must be set to use the agent adapter.",
      );
    }

    if (!cachedClient) {
      const { Orq } = await import("@orq-ai/node");
      const serverURL = process.env.ORQ_BASE_URL || "https://my.orq.ai";
      cachedClient = new Orq({ apiKey, serverURL });
    }

    // Build the user message from the last user message in the conversation
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const messageText = lastUserMessage?.content ?? "";

    // Propagate OTel trace context so the agent's server-side LLM spans
    // are linked as children of the current simulation span
    let traceHeaders: Record<string, string> = {};
    try {
      const { getTraceContextHeaders } = await import("./tracing.js");
      traceHeaders = await getTraceContextHeaders();
    } catch {
      // Tracing not available — continue without propagation
    }

    const stream = await cachedClient.agents.stream(
      {
        message: {
          role: "user",
          parts: [{ kind: "text" as const, text: messageText }],
        },
      },
      agentKey,
      { headers: traceHeaders },
    );

    // Consume stream and extract the final agent message
    let lastMessage = "";
    for await (const event of stream) {
      const data = (event as Record<string, unknown>).data as
        | Record<string, unknown>
        | undefined;
      if (data?.type === "event.agents.inactive") {
        const innerData = data.data as Record<string, unknown> | undefined;
        lastMessage = (innerData?.lastMessage as string) ?? "";
      }
    }

    return lastMessage;
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
