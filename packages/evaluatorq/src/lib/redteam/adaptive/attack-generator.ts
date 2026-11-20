import type OpenAI from "openai";
import { z } from "zod/v4";

import { executeChatParse } from "../../common/llm-call.js";
import { isConnectionError } from "../../common/retry.js";
import { extractStatusCode } from "../../common/target-call.js";
import type { AgentContext } from "../../contracts.js";
import {
  attackerModelFor,
  type LLMConfig,
  PIPELINE_CONFIG,
} from "../config.js";
import type { AttackStrategy } from "../strategy.js";
import { withRedteamLlmSpan } from "../tracing.js";
import { safeSubstitute } from "../utils.js";
import { ATTACK_TOOL_CLASSIFICATION_PROMPT } from "./objective-prompts.js";

export function fillTemplate(template: string, context: AgentContext): string {
  return safeSubstitute(template, {
    "{tool_name}": context.tools[0]?.name ?? "the tool",
    "{tool_names}": context.tools.length
      ? context.tools.map((tool) => tool.name).join(", ")
      : "tools",
    "{memory_store}": context.memoryStores[0]?.key || "memory",
    "{agent_name}": context.displayName || context.key,
    "{agent_description}": context.description || "an AI assistant",
  });
}
export function generateAttackPrompt(
  strategy: AttackStrategy,
  context: AgentContext,
): string {
  return strategy.promptTemplate
    ? fillTemplate(strategy.promptTemplate, context)
    : "";
}
export function generateObjective(
  strategy: AttackStrategy,
  context: AgentContext,
): string {
  return fillTemplate(strategy.objectiveTemplate, context);
}
const ToolRelevanceSchema = z.object({
  tool_name: z.string().describe("Name of the tool"),
  exploitation_hint: z
    .string()
    .default("")
    .describe(
      "Brief explanation of how the tool could be leveraged (empty if not relevant)",
    ),
  relevant: z
    .boolean()
    .describe("Whether this tool could be exploited for the attack"),
});
const ToolAnalysisSchema = z.object({
  tools: z
    .array(ToolRelevanceSchema)
    .describe("Relevance classification for each tool"),
});
export interface PromptAdaptationOptions {
  model?: string | null;
  llmKwargs?: Record<string, unknown> | null;
  pipelineConfig?: LLMConfig | null;
  signal?: AbortSignal;
}
export async function adaptPromptToTools(
  basePrompt: string,
  context: AgentContext,
  strategy: AttackStrategy,
  client: OpenAI,
  options: PromptAdaptationOptions = {},
): Promise<string> {
  if (!context.tools.length) return basePrompt;
  const cfg = options.pipelineConfig ?? PIPELINE_CONFIG,
    model = attackerModelFor(options.model, options.pipelineConfig);
  const tools = context.tools
    .map((tool) => `- ${tool.name}: ${tool.description || "No description"}`)
    .join("\n");
  const messages = [
    {
      role: "user",
      content: safeSubstitute(ATTACK_TOOL_CLASSIFICATION_PROMPT, {
        "{attack_technique}": strategy.attackTechnique,
        "{strategy_description}": strategy.description,
        "{base_prompt}": basePrompt,
        "{tool_list}": tools,
      }),
    },
  ];
  try {
    const analysis = await withRedteamLlmSpan(
      {
        model,
        temperature: cfg.attacker.temperature,
        maxTokens: cfg.attacker.maxTokens,
        inputMessages: messages,
        attributes: {
          "orq.redteam.llm_purpose": "adapt_prompt_to_tools",
          "orq.redteam.num_tools": context.tools.length,
        },
      },
      async (span) => {
        const response = await executeChatParse({
          client,
          model,
          messages,
          span,
          timeoutMs: cfg.attacker.timeoutMs,
          responseModel: { name: "ToolAnalysis", schema: ToolAnalysisSchema },
          temperature: cfg.attacker.temperature,
          maxCompletionTokens: cfg.attacker.maxTokens,
          reasoningEffort: cfg.attacker.reasoningEffort,
          extraBody: cfg.retryExtraBody(client),
          extraKwargs: cfg.attacker.extraKwargs,
          signal: options.signal,
        });
        const parsed = response.response.choices[0]?.message.parsed;
        if (!parsed)
          throw new Error("Tool analysis returned no parsed content");
        return ToolAnalysisSchema.parse(parsed);
      },
    );
    let best: z.infer<typeof ToolRelevanceSchema> | undefined;
    for (const tool of analysis.tools)
      if (
        tool.relevant &&
        (!best ||
          Array.from(tool.exploitation_hint).length >
            Array.from(best.exploitation_hint).length)
      )
        best = tool;
    if (!best) return basePrompt;
    const hint = best.exploitation_hint ? ` (${best.exploitation_hint})` : "";
    return `${basePrompt}\n\n[Note: This agent has a '${best.tool_name}' tool that you might leverage${hint}.]`;
  } catch (error) {
    if (
      options.signal?.aborted ||
      isConnectionError(error) ||
      extractStatusCode(error) !== null ||
      (error as { name?: unknown } | null)?.name === "AbortError"
    )
      throw error;
    console.error("Tool adaptation failed; using the original prompt", error);
    return basePrompt;
  }
}
