export const TURN_METRICS = [
  { key: "response_quality", label: "response quality", highIsRisky: false },
  { key: "hallucination_risk", label: "hallucination risk", highIsRisky: true },
  {
    key: "tone_appropriateness",
    label: "tone appropriateness",
    highIsRisky: false,
  },
  { key: "factual_accuracy", label: "factual accuracy", highIsRisky: false },
] as const;
export function isErroredResult(result: {
  metadata?: Record<string, unknown>;
  terminated_by?: string;
}): boolean {
  const metadata = result.metadata ?? {};
  return (
    Boolean(metadata.error) ||
    (Array.isArray(metadata.criteria_errors) &&
      metadata.criteria_errors.length > 0) ||
    result.terminated_by === "error"
  );
}
