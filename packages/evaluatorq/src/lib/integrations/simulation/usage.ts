import { extractUsage, type Usage, UsageSchema } from "../../contracts.js";
import type { TokenUsage } from "./types.js";
export function usageDetails(
  legacy: TokenUsage,
  detailed?: Usage | null,
): Usage {
  return detailed ?? extractUsage(legacy, 0) ?? UsageSchema.parse({});
}
export function usageDelta(after: Usage, before: Usage | null): Usage {
  const zero = before ?? UsageSchema.parse({});
  const delta = UsageSchema.parse({});
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedTokens",
    "cacheCreationTokens",
    "cacheCreation1hTokens",
    "cacheCreation5mTokens",
    "reasoningTokens",
    "calls",
    "pricedCalls",
  ] as const)
    delta[key] = Math.max(0, after[key] - zero[key]);
  for (const key of ["inputCost", "outputCost", "totalCost"] as const)
    delta[key] =
      after[key] === null ? null : Math.max(0, after[key] - (zero[key] ?? 0));
  return delta;
}
