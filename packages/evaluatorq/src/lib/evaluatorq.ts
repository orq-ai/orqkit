import { Cause, Effect, Exit, pipe } from "effect";

import type { Orq } from "@orq-ai/node";

import {
  fetchDatasetAsDataPoints,
  fetchDatasetBatches,
  setupOrqClient,
} from "./common/fetch-data.js";
import { checkLlmParallelism } from "./common/llm-limit.js";
import { resolveDatapointParallelism } from "./common/parallelism.js";
import {
  checkRunActive,
  notifyDatapointComplete,
  trackRunWork,
  withRunLifecycle,
} from "./common/run-lifecycle.js";
import {
  resolveEvaluationData,
  resolveEvaluationMode,
} from "./common/runner-input.js";
import { processDataPointEffect } from "./effects.js";
import {
  ProgressService,
  ProgressServiceLive,
  withProgress,
} from "./progress.js";
import { sendResultsToOrqEffect } from "./send-results.js";
import { displayResultsTableEffect } from "./table-display.js";
import {
  captureParentContext,
  flushTracing,
  generateRunId,
  initTracingIfNeeded,
  shutdownTracing,
  type TracingContext,
} from "./tracing/index.js";
import {
  setEvaluationAttributes,
  setJobNameAttribute,
  withEvaluationSpan,
  withJobSpan,
} from "./tracing/spans.js";
import type {
  DataPoint,
  EvaluatorParams,
  EvaluatorqResult,
  Job,
} from "./types.js";

/**
 * Check if any evaluator returned pass: false
 */
function checkPassFailures(results: EvaluatorqResult): boolean {
  for (const dataPointResult of results) {
    for (const jobResult of dataPointResult.jobResults || []) {
      for (const evaluatorScore of jobResult.evaluatorScores || []) {
        if (evaluatorScore.score.pass === false) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * @param _name - The name of the evaluation run.
 * @param params - The parameters for the evaluation run.
 * @returns The results of the evaluation run.
 */
async function runEvaluationPromise<T>(
  program: Effect.Effect<T, Error, never>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const exit = await Effect.runPromiseExit(program, options);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
export class StreamingEvaluationError extends AggregateError {
  override readonly name = "StreamingEvaluationError";
  constructor(errors: unknown[]) {
    super(
      errors,
      `Streaming evaluation failed with ${errors.length} errors: ${errors.map((error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))).join("; ")}`,
    );
  }
}
type NormalizedEvaluatorParams = EvaluatorParams & { parallelism: number };
function normalizeEvaluatorParams(
  params: EvaluatorParams,
): NormalizedEvaluatorParams {
  const parallelism = resolveDatapointParallelism(
    params.datapointParallelism,
    params.parallelism,
    { caller: "evaluatorq" },
  );
  if (!Number.isInteger(parallelism) || parallelism < 1)
    throw new RangeError("datapointParallelism must be a positive integer");
  checkLlmParallelism(params.llmParallelism ?? undefined);
  return { ...params, parallelism };
}
export async function evaluatorq(
  name: string,
  params: EvaluatorParams,
): Promise<EvaluatorqResult> {
  const normalized = normalizeEvaluatorParams(params);
  return withRunLifecycle(normalized.llmParallelism ?? undefined, () =>
    evaluatorqCore(name, normalized),
  );
}
async function evaluatorqCore(
  _name: string,
  params: NormalizedEvaluatorParams,
): Promise<EvaluatorqResult> {
  const {
    evaluators = [],
    parallelism = 1,
    print = true,
    description,
    path,
    sendResults = true,
    manageTracing = true,
    exitOnFailure = true,
  } = params;

  const { jobs, inference } = resolveEvaluationMode(
    params.data,
    params.jobs,
    params.inference,
  );
  const data = await resolveEvaluationData(params.data, {
    apiKey: process.env.ORQ_API_KEY,
    baseUrl: process.env.ORQ_BASE_URL,
  });

  // Initialize tracing if OTEL is configured
  const tracingEnabled = await initTracingIfNeeded();
  const parentContext = tracingEnabled
    ? await captureParentContext()
    : undefined;
  const tracingContext: TracingContext | undefined = tracingEnabled
    ? {
        runId: generateRunId(),
        runName: _name,
        enabled: true,
        parentContext,
      }
    : undefined;

  let orqClient: Orq | undefined;
  const orqApiKey = process.env.ORQ_API_KEY;

  // Only dataset fetching needs the SDK, uploads go over plain fetch.
  if (orqApiKey && "datasetId" in data) {
    orqClient = await setupOrqClient(orqApiKey);
  }

  const startTime = new Date();

  let datasetId: string | undefined;

  // Handle datasetId case - use streaming fetch
  if ("datasetId" in data) {
    if (!orqApiKey || !orqClient) {
      throw new Error(
        "ORQ_API_KEY environment variable must be set to fetch datapoints from Orq platform.",
      );
    }

    datasetId = data.datasetId;
    const datasetIdValue = datasetId; // Capture for use in callbacks
    const includeMessages = (data.includeMessages ?? false) || !inference;

    // Shared progress state that can be updated from within Effect.promise
    const progressRef = {
      totalDataPoints: 0,
      processedDataPoints: 0,
      phase: "fetching" as "fetching" | "processing",
      done: false,
    };

    // Stream fetch and process batches concurrently
    let progressInterval: ReturnType<typeof setInterval> | undefined;
    const streamingProgram = pipe(
      Effect.gen(function* (_) {
        const progress = yield* _(ProgressService);

        // Initialize progress with fetching phase
        yield* _(
          progress.updateProgress({
            totalDataPoints: 0,
            currentDataPoint: 0,
            phase: "fetching",
          }),
        );

        // Start a polling loop to update progress from progressRef
        progressInterval = setInterval(() => {
          Effect.runPromise(
            progress.updateProgress({
              totalDataPoints: progressRef.totalDataPoints,
              currentDataPoint: progressRef.processedDataPoints,
              phase: progressRef.phase,
            }),
          );
        }, 100);

        // Fetch and process batches with streaming
        let allResults: EvaluatorqResult = [];
        let fetchError: Error | null = null;

        try {
          allResults = yield* _(
            Effect.promise(async () => {
              const results: EvaluatorqResult = [];
              const processingPromises: Promise<EvaluatorqResult>[] = [];
              let datapointIndex = 0;
              let activeCount = 0;

              // Simple semaphore for parallelism control
              const waitForSlot = async () => {
                while (activeCount >= parallelism) {
                  checkRunActive();
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
                checkRunActive();
                activeCount++;
              };

              for await (const batch of fetchDatasetBatches(
                orqClient,
                datasetIdValue,
                { includeMessages },
              )) {
                // Update total as we fetch
                progressRef.totalDataPoints += batch.datapoints.length;
                progressRef.phase = "processing";

                // Start processing this batch immediately
                for (const datapoint of batch.datapoints) {
                  const currentIndex = datapointIndex++;

                  // Wait for available slot
                  await waitForSlot();

                  const promise = trackRunWork(async () => {
                    try {
                      // Process datapoint directly without Effect to avoid progress conflicts
                      const jobResults = await Promise.all(
                        jobs.map(async (job) => {
                          try {
                            // Wrap the job + evaluators in a job span for tracing
                            return await withJobSpan(
                              {
                                runId: tracingContext?.runId || "",
                                rowIndex: currentIndex,
                                parentContext: tracingContext?.parentContext,
                              },
                              async (jobSpan) => {
                                checkRunActive();
                                const result = await job(
                                  datapoint,
                                  currentIndex,
                                );
                                checkRunActive();
                                setJobNameAttribute(jobSpan, result.name);

                                // Run evaluators for this job
                                const evaluatorScores = await Promise.all(
                                  evaluators.map(async (evaluator) => {
                                    try {
                                      checkRunActive();
                                      // Wrap evaluator in evaluation span (child of job span)
                                      const score = await withEvaluationSpan(
                                        {
                                          runId: tracingContext?.runId || "",
                                          evaluatorName: evaluator.name,
                                        },
                                        async (evalSpan) => {
                                          const evalResult =
                                            await (async () => {
                                              checkRunActive();
                                              return evaluator.scorer({
                                                data: datapoint,
                                                output: result.output,
                                                row: currentIndex,
                                              });
                                            })();

                                          setEvaluationAttributes(
                                            evalSpan,
                                            evalResult.value,
                                            evalResult.explanation,
                                            evalResult.pass ?? undefined,
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
                                  ...(result.error && {
                                    error: new Error(result.error),
                                  }),
                                  evaluatorScores,
                                };
                              },
                            );
                          } catch (error) {
                            const err = error as Error & { jobName?: string };
                            return {
                              jobName: err.jobName || "Unknown",
                              output: null,
                              error: error as Error,
                            };
                          }
                        }),
                      );
                      const completed = [
                        { dataPoint: datapoint, jobResults },
                      ] as EvaluatorqResult;
                      await notifyDatapointComplete(
                        params.onDatapointComplete,
                        completed,
                      );
                      progressRef.processedDataPoints++;
                      return completed;
                    } finally {
                      activeCount--;
                    }
                  });
                  processingPromises.push(promise);
                }
              }

              // Wait for all processing to complete
              const settled = await Promise.allSettled(processingPromises),
                errors: unknown[] = [];
              for (const outcome of settled) {
                if (outcome.status === "fulfilled")
                  results.push(...outcome.value);
                else errors.push(outcome.reason);
              }
              if (errors.length === 1) throw errors[0];
              if (errors.length) throw new StreamingEvaluationError(errors);
              return results;
            }),
          );
        } catch (error) {
          fetchError = error as Error;
        }

        if (fetchError) {
          throw fetchError;
        }

        // Final progress update with correct counts
        yield* _(
          progress.updateProgress({
            totalDataPoints: progressRef.totalDataPoints,
            currentDataPoint: progressRef.processedDataPoints,
            phase: "processing",
          }),
        );

        return allResults;
      }),
      // Conditionally add table display
      print
        ? Effect.tap((results) => displayResultsTableEffect(results, _name))
        : Effect.tap(() => Effect.void),
      // Send results to Orq when API key is available
      orqApiKey && sendResults
        ? Effect.tap((results) =>
            sendResultsToOrqEffect(
              orqApiKey,
              _name,
              description,
              datasetId,
              results,
              startTime,
              new Date(),
              path,
              params.onResultsUploaded,
            ),
          )
        : Effect.tap(() => Effect.void),
      // Provide the progress service
      Effect.provide(ProgressServiceLive),
      // Wrap with progress tracking
      (effect) => withProgress(effect, print),
      Effect.ensuring(
        Effect.sync(() => {
          if (progressInterval !== undefined) clearInterval(progressInterval);
        }),
      ),
    );

    // Execute the streaming program
    const streamingResults = await runEvaluationPromise(streamingProgram);

    // Shutdown tracing gracefully for streaming case
    if (tracingEnabled && manageTracing) {
      await flushTracing();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await shutdownTracing();
    }

    // Check for pass failures
    const hasStreamingFailures = checkPassFailures(streamingResults);
    if (hasStreamingFailures && exitOnFailure) {
      process.exit(1);
    }

    return streamingResults;
  }

  // Non-streaming case: process all data at once
  const dataPromises = data;

  // Execute evaluation with optional tracing
  const executeEvaluation = async (): Promise<EvaluatorqResult> => {
    // Create Effect for processing all data points
    const program = pipe(
      Effect.gen(function* (_) {
        const progress = yield* _(ProgressService);

        // Initialize progress
        yield* _(
          progress.updateProgress({
            totalDataPoints: dataPromises.length,
            currentDataPoint: 0,
            phase: "initializing",
          }),
        );

        // Process data points
        const results = yield* _(
          Effect.forEach(
            dataPromises.map((dataPromise, index) => ({ dataPromise, index })),
            ({ dataPromise, index }) =>
              processDataPointEffect(
                dataPromise instanceof Promise
                  ? dataPromise
                  : Promise.resolve(dataPromise),
                index,
                jobs,
                evaluators,
                parallelism,
                tracingContext,
                params.onDatapointComplete,
              ),
            { concurrency: parallelism },
          ),
        );

        return results.flat();
      }),
      // Conditionally add table display
      print
        ? Effect.tap((results) => displayResultsTableEffect(results, _name))
        : Effect.tap(() => Effect.void),
      // Send results to Orq when API key is available
      orqApiKey && sendResults
        ? Effect.tap((results) =>
            sendResultsToOrqEffect(
              orqApiKey,
              _name,
              description,
              datasetId,
              results,
              startTime,
              new Date(),
              path,
              params.onResultsUploaded,
            ),
          )
        : Effect.tap(() => Effect.void),
      // Provide the progress service
      Effect.provide(ProgressServiceLive),
      // Wrap with progress tracking
      (effect) => withProgress(effect, print),
    );

    // Run the Effect and convert back to Promise
    return runEvaluationPromise(program);
  };

  // Execute evaluation - each job span is independent (no parent evaluation_run span)
  const results = await executeEvaluation();

  // Shutdown tracing gracefully - flush and shutdown before checking failures
  if (tracingEnabled && manageTracing) {
    // Force flush all pending spans
    await flushTracing();
    // Give additional time for network operations
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await shutdownTracing();
  }

  // Check for pass failures and exit if any
  const hasFailures = checkPassFailures(results);
  if (hasFailures && exitOnFailure) {
    process.exit(1);
  }

  return results;
}

// Create an Effect that runs evaluation and optionally displays results
const evaluatorqCoreEffect = (
  _name: string,
  params: NormalizedEvaluatorParams,
): Effect.Effect<EvaluatorqResult, Error, never> => {
  return pipe(
    Effect.tryPromise({
      try: async () => {
        const mode = resolveEvaluationMode(
          params.data,
          params.jobs,
          params.inference,
        );
        const data = await resolveEvaluationData(params.data, {
          apiKey: process.env.ORQ_API_KEY,
          baseUrl: process.env.ORQ_BASE_URL,
        });
        return { ...mode, data };
      },
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    }),
    Effect.flatMap(({ data, jobs, inference }) => {
      const {
        evaluators = [],
        parallelism = 1,
        print = true,
        description,
        path,
        sendResults = true,
      } = params;

      const startTime = new Date();

      // Handle datasetId case
      if ("datasetId" in data) {
        return Effect.gen(function* (_) {
          const apiKey = process.env.ORQ_API_KEY;
          if (!apiKey) {
            return yield* _(
              Effect.fail(
                new Error(
                  "ORQ_API_KEY environment variable must be set to fetch datasets from Orq platform.",
                ),
              ),
            );
          }

          const orqClient = yield* _(
            Effect.tryPromise({
              try: () => setupOrqClient(apiKey),
              catch: (error) =>
                new Error(
                  `Failed to setup Orq client: ${error instanceof Error ? error.message : String(error)}`,
                ),
            }),
          );

          if (!orqClient) {
            return yield* _(
              Effect.fail(new Error("Failed to setup Orq client")),
            );
          }

          const dataPromises = yield* _(
            Effect.tryPromise({
              try: () =>
                fetchDatasetAsDataPoints(orqClient, data.datasetId, {
                  includeMessages:
                    (data.includeMessages ?? false) || !inference,
                }),
              catch: (error) =>
                error instanceof Error
                  ? error
                  : new Error(`Failed to fetch dataset: ${String(error)}`),
            }),
          );

          return yield* _(
            runEvaluationEffect(
              dataPromises,
              evaluators,
              jobs,
              parallelism,
              print,
              description,
              _name,
              data.datasetId,
              apiKey,
              startTime,
              path,
              sendResults,
              params.onResultsUploaded,
              params.onDatapointComplete,
            ),
          );
        });
      }

      const dataPromises = data;
      return runEvaluationEffect(
        dataPromises,
        evaluators,
        jobs,
        parallelism,
        print,
        description,
        _name,
        undefined,
        undefined,
        startTime,
        path,
        sendResults,
        params.onResultsUploaded,
        params.onDatapointComplete,
      );
    }),
  );
};

export const evaluatorqEffect = (
  name: string,
  params: EvaluatorParams,
): Effect.Effect<EvaluatorqResult, Error, never> =>
  Effect.suspend(() => {
    let running: Promise<EvaluatorqResult> | undefined;
    return Effect.tryPromise({
      try: (signal) => {
        const normalized = normalizeEvaluatorParams(params);
        running = withRunLifecycle(
          normalized.llmParallelism ?? undefined,
          () =>
            runEvaluationPromise(evaluatorqCoreEffect(name, normalized), {
              signal,
            }),
          signal,
        );
        return running;
      },
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await running?.then(
            () => undefined,
            () => undefined,
          );
        }),
      ),
    );
  });

// Extract common evaluation logic
const runEvaluationEffect = (
  dataPromises: (Promise<DataPoint> | DataPoint)[],
  evaluators: EvaluatorParams["evaluators"] = [],
  jobs: Job[],
  parallelism: number,
  print: boolean,
  description: string | undefined,
  evaluationName: string,
  datasetId: string | undefined,
  apiKey: string | undefined,
  startTime: Date,
  path: string | undefined,
  sendResults: boolean,
  onResultsUploaded?: (experimentUrl: string) => void,
  onDatapointComplete?: EvaluatorParams["onDatapointComplete"],
): Effect.Effect<EvaluatorqResult, Error, never> => {
  // Use API key from parameter or environment
  const orqApiKey = apiKey || process.env.ORQ_API_KEY;

  return pipe(
    Effect.gen(function* (_) {
      const progress = yield* _(ProgressService);

      // Initialize progress
      yield* _(
        progress.updateProgress({
          totalDataPoints: dataPromises.length,
          currentDataPoint: 0,
          phase: "initializing",
        }),
      );

      // Process data points (no tracing in Effect variant for now)
      const results = yield* _(
        Effect.forEach(
          dataPromises.map((dataPromise, index) => ({ dataPromise, index })),
          ({ dataPromise, index }) =>
            processDataPointEffect(
              dataPromise instanceof Promise
                ? dataPromise
                : Promise.resolve(dataPromise),
              index,
              jobs,
              evaluators,
              parallelism,
              undefined,
              onDatapointComplete,
            ),
          { concurrency: parallelism },
        ),
      );

      return results.flat();
    }),
    // Conditionally add table display
    print
      ? Effect.tap((results) =>
          displayResultsTableEffect(results, evaluationName),
        )
      : Effect.tap(() => Effect.void),
    // Send results to Orq when API key is available
    orqApiKey && sendResults
      ? Effect.tap((results) =>
          sendResultsToOrqEffect(
            orqApiKey,
            evaluationName,
            description,
            datasetId,
            results,
            startTime,
            new Date(),
            path,
            onResultsUploaded,
          ),
        )
      : Effect.tap(() => Effect.void),
    // Provide the progress service
    Effect.provide(ProgressServiceLive),
    // Wrap with progress tracking
    (effect) => withProgress(effect, print),
  );
};

// Composable evaluatorq with display
export const evaluatorqWithTableEffect = (
  name: string,
  params: EvaluatorParams,
): Effect.Effect<EvaluatorqResult, Error, never> =>
  pipe(
    evaluatorqEffect(name, params),
    Effect.tap((results) => displayResultsTableEffect(results, name)),
  );
