import type OpenAI from "openai";

import { setSpanAttrs } from "../../common/tracing.js";
import type { AgentContext } from "../../contracts.js";
import { type LLMConfig, PIPELINE_CONFIG } from "../config.js";
import {
  type AttackTechnique,
  type DeliveryMethod,
  Vulnerability,
} from "../contracts.js";
import type { AttackStrategy } from "../strategy.js";
import { withRedteamSpan } from "../tracing.js";
import { resolveCategorySafe } from "../vulnerability-registry.js";
import {
  AgentCapabilities,
  classifyAgentCapabilities,
} from "./capability-classifier.js";
import { generateStrategiesForVulnerability } from "./objective-generator.js";
import {
  filterStrategiesByMethod,
  getStrategiesForVulnerability,
  selectApplicableStrategies,
  selectApplicableStrategiesForVulnerability,
} from "./strategy-registry.js";

export interface StrategyPlanningOptions {
  agentContext: AgentContext;
  llmClient?: OpenAI | null;
  attackModel: string;
  maxTurns: number;
  maxPerCategory: number | null;
  generateAdditionalStrategies: boolean;
  generatedStrategyCount: number;
  attackerInstructions?: string | null;
  llmKwargs?: Record<string, unknown> | null;
  pipelineConfig?: LLMConfig | null;
  agentCapabilities?: AgentCapabilities | null;
  strategyNames?: ReadonlySet<string> | null;
  deliveryMethods?: ReadonlySet<DeliveryMethod | string> | null;
  attackTechniques?: ReadonlySet<AttackTechnique> | null;
  signal?: AbortSignal;
}
export interface StrategySelection {
  allHardcoded: AttackStrategy[];
  applicable: AttackStrategy[];
  allHardcodedCount: number;
  applicableCount: number;
  generatedCount: number;
  generatedSingleCount: number;
  generatedMultiCount: number;
  filteredCount: number;
  totalSelected: number;
  generationError?: string | null;
}
export type StrategyPlan = [
  Record<string, AttackStrategy[]>,
  Record<string, StrategySelection | Record<string, never>>,
  AgentCapabilities,
];
export async function planStrategiesForVulnerabilities(
  options: StrategyPlanningOptions & { vulnerabilities: Vulnerability[] },
): Promise<StrategyPlan> {
  const cfg = options.pipelineConfig ?? PIPELINE_CONFIG,
    context = options.agentContext;
  let capabilities = options.agentCapabilities;
  if (!capabilities && options.llmClient) {
    capabilities = await withRedteamSpan(
      "orq.redteam.capability_classification",
      {
        "orq.redteam.num_tools": context.tools.length,
        "orq.redteam.model": options.attackModel,
      },
      async (span) => {
        const result = await classifyAgentCapabilities(
          context,
          options.llmClient as OpenAI,
          {
            model: options.attackModel,
            llmKwargs: options.llmKwargs,
            pipelineConfig: cfg,
            signal: options.signal,
          },
        );
        setSpanAttrs(span, {
          "orq.redteam.num_capabilities": result.allCapabilities().size,
        });
        return result;
      },
    );
  }
  capabilities ??= new AgentCapabilities();
  const onlyMulti = new Set<Vulnerability>([
    Vulnerability.INTER_AGENT_COMMS,
    Vulnerability.CASCADING_FAILURES,
  ]);
  const vulnerabilities = options.vulnerabilities.filter(
    (vulnerability) => context.isMultiAgent || !onlyMulti.has(vulnerability),
  );
  if (vulnerabilities.length !== options.vulnerabilities.length)
    console.warn(
      `Skipping multi-agent-only vulnerabilities for single-agent target ${context.key}`,
    );
  const filter = {
    names: options.strategyNames,
    deliveryMethods: options.deliveryMethods,
    attackTechniques: options.attackTechniques,
  };
  const allHardcoded: Record<string, AttackStrategy[]> = {},
    applicableHardcoded: Record<string, AttackStrategy[]> = {};
  const generated: Record<string, AttackStrategy[]> = {},
    generationErrors: Record<string, string | null> = {};
  const capsForFilter = Object.keys(capabilities.capabilities).length
    ? capabilities
    : null;
  for (const vulnerability of vulnerabilities) {
    allHardcoded[vulnerability] = getStrategiesForVulnerability(vulnerability);
    applicableHardcoded[vulnerability] = filterStrategiesByMethod(
      selectApplicableStrategiesForVulnerability(
        vulnerability,
        context,
        capsForFilter,
      ),
      filter,
    );
    generated[vulnerability] = [];
    generationErrors[vulnerability] = null;
  }
  if (
    options.generateAdditionalStrategies &&
    options.llmClient &&
    options.generatedStrategyCount > 0
  ) {
    await withRedteamSpan(
      "orq.redteam.strategy_planning",
      { "orq.redteam.num_vulnerabilities": vulnerabilities.length },
      async (span) => {
        const results = await Promise.all(
          vulnerabilities.map(async (vulnerability) => {
            try {
              const strategies = await generateStrategiesForVulnerability(
                vulnerability,
                context,
                options.llmClient as OpenAI,
                {
                  model: options.attackModel,
                  count: options.generatedStrategyCount,
                  turnType: "multi",
                  maxTurns: options.maxTurns,
                  attackerInstructions: options.attackerInstructions,
                  llmKwargs: options.llmKwargs,
                  pipelineConfig: cfg,
                  signal: options.signal,
                },
              );
              return { vulnerability, strategies, error: null };
            } catch (error) {
              if (
                options.signal?.aborted ||
                (error as { name?: unknown } | null)?.name === "AbortError"
              )
                throw error;
              console.error(
                `Strategy generation failed for ${vulnerability}`,
                error,
              );
              return {
                vulnerability,
                strategies: [],
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        for (const result of results) {
          generated[result.vulnerability] = filterStrategiesByMethod(
            result.strategies,
            filter,
          );
          generationErrors[result.vulnerability] = result.error;
        }
        setSpanAttrs(span, {
          "orq.redteam.generated_count": Object.values(generated).reduce(
            (sum, strategies) => sum + strategies.length,
            0,
          ),
        });
      },
    );
  }
  const strategies: Record<string, AttackStrategy[]> = {},
    selection: Record<string, StrategySelection> = {};
  for (const vulnerability of vulnerabilities) {
    const all = allHardcoded[vulnerability] ?? [],
      hardcoded = applicableHardcoded[vulnerability] ?? [],
      extra = generated[vulnerability] ?? [];
    let applicable = [...hardcoded, ...extra];
    if (options.maxPerCategory)
      applicable = applicable.slice(0, options.maxPerCategory);
    strategies[vulnerability] = applicable;
    selection[vulnerability] = {
      allHardcoded: all,
      applicable,
      allHardcodedCount: all.length,
      applicableCount: applicable.length,
      generatedCount: extra.length,
      generatedSingleCount: extra.filter(
        (strategy) => strategy.turnType === "single",
      ).length,
      generatedMultiCount: extra.filter(
        (strategy) => strategy.turnType === "multi",
      ).length,
      filteredCount: all.length - hardcoded.length,
      totalSelected: applicable.length,
      generationError: generationErrors[vulnerability] ?? null,
    };
  }
  return [strategies, selection, capabilities];
}
export async function planStrategiesForCategories(
  options: StrategyPlanningOptions & { categories: string[] },
): Promise<StrategyPlan> {
  const categoryToVulnerability = new Map<string, Vulnerability>();
  for (const category of options.categories) {
    const vulnerability = resolveCategorySafe(category);
    if (vulnerability) categoryToVulnerability.set(category, vulnerability);
    else
      console.warn(
        `Could not resolve category '${category}'; using direct category lookup`,
      );
  }
  const [vulnerabilityStrategies, vulnerabilitySelection, capabilities] =
    await planStrategiesForVulnerabilities({
      ...options,
      vulnerabilities: [...new Set(categoryToVulnerability.values())],
    });
  const strategies: Record<string, AttackStrategy[]> = {},
    selection: Record<string, StrategySelection | Record<string, never>> = {};
  for (const category of options.categories) {
    const vulnerability = categoryToVulnerability.get(category);
    if (vulnerability) {
      strategies[category] = vulnerabilityStrategies[vulnerability] ?? [];
      selection[category] = vulnerabilitySelection[vulnerability] ?? {};
    } else {
      const applicable = filterStrategiesByMethod(
        selectApplicableStrategies(
          category,
          options.agentContext,
          capabilities,
        ),
        {
          names: options.strategyNames,
          deliveryMethods: options.deliveryMethods,
          attackTechniques: options.attackTechniques,
        },
      );
      strategies[category] = applicable;
      selection[category] = {
        allHardcoded: applicable,
        applicable,
        allHardcodedCount: applicable.length,
        applicableCount: applicable.length,
        generatedCount: 0,
        generatedSingleCount: 0,
        generatedMultiCount: 0,
        filteredCount: 0,
        totalSelected: applicable.length,
      };
    }
  }
  return [strategies, selection, capabilities];
}
