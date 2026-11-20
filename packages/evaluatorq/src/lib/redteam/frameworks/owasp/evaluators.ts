import { roleModel } from "../../../common/model-roles.js";
import { pythonStrip } from "../../../common/sanitize.js";
import type { Vulnerability } from "../../contracts.js";
import {
  CANONICAL_EVALUATOR_METADATA,
  resolveCategorySafe,
} from "../../vulnerability-registry.js";
import { evaluatorData, vulnerabilityEvaluators } from "./data.js";
import { LlmEvaluatorEntity } from "./models.js";
export type EvaluatorGetter = (modelId?: string | null) => LlmEvaluatorEntity;
function createEvaluator(
  category: string,
  modelId?: string | null,
): LlmEvaluatorEntity | null {
  const entity = (evaluatorData as Record<string, typeof evaluatorData.ASI01>)[
    category
  ];
  return entity
    ? new LlmEvaluatorEntity({
        ...entity,
        model: {
          ...entity.model,
          id: modelId || roleModel("smart", { task: "redteam.evaluator" }),
        },
      })
    : null;
}
const registry: Record<string, EvaluatorGetter> = Object.create(null);
for (const category of Object.keys(evaluatorData)) {
  const getter = (modelId?: string | null) =>
    createEvaluator(category, modelId) as LlmEvaluatorEntity;
  registry[category] = getter;
}
const ordered: Record<string, EvaluatorGetter> = Object.create(null);
for (const prefix of ["ASI", "LLM"]) {
  for (const [category, getter] of Object.entries(registry))
    if (category.startsWith(prefix)) ordered[category] = getter;
  for (const [category, getter] of Object.entries(registry))
    if (category.startsWith(prefix)) ordered[`OWASP-${category}`] = getter;
}
export const OWASP_EVALUATOR_REGISTRY: Readonly<
  Record<string, EvaluatorGetter>
> = Object.freeze(ordered);
export const OWASP_EVALUATOR_REGISTRY_FULL = Object.freeze({
  ...OWASP_EVALUATOR_REGISTRY,
});
export const VULNERABILITY_EVALUATOR_REGISTRY: Readonly<
  Partial<Record<Vulnerability, EvaluatorGetter>>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(vulnerabilityEvaluators).map(([vulnerability, category]) => [
      vulnerability,
      registry[category],
    ]),
  ),
);
export function getEvaluatorForCategory(
  category: string,
  modelId?: string | null,
): LlmEvaluatorEntity | null {
  return OWASP_EVALUATOR_REGISTRY[category]?.(modelId) ?? null;
}
export function getEvaluatorForVulnerability(
  vulnerability: Vulnerability,
  modelId?: string | null,
): LlmEvaluatorEntity | null {
  return Object.hasOwn(VULNERABILITY_EVALUATOR_REGISTRY, vulnerability)
    ? (VULNERABILITY_EVALUATOR_REGISTRY[vulnerability]?.(modelId) ?? null)
    : null;
}
export interface EvaluatorMetadata {
  evaluatorId: string;
  evaluatorName: string;
}
function entityMetadata(
  entity: LlmEvaluatorEntity | null,
): EvaluatorMetadata | null {
  const id = pythonStrip(entity?.id || "");
  if (!id) return null;
  return {
    evaluatorId: id,
    evaluatorName: pythonStrip(entity?.displayName || "") || id,
  };
}
export function getEvaluatorMetadataForVulnerability(
  vulnerability: Vulnerability,
): EvaluatorMetadata | null {
  const canonical = Object.hasOwn(CANONICAL_EVALUATOR_METADATA, vulnerability)
    ? CANONICAL_EVALUATOR_METADATA[
        vulnerability as keyof typeof CANONICAL_EVALUATOR_METADATA
      ]
    : undefined;
  return canonical
    ? {
        evaluatorId: canonical.evaluator_id,
        evaluatorName: canonical.evaluator_name,
      }
    : entityMetadata(getEvaluatorForVulnerability(vulnerability));
}
export function getEvaluatorMetadataForCategory(
  category: string,
): EvaluatorMetadata | null {
  const normalized = category.startsWith("OWASP-")
      ? category.slice(6)
      : category,
    vulnerability = resolveCategorySafe(normalized);
  return vulnerability
    ? getEvaluatorMetadataForVulnerability(vulnerability)
    : entityMetadata(getEvaluatorForCategory(normalized));
}
export function listAvailableEvaluatorCategories(): string[] {
  return Object.keys(OWASP_EVALUATOR_REGISTRY);
}
export function getAsi01GoalHijackingEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI01", modelId) as LlmEvaluatorEntity;
}
export function getAsi02ToolMisuseEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI02", modelId) as LlmEvaluatorEntity;
}
export function getAsi03PrivilegeAbuseEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI03", modelId) as LlmEvaluatorEntity;
}
export function getAsi04SupplyChainEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI04", modelId) as LlmEvaluatorEntity;
}
export function getAsi05CodeExecutionEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI05", modelId) as LlmEvaluatorEntity;
}
export function getAsi06MemoryPoisoningEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI06", modelId) as LlmEvaluatorEntity;
}
export function getAsi07InteragentCommEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI07", modelId) as LlmEvaluatorEntity;
}
export function getAsi08CascadingFailuresEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI08", modelId) as LlmEvaluatorEntity;
}
export function getAsi09TrustExploitationEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI09", modelId) as LlmEvaluatorEntity;
}
export function getAsi10RogueAgentsEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("ASI10", modelId) as LlmEvaluatorEntity;
}
export function getLlm01PromptInjectionEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM01", modelId) as LlmEvaluatorEntity;
}
export function getLlm02SensitiveInfoDisclosureEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM02", modelId) as LlmEvaluatorEntity;
}
export function getLlm04DataModelPoisoningEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM04", modelId) as LlmEvaluatorEntity;
}
export function getLlm05ImproperOutputHandlingEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM05", modelId) as LlmEvaluatorEntity;
}
export function getLlm06ExcessiveAgencyEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM06", modelId) as LlmEvaluatorEntity;
}
export function getLlm07SystemPromptLeakageEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM07", modelId) as LlmEvaluatorEntity;
}
export function getLlm08VectorEmbeddingWeaknessesEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM08", modelId) as LlmEvaluatorEntity;
}
export function getLlm09MisinformationEvaluator(
  modelId?: string | null,
): LlmEvaluatorEntity {
  return createEvaluator("LLM09", modelId) as LlmEvaluatorEntity;
}
