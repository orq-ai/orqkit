import { z } from "zod/v4";

const number = z.preprocess(
  (value) =>
    typeof value === "boolean"
      ? Number(value)
      : typeof value === "string" && value.trim()
        ? Number(value)
        : value,
  z.number(),
);
const boolean = z.preprocess((value) => {
  if (value === 1 || value === 0) return Boolean(value);
  if (typeof value === "string") {
    if (["1", "true", "t", "yes", "y", "on"].includes(value.toLowerCase()))
      return true;
    if (["0", "false", "f", "no", "n", "off"].includes(value.toLowerCase()))
      return false;
  }
  return value;
}, z.boolean());

export const PersonaSchema = z.object({
  name: z.string(),
  patience: number,
  assertiveness: number,
  politeness: number,
  technical_level: number,
  communication_style: z.enum(["formal", "casual", "terse", "verbose"]),
  background: z.string(),
  emotional_arc: z
    .enum([
      "stable",
      "escalating",
      "de_escalating",
      "volatile",
      "manipulative",
      "hostile",
    ])
    .nullable()
    .default(null),
  cultural_context: z
    .enum([
      "neutral",
      "direct",
      "indirect",
      "high_context",
      "low_context",
      "hierarchical",
    ])
    .nullable()
    .default(null),
});

export const CriterionSchema = z.object({
  description: z.string(),
  type: z.enum(["must_happen", "must_not_happen"]),
  evaluator: z.string().nullable().default(null),
});

export const ScenarioSchema = z.object({
  name: z.string(),
  goal: z.string(),
  context: z.string().nullable().default(null),
  starting_emotion: z
    .enum(["neutral", "frustrated", "confused", "happy", "urgent"])
    .nullable()
    .default(null),
  criteria: z.array(CriterionSchema).nullable().default(null),
  is_edge_case: boolean.nullable().default(null),
  conversation_strategy: z
    .enum([
      "cooperative",
      "topic_switching",
      "contradictory",
      "multi_intent",
      "evasive",
      "repetitive",
      "ambiguous",
    ])
    .nullable()
    .default(null),
  ground_truth: z.string().nullable().default(null),
  input_format: z
    .enum([
      "plain_text",
      "with_url",
      "with_attachment",
      "form_data",
      "code_block",
      "mixed_media",
    ])
    .nullable()
    .default(null),
});

export const DatapointSchema = z.object({
  id: z.string(),
  persona: PersonaSchema,
  scenario: ScenarioSchema,
  user_system_prompt: z.string(),
  first_message: z.string(),
});

export const CriteriaMetaSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    type: z.enum(["must_happen", "must_not_happen"]),
    passed: z.boolean(),
    audited: z.boolean().nullable().default(null),
    evidence: z.string().nullable().default(null),
  })
  .strict();
