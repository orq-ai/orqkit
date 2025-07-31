import { Effect, pipe } from "effect";
import { ProgressService } from "./progress.js";
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
            (job) => processJobEffect(job, dataPoint, rowIndex, evaluators),
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
): Effect.Effect<JobResult, Error, ProgressService> {
  return Effect.gen(function* (_) {
    const progress = yield* _(ProgressService);

    // Update progress with current job
    const jobResult = yield* _(
      pipe(
        Effect.Do,
        Effect.bind("jobName", () =>
          Effect.sync(() => {
            // Try to get job name from a test run or use a placeholder
            return "job";
          }),
        ),
        Effect.tap(({ jobName }) =>
          progress.updateProgress({
            currentJob: jobName,
            phase: "processing",
          }),
        ),
        Effect.bind("result", () =>
          Effect.tryPromise({
            try: () => job(dataPoint, rowIndex),
            catch: (error) => error as Error,
          }),
        ),
        Effect.tap(({ result }) =>
          progress.updateProgress({
            currentJob: result.name,
          }),
        ),
        Effect.map(({ result }) => result),
      ),
    );

    // Process evaluators if any
    if (evaluators.length > 0) {
      // Update phase to evaluating
      yield* _(progress.updateProgress({ phase: "evaluating" }));

      const evaluatorScores = yield* _(
        Effect.forEach(
          evaluators,
          (evaluator) =>
            Effect.gen(function* (_) {
              // Update current evaluator
              yield* _(
                progress.updateProgress({
                  currentEvaluator: evaluator.name,
                }),
              );

              const score = yield* _(
                pipe(
                  Effect.tryPromise({
                    try: () =>
                      evaluator.scorer({
                        data: dataPoint,
                        output: jobResult.output,
                      }),
                    catch: (error) => error as Error,
                  }),
                  Effect.map((score) => ({
                    evaluatorName: evaluator.name,
                    score,
                  })),
                  Effect.catchAll((error) =>
                    Effect.succeed({
                      evaluatorName: evaluator.name,
                      score: "" as string,
                      error,
                    }),
                  ),
                ),
              );

              return score;
            }),
          { concurrency: "unbounded" },
        ),
      );

      return {
        jobName: jobResult.name,
        output: jobResult.output,
        evaluatorScores,
      };
    }

    return {
      jobName: jobResult.name,
      output: jobResult.output,
      evaluatorScores: [],
    };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        jobName: "Unknown", // We don't know the job name if it threw before returning
        output: null,
        error,
      }),
    ),
  );
}
