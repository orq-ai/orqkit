import { Effect, pipe } from "effect";

export interface EvaluatorScore {
  evaluatorName: string;
  score: number | boolean | string;
  error?: Error;
}

export interface JobResult {
  jobName: string;
  output: Output;
  error?: Error;
  evaluatorScores?: EvaluatorScore[];
}

export interface DataPointResult {
  dataPoint: DataPoint;
  error?: Error;
  jobResults?: JobResult[];
}

export type EvaluatorqResult = DataPointResult[];

/**
 * @param _name - The name of the evaluation run.
 * @param params - The parameters for the evaluation run.
 * @returns The results of the evaluation run.
 */
export async function evaluatorq(
  _name: string,
  params: EvaluatorParams,
): Promise<EvaluatorqResult> {
  const { data, evaluators = [], jobs, parallelism = 1 } = params;

  // Handle datasetId case (not implemented)
  if ("datasetId" in data) {
    throw new Error(
      "Dataset fetching not implemented. Please provide an array of DataPoint promises.",
    );
  }

  const dataPromises = data as Promise<DataPoint>[];

  // Create Effect for processing all data points
  const program = pipe(
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
    Effect.map((results) => results.flat()),
  );

  // Run the Effect and convert back to Promise
  return Effect.runPromise(program);
}

function processDataPointEffect(
  dataPromise: Promise<DataPoint>,
  rowIndex: number,
  jobs: Job[],
  evaluators: { name: string; scorer: Scorer }[],
  parallelism: number,
): Effect.Effect<DataPointResult[], Error> {
  return pipe(
    Effect.tryPromise({
      try: () => dataPromise,
      catch: (error) => error as Error,
    }),
    Effect.flatMap((dataPoint) =>
      pipe(
        Effect.forEach(
          jobs,
          (job) => processJobEffect(job, dataPoint, rowIndex, evaluators),
          { concurrency: parallelism },
        ),
        Effect.map((jobResults) => [
          {
            dataPoint,
            jobResults,
          },
        ]),
      ),
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

function processJobEffect(
  job: Job,
  dataPoint: DataPoint,
  rowIndex: number,
  evaluators: { name: string; scorer: Scorer }[],
): Effect.Effect<JobResult, Error> {
  return pipe(
    Effect.tryPromise({
      try: () => job(dataPoint, rowIndex),
      catch: (error) => error as Error,
    }),
    Effect.flatMap((jobResult) =>
      evaluators.length > 0
        ? pipe(
            Effect.forEach(
              evaluators,
              (evaluator) =>
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
              { concurrency: "unbounded" },
            ),
            Effect.map((evaluatorScores) => ({
              jobName: jobResult.name,
              output: jobResult.output,
              evaluatorScores,
            })),
          )
        : Effect.succeed({
            jobName: jobResult.name,
            output: jobResult.output,
            evaluatorScores: [],
          }),
    ),
    Effect.catchAll((error) =>
      Effect.succeed({
        jobName: "Unknown", // We don't know the job name if it threw before returning
        output: null,
        error,
      }),
    ),
  );
}

export type Output = string | number | boolean | Record<string, unknown> | null;

/**
 * @param inputs - The inputs to pass to the job.
 * @param expectedOutput - The expected output of the data point. Used for evaluation and comparing the output of the job.
 */
export interface DataPoint {
  inputs: Record<string, unknown>;
  expectedOutput?: Output;
}

/**
 * @param data - The data to evaluate.
 * @param row - The row number of the data.
 * @returns The output of the job.
 */
export type Job = (
  data: DataPoint,
  row: number,
) => Promise<{
  name: string;
  output: Output;
}>;

/**
 * @param data - The data to evaluate. If a datasetId is provided, we will fetch the data from the dataset in the orq.ai platform.
 * For this the ORQ_API_KEY environment variable must be set.
 *
 * If an array of promises is provided, we will wait for the promises to resolve before running the jobs on it.
 * @param evaluators - The evaluators to use. If not provided we will not run evaluations, only the jobs on the data provided.
 * @param jobs - The jobs to run.
 * @param parallelism - The number of jobs to run in parallel. If not provided, we will run the jobs sequentially.
 */
export interface EvaluatorParams {
  data:
    | {
        datasetId: string;
      }
    | Promise<DataPoint>[];
  evaluators?: {
    name: string;
    scorer: Scorer;
  }[];
  jobs: Job[];
  parallelism?: number;
}

export type ScorerParameter = {
  data: DataPoint;
  output: Output;
};

export type Scorer = (
  params: ScorerParameter,
) => Promise<number | boolean | string>;
