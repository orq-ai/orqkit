export function rateStyle(
  value: number,
  options: { higherIsBetter?: boolean } = {},
): "green" | "yellow" | "red" {
  const score = (options.higherIsBetter ?? true) ? value : 1 - value;
  if (score >= 0.8) {
    return "green";
  }
  return score >= 0.5 ? "yellow" : "red";
}
