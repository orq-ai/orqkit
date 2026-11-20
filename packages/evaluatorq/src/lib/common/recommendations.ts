import { z } from "zod/v4";

export const RecommendationConfigBaseSchema = z.strictObject({
  maxSuggestions: z.number().int().min(1).default(3),
  maxTokens: z.number().int().min(1).default(800),
});

export type RecommendationConfigBase = z.infer<
  typeof RecommendationConfigBaseSchema
>;

/** The config to generate recommendations with, or null to skip generation. */
export function resolveRecommendations<T>(
  value: boolean | T,
  defaultConfig: () => T,
): T | null {
  if (value === true) {
    return defaultConfig();
  }
  if (value === false) {
    return null;
  }
  return value;
}
