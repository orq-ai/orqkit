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
  // biome-ignore lint/suspicious/noExplicitAny: cached client type depends on dynamic import
  let cachedClient: any = null;

  // Multi-turn continuity: the agent stream API maintains conversation state
  // via task_id. On the first turn, we start a new conversation. On subsequent
  // turns, we pass the task_id from the previous response to continue the
  // conversation. Use first message content to identify conversations.
  const conversationTasks = new Map<string, string>();

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

    const firstUserMessage = messages.find((m) => m.role === "user");
    if (!firstUserMessage) {
      throw new Error(
        `fromOrqAgent: conversation has no user message to send to "${agentKey}".`,
      );
    }

    // Check if this is a continuation of an existing conversation
    // Use first message content as conversation identifier
    const conversationKey = firstUserMessage.content;
    const existingTaskId = conversationTasks.get(conversationKey);

    // Send only the latest user message; prior turns are reconstructed
    // server-side from the task_id.
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

    // Build request with optional taskId for conversation continuation
    const streamRequest = {
      message: {
        role: "user",
        parts: [{ kind: "text" as const, text: messageText }],
      },
      ...(existingTaskId && { taskId: existingTaskId }),
    };

    const stream = await cachedClient.agents.stream(streamRequest, agentKey, {
      headers: traceHeaders,
    });

    // Consume stream and extract the final agent message + task ID
    let lastMessage: string | undefined;
    let taskId: string | undefined;
    for await (const event of stream) {
      const data = (event as Record<string, unknown>).data as
        | Record<string, unknown>
        | undefined;
      if (data?.type === "event.agents.inactive") {
        const innerData = data.data as Record<string, unknown> | undefined;
        lastMessage = (innerData?.lastMessage as string) ?? "";
        taskId = (innerData?.taskId as string) ?? undefined;
      }
    }

    if (!lastMessage) {
      throw new Error(
        `Agent stream for "${agentKey}" ended without an event.agents.inactive event. ` +
          "The agent may have errored out server-side.",
      );
    }

    // Store task ID for conversation continuation
    if (taskId) {
      conversationTasks.set(conversationKey, taskId);
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
