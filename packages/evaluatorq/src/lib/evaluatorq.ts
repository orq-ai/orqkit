import type { Orq } from "@orq-ai/node";
import { Effect, pipe } from "effect";
import { processDataPointEffect } from "./effects.js";
import {
  ProgressService,
  ProgressServiceLive,
  withProgress,
} from "./progress.js";
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

    return new client.Orq({ apiKey, serverURL: "https://my.staging.orq.ai" });
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
 * @param _name - The name of the evaluation run.
 * @param params - The parameters for the evaluation run.
 * @returns The results of the evaluation run.
 */
export async function evaluatorq(
  _name: string,
  params: EvaluatorParams,
): Promise<EvaluatorqResult> {
  const { data, evaluators = [], jobs, parallelism = 1, print = true } = params;

  let orqClient: Orq | undefined;
  const orqApiKey = process.env.ORQ_API_KEY;

  if (orqApiKey) {
    orqClient = await setupOrqClient(orqApiKey);
  }

  let dataPromises: Promise<DataPoint>[];

  // Handle datasetId case
  if ("datasetId" in data) {
    if (!orqApiKey || !orqClient) {
      throw new Error(
        "ORQ_API_KEY environment variable must be set to fetch datapoints from Orq platform.",
      );
    }
    dataPromises = await fetchDatasetAsDataPoints(orqClient, data.datasetId);
  } else {
    dataPromises = data as Promise<DataPoint>[];
  }

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
              dataPromise,
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
  const { data, evaluators = [], jobs, parallelism = 1, print = true } = params;

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
        runEvaluationEffect(dataPromises, evaluators, jobs, parallelism, print),
      );
    });
  }

  const dataPromises = data as Promise<DataPoint>[];
  return runEvaluationEffect(
    dataPromises,
    evaluators,
    jobs,
    parallelism,
    print,
  );
};

// Extract common evaluation logic
const runEvaluationEffect = (
  dataPromises: Promise<DataPoint>[],
  evaluators: EvaluatorParams["evaluators"] = [],
  jobs: Job[],
  parallelism: number,
  print: boolean,
): Effect.Effect<EvaluatorqResult, Error, never> =>
  pipe(
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
              dataPromise,
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
    // Provide the progress service
    Effect.provide(ProgressServiceLive),
    // Wrap with progress tracking
    (effect) => withProgress(effect, print),
  );

// Composable evaluatorq with display
export const evaluatorqWithTableEffect = (
  name: string,
  params: EvaluatorParams,
): Effect.Effect<EvaluatorqResult, Error, never> =>
  pipe(
    evaluatorqEffect(name, params),
    Effect.tap((results) => displayResultsTableEffect(results)),
  );
