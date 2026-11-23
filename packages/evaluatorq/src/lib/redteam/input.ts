import { z } from "zod/v4";

import { MessageSchema } from "../contracts.js";
import {
  Framework,
  FrameworkSchema,
  normalizeFramework,
  SeveritySchema,
  TurnTypeSchema,
  VulnerabilityDomainSchema,
} from "./contracts.js";
import {
  getPrimaryCategory,
  resolveCategorySafe,
} from "./vulnerability-registry.js";

const inputKeys = [
  "attackTechnique",
  "deliveryMethod",
  "vulnerabilityDomain",
  "evaluatorId",
  "evaluatorName",
  "turnType",
  "additionalMetadata",
];
function normalizeInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = { ...raw } as Record<string, unknown>;
  for (const name of inputKeys) {
    const snake = name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (!(name in value) && snake in value) value[name] = value[snake];
  }
  if (!("vulnerabilityDomain" in value) && "scope" in value) {
    const scope = value.scope;
    value.vulnerabilityDomain = scope === "application" ? "agent" : scope;
  }
  if (
    typeof value.vulnerability === "string" &&
    value.vulnerability &&
    !value.category
  )
    value.category = getPrimaryCategory(value.vulnerability);
  else if (
    typeof value.category === "string" &&
    value.category &&
    !value.vulnerability
  ) {
    const vulnerability = resolveCategorySafe(value.category);
    if (vulnerability !== null) value.vulnerability = vulnerability;
  }
  return value;
}
export const RedTeamInputSchema = z.preprocess(
  normalizeInput,
  z
    .object({
      id: z.string().min(1),
      vulnerability: z.string().default(""),
      category: z.string().default(""),
      attackTechnique: z.string().default(""),
      deliveryMethod: z.string().default(""),
      severity: SeveritySchema,
      vulnerabilityDomain: VulnerabilityDomainSchema,
      framework: z.preprocess((value, ctx) => {
        if (typeof value !== "string") return value;
        try {
          return normalizeFramework(value);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: `Unknown framework: ${value}`,
          });
          return z.NEVER;
        }
      }, FrameworkSchema.default(Framework.OWASP_AGENTIC)),
      evaluatorId: z.string().default(""),
      evaluatorName: z.string().default(""),
      turnType: TurnTypeSchema,
      source: z.string().min(1),
      additionalMetadata: z
        .record(z.string(), z.unknown())
        .nullable()
        .default(null),
    })
    .superRefine((value, ctx) => {
      if (!value.vulnerability && !value.category)
        ctx.addIssue({
          code: "custom",
          message:
            "RedTeamInput requires at least one of vulnerability or category",
        });
    }),
);
export type RedTeamInput = z.infer<typeof RedTeamInputSchema>;
export const CanonicalMessageSchema = z.unknown().transform((value, ctx) => {
  const parsed = MessageSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues)
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  return z.NEVER;
});
export const RedTeamSampleSchema = z.object({
  input: RedTeamInputSchema,
  messages: z.array(CanonicalMessageSchema).min(1),
});
export type RedTeamSample = z.infer<typeof RedTeamSampleSchema>;
export const StaticDatasetSchema = z.object({
  samples: z.array(RedTeamSampleSchema).min(1),
});
export type StaticDataset = z.infer<typeof StaticDatasetSchema>;
export const TargetConfigSchema = z.preprocess(
  (value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const raw = value as Record<string, unknown>;
      return {
        systemPrompt: Object.hasOwn(raw, "systemPrompt")
          ? raw.systemPrompt
          : raw.system_prompt,
      };
    }
    return value;
  },
  z.object({ systemPrompt: z.string().nullable().default(null) }),
);
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
