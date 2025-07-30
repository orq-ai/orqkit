import { Effect } from 'effect';
import { Evaluator } from '@evaluatorq/shared';

function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create a 2D array for dynamic programming
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize base cases
  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
  }

  // Fill the dp table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] =
          1 +
          Math.min(
            dp[i - 1]![j]!, // deletion
            dp[i]![j - 1]!, // insertion
            dp[i - 1]![j - 1]!, // substitution
          );
      }
    }
  }

  return dp[m]![n]!;
}

export const LevenshteinDistance: Evaluator<string> = {
  name: 'LevenshteinDistance',
  evaluate: (output: string, expected: string) =>
    Effect.sync(() => {
      // Handle edge cases
      if (!output || !expected) {
        return output === expected ? 1 : 0;
      }

      // Calculate Levenshtein distance
      const distance = levenshteinDistance(output, expected);

      // Normalize to 0-1 range (1 = perfect match, 0 = completely different)
      const maxLength = Math.max(output.length, expected.length);
      const similarity = maxLength === 0 ? 1 : 1 - distance / maxLength;

      return Math.max(0, Math.min(1, similarity));
    }),
};