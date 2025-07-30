import { describe, it, expect, vi } from 'vitest';
import { Effect, Exit } from 'effect';
import { Evaluatorq } from './evaluatorq.js';
import type { Evaluator } from '@evaluatorq/shared';

describe('Evaluatorq', () => {
  const mockEvaluator: Evaluator<string> = {
    name: 'MockEvaluator',
    evaluate: (output, expected) =>
      Effect.succeed(output === expected ? 1 : 0),
  };

  it('should run evaluation successfully', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleTableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

    const result = await Evaluatorq('Test Experiment', {
      data: async () => [
        { input: 'test', output: 'test' },
        { input: 'foo', output: 'bar' },
      ],
      tasks: [
        ({ input, output }) => ({
          isMatch: input === output,
        }),
      ],
      evaluators: [mockEvaluator],
    });

    expect(result).toBeDefined();
    expect(result.experimentName).toBe('Test Experiment');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].scores[0].score).toBe(1);
    expect(result.results[1].scores[0].score).toBe(0);
    expect(result.summary.totalSamples).toBe(2);
    expect(result.summary.averageScores['MockEvaluator']).toBe(0.5);

    consoleSpy.mockRestore();
    consoleTableSpy.mockRestore();
  });

  it('should handle errors in data loading', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      Evaluatorq('Error Test', {
        data: async () => {
          throw new Error('Data loading failed');
        },
        tasks: [],
        evaluators: [],
      }),
    ).rejects.toThrow('Evaluation failed');

    consoleSpy.mockRestore();
  });

  it('should handle task execution errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleTableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

    await expect(
      Evaluatorq('Task Error Test', {
        data: async () => [{ input: 'test', output: 'test' }],
        tasks: [
          () => {
            throw new Error('Task failed');
          },
        ],
        evaluators: [mockEvaluator],
      }),
    ).rejects.toThrow('Evaluation failed');

    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleTableSpy.mockRestore();
  });

  it('should handle evaluator errors gracefully', async () => {
    const errorEvaluator: Evaluator<string> = {
      name: 'ErrorEvaluator',
      evaluate: () =>
        Effect.fail({
          evaluatorName: 'ErrorEvaluator',
          message: 'Evaluation failed',
        } as any),
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleTableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

    await expect(
      Evaluatorq('Evaluator Error Test', {
        data: async () => [{ input: 'test', output: 'test' }],
        tasks: [],
        evaluators: [errorEvaluator],
      }),
    ).rejects.toThrow('Evaluation failed');

    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleTableSpy.mockRestore();
  });

  it('should handle concurrent evaluations', async () => {
    const slowEvaluator: Evaluator<string> = {
      name: 'SlowEvaluator',
      evaluate: (output, expected) =>
        Effect.gen(function* () {
          yield* Effect.sleep(100);
          return output === expected ? 1 : 0;
        }),
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleTableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

    const startTime = Date.now();
    const result = await Evaluatorq('Concurrent Test', {
      data: async () =>
        Array.from({ length: 10 }, (_, i) => ({
          input: `test${i}`,
          output: `test${i}`,
        })),
      tasks: [],
      evaluators: [slowEvaluator],
    });

    const duration = Date.now() - startTime;
    
    // Should process in parallel (not take 10 * 100ms)
    expect(duration).toBeLessThan(500);
    expect(result.results).toHaveLength(10);
    expect(result.summary.averageScores['SlowEvaluator']).toBe(1);

    consoleSpy.mockRestore();
    consoleTableSpy.mockRestore();
  });
});