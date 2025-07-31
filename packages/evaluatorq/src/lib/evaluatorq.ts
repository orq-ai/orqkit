import { Effect, pipe } from "effect";
import { processDataPointEffect } from "./effects.js";
import {
  ProgressService,
  ProgressServiceLive,
  withProgress,
} from "./progress.js";
import { displayResultsTableEffect } from "./table-display.js";
import type { DataPoint, EvaluatorParams, EvaluatorqResult } from "./types.js";

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

  // Handle datasetId case (not implemented)
  if ("datasetId" in data) {
    throw new Error(
      "Dataset fetching not implemented. Please provide an array of DataPoint promises.",
    );
  }

  const dataPromises = data as Promise<DataPoint>[];

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

  // Handle datasetId case (not implemented)
  if ("datasetId" in data) {
    return Effect.fail(
      new Error(
        "Dataset fetching not implemented. Please provide an array of DataPoint promises.",
      ),
    );
  }

  const dataPromises = data as Promise<DataPoint>[];

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
