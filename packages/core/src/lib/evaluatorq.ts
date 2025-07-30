import { Effect, pipe } from 'effect';
import type { Experiment, EvaluationResult } from '@evaluatorq/shared';
import { runEvaluation } from './engine.js';
import { LocalOutputHandler, CLIOutputHandler, CompositeOutputHandler } from './output-handler.js';

export interface EvaluatorqConfig<TInput, TOutput> {
  data: () => Promise<Array<{ input: TInput; output: TOutput }>>;
  tasks: Array<(dataPoint: { input: TInput; output: TOutput }) => Promise<any> | any>;
  evaluators: Array<{
    name: string;
    evaluate: (output: TOutput, expected: TOutput) => Effect.Effect<number, any>;
  }>;
}

export const Evaluatorq = async <TInput, TOutput>(
  name: string,
  config: EvaluatorqConfig<TInput, TOutput>,
): Promise<EvaluationResult<TInput, TOutput>> => {
  const experiment: Experiment<TInput, TOutput> = {
    name,
    ...config,
  };

  // Create output handlers
  const handlers = [];
  
  // Always add CLI handler
  handlers.push(new CLIOutputHandler());
  
  // Always add local JSON handler
  handlers.push(new LocalOutputHandler());
  
  // Check for orq.ai integration
  if (process.env.ORQ_API_KEY) {
    try {
      // Dynamically import orq integration to avoid circular dependencies
      const { createOrqOutputHandler, OrqApiService } = await import('@evaluatorq/orq-integration');
      const orqService = await Effect.runPromise(
        OrqApiService.make(process.env.ORQ_API_KEY, process.env.ORQ_API_URL)
      );
      
      // Create a simple orq handler inline
      handlers.push({
        handle: async (result: EvaluationResult<TInput, TOutput>) => {
          try {
            const { transformToOrqFormat } = await import('@evaluatorq/orq-integration');
            const data = await Effect.runPromise(transformToOrqFormat(result));
            const response = await Effect.runPromise(orqService.submitExperiment(data));
            console.log(`\n✓ Results uploaded to orq.ai`);
            console.log(`  View at: ${response.url}`);
          } catch (error) {
            console.error('Failed to upload to orq.ai:', error);
          }
        },
      });
    } catch (error) {
      console.warn('Failed to initialize orq.ai integration:', error);
    }
  }
  
  const outputHandler = new CompositeOutputHandler(handlers);

  const program = pipe(
    runEvaluation(experiment),
    Effect.tap((result) => outputHandler.handle(result)),
    Effect.catchAll((error) =>
      Effect.fail(
        new Error(
          `Evaluation failed: ${
            error._tag || 'Unknown error'
          } - ${error.message || JSON.stringify(error)}`,
        ),
      ),
    ),
  );

  return Effect.runPromise(program);
};