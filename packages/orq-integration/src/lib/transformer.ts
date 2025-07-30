import { Effect } from 'effect';
import type { EvaluationResult, DataPointResult } from '@evaluatorq/shared';
import type { ExperimentData } from './client.js';

export interface OrqExperimentData {
  samples: Array<{
    id: string;
    input: any;
    output: any;
    metadata: {
      taskResults: any[];
      evaluatorScores: Record<string, number>;
    };
  }>;
  summary: {
    totalSamples: number;
    averageScores: Record<string, number>;
    executionTime: number;
  };
  metadata: {
    experimentName: string;
    timestamp: string;
    evaluators: string[];
  };
}

export const transformToOrqFormat = <TInput, TOutput>(
  result: EvaluationResult<TInput, TOutput>,
): Effect.Effect<ExperimentData> =>
  Effect.succeed({
    name: result.experimentName,
    description: `Evaluatorq experiment run at ${result.timestamp.toISOString()}`,
    data: transformResultData(result),
    metadata: {
      experimentName: result.experimentName,
      timestamp: result.timestamp.toISOString(),
      evaluators: getEvaluatorNames(result.results),
      summary: result.summary,
    },
  });

function transformResultData<TInput, TOutput>(
  result: EvaluationResult<TInput, TOutput>,
): OrqExperimentData['samples'] {
  return result.results.map((dataPoint, index) => ({
    id: `sample-${index + 1}`,
    input: dataPoint.input,
    output: dataPoint.output,
    metadata: {
      taskResults: dataPoint.taskResults,
      evaluatorScores: dataPoint.scores.reduce<Record<string, number>>(
        (acc, score) => {
          acc[score.evaluatorName] = score.score;
          return acc;
        },
        {},
      ),
    },
  }));
}

function getEvaluatorNames<TInput, TOutput>(
  results: Array<DataPointResult<TInput, TOutput>>,
): string[] {
  if (results.length === 0) return [];
  
  const firstResult = results[0];
  if (!firstResult) return [];
  
  return firstResult.scores.map((score) => score.evaluatorName);
}

// Transform specific types of outputs to be more readable in orq.ai
export const normalizeOutput = (output: unknown): unknown => {
  // Handle null/undefined
  if (output == null) {
    return null;
  }

  // Handle arrays
  if (Array.isArray(output)) {
    return output.map(normalizeOutput);
  }

  // Handle objects
  if (typeof output === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(output)) {
      normalized[key] = normalizeOutput(value);
    }
    return normalized;
  }

  // Handle functions (convert to string representation)
  if (typeof output === 'function') {
    return `[Function: ${output.name || 'anonymous'}]`;
  }

  // Primitives are returned as-is
  return output;
};