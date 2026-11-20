import { configuredOrqHost } from "../orq-host.js";
import type { DataPoint, Output } from "../types.js";
import { orqServerUrl, resolveOrqClient } from "./orq-client.js";
import { pythonStrip } from "./sanitize.js";
import type { FetchLike } from "./trace-input.js";

export async function setupOrqClient(apiKey: string, baseUrl?: string) {
  return resolveOrqClient(
    apiKey,
    baseUrl ?? configuredOrqHost() ?? "https://my.orq.ai",
  );
}

export interface DatasetClient {
  datasets: {
    listDatapoints(request: {
      datasetId: string;
      limit: number;
      startingAfter?: string;
    }): Promise<{
      data: {
        inputs?: Record<string, unknown>;
        expectedOutput?: Output;
        messages?: unknown[];
        id?: string;
        _id?: string;
      }[];
      hasMore?: boolean;
    }>;
  };
}

export interface ExperimentClient {
  experiments: {
    listRuns(request: { experimentId: string; limit: number }): Promise<{
      data?: { runId?: string; createdAt?: Date }[];
      hasMore?: boolean;
    }>;
    exportRun(
      request: { experimentId: string; runId: string; format: "jsonl" },
      options?: { timeoutMs?: number },
    ): Promise<ReadableStream<Uint8Array>>;
  };
}

export interface DataPointBatch {
  datapoints: DataPoint[];
  hasMore: boolean;
  batchNumber: number;
}

export async function* fetchDatasetBatches(
  orqClient: DatasetClient,
  datasetId: string,
  options?: { includeMessages?: boolean },
): AsyncGenerator<DataPointBatch> {
  let startingAfter: string | undefined;
  let batchNumber = 0;
  let hasYielded = false;
  const cursors = new Set<string>();

  try {
    while (true) {
      const response = await orqClient.datasets.listDatapoints({
        datasetId,
        limit: 50,
        startingAfter,
      });

      if (!response.data || response.data.length === 0) {
        if (!hasYielded) {
          throw new Error(`Dataset ${datasetId} not found or has no data`);
        }
        throw new Error(
          "Dataset pagination ended while hasMore was true; refusing a partial import",
        );
      }

      const batchDatapoints: DataPoint[] = [];
      for (const datapoint of response.data) {
        const inputs = { ...(datapoint.inputs || {}) };
        if (options?.includeMessages) {
          if ("messages" in inputs) {
            throw new Error(
              "includeMessages is enabled but the datapoint inputs already contain a 'messages' key. Remove 'messages' from inputs or disable includeMessages.",
            );
          }
          if (datapoint.messages) {
            inputs.messages = datapoint.messages;
          }
        }
        batchDatapoints.push({
          inputs,
          expectedOutput: datapoint.expectedOutput,
        } as DataPoint);

        startingAfter =
          (datapoint as unknown as { _id?: string })._id ??
          (datapoint as unknown as { id?: string }).id;
      }

      batchNumber++;
      const hasMore = response.hasMore ?? false;
      if (hasMore) {
        if (!startingAfter || cursors.has(startingAfter))
          throw new Error(
            "Dataset pagination returned a missing or repeated cursor; refusing a partial import",
          );
        cursors.add(startingAfter);
      }

      yield {
        datapoints: batchDatapoints,
        hasMore,
        batchNumber,
      };
      hasYielded = true;

      if (!hasMore) {
        break;
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to fetch dataset ${datasetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function fetchDatasetAsDataPoints(
  orqClient: DatasetClient,
  datasetId: string,
  options?: { includeMessages?: boolean },
): Promise<Promise<DataPoint>[]> {
  const allDatapoints: DataPoint[] = [];
  for await (const batch of fetchDatasetBatches(
    orqClient,
    datasetId,
    options,
  )) {
    allDatapoints.push(...batch.datapoints);
  }
  return allDatapoints.map((dp) => Promise.resolve(dp));
}

export function experimentRowToDataPoint(
  row: Record<string, unknown>,
): DataPoint {
  let raw = row.inputs;
  if (typeof raw === "string") {
    try {
      raw = pythonStrip(raw) ? JSON.parse(raw) : {};
    } catch {
      raw = { input: raw };
    }
  }
  const inputs: Record<string, unknown> =
    raw === null || raw === undefined
      ? {}
      : typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : { input: raw };
  const messages: unknown[] = Array.isArray(inputs.messages)
    ? [...inputs.messages]
    : [];
  if (
    row.task_output !== null &&
    row.task_output !== undefined &&
    pythonStrip(String(row.task_output))
  )
    messages.push({ role: "assistant", content: row.task_output });
  inputs.messages = messages;
  return { inputs, expectedOutput: row.expected_output as Output | undefined };
}

const PYTHON_LINE_BREAKS =
  "\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]";

export function rowsFromExperimentExport(
  text: string,
  experimentId: string,
  runId: string,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of text
    .split(new RegExp(PYTHON_LINE_BREAKS))
    .entries()) {
    if (!pythonStrip(line)) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Malformed JSONL on line ${index + 1} of the export for run '${runId}' (experiment '${experimentId}')`,
        { cause: error },
      );
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error(
        `Export for run '${runId}' (experiment '${experimentId}') line ${index + 1} is not an object`,
      );
    rows.push(row as Record<string, unknown>);
  }
  if (!rows.length)
    throw new Error(
      `Experiment run '${runId}' (experiment '${experimentId}') returned no rows to evaluate.`,
    );
  return rows;
}

export async function fetchExperimentDataPoints(
  apiKey: string,
  experimentId: string,
  runId?: string,
  options: {
    baseUrl?: string;
    orqClient?: ExperimentClient;
    fetchFn?: FetchLike;
  } = {},
): Promise<DataPoint[]> {
  const client =
    options.orqClient ?? (await setupOrqClient(apiKey, options.baseUrl));
  let resolved = runId;
  if (resolved === undefined) {
    const runs = await client.experiments.listRuns({ experimentId, limit: 1 });
    const latest = runs.data?.[0];
    if (!latest)
      throw new Error(
        `Experiment '${experimentId}' has no runs to load responses from.`,
      );
    if (!latest.createdAt || !Number.isFinite(latest.createdAt.getTime()))
      throw new Error(
        `Experiment '${experimentId}' latest run has no created timestamp; pass runId explicitly.`,
      );
    resolved = latest.runId;
    if (!resolved)
      throw new Error(
        `Could not determine the latest run for experiment '${experimentId}'.`,
      );
  }
  let text: string;
  if (options.orqClient) {
    const stream = await client.experiments.exportRun(
      { experimentId, runId: resolved, format: "jsonl" },
      { timeoutMs: 60_000 },
    );
    text = await new Response(stream).text();
  } else {
    // The API returns x-ndjson, which the installed SDK's export matcher rejects.
    const base = (
      options.baseUrl ??
      configuredOrqHost() ??
      orqServerUrl()
    ).replace(/\/+$/, "");
    const url = `${base}/v3/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(resolved)}/export?format=jsonl`;
    const response = await (options.fetchFn ?? fetch)(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/x-ndjson",
      },
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Could not export run '${resolved}' for experiment '${experimentId}': HTTP ${response.status}`,
      );
    text = await response.text();
  }
  return rowsFromExperimentExport(text, experimentId, resolved).map(
    experimentRowToDataPoint,
  );
}
