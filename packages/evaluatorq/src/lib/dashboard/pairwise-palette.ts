import type { PairwiseRun } from "../pairwise-run.js";

export function pwSideColour(value: string | null | undefined): string {
  if (value === "A") return "var(--pw-a)";
  if (value === "B") return "var(--pw-b)";
  if (value === "tie") return "var(--pw-tie)";
  return "var(--pw-none)";
}

export function pwSideLabel(
  value: string | null | undefined,
  run: Pick<PairwiseRun, "labelA" | "labelB">,
): string {
  if (value === "A") return run.labelA;
  if (value === "B") return run.labelB;
  if (value === "tie" || value === "inconclusive") return value;
  return "abstain";
}

export function verdictEyebrow(state: string): string {
  if (state === "clear") return "✓ Clear winner";
  if (state === "no_decided") return "No decided comparisons";
  return "⚠ Too close to call";
}
