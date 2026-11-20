import { z } from "zod/v4";
export const OWASPCategory = Object.freeze({
  ASI01: "ASI01",
  ASI02: "ASI02",
  ASI03: "ASI03",
  ASI04: "ASI04",
  ASI05: "ASI05",
  ASI06: "ASI06",
  ASI07: "ASI07",
  ASI08: "ASI08",
  ASI09: "ASI09",
  ASI10: "ASI10",
} as const);
export type OWASPCategory = (typeof OWASPCategory)[keyof typeof OWASPCategory];
export const OWASPCategorySchema = z.enum(OWASPCategory);
export const LlmEvaluatorOutputFormat = Object.freeze({
  BOOLEAN: "boolean",
  NUMBER: "number",
  STRING: "string",
  CATEGORICAL: "categorical",
} as const);
export type LlmEvaluatorOutputFormat =
  (typeof LlmEvaluatorOutputFormat)[keyof typeof LlmEvaluatorOutputFormat];
function aliases(value: unknown, keys: string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const raw = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!(key in raw) && snake in raw) raw[key] = raw[snake];
  }
  return raw;
}
export const EvaluatorModelConfigSchema = z.preprocess(
  (value) => aliases(value, ["integrationId"]),
  z.object({
    id: z.string(),
    integrationId: z.string().nullable().default(null),
  }),
);
export type EvaluatorModelConfig = z.infer<typeof EvaluatorModelConfigSchema>;
export const LlmEvaluatorEntitySchema = z.preprocess(
  (value) =>
    aliases(value, [
      "displayName",
      "outputType",
      "requiresReference",
      "guardrailConfig",
      "categoricalLabels",
    ]),
  z.object({
    id: z.string().default(""),
    displayName: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    model: EvaluatorModelConfigSchema,
    prompt: z.string(),
    outputType: z.enum(LlmEvaluatorOutputFormat),
    temperature: z.number().default(0.1),
    requiresReference: z.boolean().default(false),
    guardrailConfig: z.record(z.string(), z.unknown()).nullable().default(null),
    categoricalLabels: z
      .array(z.record(z.string(), z.unknown()))
      .nullable()
      .default(null),
  }),
);
export class LlmEvaluatorEntity {
  id!: string;
  displayName!: string | null;
  description!: string | null;
  model!: EvaluatorModelConfig;
  prompt!: string;
  outputType!: LlmEvaluatorOutputFormat;
  temperature!: number;
  requiresReference!: boolean;
  guardrailConfig!: Record<string, unknown> | null;
  categoricalLabels!: Record<string, unknown>[] | null;
  constructor(value: unknown) {
    Object.assign(this, LlmEvaluatorEntitySchema.parse(value));
  }
  get modelId(): string {
    return this.model.id;
  }
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this));
  }
}
