import type { AgentResponse, Message, Usage } from "./contracts.js";
import type { ExperimentInput } from "./experiment.js";
import type { AtifTrajectory } from "./formats/atif.js";
import type { ChatConversation } from "./formats/chat.js";
import type { OtelTrace } from "./formats/otel.js";
import type { ResponsesConversation } from "./formats/responses.js";
import type { ResponseResource } from "./integrations/openresponses/index.js";
import type { TraceInput } from "./trace.js";

export type Output =
  | AtifTrajectory
  | ChatConversation
  | OtelTrace
  | ResponsesConversation
  | string
  | number
  | boolean
  | ResponseResource
  | AgentResponse
  | Message[]
  | Record<string, unknown>
  | null;

export type EvaluationResultCellValue =
  | string
  | number
  | Record<string, string | number | Record<string, string | number>>;

export type EvaluationResultCell = {
  type: string;
  value: Record<string, EvaluationResultCellValue>;
};

export type EvaluationResult<T> = {
  value: T;
  explanation?: string | null;
  /** null records a verdict with no pass or fail, such as an inconclusive jury. */
  pass?: boolean | null;
  tokenUsage?: Usage | null;
  rawOutput?: Record<string, unknown> | null;
};

export interface EvaluatorScore {
  evaluatorName: string;
  score: EvaluationResult<
    | number
    | boolean
    | string
    | EvaluationResultCell
    | Record<string, unknown>
    | null
  >;
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
  /** Set when the job produced output for a failed run. Evaluators still run. */
  error?: string;
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
 * @param path - Optional path (e.g. "MyProject/MyFolder") to place the experiment in a specific project and folder on the Orq platform.
 * @param sendResults - Whether to upload results when ORQ_API_KEY is set. Defaults to true.
 * @param manageTracing - Whether to flush and shut down tracing when the run ends. Set to false when the caller owns the tracing lifecycle. Defaults to true.
 */
export interface EvaluatorParams {
  data:
    | ExperimentInput
    | TraceInput
    | {
        datasetId: string;
        includeMessages?: boolean;
      }
    | (Promise<DataPoint> | DataPoint)[];
  evaluators?: Evaluator[];
  jobs?: Job[];
  inference?: boolean | null;
  parallelism?: number;
  datapointParallelism?: number | null;
  llmParallelism?: number | null;
  onDatapointComplete?: (result: DataPointResult) => void | Promise<void>;
  print?: boolean;
  description?: string;
  path?: string;
  sendResults?: boolean;
  onResultsUploaded?: (experimentUrl: string) => void;
  manageTracing?: boolean;
  /** Exit with code 1 for failed scores. Disable when a higher-level runner owns the verdict. */
  exitOnFailure?: boolean;
}

export type Evaluator = {
  name: string;
  evaluatorType?: string;
  scorer: Scorer;
};

export type ScorerParameter = {
  data: DataPoint;
  output: Output;
  /** Dataset row index, set when the runner calls the scorer. */
  row?: number;
};

export type Scorer = (
  params: ScorerParameter,
) => Promise<
  EvaluationResult<
    | string
    | number
    | boolean
    | EvaluationResultCell
    | Record<string, unknown>
    | null
  >
>;
