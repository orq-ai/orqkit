import { createHash } from "node:crypto";

import type OpenAI from "openai";
import { z } from "zod/v4";

import {
  isContentFilterError,
  regenerateOnContentFilter,
} from "../../common/content-filter.js";
import {
  ContentFilterFinishReasonError,
  executeChatCompletion,
  LengthFinishReasonError,
} from "../../common/llm-call.js";
import { isConnectionError } from "../../common/retry.js";
import { extractStatusCode } from "../../common/target-call.js";
import type { AttrMap } from "../../common/tracing.js";
import type { AgentContext } from "../../contracts.js";
import { toStrictSchema } from "../../integrations/simulation/utils/strict-schema.js";
import {
  attackerModelFor,
  type LLMConfig,
  PIPELINE_CONFIG,
} from "../config.js";
import {
  AgentCapability,
  AttackTechnique,
  DeliveryMethodSchema,
  SeveritySchema,
  type TurnType,
  TurnTypeSchema,
  type Vulnerability,
} from "../contracts.js";
import { type AttackStrategy, AttackStrategySchema } from "../strategy.js";
import { withRedteamLlmSpan } from "../tracing.js";
import { safeSubstitute } from "../utils.js";
import {
  getPrimaryCategory,
  resolveCategorySafe,
  VULNERABILITY_DEFS,
} from "../vulnerability-registry.js";
import {
  DELIVERY_METHOD_VALUES,
  OBJECTIVE_GENERATION_PROMPT,
  SEVERITY_GUIDANCE,
  SEVERITY_VALUES,
} from "./objective-prompts.js";
import { categoryNames } from "./strategy-data.js";

const WireObjectiveSchema = z.object({
  objective: z.string().describe("Attack objective text"),
  turn_type: TurnTypeSchema.describe(
    "Recommended turn type for this objective (single or multi)",
  ),
  delivery_method: DeliveryMethodSchema.describe(
    `Jailbreak/delivery technique best suited to this objective. One of: ${DELIVERY_METHOD_VALUES}`,
  ),
  requires_tools: z
    .boolean()
    .default(false)
    .describe("Whether executing this objective requires agent tools"),
  requires_memory: z
    .boolean()
    .default(false)
    .describe("Whether executing this objective requires agent memory"),
  severity: SeveritySchema.default("medium").describe(
    `Expected severity if this attack succeeds. One of: ${SEVERITY_VALUES}`,
  ),
});
const WireObjectivesSchema = z.object({
  objectives: z
    .array(WireObjectiveSchema)
    .describe("List of generated objectives with requirements"),
});
export const GeneratedObjectiveSchema = z.preprocess(
  (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const raw = { ...value } as Record<string, unknown>;
    for (const key of [
      "turnType",
      "deliveryMethod",
      "requiresTools",
      "requiresMemory",
    ]) {
      const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      if (!(key in raw) && snake in raw) raw[key] = raw[snake];
    }
    return raw;
  },
  z.object({
    objective: z.string(),
    turnType: TurnTypeSchema,
    deliveryMethod: DeliveryMethodSchema,
    requiresTools: z.boolean().default(false),
    requiresMemory: z.boolean().default(false),
    severity: SeveritySchema.default("medium"),
  }),
);
export type GeneratedObjective = z.infer<typeof GeneratedObjectiveSchema>;
export const GeneratedObjectivesSchema = z.object({
  objectives: z.array(GeneratedObjectiveSchema),
});
export interface ObjectiveGenerationOptions {
  model?: string | null;
  count?: number;
  turnType?: TurnType | null;
  maxTurns?: number;
  attackerInstructions?: string | null;
  llmKwargs?: Record<string, unknown> | null;
  pipelineConfig?: LLMConfig | null;
  signal?: AbortSignal;
}
export function buildObjectivePrompt(
  context: AgentContext,
  vulnerabilityName: string,
  categoryCode: string,
  turnType: TurnType | null,
  maxTurns: number,
  attackerInstructions?: string | null,
): string {
  const guidance =
    turnType == null
      ? 'Decide turn_type per objective based on complexity and likely resistance. Prefer "single" for direct one-shot attempts and "multi" for attacks that need adaptation over multiple turns.'
      : `All objectives MUST use turn_type="${turnType}". Do not mix turn types in this output.`;
  const prompt = safeSubstitute(OBJECTIVE_GENERATION_PROMPT, {
    "{agent_name}": context.displayName || context.key,
    "{agent_description}": context.description || "An AI assistant",
    "{tools}": context.tools.map((tool) => tool.name).join(", ") || "None",
    "{memory_stores}":
      context.memoryStores.map((store) => store.key || store.id).join(", ") ||
      "None",
    "{instructions_excerpt}":
      context.instructions || context.systemPrompt || "Not available",
    "{vulnerability_name}": vulnerabilityName,
    "{category_code}": categoryCode,
    "{turn_type_guidance}": guidance,
    "{max_turns}": String(maxTurns),
    "{delivery_method_values}": DELIVERY_METHOD_VALUES,
    "{severity_values}": SEVERITY_VALUES,
    "{severity_guidance}": SEVERITY_GUIDANCE,
  });
  return attackerInstructions
    ? `${prompt}\n\n## Additional Context from Operator\n${attackerInstructions}`
    : prompt;
}
async function generateSingle(
  template: string,
  client: OpenAI,
  model: string,
  count: number,
  attributes: AttrMap,
  cfg: LLMConfig,
  signal?: AbortSignal,
): Promise<GeneratedObjective[]> {
  try {
    const messages = [
      { role: "user", content: template.replaceAll("{count}", String(count)) },
    ];
    return await withRedteamLlmSpan(
      {
        model,
        temperature: cfg.attacker.temperature,
        maxTokens: cfg.attacker.maxTokens,
        inputMessages: messages,
        attributes: {
          "orq.redteam.llm_purpose": "generate_strategies",
          "orq.redteam.count": count,
          ...attributes,
        },
      },
      async (span) => {
        const response = await regenerateOnContentFilter(
          async () => {
            const called = await executeChatCompletion({
              client,
              model,
              messages,
              span,
              timeoutMs: cfg.attacker.timeoutMs,
              responseFormat: {
                type: "json_schema",
                json_schema: {
                  name: "GeneratedObjectives",
                  strict: true,
                  schema: toStrictSchema(WireObjectivesSchema),
                },
              },
              temperature: cfg.attacker.temperature,
              maxCompletionTokens: cfg.attacker.maxTokens,
              reasoningEffort: cfg.attacker.reasoningEffort,
              extraBody: cfg.retryExtraBody(client),
              extraKwargs: cfg.attacker.extraKwargs,
              signal,
            });
            return called.response;
          },
          {
            maxAttempts: Math.max(1, cfg.maxContentFilterRetries + 1),
            label: "Objective generation",
          },
        );
        const choice = response.choices[0];
        if (choice?.finish_reason === "length")
          throw new LengthFinishReasonError(response);
        if (choice?.finish_reason === "content_filter")
          throw new ContentFilterFinishReasonError();
        if (!choice?.message.content || choice.message.refusal)
          throw new Error("Objective generation returned no parsed content");
        const parsed = WireObjectivesSchema.parse(
          JSON.parse(choice.message.content),
        );
        return GeneratedObjectivesSchema.parse(parsed).objectives.slice(
          0,
          count,
        );
      },
    );
  } catch (error) {
    if (
      signal?.aborted ||
      (error as { name?: unknown } | null)?.name === "AbortError"
    )
      throw error;
    if (isConnectionError(error) || extractStatusCode(error) !== null) {
      if (isContentFilterError(error)) {
        console.error(
          "Objective generation content-filtered after retries; returning no objectives",
        );
        return [];
      }
      throw error;
    }
    console.error(
      "Objective generation failed; returning no objectives",
      error,
    );
    return [];
  }
}
async function generateBatches(
  template: string,
  client: OpenAI,
  model: string,
  count: number,
  attributes: AttrMap,
  cfg: LLMConfig,
  signal?: AbortSignal,
): Promise<GeneratedObjective[]> {
  if (count <= cfg.maxObjectivesPerLlmCall)
    return generateSingle(
      template,
      client,
      model,
      count,
      attributes,
      cfg,
      signal,
    );
  const result: GeneratedObjective[] = [];
  for (let remaining = count, index = 0; remaining > 0; index++) {
    const size = Math.min(remaining, cfg.maxObjectivesPerLlmCall);
    const batch = await generateSingle(
      template,
      client,
      model,
      size,
      { ...attributes, "orq.redteam.batch_index": index },
      cfg,
      signal,
    );
    if (!batch.length) {
      console.warn(`Batch ${index + 1} returned no objectives; stopping early`);
      break;
    }
    result.push(...batch);
    remaining -= size;
  }
  return result.slice(0, count);
}
export function generateObjectivesForVulnerability(
  vulnerability: Vulnerability,
  context: AgentContext,
  client: OpenAI,
  options: ObjectiveGenerationOptions = {},
): Promise<GeneratedObjective[]> {
  const category = getPrimaryCategory(vulnerability);
  const template = buildObjectivePrompt(
    context,
    VULNERABILITY_DEFS[vulnerability]?.name ?? vulnerability,
    category,
    options.turnType ?? null,
    options.maxTurns ?? 5,
    options.attackerInstructions,
  );
  return generateBatches(
    template,
    client,
    attackerModelFor(options.model, options.pipelineConfig),
    options.count ?? 3,
    {
      "orq.redteam.category": category,
      "orq.redteam.vulnerability": vulnerability,
    },
    options.pipelineConfig ?? PIPELINE_CONFIG,
    options.signal,
  );
}
export function generateObjectivesForCategory(
  category: string,
  context: AgentContext,
  client: OpenAI,
  options: ObjectiveGenerationOptions = {},
): Promise<GeneratedObjective[]> {
  const vulnerability = resolveCategorySafe(category);
  if (vulnerability)
    return generateObjectivesForVulnerability(
      vulnerability,
      context,
      client,
      options,
    );
  console.warn(
    `Category '${category}' could not be resolved; using category-based objective generation`,
  );
  const template = buildObjectivePrompt(
    context,
    (categoryNames as Record<string, string>)[category] ?? category,
    category,
    options.turnType ?? null,
    options.maxTurns ?? 5,
    options.attackerInstructions,
  );
  return generateBatches(
    template,
    client,
    attackerModelFor(options.model, options.pipelineConfig),
    options.count ?? 3,
    { "orq.redteam.category": category, "orq.redteam.vulnerability": "" },
    options.pipelineConfig ?? PIPELINE_CONFIG,
    options.signal,
  );
}
export const ATTACK_TECHNIQUE_POOL = Object.freeze([
  AttackTechnique.INDIRECT_INJECTION,
  AttackTechnique.DIRECT_INJECTION,
  AttackTechnique.SOCIAL_ENGINEERING,
  AttackTechnique.EMOTIONAL_MANIPULATION,
  AttackTechnique.TOOL_ABUSE,
  AttackTechnique.CONTEXT_POISONING,
  AttackTechnique.PRIVILEGE_ESCALATION,
  AttackTechnique.PAYLOAD_SPLITTING,
]);
function techniqueForObjective(objective: string): AttackTechnique {
  const hash = createHash("sha256").update(objective).digest("hex");
  const key: number[] = [];
  for (let end = hash.length; end > 0; end -= 8)
    key.push(Number.parseInt(hash.slice(Math.max(0, end - 8), end), 16));
  // Python seeds MT19937 with all SHA-256 words, then uses getrandbits rejection for choice.
  const state = new Uint32Array(624);
  state[0] = 19650218;
  for (let i = 1; i < 624; i++) {
    const previous = state[i - 1] as number;
    state[i] = (Math.imul(1812433253, previous ^ (previous >>> 30)) + i) >>> 0;
  }
  let i = 1,
    j = 0;
  for (let k = 624; k > 0; k--) {
    const previous = state[i - 1] as number;
    state[i] =
      (((state[i] as number) ^
        Math.imul(previous ^ (previous >>> 30), 1664525)) +
        (key[j] as number) +
        j) >>>
      0;
    i++;
    j++;
    if (i >= 624) {
      state[0] = state[623] as number;
      i = 1;
    }
    if (j >= key.length) j = 0;
  }
  for (let k = 623; k > 0; k--) {
    const previous = state[i - 1] as number;
    state[i] =
      (((state[i] as number) ^
        Math.imul(previous ^ (previous >>> 30), 1566083941)) -
        i) >>>
      0;
    i++;
    if (i >= 624) {
      state[0] = state[623] as number;
      i = 1;
    }
  }
  state[0] = 0x80000000;
  let index = 624;
  for (;;) {
    if (index >= 624) {
      for (let n = 0; n < 624; n++) {
        const value =
          ((state[n] as number) & 0x80000000) |
          ((state[(n + 1) % 624] as number) & 0x7fffffff);
        state[n] =
          (state[(n + 397) % 624] as number) ^
          (value >>> 1) ^
          (value & 1 ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let word = state[index++] as number;
    word ^= word >>> 11;
    word ^= (word << 7) & 0x9d2c5680;
    word ^= (word << 15) & 0xefc60000;
    word ^= word >>> 18;
    const choice = word >>> 28;
    if (choice < ATTACK_TECHNIQUE_POOL.length)
      return ATTACK_TECHNIQUE_POOL[choice] as AttackTechnique;
  }
}
export function createStrategyFromObjective(
  category: string,
  objective: GeneratedObjective,
  options: {
    turnType?: TurnType | null;
    objectiveIndex?: number;
    vulnerability?: Vulnerability | null;
  } = {},
): AttackStrategy {
  const vulnerability = options.vulnerability ?? resolveCategorySafe(category);
  const effectiveCategory = vulnerability
    ? category || getPrimaryCategory(vulnerability)
    : category;
  if (!vulnerability)
    console.warn(
      `Cannot resolve category '${category}' to a known vulnerability`,
    );
  const turnType = options.turnType ?? objective.turnType;
  const nameBase = Array.from(objective.objective)
    .slice(0, 30)
    .join("")
    .toLowerCase()
    .replaceAll(" ", "_")
    .replaceAll("'", "");
  return AttackStrategySchema.parse({
    vulnerability,
    category: effectiveCategory,
    name: `generated_${turnType}_${String((options.objectiveIndex ?? 0) + 1).padStart(2, "0")}_${nameBase}`,
    description: `LLM-generated: ${Array.from(objective.objective).slice(0, 100).join("")}...`,
    attackTechnique: techniqueForObjective(objective.objective),
    deliveryMethods: [objective.deliveryMethod],
    turnType,
    severity: objective.severity,
    requiresTools: objective.requiresTools,
    requiredCapabilities: objective.requiresMemory
      ? [AgentCapability.MEMORY_READ, AgentCapability.MEMORY_WRITE]
      : [],
    objectiveTemplate: objective.objective,
    promptTemplate: null,
    isGenerated: true,
  });
}
export function objectivesToStrategies(
  objectives: GeneratedObjective[],
  context: AgentContext,
  category: string,
  options: {
    turnType?: TurnType | null;
    vulnerability?: Vulnerability | null;
  } = {},
): AttackStrategy[] {
  return objectives.flatMap((objective, index) =>
    (objective.requiresTools && !context.tools.length) ||
    (objective.requiresMemory && !context.memoryStores.length)
      ? []
      : [
          createStrategyFromObjective(category, objective, {
            ...options,
            objectiveIndex: index,
          }),
        ],
  );
}
export async function generateStrategiesForVulnerability(
  vulnerability: Vulnerability,
  context: AgentContext,
  client: OpenAI,
  options: ObjectiveGenerationOptions = {},
): Promise<AttackStrategy[]> {
  const objectives = await generateObjectivesForVulnerability(
    vulnerability,
    context,
    client,
    { ...options, count: options.count ?? 2 },
  );
  return objectivesToStrategies(
    objectives,
    context,
    getPrimaryCategory(vulnerability),
    { vulnerability, turnType: options.turnType },
  );
}
export async function generateStrategiesForCategory(
  category: string,
  context: AgentContext,
  client: OpenAI,
  options: ObjectiveGenerationOptions = {},
): Promise<AttackStrategy[]> {
  const vulnerability = resolveCategorySafe(category);
  if (vulnerability)
    return generateStrategiesForVulnerability(
      vulnerability,
      context,
      client,
      options,
    );
  const objectives = await generateObjectivesForCategory(
    category,
    context,
    client,
    { ...options, count: options.count ?? 2 },
  );
  return objectivesToStrategies(objectives, context, category, {
    turnType: options.turnType,
  });
}
