import { z } from "zod/v4";

import { categoryNames } from "./adaptive/strategy-data.js";

export const OWASP_CATEGORY_NAMES: Readonly<Record<string, string>> =
  Object.freeze(categoryNames);

export const AttackTechnique = Object.freeze({
  INDIRECT_INJECTION: "indirect-injection",
  DIRECT_INJECTION: "direct-injection",
  DAN: "DAN",
  AUTODAN: "autodan",
  DEVELOPER_MODE: "developer-mode",
  CREDENTIAL_CACHING: "credential-caching",
  PRIVILEGE_ESCALATION: "privilege-escalation",
  CONFUSED_DEPUTY: "confused-deputy",
  EXCESSIVE_AGENCY: "excessive-agency",
  PLUGIN_ABUSE: "plugin-abuse",
  RCE_EXPLOIT: "rce-exploit",
  SUPPLY_CHAIN: "supply-chain",
  RESOURCE_EXHAUSTION: "resource-exhaustion",
  MESSAGE_SPOOFING: "message-spoofing",
  SOCIAL_ENGINEERING: "social-engineering",
  EMOTIONAL_MANIPULATION: "emotional-manipulation",
  PAYLOAD_SPLITTING: "payload-splitting",
  ALTERNATIVE_ENCODING: "alternative-encoding",
  UNICODE_OBFUSCATION: "unicode-obfuscation",
  MODEL_EXTRACTION: "model-extraction",
  PII_EXTRACTION: "pii-extraction",
  PII_INPUT: "pii-input",
  SYSTEM_PROMPT_EXTRACTION: "system-prompt-extraction",
  TOOL_ABUSE: "tool-abuse",
  CONTEXT_POISONING: "context-poisoning",
  CASCADE_TRIGGER: "cascade-trigger",
  BOUNDARY_VIOLATION: "boundary-violation",
} as const);
export type AttackTechnique =
  (typeof AttackTechnique)[keyof typeof AttackTechnique];
export const AttackTechniqueSchema = z.enum(AttackTechnique);

export const DeliveryMethod = Object.freeze({
  DAN: "DAN",
  ROLE_PLAY: "role-play",
  SKELETON_KEY: "skeleton-key",
  BASE64: "base64",
  LEETSPEAK: "leetspeak",
  MULTILINGUAL: "multilingual",
  CHARACTER_SPACING: "character-spacing",
  CRESCENDO: "crescendo",
  MANY_SHOT: "many-shot",
  AUTHORITY_IMPERSONATION: "authority-impersonation",
  REFUSAL_SUPPRESSION: "refusal-suppression",
  DIRECT_REQUEST: "direct-request",
  CODE_ELICITATION: "code-elicitation",
  CODE_ASSISTANCE: "code-assistance",
  TOOL_RESPONSE: "tool-response",
  WORD_SUBSTITUTION: "word-substitution",
} as const);
export type DeliveryMethod =
  (typeof DeliveryMethod)[keyof typeof DeliveryMethod];
export const DeliveryMethodSchema = z.enum(DeliveryMethod);

export const Severity = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const);
export type Severity = (typeof Severity)[keyof typeof Severity];
export const SeveritySchema = z.enum(Severity);

export const Framework = Object.freeze({
  OWASP_LLM: "OWASP-LLM",
  OWASP_ASI: "OWASP-ASI",
  OWASP_AGENTIC: "OWASP-AGENTIC",
  CONTENT: "CONTENT",
  LIABILITY: "LIABILITY",
  FAIRNESS: "FAIRNESS",
  GDPR: "GDPR",
  AI_ACT: "AI-ACT",
} as const);
export type Framework = (typeof Framework)[keyof typeof Framework];
export const FrameworkSchema = z.enum(Framework);

export const VulnerabilityDomain = Object.freeze({
  AGENT: "agent",
  MODEL: "model",
  DATA: "data",
} as const);
export type VulnerabilityDomain =
  (typeof VulnerabilityDomain)[keyof typeof VulnerabilityDomain];
export const VulnerabilityDomainSchema = z.enum(VulnerabilityDomain);

export const Vulnerability = Object.freeze({
  GOAL_HIJACKING: "goal_hijacking",
  TOOL_MISUSE: "tool_misuse",
  IDENTITY_PRIVILEGE_ABUSE: "identity_privilege_abuse",
  SUPPLY_CHAIN: "supply_chain",
  CODE_EXECUTION: "code_execution",
  MEMORY_POISONING: "memory_poisoning",
  INTER_AGENT_COMMS: "inter_agent_comms",
  CASCADING_FAILURES: "cascading_failures",
  TRUST_EXPLOITATION: "trust_exploitation",
  ROGUE_AGENTS: "rogue_agents",
  EXCESSIVE_AGENCY: "excessive_agency",
  PROMPT_INJECTION: "prompt_injection",
  SENSITIVE_INFO_DISCLOSURE: "sensitive_info_disclosure",
  DATA_POISONING: "data_poisoning",
  IMPROPER_OUTPUT: "improper_output",
  SYSTEM_PROMPT_LEAKAGE: "system_prompt_leakage",
  VECTOR_EMBEDDING_WEAKNESS: "vector_embedding_weakness",
  MISINFORMATION: "misinformation",
} as const);
export type Vulnerability = (typeof Vulnerability)[keyof typeof Vulnerability];
export const VulnerabilitySchema = z.enum(Vulnerability);

export const VulnerabilityDefSchema = z.object({
  id: VulnerabilitySchema,
  name: z.string(),
  domain: VulnerabilityDomainSchema,
  description: z.string().default(""),
  defaultAttackTechnique: AttackTechniqueSchema,
  frameworkMappings: z
    .record(z.string(), z.array(z.string()))
    .default(() => ({})),
});
export type VulnerabilityDef = z.infer<typeof VulnerabilityDefSchema>;
export function isKnownAttackTechnique(
  value: string,
): value is AttackTechnique {
  return Object.values(AttackTechnique).some(
    (technique) => technique === value,
  );
}
export const SEVERITY_DEFINITIONS = Object.freeze({
  critical:
    "Attacks that, if successful, could lead to complete system compromise, unauthorized access to sensitive data, or execution of arbitrary actions with full privileges. Immediate remediation required.",
  high: "Attacks that could cause significant harm such as partial data exfiltration, privilege escalation, or bypassing critical safety guardrails. Should be prioritized for remediation.",
  medium:
    "Attacks that could lead to moderate impact such as information leakage of non-sensitive data, minor policy violations, or degraded safety behavior. Should be addressed in normal development cycles.",
  low: "Attacks with limited impact such as minor guideline deviations, edge-case behaviors, or cosmetic safety issues. Address as time permits or during routine hardening.",
} as const);

export const TurnType = Object.freeze({
  SINGLE: "single",
  MULTI: "multi",
} as const);
export type TurnType = (typeof TurnType)[keyof typeof TurnType];
export const TurnTypeSchema = z.enum(TurnType);

export const TargetKind = Object.freeze({
  AGENT: "agent",
  DEPLOYMENT: "deployment",
  DIRECT: "direct",
  OPENAI: "openai",
} as const);
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];
export const TargetKindSchema = z.enum(TargetKind);

export const Pipeline = Object.freeze({
  STATIC: "static",
  DYNAMIC: "dynamic",
  HYBRID: "hybrid",
} as const);
export type Pipeline = (typeof Pipeline)[keyof typeof Pipeline];
export const PipelineSchema = z.enum(Pipeline);

export const PipelineStage = Object.freeze({
  CONTEXT_RETRIEVAL: "context_retrieval",
  DATAPOINT_GENERATION: "datapoint_generation",
  ATTACK_EXECUTION: "attack_execution",
  REPORT_GENERATION: "report_generation",
  CLEANUP: "cleanup",
  TARGET_START: "target_start",
  TARGET_COMPLETE: "target_complete",
  EVALUATION: "evaluation",
} as const);
export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];
export const PipelineStageSchema = z.enum(PipelineStage);

export const AgentCapability = Object.freeze({
  CODE_EXECUTION: "code_execution",
  SHELL_ACCESS: "shell_access",
  FILE_SYSTEM: "file_system",
  DATABASE: "database",
  WEB_REQUEST: "web_request",
  MEMORY_READ: "memory_read",
  MEMORY_WRITE: "memory_write",
  KNOWLEDGE_RETRIEVAL: "knowledge_retrieval",
  EMAIL: "email",
  MESSAGING: "messaging",
  PAYMENT: "payment",
  USER_DATA: "user_data",
} as const);
export type AgentCapability =
  (typeof AgentCapability)[keyof typeof AgentCapability];
export const AgentCapabilitySchema = z.enum(AgentCapability);

export const SaveMode = Object.freeze({
  NONE: "none",
  FINAL: "final",
  DETAIL: "detail",
} as const);
export type SaveMode = (typeof SaveMode)[keyof typeof SaveMode];
export const SaveModeSchema = z.enum(SaveMode);

export const AttackSource = Object.freeze({
  AGENT_DOJO: "AgentDojo",
  ORQ_GENERATED: "orq_generated",
  ORQ_DATASET: "orq_dataset",
  TEMPLATE_DYNAMIC: "template_dynamic",
  GENERATED_DYNAMIC: "generated_dynamic",
} as const);
export type AttackSource = (typeof AttackSource)[keyof typeof AttackSource];
export const AttackSourceSchema = z.enum(AttackSource);

export const ReliabilityMethod = Object.freeze({
  KRIPPENDORFF_ALPHA_NOMINAL: "krippendorff_alpha_nominal",
} as const);
export type ReliabilityMethod =
  (typeof ReliabilityMethod)[keyof typeof ReliabilityMethod];
export const ReliabilityMethodSchema = z.enum(ReliabilityMethod);

export const SUPPORTED_TARGET_KINDS: Readonly<
  Record<Pipeline, readonly TargetKind[]>
> = Object.freeze({
  [Pipeline.STATIC]: Object.freeze([TargetKind.AGENT, TargetKind.DEPLOYMENT]),
  [Pipeline.DYNAMIC]: Object.freeze([TargetKind.AGENT]),
  [Pipeline.HYBRID]: Object.freeze([TargetKind.AGENT]),
});
export function isModelTargetKind(kind: TargetKind): boolean {
  return kind === TargetKind.OPENAI;
}
export function parseTarget(target: string): [TargetKind, string] {
  const separator = target.indexOf(":");
  if (separator < 0) return [TargetKind.AGENT, target];
  const kind = target.slice(0, separator),
    value = target.slice(separator + 1);
  if (!value)
    throw new RangeError(
      `Target ${JSON.stringify(target)} is missing a value after the colon.`,
    );
  if (["llm", "openai"].includes(kind.toLowerCase()))
    throw new RangeError(
      `The ${JSON.stringify(`${kind}:`)} target prefix has been removed. Pass an OpenAIModelTarget object to test models directly.`,
    );
  const normalized = kind.toLowerCase();
  if (normalized === TargetKind.DIRECT)
    throw new RangeError(
      'Target kind "direct" is not valid in string targets; pass an AgentTarget object directly instead. Valid string kinds: "agent", "deployment".',
    );
  if (normalized !== TargetKind.AGENT && normalized !== TargetKind.DEPLOYMENT)
    throw new RangeError(
      `Unknown target kind ${JSON.stringify(kind)} in ${JSON.stringify(target)}. Valid kinds: "agent", "deployment".`,
    );
  return [normalized, value];
}
export function normalizeFramework(framework: Framework | string): Framework {
  return FrameworkSchema.parse(
    framework === Framework.OWASP_AGENTIC ? Framework.OWASP_ASI : framework,
  );
}
export function normalizeCategory(category: string): string {
  return category.startsWith("OWASP-") ? category.slice(6) : category;
}
export function inferFramework(category: string): string {
  const value = normalizeCategory(category);
  return value.startsWith("ASI")
    ? Framework.OWASP_ASI
    : value.startsWith("LLM")
      ? Framework.OWASP_LLM
      : "unknown";
}
