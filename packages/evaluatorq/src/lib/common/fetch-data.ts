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
    listRuns(request: {
      experimentId: string;
      limit: number;
      startingAfter?: string;
    }): Promise<{
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

export const MAX_EXPERIMENT_EXPORT_BYTES = 100 * 1024 * 1024;

async function beforeDeadline<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function boundedExportText(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await beforeDeadline(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EXPERIMENT_EXPORT_BYTES)
        throw new Error("Experiment export exceeds the 100 MB size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchExperimentDataPoints(
  apiKey: string,
  experimentId: string,
  runId?: string,
  options: {
    baseUrl?: string;
    orqClient?: ExperimentClient;
    fetchFn?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<DataPoint[]> {
  const client =
    options.orqClient ?? (await setupOrqClient(apiKey, options.baseUrl));
  let resolved = runId;
  if (resolved === undefined) {
    let startingAfter: string | undefined;
    let latest: { runId: string; createdAt: Date } | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const page = await client.experiments.listRuns({
        experimentId,
        limit: 50,
        ...(startingAfter && { startingAfter }),
      });
      if (!page.data?.length) {
        if (startingAfter)
          throw new Error(
            `Experiment '${experimentId}' pagination ended before all runs were loaded`,
          );
        throw new Error(
          `Experiment '${experimentId}' has no runs to load responses from.`,
        );
      }
      for (const run of page.data) {
        if (
          !(run.createdAt instanceof Date) ||
          !Number.isFinite(run.createdAt.getTime()) ||
          !run.runId
        )
          throw new Error(
            `Experiment '${experimentId}' run has no valid created timestamp or run ID; pass runId explicitly.`,
          );
        if (!latest || run.createdAt > latest.createdAt)
          latest = { runId: run.runId, createdAt: run.createdAt };
      }
      if (!page.hasMore) break;
      const cursor = page.data.at(-1)?.runId;
      if (!cursor || cursors.has(cursor))
        throw new Error(
          `Experiment '${experimentId}' pagination repeated or omitted its cursor`,
        );
      cursors.add(cursor);
      startingAfter = cursor;
    }
    resolved = latest?.runId;
    if (!resolved)
      throw new Error(
        `Could not determine the latest run for experiment '${experimentId}'.`,
      );
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Export timeout must be positive and finite");
  const signal = AbortSignal.timeout(timeoutMs);
  let text: string;
  if (options.orqClient) {
    const stream = await beforeDeadline(
      client.experiments.exportRun(
        { experimentId, runId: resolved, format: "jsonl" },
        { timeoutMs },
      ),
      signal,
    );
    text = await boundedExportText(stream, signal);
  } else {
    // The API returns x-ndjson, which the installed SDK's export matcher rejects.
    const base = (
      options.baseUrl ??
      configuredOrqHost() ??
      orqServerUrl()
    ).replace(/\/+$/, "");
    const url = `${base}/v3/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(resolved)}/export?format=jsonl`;
    const response = await beforeDeadline(
      (options.fetchFn ?? fetch)(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/x-ndjson",
        },
        signal,
        redirect: "error",
      }),
      signal,
    );
    if (!response.ok)
      throw new Error(
        `Could not export run '${resolved}' for experiment '${experimentId}': HTTP ${response.status}`,
      );
    if (!response.body)
      throw new Error(`Experiment run '${resolved}' returned no export body`);
    text = await boundedExportText(response.body, signal);
  }
  return rowsFromExperimentExport(text, experimentId, resolved).map(
    experimentRowToDataPoint,
  );
}
