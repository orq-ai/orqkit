import {
  type DatasetClient,
  fetchDatasetBatches,
  setupOrqClient,
} from "../../common/fetch-data.js";
import { extractSingleDatapoint } from "./datapoint-io.js";
import {
  extendFromSeeds,
  requireOrqApiKey,
  type SeedExtensionOptions,
} from "./seed-extension.js";
import type { Datapoint } from "./types.js";

export interface DatasetSourceOptions {
  apiKey?: string;
  baseUrl?: string;
  orqClient?: DatasetClient;
}
export async function datapointsFromDataset(
  datasetId: string,
  options: DatasetSourceOptions = {},
): Promise<Datapoint[]> {
  const key = requireOrqApiKey(options.apiKey, "load Orq datasets");
  const client =
    options.orqClient ?? (await setupOrqClient(key, options.baseUrl));
  const out: Datapoint[] = [];
  for await (const batch of fetchDatasetBatches(client, datasetId))
    for (const row of batch.datapoints) {
      try {
        out.push(extractSingleDatapoint(row, "row"));
      } catch (error) {
        throw new Error(
          `dataset '${datasetId}' row ${out.length}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  if (!out.length)
    throw new Error(
      `Dataset '${datasetId}' returned zero simulation-compatible datapoints`,
    );
  return out;
}
export interface ExtendFromDatasetOptions
  extends DatasetSourceOptions,
    SeedExtensionOptions {}
export async function extendFromDataset(
  datasetId: string,
  options: ExtendFromDatasetOptions = {},
): Promise<Datapoint[]> {
  const key = requireOrqApiKey(options.apiKey, "load Orq datasets");
  return extendFromSeeds(
    await datapointsFromDataset(datasetId, { ...options, apiKey: key }),
    { ...options, apiKey: key },
  );
}
