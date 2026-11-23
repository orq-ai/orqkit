import { randomUUID } from "node:crypto";

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { CallbackManager } from "@langchain/core/callbacks/manager";
import type { LLMResult } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";

import { getField } from "../../common/fields.js";
import { toolResultToText } from "../../common/messages.js";
import { sumStructuredUsage } from "../../common/structured-output.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  contentToText,
  extractUsage,
  type Message,
  type OutputMessage,
  textOutputItem,
  toolCallOutputItem,
  type Usage,
} from "../../contracts.js";
import {
  getMessageData,
  getMessageType,
  type MessageInput,
} from "./convert.js";
import type { LangChainInvocable } from "./types.js";
import { extractToolsFromAgent } from "./wrap-agent.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return toolResultToText(content);
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block !== null && typeof block === "object") {
      if (block.type === "text") parts.push(String(block.text || ""));
      else if (
        !["tool_use", "thinking", "redacted_thinking"].includes(block.type)
      )
        console.warn(
          `LangGraphTarget: dropping unrenderable content block type=${String(block.type)}`,
        );
    }
  }
  return parts.join("");
}
export function langGraphOutputItems(
  messages: readonly unknown[],
): OutputMessage[] {
  const output: OutputMessage[] = [];
  const tools = new Map<string, number>();
  for (const raw of messages) {
    const message = raw as MessageInput;
    const type = getMessageType(message);
    const role =
      getField(raw, "role") ||
      (
        {
          ai: "assistant",
          tool: "tool",
          human: "user",
          system: "system",
        } as Record<string, string>
      )[type] ||
      "";
    const data = getMessageData(message);
    if (role === "tool") {
      const id = String(data.tool_call_id || ""),
        index = tools.get(id);
      tools.delete(id);
      if (index === undefined) {
        console.warn(
          `LangGraphTarget: discarding tool result for call_id=${JSON.stringify(id)}; no matching call in this invocation`,
        );
        continue;
      }
      const item = output[index];
      if (item?.type === "function_call")
        output[index] = {
          ...item,
          result: contentText(data.content) || toolResultToText(data.content),
        };
      continue;
    }
    if (!role) {
      console.warn("LangGraphTarget: skipping an unrecognized state message");
      continue;
    }
    if (role !== "assistant") continue;
    const text = contentText(data.content);
    if (text) output.push(textOutputItem(text));
    for (const call of data.tool_calls ?? []) {
      const id = call.id;
      output.push(
        toolCallOutputItem({
          name: String(call.name ?? ""),
          arguments: record(call.args),
          ...(id ? { call_id: String(id) } : {}),
        }),
      );
      if (id) tools.set(String(id), output.length - 1);
      else
        console.warn(
          `LangGraphTarget: tool call ${JSON.stringify(call.name)} has no id; its result cannot be paired`,
        );
    }
  }
  return output;
}
class TokenUsageCollector extends BaseCallbackHandler {
  name = "evaluatorq_langgraph_usage";
  private usage: Usage | null = null;
  override handleLLMEnd(result: LLMResult): void {
    for (const candidates of result.generations) {
      const message = getField(candidates[0], "message");
      const usage = extractUsage(getField(message, "usage_metadata"), 1);
      if (usage) this.usage = sumStructuredUsage([this.usage, usage]);
    }
  }
  override handleLLMError(error: Error): void {
    const response = getField(error, "response");
    const partial =
      getField(response, "llm_result") ?? getField(response, "llm_output");
    if (Array.isArray(getField(partial, "generations")))
      this.handleLLMEnd(partial as LLMResult);
  }
  collected(): Usage | null {
    return this.usage;
  }
}
export interface LangGraphTargetOptions {
  config?: RunnableConfig;
  agentContext?: AgentContext;
}
export class LangGraphTarget extends AgentTarget {
  override readonly historyMode = "target" as const;
  private previousCount = 0;
  private readonly key: string;
  constructor(
    readonly graph: LangChainInvocable,
    readonly options: LangGraphTargetOptions = {},
  ) {
    super();
    this.mintMemoryEntityId(randomUUID().replaceAll("-", ""));
    this.key = `${getField(graph, "name") || "langgraph_target"}_${randomUUID().slice(0, 8)}`;
  }
  override async respond(
    messages: Message[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    const last = messages.at(-1);
    if (last?.role !== "user")
      throw new Error(
        "LangGraphTarget.respond requires the last message to have role user",
      );
    const collector = new TokenUsageCollector();
    const config = this.options.config ?? {};
    const existing = config.callbacks;
    let callbacks: RunnableConfig["callbacks"];
    if (Array.isArray(existing)) callbacks = [...existing, collector];
    else if (existing && typeof existing.copy === "function") {
      const manager = (existing as CallbackManager).copy();
      manager.addHandler(collector, true);
      callbacks = manager;
    } else callbacks = [collector];
    const callConfig: RunnableConfig = {
      ...config,
      configurable: { ...config.configurable, thread_id: this.memoryEntityId },
      callbacks,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    let result: Awaited<ReturnType<LangChainInvocable["invoke"]>>;
    try {
      result = await this.graph.invoke(
        { messages: [{ role: "user", content: contentToText(last.content) }] },
        callConfig,
      );
    } catch (error) {
      const usage = collector.collected();
      if (
        usage &&
        error !== null &&
        typeof error === "object" &&
        Object.isExtensible(error)
      )
        Object.assign(error, { usage });
      throw error;
    }
    const values = getField(result, "messages");
    if (!Array.isArray(values))
      throw new Error(
        "LangGraphTarget requires graph state with a messages array",
      );
    if (!values.length)
      throw new Error("LangGraphTarget: graph returned an empty messages list");
    let current = values.slice(this.previousCount);
    if (!current.length && this.previousCount > 0) {
      console.warn(
        "LangGraphTarget: message history was trimmed; reading the full result may repeat earlier tool calls",
      );
      current = values;
    }
    const output = langGraphOutputItems(current);
    this.previousCount = values.length;
    if (!output.some((item) => item.type === "output_text")) {
      console.warn(
        "LangGraphTarget: no assistant text in turn; using last message content",
      );
      output.push(
        textOutputItem(contentText(getField(values.at(-1), "content") ?? "")),
      );
    }
    return new AgentResponse({ output, usage: collector.collected() });
  }
  resetConversation(): void {
    this.mintMemoryEntityId(randomUUID().replaceAll("-", ""));
    this.previousCount = 0;
  }
  override newInstance(): LangGraphTarget {
    return new LangGraphTarget(this.graph, {
      ...this.options,
      config: { ...this.options.config },
    });
  }
  override async getAgentContext(): Promise<AgentContext> {
    if (this.options.agentContext) return this.options.agentContext;
    const tools = extractToolsFromAgent(this.graph);
    for (const node of Object.values(record(getField(this.graph, "nodes")))) {
      const bound = getField(node, "bound");
      const nodeTools = getField(bound, "tools");
      const namedTools = getField(bound, "tools_by_name");
      for (const tool of [
        ...(Array.isArray(nodeTools) ? nodeTools : []),
        ...Object.values(record(namedTools)),
      ]) {
        const name = getField(tool, "name");
        if (
          typeof name === "string" &&
          !tools.some((known) => known.name === name)
        )
          tools.push({
            name,
            description:
              typeof getField(tool, "description") === "string"
                ? (getField(tool, "description") as string)
                : "",
          });
      }
    }
    const checkpointer = getField(this.graph, "checkpointer");
    return AgentContextSchema.parse({
      key: this.key,
      description: "LangGraph compiled state graph target",
      tools: [...new Map(tools.map((tool) => [tool.name, tool])).values()],
      memoryStores:
        checkpointer && this.memoryEntityId
          ? [
              {
                id: this.memoryEntityId,
                key: "langgraph_checkpointer",
                description: `LangGraph checkpointer (${checkpointer.constructor?.name ?? "unknown"})`,
              },
            ]
          : [],
    });
  }
}
