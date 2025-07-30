import { Effect, pipe } from 'effect';
import {
  DataPoint,
  Task,
  Evaluator,
  Experiment,
  TaskResult,
  EvaluationScore,
  DataPointResult,
  EvaluationResult,
  DataError,
  TaskError,
  EvaluatorError,
} from '@evaluatorq/shared';

export const runTasks = <TInput, TOutput>(
  dataPoint: DataPoint<TInput, TOutput>,
  tasks: Array<Task<TInput, TOutput>>,
): Effect.Effect<Array<TaskResult>, TaskError> =>
  pipe(
    tasks,
    Effect.forEach((task, index) =>
      Effect.tryPromise({
        try: async () => ({
          taskIndex: index,
          result: await Promise.resolve(task(dataPoint)),
        }),
        catch: (error) =>
          new TaskError({
            taskIndex: index,
            message: `Task ${index} failed`,
            cause: error,
          }),
      }),
    ),
  );

export const applyEvaluators = <T>(
  output: T,
  expected: T,
  evaluators: Array<Evaluator<T>>,
): Effect.Effect<Array<EvaluationScore>, EvaluatorError> =>
  pipe(
    evaluators,
    Effect.forEach((evaluator) =>
      pipe(
        evaluator.evaluate(output, expected),
        Effect.map((score) => ({
          evaluatorName: evaluator.name,
          score,
        })),
      ),
    ),
  );

export const processDataPoint = <TInput, TOutput>(
  dataPoint: DataPoint<TInput, TOutput>,
  tasks: Array<Task<TInput, TOutput>>,
  evaluators: Array<Evaluator<TOutput>>,
): Effect.Effect<DataPointResult<TInput, TOutput>, TaskError | EvaluatorError> =>
  Effect.gen(function* () {
    const taskResults = yield* runTasks(dataPoint, tasks);
    // For string inputs, use input as expected and output as actual
    // This allows comparing model outputs
    const expected = dataPoint.input as unknown as TOutput;
    const actual = dataPoint.output;
    const scores = yield* applyEvaluators(actual, expected, evaluators);
    
    return {
      input: dataPoint.input,
      output: dataPoint.output,
      taskResults,
      scores,
    };
  });

export const runEvaluation = <TInput, TOutput>(
  experiment: Experiment<TInput, TOutput>,
): Effect.Effect<EvaluationResult<TInput, TOutput>, DataError | TaskError | EvaluatorError> =>
  Effect.gen(function* () {
    const startTime = Date.now();
    
    // Load data
    const data = yield* Effect.tryPromise({
      try: () => experiment.data(),
      catch: (error) =>
        new DataError({
          message: 'Failed to load experiment data',
          cause: error,
        }),
    });
    
    // Process each data point
    const results = yield* pipe(
      data,
      Effect.forEach(
        (dataPoint) => processDataPoint(dataPoint, experiment.tasks, experiment.evaluators),
        { concurrency: 5 },
      ),
    );
    
    // Calculate summary statistics
    const summary = calculateSummary(results, Date.now() - startTime);
    
    return {
      experimentName: experiment.name,
      timestamp: new Date(),
      results,
      summary,
    };
  });

const calculateSummary = <TInput, TOutput>(
  results: Array<DataPointResult<TInput, TOutput>>,
  executionTime: number,
): EvaluationResult<TInput, TOutput>['summary'] => {
  const scoresByEvaluator = results.reduce<Record<string, number[]>>((acc, result) => {
    result.scores.forEach((score) => {
      if (!acc[score.evaluatorName]) {
        acc[score.evaluatorName] = [];
      }
      acc[score.evaluatorName]?.push(score.score);
    });
    return acc;
  }, {});

  const averageScores = Object.entries(scoresByEvaluator).reduce<Record<string, number>>(
    (acc, [evaluatorName, scores]) => {
      acc[evaluatorName] = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return acc;
    },
    {},
  );

  return {
    totalSamples: results.length,
    averageScores,
    executionTime,
  };
};