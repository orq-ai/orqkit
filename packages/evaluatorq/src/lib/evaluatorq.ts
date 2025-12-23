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
import {
  captureParentContext,
  flushTracing,
  generateRunId,
  initTracingIfNeeded,
  shutdownTracing,
  type TracingContext,
} from "./tracing/index.js";
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

async function fetchDatasetAsDataPoints(
  orqClient: Orq,
  datasetId: string,
): Promise<Promise<DataPoint>[]> {
  try {
    const response = await orqClient.datasets.listDatapoints({ datasetId });

    return response.data.map((datapoint) =>
      Promise.resolve({
        inputs: datapoint.inputs || {},
        expectedOutput: datapoint.expectedOutput,
      } as DataPoint),
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch dataset ${datasetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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

  if (orqApiKey) {
    orqClient = await setupOrqClient(orqApiKey);
  }

  const startTime = new Date();

  let dataPromises: (Promise<DataPoint> | DataPoint)[];
  let datasetId: string | undefined;

  // Handle datasetId case
  if ("datasetId" in data) {
    if (!orqApiKey || !orqClient) {
      throw new Error(
        "ORQ_API_KEY environment variable must be set to fetch datapoints from Orq platform.",
      );
    }
    datasetId = data.datasetId;
    dataPromises = await fetchDatasetAsDataPoints(orqClient, data.datasetId);
  } else {
    dataPromises = data;
  }

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
  };

  // Execute evaluation - each job span is independent (no parent evaluation_run span)
  const results = await executeEvaluation();

  // Shutdown tracing gracefully - flush and shutdown before checking failures
  if (tracingEnabled) {
    // Force flush all pending spans
    await flushTracing();
    // Give additional time for network operations
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await shutdownTracing();
  }

  // Check for pass failures and exit if any
  const hasFailures = checkPassFailures(results);
  if (hasFailures) {
    process.exit(1);
  }

  return results;
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
