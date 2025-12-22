import { Effect, pipe } from "effect";

import type { Orq } from "@orq-ai/node";

import { processDataPointEffect } from "./effects.js";
import {
  ProgressService,
  ProgressServiceLive,
  withProgress,
} from "./progress.js";
import { sendResultsToOrqEffect } from "./send-results.js";
import { displayResultsTableEffect } from "./table-display.js";
import type {
  DataPoint,
  EvaluatorParams,
  EvaluatorqResult,
  Job,
} from "./types.js";

async function setupOrqClient(apiKey: string) {
  try {
    const client = await import("@orq-ai/node");
    const serverURL = process.env.ORQ_BASE_URL || "https://my.orq.ai";

    return new client.Orq({ apiKey, serverURL });
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    if (
      err.code === "MODULE_NOT_FOUND" ||
      err.code === "ERR_MODULE_NOT_FOUND" ||
      err.message?.includes("Cannot find module")
    ) {
      throw new Error(
        "The @orq-ai/node package is not installed. To use dataset features, please install it:\n" +
          "  npm install @orq-ai/node\n" +
          "  # or\n" +
          "  yarn add @orq-ai/node\n" +
          "  # or\n" +
          "  bun add @orq-ai/node",
      );
    }
    throw new Error(`Failed to setup ORQ client: ${err.message || err}`);
  }
}

interface DataPointBatch {
  datapoints: DataPoint[];
  hasMore: boolean;
  batchNumber: number;
}

async function* fetchDatasetBatches(
  orqClient: Orq,
  datasetId: string,
): AsyncGenerator<DataPointBatch> {
  let startingAfter: string | undefined;
  let batchNumber = 0;
  let hasYielded = false;

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
        break;
      }

      const batchDatapoints: DataPoint[] = [];
      for (const datapoint of response.data) {
        batchDatapoints.push({
          inputs: datapoint.inputs || {},
          expectedOutput: datapoint.expectedOutput,
        } as DataPoint);

        startingAfter =
          (datapoint as unknown as { _id?: string })._id ??
          (datapoint as unknown as { id?: string }).id;
      }

      batchNumber++;
      const hasMore = response.hasMore ?? false;

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

async function fetchDatasetAsDataPoints(
  orqClient: Orq,
  datasetId: string,
): Promise<Promise<DataPoint>[]> {
  const allDatapoints: DataPoint[] = [];
  for await (const batch of fetchDatasetBatches(orqClient, datasetId)) {
    allDatapoints.push(...batch.datapoints);
  }
  return allDatapoints.map((dp) => Promise.resolve(dp));
}

/**
 * @param _name - The name of the evaluation run.
 * @param params - The parameters for the evaluation run.
 * @returns The results of the evaluation run.
 */
export async function evaluatorq(
  _name: string,
  params: EvaluatorParams,
): Promise<EvaluatorqResult> {
  const {
    data,
    evaluators = [],
    jobs,
    parallelism = 1,
    print = true,
    description,
  } = params;

  let orqClient: Orq | undefined;
  const orqApiKey = process.env.ORQ_API_KEY;

  if (orqApiKey) {
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

    const datasetIdValue = data.datasetId;

    // Shared progress state that can be updated from within Effect.promise
    const progressRef = {
      totalDataPoints: 0,
      processedDataPoints: 0,
      phase: "fetching" as "fetching" | "processing",
      done: false,
    };

    // Stream fetch and process batches concurrently
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
        const progressInterval = setInterval(() => {
          Effect.runPromise(
            progress.updateProgress({
              totalDataPoints: progressRef.totalDataPoints,
              currentDataPoint: progressRef.processedDataPoints,
              phase: progressRef.phase,
            }),
          );
        }, 100);

        // Fetch and process batches with streaming
        const allResults = yield* _(
          Effect.promise(async () => {
            const results: EvaluatorqResult = [];
            const processingPromises: Promise<EvaluatorqResult>[] = [];
            let datapointIndex = 0;

            for await (const batch of fetchDatasetBatches(
              orqClient,
              datasetIdValue,
            )) {
              // Update total as we fetch
              progressRef.totalDataPoints += batch.datapoints.length;
              progressRef.phase = "processing";

              // Start processing this batch immediately
              for (const datapoint of batch.datapoints) {
                const currentIndex = datapointIndex++;
                const promise = (async () => {
                  // Process datapoint directly without Effect to avoid progress conflicts
                  const jobResults = await Promise.all(
                    jobs.map(async (job) => {
                      try {
                        const result = await job(datapoint, currentIndex);
                        // Run evaluators for this job
                        const evaluatorScores = await Promise.all(
                          evaluators.map(async (evaluator) => {
                            try {
                              const score = await evaluator.scorer({
                                data: datapoint,
                                output: result.output,
                              });
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
                  progressRef.processedDataPoints++;
                  return [
                    { dataPoint: datapoint, jobResults },
                  ] as EvaluatorqResult;
                })();
                processingPromises.push(promise);
              }
            }

            // Wait for all processing to complete
            const resultsNested = await Promise.all(processingPromises);
            for (const resultList of resultsNested) {
              results.push(...resultList);
            }

            return results;
          }),
        );

        // Stop the progress polling
        clearInterval(progressInterval);

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
        ? Effect.tap((results) => displayResultsTableEffect(results))
        : Effect.tap(() => Effect.void),
      // Send results to Orq when API key is available
      orqApiKey
        ? Effect.tap((results) =>
            sendResultsToOrqEffect(
              orqApiKey,
              _name,
              description,
              datasetId,
              results,
              startTime,
              new Date(),
            ),
          )
        : Effect.tap(() => Effect.void),
      // Provide the progress service
      Effect.provide(ProgressServiceLive),
      // Wrap with progress tracking
      (effect) => withProgress(effect, print),
    );

    return Effect.runPromise(streamingProgram);
  }

  // Non-streaming case: process all data at once
  const dataPromises = data;

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
            ),
          { concurrency: parallelism },
        ),
      );

      return results.flat();
    }),
    // Conditionally add table display
    print
      ? Effect.tap((results) => displayResultsTableEffect(results))
      : Effect.tap(() => Effect.void),
    // Send results to Orq when API key is available
    orqApiKey
      ? Effect.tap((results) =>
          sendResultsToOrqEffect(
            orqApiKey,
            _name,
            description,
            datasetId,
            results,
            startTime,
            new Date(),
          ),
        )
      : Effect.tap(() => Effect.void),
    // Provide the progress service
    Effect.provide(ProgressServiceLive),
    // Wrap with progress tracking
    (effect) => withProgress(effect, print),
  );

  // Run the Effect and convert back to Promise
  return Effect.runPromise(program);
}

// Create an Effect that runs evaluation and optionally displays results
export const evaluatorqEffect = (
  _name: string,
  params: EvaluatorParams,
): Effect.Effect<EvaluatorqResult, Error, never> => {
  const {
    data,
    evaluators = [],
    jobs,
    parallelism = 1,
    print = true,
    description,
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
        return yield* _(Effect.fail(new Error("Failed to setup Orq client")));
      }

      const dataPromises = yield* _(
        Effect.tryPromise({
          try: () => fetchDatasetAsDataPoints(orqClient, data.datasetId),
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
  );
};

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
            ),
          { concurrency: parallelism },
        ),
      );

      return results.flat();
    }),
    // Conditionally add table display
    print
      ? Effect.tap((results) => displayResultsTableEffect(results))
      : Effect.tap(() => Effect.void),
    // Send results to Orq when API key is available
    orqApiKey
      ? Effect.tap((results) =>
          sendResultsToOrqEffect(
            orqApiKey,
            evaluationName,
            description,
            datasetId,
            results,
            startTime,
            new Date(),
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
    Effect.tap((results) => displayResultsTableEffect(results)),
  );
