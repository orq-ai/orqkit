/**
 * Zod schemas for optional runtime validation of simulation types.
 *
 * Separated from types.ts so that importing the simulation module
 * does not require zod to be installed. Only users who explicitly
 * import these schemas need zod as a dependency.
 */

import { z } from "zod";

export const PersonaSchema = z.object({
  name: z.string(),
  patience: z.number().min(0).max(1).default(0.5),
  assertiveness: z.number().min(0).max(1).default(0.5),
  politeness: z.number().min(0).max(1).default(0.5),
  technical_level: z.number().min(0).max(1).default(0.5),
  communication_style: z
    .enum(["formal", "casual", "terse", "verbose"])
    .default("casual"),
  background: z.string().default(""),
  emotional_arc: z
    .enum([
      "stable",
      "escalating",
      "de_escalating",
      "volatile",
      "manipulative",
      "hostile",
    ])
    .optional(),
  cultural_context: z
    .enum([
      "neutral",
      "direct",
      "indirect",
      "high_context",
      "low_context",
      "hierarchical",
    ])
    .optional(),
});

export const CriterionSchema = z.object({
  description: z.string(),
  type: z.enum(["must_happen", "must_not_happen"]),
  evaluator: z.string().nullable().optional(),
});

export const ScenarioSchema = z.object({
  name: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  starting_emotion: z
    .enum(["neutral", "frustrated", "confused", "happy", "urgent"])
    .optional(),
  criteria: z.array(CriterionSchema).optional(),
  is_edge_case: z.boolean().optional(),
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
    .optional(),
  ground_truth: z.string().optional(),
  input_format: z
    .enum([
      "plain_text",
      "with_url",
      "with_attachment",
      "form_data",
      "code_block",
      "mixed_media",
    ])
    .optional(),
});
