import type { Effect } from 'effect';
import type { DataError, EvaluatorError, TaskError } from './errors.js';

export interface DataPoint<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

export interface Task<TInput, TOutput> {
  (dataPoint: DataPoint<TInput, TOutput>): Promise<any> | any;
}

export interface Evaluator<T> {
  name: string;
  evaluate: (output: T, expected: T) => Effect.Effect<number, EvaluatorError>;
}

export interface Experiment<TInput, TOutput> {
  name: string;
  data: () => Promise<Array<DataPoint<TInput, TOutput>>>;
  tasks: Array<Task<TInput, TOutput>>;
  evaluators: Array<Evaluator<TOutput>>;
}

export interface TaskResult {
  taskIndex: number;
  result: any;
  error?: TaskError;
}

export interface EvaluationScore {
  evaluatorName: string;
  score: number;
}

export interface DataPointResult<TInput, TOutput> {
  input: TInput;
  output: TOutput;
  taskResults: Array<TaskResult>;
  scores: Array<EvaluationScore>;
}

export interface EvaluationResult<TInput = unknown, TOutput = unknown> {
  experimentName: string;
  timestamp: Date;
  results: Array<DataPointResult<TInput, TOutput>>;
  summary: {
    totalSamples: number;
    averageScores: Record<string, number>;
    executionTime: number;
  };
}