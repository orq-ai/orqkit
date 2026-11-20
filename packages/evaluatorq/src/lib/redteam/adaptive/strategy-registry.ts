import type { AgentContext } from "../../contracts.js";
import {
  AgentCapability,
  type AttackTechnique,
  type DeliveryMethod,
  type Vulnerability,
} from "../contracts.js";
import { type AttackStrategy, AttackStrategySchema } from "../strategy.js";
import {
  CATEGORY_TO_VULNERABILITY,
  VULNERABILITY_DEFS,
} from "../vulnerability-registry.js";
import type { AgentCapabilities } from "./capability-classifier.js";
import {
  categoryNames,
  evaluatorCategories,
  strategyData,
} from "./strategy-data.js";

const categories: Record<string, readonly AttackStrategy[]> =
  Object.create(null);
const vulnerabilities: Partial<
  Record<Vulnerability, readonly AttackStrategy[]>
> = Object.create(null);
for (const [category, data] of Object.entries(
  strategyData as Record<string, unknown[]>,
)) {
  const strategies = Object.freeze(
    data.map((value) => AttackStrategySchema.parse(value)),
  );
  categories[category] = strategies;
  categories[`OWASP-${category}`] = strategies;
  const vulnerability = CATEGORY_TO_VULNERABILITY[category];
  if (vulnerability) vulnerabilities[vulnerability] = strategies;
}
export const STRATEGY_REGISTRY: Readonly<
  Record<string, readonly AttackStrategy[]>
> = Object.freeze(categories);
export const VULNERABILITY_STRATEGY_REGISTRY: Readonly<
  Partial<Record<Vulnerability, readonly AttackStrategy[]>>
> = Object.freeze(vulnerabilities);
export function getStrategiesForCategory(category: string): AttackStrategy[] {
  return [...(STRATEGY_REGISTRY[category] ?? [])];
}
export function getStrategiesForVulnerability(
  vulnerability: Vulnerability,
): AttackStrategy[] {
  return [...(VULNERABILITY_STRATEGY_REGISTRY[vulnerability] ?? [])];
}
function fallbackCapabilityCheck(
  required: readonly AgentCapability[],
  context: AgentContext,
): boolean {
  return required.some((cap) =>
    cap === AgentCapability.MEMORY_READ || cap === AgentCapability.MEMORY_WRITE
      ? context.memoryStores.length > 0
      : cap === AgentCapability.KNOWLEDGE_RETRIEVAL
        ? context.knowledgeBases.length > 0
        : context.tools.length > 0,
  );
}
function applicable(
  strategies: readonly AttackStrategy[],
  context: AgentContext,
  capabilities?: AgentCapabilities | null,
): AttackStrategy[] {
  return strategies.filter((strategy) => {
    if (strategy.requiresTools && !context.tools.length) return false;
    if (!strategy.requiredCapabilities.length) return true;
    if (capabilities == null)
      return fallbackCapabilityCheck(strategy.requiredCapabilities, context);
    return (
      capabilities.classificationFailed ||
      capabilities.hasAny(strategy.requiredCapabilities)
    );
  });
}
export function selectApplicableStrategies(
  category: string,
  context: AgentContext,
  capabilities?: AgentCapabilities | null,
): AttackStrategy[] {
  return applicable(getStrategiesForCategory(category), context, capabilities);
}
export function selectApplicableStrategiesForVulnerability(
  vulnerability: Vulnerability,
  context: AgentContext,
  capabilities?: AgentCapabilities | null,
): AttackStrategy[] {
  return applicable(
    getStrategiesForVulnerability(vulnerability),
    context,
    capabilities,
  );
}
export interface StrategyFilters {
  names?: ReadonlySet<string> | null;
  deliveryMethods?: ReadonlySet<DeliveryMethod | string> | null;
  attackTechniques?: ReadonlySet<AttackTechnique> | null;
}
export function filterStrategiesByMethod(
  strategies: readonly AttackStrategy[],
  filters: StrategyFilters = {},
): AttackStrategy[] {
  return strategies.filter(
    (strategy) =>
      (filters.names == null || filters.names.has(strategy.name)) &&
      (filters.deliveryMethods == null ||
        strategy.deliveryMethods.some((method) =>
          filters.deliveryMethods?.has(method),
        )) &&
      (filters.attackTechniques == null ||
        filters.attackTechniques.has(strategy.attackTechnique)),
  );
}
export function knownStrategyNames(): Set<string> {
  return new Set(
    Object.values(VULNERABILITY_STRATEGY_REGISTRY).flatMap((strategies) =>
      strategies.map((strategy) => strategy.name),
    ),
  );
}
export function listAvailableCategories(): string[] {
  return [
    ...new Set([
      ...Object.keys(STRATEGY_REGISTRY).filter(
        (key) => !key.startsWith("OWASP-"),
      ),
      ...evaluatorCategories,
    ]),
  ].sort();
}
export function getCategoryInfo(): Record<
  string,
  {
    name: string;
    strategyCount: number;
    singleTurnCount: number;
    multiTurnCount: number;
    vulnerability: Vulnerability | null;
    vulnerabilityName: string | null;
  }
> {
  return Object.fromEntries(
    listAvailableCategories().map((category) => {
      const strategies = getStrategiesForCategory(category),
        vulnerability = CATEGORY_TO_VULNERABILITY[category] ?? null;
      return [
        category,
        {
          name: (categoryNames as Record<string, string>)[category] ?? category,
          strategyCount: strategies.length,
          singleTurnCount: strategies.filter(
            (strategy) => strategy.turnType === "single",
          ).length,
          multiTurnCount: strategies.filter(
            (strategy) => strategy.turnType === "multi",
          ).length,
          vulnerability,
          vulnerabilityName: vulnerability
            ? (VULNERABILITY_DEFS[vulnerability]?.name ?? vulnerability)
            : null,
        },
      ];
    }),
  );
}
