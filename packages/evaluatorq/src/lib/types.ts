export type Output = string | number | boolean | Record<string, unknown> | null;

type EvaluationResult<T> = {
  value: T;
  explanation?: string;
  pass?: boolean;
};

export interface EvaluatorScore {
  evaluatorName: string;
  score: EvaluationResult<number | boolean | string>;
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
 * @param inputs - The inputs to pass to the job.
 * @param expectedOutput - The expected output of the data point. Used for evaluation and comparing the output of the job.
 */
export interface DataPoint {
  inputs: Record<string, unknown>;
  expectedOutput?: Output;
}

/**
 * A job function that processes data and returns output.
 * Use the `job` helper to create named jobs from these functions.
 *
 * @param data - The data to evaluate.
 * @param row - The row number of the data.
 * @returns The output of the job.
 *
 * @example
 * const processData = job("processData", async (data) => {
 *   return data.inputs.text.toUpperCase();
 * });
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
 * @param print - Whether to print the results in a table format to the console. Defaults to true.
 * @param description - Optional description for the evaluation run.
 */
export interface EvaluatorParams {
  data:
    | {
        datasetId: string;
        includeMessages?: boolean;
      }
    | (Promise<DataPoint> | DataPoint)[];
  evaluators?: Evaluator[];
  jobs: Job[];
  parallelism?: number;
  print?: boolean;
  description?: string;
}

export type Evaluator = {
  name: string;
  scorer: Scorer;
};

export type ScorerParameter = {
  data: DataPoint;
  output: Output;
};

export type Scorer =
  | ((params: ScorerParameter) => Promise<EvaluationResult<string>>)
  | ((params: ScorerParameter) => Promise<EvaluationResult<number>>)
  | ((params: ScorerParameter) => Promise<EvaluationResult<boolean>>);
