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

  // Process data points with controlled parallelism
  const results: EvaluatorqResult = [];
  const dataPromises = data as Promise<DataPoint>[];

  // Process data points in batches
  for (let i = 0; i < dataPromises.length; i += parallelism) {
    const batch = dataPromises.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map(async (dataPromise, batchIndex) => {
        const rowIndex = i + batchIndex;
        return processDataPoint(
          dataPromise,
          rowIndex,
          jobs,
          evaluators,
          parallelism,
        );
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

async function processDataPoint(
  dataPromise: Promise<DataPoint>,
  rowIndex: number,
  jobs: Job[],
  evaluators: { name: string; scorer: Scorer }[],
  parallelism: number,
): Promise<DataPointResult> {
  try {
    const dataPoint = await dataPromise;
    const jobResults: JobResult[] = [];

    // Run jobs with controlled parallelism
    for (let i = 0; i < jobs.length; i += parallelism) {
      const jobBatch = jobs.slice(i, i + parallelism);
      const batchResults = await Promise.all(
        jobBatch.map(async (job) => {
          return processJob(job, dataPoint, rowIndex, evaluators);
        }),
      );
      jobResults.push(...batchResults);
    }

    return {
      dataPoint,
      jobResults,
    };
  } catch (error) {
    return {
      dataPoint: { inputs: {} }, // Placeholder since we couldn't get the actual data
      error: error as Error,
    };
  }
}

async function processJob(
  job: Job,
  dataPoint: DataPoint,
  rowIndex: number,
  evaluators: { name: string; scorer: Scorer }[],
): Promise<JobResult> {
  try {
    const jobResult = await job(dataPoint, rowIndex);
    const evaluatorScores: EvaluatorScore[] = [];

    // Run evaluators on successful job output
    if (evaluators.length > 0) {
      const scorerResults = await Promise.all(
        evaluators.map(async (evaluator) => {
          try {
            const score = await evaluator.scorer({
              data: dataPoint,
              output: jobResult.output,
            });
            return {
              evaluatorName: evaluator.name,
              score,
            };
          } catch (error) {
            return {
              evaluatorName: evaluator.name,
              score: "" as string,
              error: error as Error,
            };
          }
        }),
      );
      evaluatorScores.push(...scorerResults);
    }

    return {
      jobName: jobResult.name,
      output: jobResult.output,
      evaluatorScores,
    };
  } catch (error) {
    return {
      jobName: "Unknown", // We don't know the job name if it threw before returning
      output: null,
      error: error as Error,
    };
  }
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
