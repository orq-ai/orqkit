import type { SimulationResult } from "./types.js";

export class SimulationError extends Error {
  override name = "SimulationError";
}
export class SimulationCancelledError extends SimulationError {
  override name = "SimulationCancelledError";
}
export class SimulationDroppedError extends SimulationError {
  override name = "SimulationDroppedError";
  constructor(
    message: string,
    readonly partialResults: SimulationResult[],
  ) {
    super(message);
  }
}
