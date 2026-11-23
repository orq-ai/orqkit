import type OpenAI from "openai";
import { z } from "zod/v4";

import { executeChatParse } from "../../common/llm-call.js";
import { isConnectionError } from "../../common/retry.js";
import { pythonStrip } from "../../common/sanitize.js";
import { extractStatusCode } from "../../common/target-call.js";
import type { AgentContext } from "../../contracts.js";
import {
  attackerModelFor,
  type LLMConfig,
  PIPELINE_CONFIG,
} from "../config.js";
import { AgentCapability, AgentCapabilitySchema } from "../contracts.js";
import { withRedteamLlmSpan } from "../tracing.js";
import { safeSubstitute } from "../utils.js";
import {
  RESOURCE_CAPABILITY_PROMPT,
  TOOL_CLASSIFICATION_PROMPT,
} from "./capability-prompts.js";
export const AgentCapabilitiesSchema = z.preprocess(
  (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const raw = value as Record<string, unknown>;
    return {
      ...raw,
      classificationFailed: Object.hasOwn(raw, "classificationFailed")
        ? raw.classificationFailed
        : raw.classification_failed,
    };
  },
  z.object({
    capabilities: z
      .record(z.string(), z.array(AgentCapabilitySchema))
      .default(() => ({})),
    classificationFailed: z.boolean().default(false),
  }),
);
export class AgentCapabilities {
  capabilities: Record<string, AgentCapability[]>;
  classificationFailed: boolean;
  constructor(value: unknown = {}) {
    const parsed = AgentCapabilitiesSchema.parse(value);
    this.capabilities = parsed.capabilities;
    this.classificationFailed = parsed.classificationFailed;
  }
  allCapabilities(): Set<string> {
    return new Set(Object.values(this.capabilities).flat());
  }
  hasAny(required: readonly AgentCapability[]): boolean {
    const all = this.allCapabilities();
    return required.some((cap) => all.has(cap));
  }
  toJSON() {
    return {
      capabilities: this.capabilities,
      classificationFailed: this.classificationFailed,
    };
  }
}

const ResourceCapabilityInferenceSchema = z.object({
  memory_read: z
    .boolean()
    .describe("Whether the agent can read from persistent memory"),
  memory_write: z
    .boolean()
    .describe("Whether the agent can write to persistent memory"),
  knowledge_retrieval: z
    .boolean()
    .describe("Whether the agent can retrieve external knowledge/data"),
  is_multi_agent: z
    .boolean()
    .default(false)
    .describe(
      "Whether the agent orchestrates, delegates to, or hands off to other agents (a multi-agent system), versus being a single standalone agent",
    ),
});
const ToolCapabilitiesResponseSchema = z.object({
  tools: z
    .array(
      z.object({
        tool_name: z.string().describe("Name of the tool"),
        capabilities: z
          .array(z.string())
          .describe(
            "Capability tags from the taxonomy that this tool provides",
          ),
      }),
    )
    .describe("Capability classification for each tool"),
});
export interface CapabilityClassificationOptions {
  model?: string | null;
  llmKwargs?: Record<string, unknown> | null;
  pipelineConfig?: LLMConfig | null;
  signal?: AbortSignal;
}
function propagateClassifierError(error: unknown, signal?: AbortSignal): void {
  if (
    signal?.aborted ||
    isConnectionError(error) ||
    extractStatusCode(error) !== null ||
    (error as { name?: unknown } | null)?.name === "AbortError"
  )
    throw error;
}
export async function classifyAgentCapabilities(
  agentContext: AgentContext,
  client: OpenAI,
  options: CapabilityClassificationOptions = {},
): Promise<AgentCapabilities> {
  const cfg = options.pipelineConfig ?? PIPELINE_CONFIG;
  const model = attackerModelFor(options.model, options.pipelineConfig);
  const toolList = agentContext.tools
    .map((tool) => `- ${tool.name}: ${tool.description || "No description"}`)
    .join("\n");
  const instructions =
    pythonStrip(
      agentContext.instructions || agentContext.systemPrompt || "(none)",
    ) || "(none)";
  const resourceMessages = [
    {
      role: "user",
      content: safeSubstitute(RESOURCE_CAPABILITY_PROMPT, {
        "{has_memory_stores}": agentContext.memoryStores.length
          ? "True"
          : "False",
        "{has_knowledge_bases}": agentContext.knowledgeBases.length
          ? "True"
          : "False",
        "{description}": agentContext.description || "(none)",
        "{instructions}": instructions,
        "{tool_list}": toolList || "- none",
      }),
    },
  ];
  let resources: z.infer<typeof ResourceCapabilityInferenceSchema>;
  try {
    resources = await withRedteamLlmSpan(
      {
        model,
        temperature: cfg.attacker.temperature,
        maxTokens: cfg.attacker.maxTokens,
        inputMessages: resourceMessages,
        attributes: { "orq.redteam.llm_purpose": "infer_resources" },
      },
      async (span) => {
        const response = await executeChatParse({
          client,
          model,
          messages: resourceMessages,
          span,
          timeoutMs: cfg.attacker.timeoutMs,
          responseModel: {
            name: "ResourceCapabilityInference",
            schema: ResourceCapabilityInferenceSchema,
          },
          temperature: cfg.attacker.temperature,
          maxCompletionTokens: cfg.attacker.maxTokens,
          reasoningEffort: cfg.attacker.reasoningEffort,
          extraBody: cfg.retryExtraBody(client),
          extraKwargs: cfg.attacker.extraKwargs,
          signal: options.signal,
        });
        const parsed = response.response.choices[0]?.message.parsed;
        if (!parsed)
          throw new Error(
            "Resource capability inference returned no parsed content",
          );
        return ResourceCapabilityInferenceSchema.parse(parsed);
      },
    );
  } catch (error) {
    propagateClassifierError(error, options.signal);
    console.error(
      "Capability inference failed; using configured resources and assuming a single-agent target",
      error,
    );
    resources = {
      memory_read: agentContext.memoryStores.length > 0,
      memory_write: agentContext.memoryStores.length > 0,
      knowledge_retrieval: agentContext.knowledgeBases.length > 0,
      is_multi_agent: false,
    };
  }
  agentContext.isMultiAgent = resources.is_multi_agent;
  const capabilities: Record<string, AgentCapability[]> = {};
  for (const store of agentContext.memoryStores) {
    const tags: AgentCapability[] = [];
    if (resources.memory_read) tags.push(AgentCapability.MEMORY_READ);
    if (resources.memory_write) tags.push(AgentCapability.MEMORY_WRITE);
    if (tags.length) capabilities[`memory:${store.key || store.id}`] = tags;
  }
  for (const kb of agentContext.knowledgeBases)
    capabilities[`knowledge:${kb.key || kb.name || kb.id}`] = [
      AgentCapability.KNOWLEDGE_RETRIEVAL,
    ];
  if (!agentContext.knowledgeBases.length && resources.knowledge_retrieval)
    capabilities["knowledge:inferred"] = [AgentCapability.KNOWLEDGE_RETRIEVAL];
  let classificationFailed = false;
  if (agentContext.tools.length) {
    const messages = [
      {
        role: "user",
        content: safeSubstitute(TOOL_CLASSIFICATION_PROMPT, {
          "{tool_list}": toolList,
        }),
      },
    ];
    try {
      const tools = await withRedteamLlmSpan(
        {
          model,
          temperature: cfg.attacker.temperature,
          maxTokens: cfg.attacker.maxTokens,
          inputMessages: messages,
          attributes: {
            "orq.redteam.llm_purpose": "classify_tools",
            "orq.redteam.num_tools": agentContext.tools.length,
          },
        },
        async (span) => {
          const response = await executeChatParse({
            client,
            model,
            messages,
            span,
            timeoutMs: cfg.attacker.timeoutMs,
            responseModel: {
              name: "ToolCapabilitiesResponse",
              schema: ToolCapabilitiesResponseSchema,
            },
            temperature: cfg.attacker.temperature,
            maxCompletionTokens: cfg.attacker.maxTokens,
            reasoningEffort: cfg.attacker.reasoningEffort,
            extraBody: cfg.retryExtraBody(client),
            extraKwargs: cfg.attacker.extraKwargs,
            signal: options.signal,
          });
          const parsed = response.response.choices[0]?.message.parsed;
          if (!parsed)
            throw new Error("Tool classification returned no parsed content");
          return ToolCapabilitiesResponseSchema.parse(parsed);
        },
      );
      for (const tool of tools.tools) {
        const tags = tool.capabilities.flatMap((value) => {
          const parsed = AgentCapabilitySchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        if (tags.length) capabilities[tool.tool_name] = tags;
      }
    } catch (error) {
      propagateClassifierError(error, options.signal);
      console.error(
        "Tool classification failed; strategies will be included optimistically",
        error,
      );
      classificationFailed = true;
    }
  }
  return new AgentCapabilities({ capabilities, classificationFailed });
}
