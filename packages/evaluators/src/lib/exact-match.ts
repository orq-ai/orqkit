import { Effect } from 'effect';
import { Evaluator } from '@evaluatorq/shared';

export interface ExactMatchOptions {
  caseSensitive?: boolean;
  trimWhitespace?: boolean;
}

export const createExactMatchEvaluator = (
  options: ExactMatchOptions = {},
): Evaluator<string> => {
  const { caseSensitive = false, trimWhitespace = true } = options;

  return {
    name: 'ExactMatch',
    evaluate: (output: string, expected: string) =>
      Effect.sync(() => {
        let processedOutput = output || '';
        let processedExpected = expected || '';

        if (trimWhitespace) {
          processedOutput = processedOutput.trim();
          processedExpected = processedExpected.trim();
        }

        if (!caseSensitive) {
          processedOutput = processedOutput.toLowerCase();
          processedExpected = processedExpected.toLowerCase();
        }

        return processedOutput === processedExpected ? 1 : 0;
      }),
  };
};

// Default exact match evaluator
export const ExactMatch = createExactMatchEvaluator();