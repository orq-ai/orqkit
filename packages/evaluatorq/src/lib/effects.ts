import { Effect, pipe } from "effect";

import { ProgressService } from "./progress.js";
import type { TracingContext } from "./tracing/context.js";
import {
  setEvaluationAttributes,
  setJobNameAttribute,
  withEvaluationSpan,
  withJobSpan,
} from "./tracing/spans.js";
import type {
  DataPoint,
  DataPointResult,
  Job,
  JobResult,
  Scorer,
} from "./types.js";

export function processDataPointEffect(
  dataPromise: Promise<DataPoint>,
  rowIndex: number,
  jobs: Job[],
  evaluators: { name: string; scorer: Scorer }[],
  parallelism: number,
  tracingContext?: TracingContext,
): Effect.Effect<DataPointResult[], Error, ProgressService> {
  return pipe(
    Effect.tryPromise({
      try: () => dataPromise,
      catch: (error) => error as Error,
    }),
    Effect.flatMap((dataPoint) =>
      Effect.gen(function* (_) {
        const progress = yield* _(ProgressService);

        // Update progress for this data point
        yield* _(
          progress.updateProgress({
            currentDataPoint: rowIndex + 1,
            phase: "processing",
          }),
        );

        // Process jobs
        const jobResults = yield* _(
          Effect.forEach(
            jobs,
            (job) =>
              processJobEffect(
                job,
                dataPoint,
                rowIndex,
                evaluators,
                tracingContext,
              ),
            { concurrency: parallelism },
          ),
        );

        return [
          {
            dataPoint,
            jobResults,
          },
        ];
      }),
    ),
    Effect.catchAll((error) =>
      Effect.succeed([
        {
          dataPoint: { inputs: {} }, // Placeholder since we couldn't get the actual data
          error,
        },
      ]),
    ),
  );
}

export function processJobEffect(
  job: Job,
  dataPoint: DataPoint,
  rowIndex: number,
  evaluators: { name: string; scorer: Scorer }[],
  tracingContext?: TracingContext,
): Effect.Effect<JobResult, Error, ProgressService> {
  return Effect.gen(function* (_) {
    const progress = yield* _(ProgressService);

    // Execute job with tracing
    const jobResult = yield* _(
      Effect.tryPromise({
        try: async () => {
          // Wrap the entire job + evaluators in a job span
          // This ensures evaluator spans are children of the job span
          return await withJobSpan(
            {
              runId: tracingContext?.runId || "",
              rowIndex,
              parentContext: tracingContext?.parentContext,
            },
            async (jobSpan) => {
              // Update progress with placeholder
              await Effect.runPromise(
                progress.updateProgress({
                  currentJob: "job",
                  phase: "processing",
                }),
              );

              // Execute the job
              const result = await job(dataPoint, rowIndex);

              // Set job name on span after execution
              setJobNameAttribute(jobSpan, result.name);

              // Update progress with actual job name
              await Effect.runPromise(
                progress.updateProgress({
                  currentJob: result.name,
                }),
              );

              // Process evaluators within the job span context
              if (evaluators.length > 0) {
                await Effect.runPromise(
                  progress.updateProgress({ phase: "evaluating" }),
                );

                const evaluatorScores = await Promise.all(
                  evaluators.map(async (evaluator) => {
                    // Update current evaluator
                    await Effect.runPromise(
                      progress.updateProgress({
                        currentEvaluator: evaluator.name,
                      }),
                    );

                    try {
                      // Wrap evaluator in evaluation span (child of job span)
                      const score = await withEvaluationSpan(
                        {
                          runId: tracingContext?.runId || "",
                          evaluatorName: evaluator.name,
                        },
                        async (evalSpan) => {
                          const evalResult = await evaluator.scorer({
                            data: dataPoint,
                            output: result.output,
                          });

                          // Set evaluation attributes on span
                          setEvaluationAttributes(
                            evalSpan,
                            evalResult.value,
                            evalResult.explanation,
                            evalResult.pass,
                          );

                          return evalResult;
                        },
                      );

                      return {
                        evaluatorName: evaluator.name,
                        score,
                      };
                    } catch (error) {
                      return {
                        evaluatorName: evaluator.name,
                        score: { value: "" as string },
                        error: error as Error,
                      };
                    }
                  }),
                );

                return {
                  jobName: result.name,
                  output: result.output,
                  evaluatorScores,
                };
              }

              return {
                jobName: result.name,
                output: result.output,
                evaluatorScores: [],
              };
            },
          );
        },
        catch: (error) => error as Error,
      }),
    );

    return jobResult;
  }).pipe(
    Effect.catchAll((error) => {
      // Check if the error has a jobName property (set by our job helper)
      const errorWithJobName = error as Error & { jobName?: string };
      const jobName = errorWithJobName.jobName || "Unknown";
      return Effect.succeed({
        jobName,
        output: null,
        error,
      });
    }),
  );
}
