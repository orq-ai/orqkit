import type { Output, Scorer } from "../../types.js";
import type { SimulationScorer } from "./evaluators/index.js";
import type { SimulationResult } from "./types.js";

const results = new WeakMap<object, SimulationResult>();

export function rememberSimulationResult(
  output: Output,
  result: SimulationResult,
): void {
  if (output !== null && typeof output === "object")
    results.set(output, result);
}

export function wrapSimulationScorer(scorer: SimulationScorer): Scorer {
  return async ({ output }) => {
    const result =
      output !== null && typeof output === "object"
        ? results.get(output)
        : undefined;
    if (!result)
      throw new Error(
        "wrapSimulationScorer requires output from wrapSimulationAgent in the same process",
      );
    return { value: scorer(result) };
  };
}
