import { Effect, pipe } from "effect";

import {
  checkRunActive,
  notifyDatapointComplete,
  trackRunWork,
} from "./common/run-lifecycle.js";
import { recordSpanPayload } from "./common/tracing.js";
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
  Evaluator,
  EvaluatorParams,
  Job,
  JobResult,
} from "./types.js";

export function processDataPointEffect(
  dataPromise: Promise<DataPoint>,
  rowIndex: number,
  jobs: Job[],
  evaluators: Evaluator[],
  parallelism: number,
  tracingContext?: TracingContext,
  onDatapointComplete?: EvaluatorParams["onDatapointComplete"],
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
    Effect.tap((results) =>
      Effect.tryPromise({
        try: () => notifyDatapointComplete(onDatapointComplete, results),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
    ),
  );
}

export function processJobEffect(
  job: Job,
  dataPoint: DataPoint,
  rowIndex: number,
  evaluators: Evaluator[],
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
          return await trackRunWork(() =>
            withJobSpan(
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
                checkRunActive();
                const result = await job(dataPoint, rowIndex);
                checkRunActive();

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
                            evaluatorType:
                              evaluator.evaluatorType ?? "python_eval",
                          },
                          async (evalSpan) => {
                            const params = {
                              data: dataPoint,
                              output: result.output,
                              row: rowIndex,
                            };
                            recordSpanPayload(evalSpan, {
                              key: "orq.evaluation.input",
                              payload: params,
                            });
                            checkRunActive();
                            const evalResult = await evaluator.scorer(params);

                            // Set evaluation attributes on span
                            setEvaluationAttributes(
                              evalSpan,
                              evalResult.value,
                              evalResult.explanation,
                              evalResult.pass ?? undefined,
                              {
                                evaluatorName: evaluator.name,
                                evaluatorType:
                                  evaluator.evaluatorType ?? "python_eval",
                                rawOutput: evalResult.rawOutput,
                              },
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
                    ...(result.error && { error: new Error(result.error) }),
                    evaluatorScores,
                  };
                }

                return {
                  jobName: result.name,
                  output: result.output,
                  ...(result.error && { error: new Error(result.error) }),
                  evaluatorScores: [],
                };
              },
            ),
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
