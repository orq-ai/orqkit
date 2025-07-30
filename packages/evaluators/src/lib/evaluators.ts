import type { DataPoint } from '@evaluatorq/shared';

export function evaluators(): string {
  return 'evaluators';
}

// Test import
export type TestDataPoint = DataPoint<string, string>;
