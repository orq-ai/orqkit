import { z } from "zod/v4";

import {
  AgentCapabilitySchema,
  AttackTechniqueSchema,
  DeliveryMethodSchema,
  SeveritySchema,
  TurnTypeSchema,
  VulnerabilitySchema,
} from "./contracts.js";

const bool = z.preprocess((value) => {
  if (value === 0 || value === 1) return Boolean(value);
  if (typeof value === "string") {
    if (["true", "1", "t", "yes", "y", "on"].includes(value.toLowerCase()))
      return true;
    if (["false", "0", "f", "no", "n", "off"].includes(value.toLowerCase()))
      return false;
  }
  return value;
}, z.boolean());
function aliases(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const raw = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    const snake = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (!(key in raw) && snake in raw) raw[key] = raw[snake];
  }
  return raw;
}
export const AttackStrategySchema = z.preprocess(
  (value) =>
    aliases(value, [
      "attackTechnique",
      "deliveryMethods",
      "turnType",
      "requiresTools",
      "requiredCapabilities",
      "objectiveTemplate",
      "promptTemplate",
      "isGenerated",
      "decomposeToolChain",
    ]),
  z
    .object({
      vulnerability: VulnerabilitySchema.nullable().default(null),
      category: z.string(),
      name: z.string(),
      description: z.string(),
      attackTechnique: AttackTechniqueSchema,
      deliveryMethods: z.array(DeliveryMethodSchema),
      turnType: TurnTypeSchema,
      severity: SeveritySchema.default("medium"),
      requiresTools: bool.default(false),
      requiredCapabilities: z.array(AgentCapabilitySchema).default([]),
      objectiveTemplate: z.string(),
      promptTemplate: z.string().nullable().default(null),
      isGenerated: bool.default(false),
      decomposeToolChain: bool.default(false),
    })
    .readonly(),
);
export type AttackStrategy = z.infer<typeof AttackStrategySchema>;
export const RunErrorSchema = z.preprocess(
  (value) => aliases(value, ["errorType"]),
  z
    .object({
      message: z.string(),
      errorType: z.string(),
      stage: z.string().nullable().default(null),
      code: z.string().nullable().default(null),
      details: z.record(z.string(), z.unknown()).nullable().default(null),
      turn: z.number().int().nullable().default(null),
    })
    .readonly(),
);
export type RunError = z.infer<typeof RunErrorSchema>;
