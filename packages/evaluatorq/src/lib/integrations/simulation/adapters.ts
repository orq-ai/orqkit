import { randomUUID } from "node:crypto";

import {
  pipelineMetadataParam,
  threadBodyParam,
} from "../../common/thread-context.js";
import {
  recordLlmResponse,
  recordTokenUsage,
  withLlmSpan,
} from "../../common/tracing.js";
import {
  AgentResponse,
  type AgentTarget,
  DEFAULT_TARGET_MAX_TOKENS,
  DEFAULT_TARGET_TIMEOUT_MS,
  LLMCallConfig,
} from "../../contracts.js";
import { OrqResponsesTarget } from "../openresponses/target.js";
import type { TargetAgent } from "./runner/simulation.js";

/**
 * Convenience adapters for creating simulation targetCallbacks.
 *
 * These helpers create `targetCallback` functions from common agent sources,
 * so users don't need to wire the plumbing themselves.
 */

import { currentConversation } from "./conversation.js";
import { resolveOrqHost } from "./defaults.js";
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
export function fromOrqDeployment(deploymentKey: string): ((
  messages: ChatMessage[],
) => Promise<AgentResponse>) & {
  deploymentKey: string;
} {
  if (!deploymentKey.trim())
    throw new Error("deploymentKey must be a non-empty string");
  const callback = async (messages: ChatMessage[]): Promise<AgentResponse> => {
    const { deployment } = await import("../../deployment-helper.js");
    const payload = {
      messages: messages.map((message) => {
        if (message.role === "tool")
          return {
            role: "tool" as const,
            content: message.content,
            toolCallId: message.tool_call_id ?? null,
          };
        if (message.role === "assistant")
          return {
            role: "assistant" as const,
            content: message.content,
            toolCalls: message.tool_calls?.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.function.name,
                arguments:
                  typeof call.function.arguments === "string"
                    ? call.function.arguments
                    : JSON.stringify(call.function.arguments),
              },
            })),
          };
        return { role: message.role, content: message.content };
      }),
      ...pipelineMetadataParam(),
      ...threadBodyParam(),
    };
    return withLlmSpan(
      {
        model: `deployment:${deploymentKey}`,
        operation: "invoke",
        provider: "orq",
        inputMessages: payload.messages,
        attributes: { "orq.llm.purpose": "target" },
      },
      async (span) => {
        const response = await deployment(deploymentKey, payload);
        recordLlmResponse(span, response.raw, {
          outputContent: response.content,
        });
        if (response.usage) recordTokenUsage(span, { usage: response.usage });
        return new AgentResponse({
          text: response.content,
          usage: response.usage,
        });
      },
    );
  };
  return Object.assign(callback, { deploymentKey });
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

  // The agent stream API keeps conversation state under a task id. Rows can share
  // an opener and overlap, so the runner's conversation tells them apart, and its
  // task id goes when the conversation does. A caller outside the runner gets one
  // conversation per opener.
  const conversationTasks = new WeakMap<object, string>();
  const openerConversations = new Map<string, object>();
  const conversationForOpener = (opener: string): object => {
    const known = openerConversations.get(opener);
    if (known) {
      return known;
    }
    const conversation = {};
    openerConversations.set(opener, conversation);
    return conversation;
  };

  return async (messages: ChatMessage[]): Promise<string> => {
    const apiKey = process.env.ORQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ORQ_API_KEY environment variable must be set to use the agent adapter.",
      );
    }

    if (!cachedClient) {
      const { Orq } = await import("@orq-ai/node");
      cachedClient = new Orq({ apiKey, serverURL: resolveOrqHost() });
    }

    const firstUserMessage = messages.find((m) => m.role === "user");
    if (!firstUserMessage) {
      throw new Error(
        `fromOrqAgent: conversation has no user message to send to "${agentKey}".`,
      );
    }

    const conversation =
      currentConversation() ?? conversationForOpener(firstUserMessage.content);
    const isFirstTurn = !messages.some((m) => m.role === "assistant");
    const existingTaskId = isFirstTurn
      ? undefined
      : conversationTasks.get(conversation);
    if (!isFirstTurn && !existingTaskId) {
      throw new Error(
        `Agent "${agentKey}" has no task id for this conversation, so this turn cannot continue it.`,
      );
    }

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
      // Tracing not available : continue without propagation
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
      const innerData = data?.data as Record<string, unknown> | undefined;
      if (data?.type === "agents.execution_started") {
        taskId = innerData?.agentTaskId as string | undefined;
      }
      if (data?.type === "event.agents.inactive") {
        lastMessage = (innerData?.lastMessage as string) ?? "";
      }
    }

    if (!lastMessage) {
      throw new Error(
        `Agent stream for "${agentKey}" ended without an event.agents.inactive event. ` +
          "The agent may have errored out server-side.",
      );
    }

    const nextTaskId = taskId ?? existingTaskId;
    if (nextTaskId) {
      conversationTasks.set(conversation, nextTaskId);
    } else {
      conversationTasks.delete(conversation);
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
 *     model: "your-model",
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
  ) => string | AgentResponse | Promise<string | AgentResponse>,
): (messages: ChatMessage[]) => Promise<string | AgentResponse> {
  return async (messages: ChatMessage[]): Promise<string | AgentResponse> => {
    return fn(messages.map((m) => ({ role: m.role, content: m.content })));
  };
}

export interface SimulationTargetOptions {
  target?:
    | string
    | import("./types.js").TargetCallback
    | AgentTarget
    | TargetAgent;
  targetAgent?: AgentTarget | TargetAgent;
  targetCallback?: import("./types.js").TargetCallback;
  agentKey?: string;
  memoryEntityId?: string;
  targetReasoningEffort?: string;
  targetAgentTimeoutMs?: number;
}

export function resolveSimulationTarget(options: SimulationTargetOptions): {
  targetAgent?: AgentTarget | TargetAgent;
  targetCallback?: import("./types.js").TargetCallback;
} {
  if (
    options.target !== undefined &&
    (options.targetCallback ||
      options.agentKey !== undefined ||
      options.targetAgent)
  )
    throw new Error(
      "target cannot be combined with targetCallback, agentKey, or targetAgent",
    );
  const selected =
    options.target ?? options.targetAgent ?? options.targetCallback;
  if (
    options.memoryEntityId !== undefined &&
    (!options.memoryEntityId.trim() ||
      typeof selected !== "string" ||
      selected.startsWith("deployment:"))
  )
    throw new Error(
      "memoryEntityId requires a non-empty id and a string agent target",
    );
  if (selected === undefined && options.agentKey !== undefined) {
    if (options.targetReasoningEffort)
      console.warn(
        "targetReasoningEffort does not apply to legacy agentKey; use target: 'agent:<key>'",
      );
    return { targetCallback: fromOrqAgent(options.agentKey) };
  }
  if (typeof selected === "string") {
    if (!selected.trim())
      throw new Error("agentKey must be a non-empty string");
    if (selected.startsWith("deployment:")) {
      if (options.targetReasoningEffort)
        console.warn(
          "targetReasoningEffort does not apply to deployment targets",
        );
      return {
        targetCallback: fromOrqDeployment(selected.slice("deployment:".length)),
      };
    }
    if (selected.includes(":") && !selected.startsWith("agent:"))
      throw new Error(
        "Unsupported simulation target kind; use agent:<key>, deployment:<key>, an AgentTarget, or a callback",
      );
    const key = selected.replace(/^agent:/, "");
    if (!key.trim()) throw new Error("agentKey must be a non-empty string");
    const target = new OrqResponsesTarget(
      new LLMCallConfig({
        model: `agent/${key}`,
        maxTokens: DEFAULT_TARGET_MAX_TOKENS,
        timeoutMs: options.targetAgentTimeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS,
        ...(options.targetReasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.targetReasoningEffort }),
      }),
      { requireOrq: true, memoryEntityId: options.memoryEntityId },
    );
    if (options.memoryEntityId === undefined)
      target.mintMemoryEntityId(randomUUID());
    return { targetAgent: target };
  }
  if (options.targetReasoningEffort)
    console.warn(
      "targetReasoningEffort does not apply to preconstructed targets or callbacks; configure the target directly",
    );
  if (typeof selected === "function") return { targetCallback: selected };
  if (selected && typeof selected.respond === "function")
    return { targetAgent: selected };
  throw new Error(
    "Either target, targetCallback, targetAgent, or agentKey is required",
  );
}
