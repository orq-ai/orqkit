export async function evaluatorq(_name: string, _params: EvaluatorParams) {
  return "evaluatorq";
}

export type Output = string | number | boolean | Record<string, unknown> | null;

export interface DataPoint {
  inputs: Record<string, unknown>;
  expectedOutput?: Output;
}

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
 */
export interface EvaluatorParams {
  data:
    | {
        datasetId: string;
      }
    | Promise<{
        data: DataPoint;
      }>[];
  evaluators?: Scorer[];
  jobs: Job[];
}

export type ScorerParameter = {
  data: DataPoint;
};

export type Scorer = (
  params: ScorerParameter,
) => Promise<number | boolean | string>;
