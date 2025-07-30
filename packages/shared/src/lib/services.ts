import { Context, Effect, Layer } from 'effect';
import * as Schema from '@effect/schema/Schema';
import type { EvaluatorqConfig } from './config.js';
import type { EvaluationResult } from './types.js';

// Configuration Service
export class ConfigService extends Context.Tag('ConfigService')<
  ConfigService,
  {
    readonly config: EvaluatorqConfig;
    readonly getOrqApiKey: Effect.Effect<string | undefined>;
    readonly getOutputDir: Effect.Effect<string>;
  }
>() {}

export const ConfigServiceLive = (config: EvaluatorqConfig) =>
  Layer.succeed(
    ConfigService,
    ConfigService.of({
      config,
      getOrqApiKey: Effect.succeed(config.orq?.apiKey),
      getOutputDir: Effect.succeed(config.output?.outputDir ?? './evaluations'),
    }),
  );

// Storage Service
export class StorageService extends Context.Tag('StorageService')<
  StorageService,
  {
    readonly save: <T>(
      filename: string,
      data: T,
    ) => Effect.Effect<void, StorageError>;
    readonly load: <T>(
      filename: string,
      schema: Schema.Schema<T>,
    ) => Effect.Effect<T, StorageError>;
    readonly exists: (filename: string) => Effect.Effect<boolean>;
  }
>() {}

export class StorageError extends Schema.TaggedError<StorageError>()(
  'StorageError',
  {
    filename: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// Remote API Service
export class RemoteApiService extends Context.Tag('RemoteApiService')<
  RemoteApiService,
  {
    readonly submitResults: <TInput, TOutput>(
      results: EvaluationResult<TInput, TOutput>,
    ) => Effect.Effect<SubmissionResponse, RemoteApiError>;
    readonly getExperimentHistory: (
      experimentName: string,
    ) => Effect.Effect<ExperimentHistory[], RemoteApiError>;
  }
>() {}

export class RemoteApiError extends Schema.TaggedError<RemoteApiError>()(
  'RemoteApiError',
  {
    message: Schema.String,
    statusCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const SubmissionResponseSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  timestamp: Schema.Date,
});

export type SubmissionResponse = Schema.Schema.Type<typeof SubmissionResponseSchema>;

export const ExperimentHistorySchema = Schema.Struct({
  id: Schema.String,
  experimentName: Schema.String,
  timestamp: Schema.Date,
  summary: Schema.Struct({
    totalSamples: Schema.Number,
    averageScores: Schema.Record({ key: Schema.String, value: Schema.Number }),
    executionTime: Schema.Number,
  }),
});

export type ExperimentHistory = Schema.Schema.Type<typeof ExperimentHistorySchema>;

// Logger Service
export class LoggerService extends Context.Tag('LoggerService')<
  LoggerService,
  {
    readonly info: (message: string, data?: unknown) => Effect.Effect<void>;
    readonly error: (message: string, error?: unknown) => Effect.Effect<void>;
    readonly debug: (message: string, data?: unknown) => Effect.Effect<void>;
  }
>() {}

export const LoggerServiceLive = Layer.succeed(
  LoggerService,
  LoggerService.of({
    info: (message, data) =>
      Effect.sync(() => {
        console.log(`[INFO] ${message}`, data ?? '');
      }),
    error: (message, error) =>
      Effect.sync(() => {
        console.error(`[ERROR] ${message}`, error ?? '');
      }),
    debug: (message, data) =>
      Effect.sync(() => {
        if (process.env.DEBUG) {
          console.debug(`[DEBUG] ${message}`, data ?? '');
        }
      }),
  }),
);

// Metrics Service
export class MetricsService extends Context.Tag('MetricsService')<
  MetricsService,
  {
    readonly recordEvaluation: (
      experimentName: string,
      duration: number,
      samplesCount: number,
    ) => Effect.Effect<void>;
    readonly recordEvaluatorExecution: (
      evaluatorName: string,
      duration: number,
    ) => Effect.Effect<void>;
  }
>() {}

export const MetricsServiceLive = Layer.succeed(
  MetricsService,
  MetricsService.of({
    recordEvaluation: (experimentName, duration, samplesCount) =>
      Effect.sync(() => {
        // In a real implementation, this would send metrics to a monitoring service
        console.log(`[METRICS] Evaluation ${experimentName}: ${duration}ms, ${samplesCount} samples`);
      }),
    recordEvaluatorExecution: (evaluatorName, duration) =>
      Effect.sync(() => {
        console.log(`[METRICS] Evaluator ${evaluatorName}: ${duration}ms`);
      }),
  }),
);