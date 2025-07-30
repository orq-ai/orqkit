import { Effect, pipe } from 'effect';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EvaluationResult, OutputError } from '@evaluatorq/shared';

export interface OutputHandler {
  handle: (result: EvaluationResult) => Effect.Effect<void, OutputError>;
}

export class LocalOutputHandler implements OutputHandler {
  constructor(private readonly outputDir: string = './evaluations') {}

  handle(result: EvaluationResult): Effect.Effect<void, OutputError> {
    return pipe(
      Effect.tryPromise({
        try: async () => {
          // Ensure output directory exists
          await fs.mkdir(this.outputDir, { recursive: true });

          // Generate filename with timestamp
          const timestamp = result.timestamp.toISOString().replace(/[:.]/g, '-');
          const filename = `${result.experimentName}-${timestamp}.json`;
          const filepath = join(this.outputDir, filename);

          // Write JSON file
          await fs.writeFile(filepath, JSON.stringify(result, null, 2), 'utf-8');

          // Log to console
          console.log(`\nResults saved to: ${filepath}`);
        },
        catch: (error) =>
          new (OutputError as any)({
            message: 'Failed to save results locally',
            cause: error,
          }),
      }),
    );
  }
}

export class CLIOutputHandler implements OutputHandler {
  handle(result: EvaluationResult): Effect.Effect<void, OutputError> {
    return Effect.sync(() => {
      console.log(`\n✓ ${result.experimentName} completed in ${result.summary.executionTime}ms\n`);

      // Create table header
      const headers = ['Sample', 'Input', 'Output'];
      const evaluatorNames = Object.keys(result.summary.averageScores);
      headers.push(...evaluatorNames.map((name) => `${name} Score`));

      // Calculate column widths
      const columnWidths = headers.map((header) => Math.max(header.length, 15));

      // Print table header
      console.log(this.createTableRow(headers, columnWidths));
      console.log(this.createSeparator(columnWidths));

      // Print each result row
      result.results.forEach((dataPoint, index) => {
        const row = [
          (index + 1).toString(),
          this.truncate(JSON.stringify(dataPoint.input), 15),
          this.truncate(JSON.stringify(dataPoint.output), 15),
        ];

        evaluatorNames.forEach((evaluatorName) => {
          const score = dataPoint.scores.find((s) => s.evaluatorName === evaluatorName);
          row.push(score ? score.score.toFixed(2) : 'N/A');
        });

        console.log(this.createTableRow(row, columnWidths));
      });

      // Print summary
      console.log('\nSummary:');
      console.log(`• Total Samples: ${result.summary.totalSamples}`);
      Object.entries(result.summary.averageScores).forEach(([evaluator, avgScore]) => {
        console.log(`• Average ${evaluator}: ${avgScore.toFixed(2)}`);
      });
      console.log(`• Execution Time: ${result.summary.executionTime}ms`);
    });
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  private createTableRow(cells: string[], widths: number[]): string {
    const paddedCells = cells.map((cell, i) => cell.padEnd(widths[i] || 15));
    return '│ ' + paddedCells.join(' │ ') + ' │';
  }

  private createSeparator(widths: number[]): string {
    const sections = widths.map((width) => '─'.repeat(width));
    return '├─' + sections.join('─┼─') + '─┤';
  }
}

export class CompositeOutputHandler implements OutputHandler {
  constructor(private readonly handlers: OutputHandler[]) {}

  handle(result: EvaluationResult): Effect.Effect<void, OutputError> {
    return pipe(
      this.handlers,
      Effect.forEach((handler) => handler.handle(result), { concurrency: 'unbounded' }),
      Effect.map(() => undefined),
    );
  }
}