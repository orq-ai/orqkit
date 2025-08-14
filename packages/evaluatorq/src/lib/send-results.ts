import { Effect } from "effect";

import type { DataPoint, EvaluatorqResult, Output } from "./types.js";

// Same structure as EvaluatorqResult but with Error objects converted to strings for JSON serialization
export interface SerializedEvaluatorScore {
  evaluatorName: string;
  score: number | boolean | string;
  error?: string; // Error serialized to string
}

export interface SerializedJobResult {
  jobName: string;
  output: Output;
  error?: string; // Error serialized to string
  evaluatorScores?: SerializedEvaluatorScore[];
}

export interface SerializedDataPointResult {
  dataPoint: DataPoint;
  error?: string; // Error serialized to string
  jobResults?: SerializedJobResult[];
}

// The payload format expected by the Orq API
export interface SendResultsPayload {
  _name: string;
  _description?: string;
  _createdAt: string;
  _endedAt: string;
  _evaluationDuration: number;
  datasetId?: string;
  results: SerializedDataPointResult[];
}

interface OrqResponse {
  sheet_id: string;
  manifest_id: string;
  experiment_name: string;
  rows_created: number;
  workspace_key?: string;
  experiment_url?: string;
}

export const sendResultsToOrqEffect = (
  apiKey: string,
  evaluationName: string,
  evaluationDescription: string | undefined,
  datasetId: string | undefined,
  results: EvaluatorqResult,
  startTime: Date,
  endTime: Date,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* (_) {
    // Convert Error objects to strings for JSON serialization
    const serializedResults: SerializedDataPointResult[] = results.map(
      (result) => ({
        dataPoint: result.dataPoint,
        error: result.error ? String(result.error) : undefined,
        jobResults: result.jobResults?.map(
          (jobResult): SerializedJobResult => ({
            jobName: jobResult.jobName,
            output: jobResult.output,
            error: jobResult.error ? String(jobResult.error) : undefined,
            evaluatorScores: jobResult.evaluatorScores?.map(
              (score): SerializedEvaluatorScore => ({
                evaluatorName: score.evaluatorName,
                score: score.score,
                error: score.error ? String(score.error) : undefined,
              }),
            ),
          }),
        ),
      }),
    );

    const payload: SendResultsPayload = {
      _name: evaluationName,
      _description: evaluationDescription,
      _createdAt: startTime.toISOString(),
      _endedAt: endTime.toISOString(),
      _evaluationDuration: endTime.getTime() - startTime.getTime(),
      ...(datasetId && { datasetId }),
      results: serializedResults,
    };

    // Use tryPromise but catch and log errors instead of propagating them
    yield* _(
      Effect.tryPromise({
        try: async () => {
          const baseUrl = process.env.ORQ_BASE_URL || "https://api.orq.ai";

          const response = await fetch(
            `${baseUrl}/v2/spreadsheets/evaluations/receive`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(payload),
            },
          );

          if (!response.ok) {
            const errorText = await response
              .text()
              .catch(() => "Unknown error");

            // Log warning instead of throwing
            console.warn(
              `\n⚠️  Warning: Could not send results to Orq platform (${response.status} ${response.statusText})`,
            );

            // Only show detailed error in verbose mode or specific error cases
            if (process.env.ORQ_DEBUG === "true" || response.status >= 500) {
              console.warn(`   Details: ${errorText}`);
            }

            return; // Return early but don't throw
          }

          const result = (await response.json()) as OrqResponse;
          console.log(
            `\n✅ Results sent to Orq: ${result.experiment_name} (${result.rows_created} rows created)`,
          );

          // Display the experiment URL if available
          if (result.experiment_url) {
            console.log(
              `   📊 View your evaluation at: ${result.experiment_url}`,
            );
          }
        },
        catch: (error) => {
          // Log warning for network or other errors
          console.warn(`\n⚠️  Warning: Could not send results to Orq platform`);

          if (process.env.ORQ_DEBUG === "true") {
            console.warn(
              `   Details: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          // Return undefined to indicate handled error
          return undefined;
        },
      }),
      // Catch any Effect errors and convert to success
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
  });
