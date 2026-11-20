import {
  type ExperimentClient,
  fetchExperimentDataPoints,
} from "../../common/fetch-data.js";
import type { FetchLike } from "../../common/trace-input.js";
import { extractSingleDatapoint } from "./datapoint-io.js";
import {
  extendFromSeeds,
  requireOrqApiKey,
  type SeedExtensionOptions,
} from "./seed-extension.js";
import type { Datapoint } from "./types.js";

export interface ExperimentSourceOptions {
  runId?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  orqClient?: ExperimentClient;
}
export async function datapointsFromExperiment(
  experimentId: string,
  options: ExperimentSourceOptions = {},
): Promise<Datapoint[]> {
  const key = requireOrqApiKey(options.apiKey, "load Orq experiments");
  const rows = await fetchExperimentDataPoints(
    key,
    experimentId,
    options.runId,
    options,
  );
  const out: Datapoint[] = [];
  for (const row of rows) {
    try {
      out.push(extractSingleDatapoint(row, "row"));
    } catch (error) {
      throw new Error(
        `experiment '${experimentId}' row ${out.length}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  if (!out.length)
    throw new Error(
      `Experiment '${experimentId}' returned zero simulation-compatible rows`,
    );
  return out;
}
export interface ExtendFromExperimentOptions
  extends ExperimentSourceOptions,
    SeedExtensionOptions {}
export async function extendFromExperiment(
  experimentId: string,
  options: ExtendFromExperimentOptions = {},
): Promise<Datapoint[]> {
  const key = requireOrqApiKey(options.apiKey, "load Orq experiments");
  return extendFromSeeds(
    await datapointsFromExperiment(experimentId, { ...options, apiKey: key }),
    { ...options, apiKey: key },
  );
}
