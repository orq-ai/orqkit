import { Effect } from "effect";
import { z } from "zod/v4";

import { DEFAULT_ORQ_BASE_URL } from "./common/env-config.js";
import { scrubKnownSecrets } from "./common/redact.js";
import { withRetry } from "./common/retry.js";
import type { FetchLike } from "./common/trace-input.js";
import { AgentResponse } from "./contracts.js";
import { configuredOrqHost } from "./orq-host.js";
import type { DataPoint, EvaluatorqResult, Output } from "./types.js";

export interface SerializedEvaluatorScore {
  evaluatorName: string;
  score: {
    value:
      | number
      | boolean
      | string
      | { type: string; value: Record<string, unknown> }
      | null;
    explanation?: string;
    pass?: boolean;
  };
  error?: string;
}
export interface SerializedJobResult {
  jobName: string;
  output: Output;
  error?: string;
  evaluatorScores?: SerializedEvaluatorScore[];
}
export interface SerializedDataPointResult {
  dataPoint: DataPoint;
  error?: string;
  jobResults?: SerializedJobResult[];
}
export interface SendResultsPayload {
  _name: string;
  _description?: string;
  _createdAt: string;
  _endedAt: string;
  _evaluationDuration: number;
  datasetId?: string;
  path?: string;
  results: SerializedDataPointResult[];
}
const OrqResponseSchema = z.object({
  sheet_id: z.string(),
  manifest_id: z.string(),
  experiment_name: z.string(),
  rows_created: z.number().int(),
  workspace_key: z.string().nullable().optional(),
  experiment_url: z.string().nullable().optional(),
});
export type OrqResponse = z.infer<typeof OrqResponseSchema>;
export const UPLOAD_TIMEOUT_MS = 120_000;
export class SendResultsError extends Error {
  override name = "SendResultsError";
}
interface PostResult {
  response: Response;
  text: string;
}
class RateLimitResponse extends Error {
  readonly status = 429;
  constructor(readonly result: PostResult) {
    super("Orq result upload rate limited");
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isEvaluationResultCell = (
  value: unknown,
): value is { type: string; value: Record<string, unknown> } =>
  isRecord(value) && typeof value.type === "string" && isRecord(value.value);
const serializeScoreValue = (value: unknown): unknown =>
  isRecord(value) && !isEvaluationResultCell(value)
    ? JSON.stringify(value)
    : value;
const serializeOutput = (output: Output): Output =>
  output instanceof AgentResponse ||
  (isRecord(output) && output.object === "response")
    ? output
    : isRecord(output)
      ? JSON.stringify(output)
      : output;
export function serializeResultsPayload(
  options: Pick<
    SendResultsOptions,
    | "evaluationName"
    | "evaluationDescription"
    | "datasetId"
    | "results"
    | "startTime"
    | "endTime"
    | "path"
  >,
): SendResultsPayload {
  const results = options.results.map(
    (result): SerializedDataPointResult => ({
      dataPoint: result.dataPoint,
      ...(result.error ? { error: String(result.error) } : {}),
      ...(result.jobResults
        ? {
            jobResults: result.jobResults.map(
              (job): SerializedJobResult => ({
                jobName: job.jobName,
                output: serializeOutput(job.output ?? null),
                error: job.error ? String(job.error) : "",
                ...(job.evaluatorScores
                  ? {
                      evaluatorScores: job.evaluatorScores.map(
                        (evaluation): SerializedEvaluatorScore => ({
                          evaluatorName: evaluation.evaluatorName,
                          score: {
                            value: serializeScoreValue(
                              evaluation.score.value,
                            ) as SerializedEvaluatorScore["score"]["value"],
                            explanation: evaluation.score.explanation ?? "",
                            ...(evaluation.score.pass == null
                              ? {}
                              : { pass: evaluation.score.pass }),
                          },
                          error: evaluation.error
                            ? String(evaluation.error)
                            : "",
                        }),
                      ),
                    }
                  : {}),
              }),
            ),
          }
        : {}),
    }),
  );
  return {
    _name: options.evaluationName,
    ...(options.evaluationDescription != null
      ? { _description: options.evaluationDescription }
      : {}),
    _createdAt: options.startTime.toISOString(),
    _endedAt: options.endTime.toISOString(),
    _evaluationDuration: Math.trunc(
      options.endTime.getTime() - options.startTime.getTime(),
    ),
    ...(options.datasetId ? { datasetId: options.datasetId } : {}),
    ...(options.path ? { path: options.path } : {}),
    results,
  };
}
export interface SendResultsOptions {
  apiKey: string;
  evaluationName: string;
  evaluationDescription?: string;
  datasetId?: string;
  results: EvaluatorqResult;
  startTime: Date;
  endTime: Date;
  path?: string;
  baseUrl?: string;
  raiseOnError?: boolean;
  signal?: AbortSignal;
  fetch?: FetchLike;
}
async function postResults(
  url: string,
  options: SendResultsOptions,
  body: string,
): Promise<PostResult | null> {
  try {
    return await withRetry(
      async () => {
        const controller = new AbortController();
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          controller.abort();
        }, UPLOAD_TIMEOUT_MS);
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal;
        try {
          const response = await (options.fetch ?? globalThis.fetch)(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.apiKey}`,
            },
            body,
            signal,
          });
          const result = { response, text: await response.text() };
          if (response.status === 429) throw new RateLimitResponse(result);
          return result;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (expired) return null;
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      { maxAttempts: 3, label: "Orq results upload", signal: options.signal },
    );
  } catch (error) {
    if (error instanceof RateLimitResponse) return error.result;
    throw error;
  }
}
export async function sendResultsToOrq(
  options: SendResultsOptions,
): Promise<OrqResponse | null> {
  try {
    options.signal?.throwIfAborted();
    const payload = serializeResultsPayload(options),
      baseUrl = (
        options.baseUrl ??
        configuredOrqHost() ??
        DEFAULT_ORQ_BASE_URL
      ).replace(/\/+$/, "");
    const posted = await postResults(
      `${baseUrl}/v2/spreadsheets/evaluations/receive`,
      options,
      JSON.stringify(payload),
    );
    if (posted === null)
      throw new SendResultsError(
        `Orq results upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s. The server may still finish and create the run: check the experiment before uploading again.`,
      );
    if (!posted.response.ok)
      throw new SendResultsError(
        `Could not send results to Orq platform (${posted.response.status} ${posted.response.statusText})${posted.text ? `: ${scrubKnownSecrets(posted.text)}` : ""}`,
      );
    const result = OrqResponseSchema.parse(JSON.parse(posted.text));
    if (result.rows_created < options.results.length)
      console.warn(
        `Orq registered ${result.rows_created}/${options.results.length} uploaded result rows; the local results are retained.`,
      );
    console.error(
      `\n✅ Results sent to Orq: ${result.experiment_name} (${result.rows_created} rows created)`,
    );
    if (result.experiment_url)
      console.error(`   📊 View your evaluation at: ${result.experiment_url}`);
    return result;
  } catch (error) {
    if (options.signal?.aborted || (error as Error)?.name === "AbortError")
      throw error;
    if (options.raiseOnError) throw error;
    console.warn(
      `Warning: ${error instanceof Error ? scrubKnownSecrets(error.message) : "Could not send results to Orq platform"}`,
    );
    return null;
  }
}
export const sendResultsToOrqEffect = (
  apiKey: string,
  evaluationName: string,
  evaluationDescription: string | undefined,
  datasetId: string | undefined,
  results: EvaluatorqResult,
  startTime: Date,
  endTime: Date,
  path: string | undefined,
  onResultsUploaded?: (experimentUrl: string) => void,
): Effect.Effect<void, never, never> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await sendResultsToOrq({
        apiKey,
        signal,
        evaluationName,
        evaluationDescription,
        datasetId,
        results,
        startTime,
        endTime,
        path,
      });
      if (response?.experiment_url)
        onResultsUploaded?.(response.experiment_url);
    },
    catch: (error) => {
      console.warn(
        `Warning: Could not record the Orq upload result: ${error instanceof Error ? scrubKnownSecrets(error.message) : "unknown error"}`,
      );
    },
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
