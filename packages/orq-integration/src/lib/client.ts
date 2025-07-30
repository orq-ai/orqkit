import { Effect, pipe, Schedule, Config } from 'effect';
import { withRetry, safeAsync } from '@evaluatorq/shared';
import type { RemoteApiError } from '@evaluatorq/shared';
import { createClient } from '@orq-ai/node';

// Types for orq.ai client
export interface OrqClient {
  readonly experiments: {
    readonly create: (data: ExperimentData) => Promise<ExperimentResponse>;
    readonly list: (params?: ListParams) => Promise<ExperimentResponse[]>;
    readonly get: (id: string) => Promise<ExperimentResponse>;
  };
}

export interface ExperimentData {
  name: string;
  description?: string;
  data: Record<string, any>[];
  metadata?: Record<string, any>;
}

export interface ExperimentResponse {
  id: string;
  name: string;
  createdAt: string;
  url: string;
}

export interface ListParams {
  limit?: number;
  offset?: number;
}

// Service definition
export class OrqApiService {
  private constructor(private readonly client: OrqClient) {}

  static make = (apiKey: string, baseUrl?: string) =>
    Effect.gen(function* () {
      const client = createClient({
        apiKey,
        ...(baseUrl && { baseURL: baseUrl }),
      });
      
      return new OrqApiService(client as unknown as OrqClient);
    });

  submitExperiment = (data: ExperimentData) =>
    pipe(
      safeAsync(
        () => this.client.experiments.create(data),
        (error) => ({
          _tag: 'RemoteApiError' as const,
          message: `Failed to submit experiment: ${String(error)}`,
          cause: error,
        }),
      ),
      withRetry(3, 1000),
    );

  listExperiments = (params?: ListParams) =>
    pipe(
      safeAsync(
        () => this.client.experiments.list(params),
        (error) => ({
          _tag: 'RemoteApiError' as const,
          message: `Failed to list experiments: ${String(error)}`,
          cause: error,
        }),
      ),
      withRetry(3, 1000),
    );

  getExperiment = (id: string) =>
    pipe(
      safeAsync(
        () => this.client.experiments.get(id),
        (error) => ({
          _tag: 'RemoteApiError' as const,
          message: `Failed to get experiment: ${String(error)}`,
          cause: error,
        }),
      ),
      withRetry(3, 1000),
    );
}

// Layer for dependency injection
export const OrqApiServiceLive = (apiKey: string, baseUrl?: string) =>
  Effect.map(
    OrqApiService.make(apiKey, baseUrl),
    (service) => ({
      submitExperiment: service.submitExperiment,
      listExperiments: service.listExperiments,
      getExperiment: service.getExperiment,
    }),
  );

// Config layer that reads from environment
export const OrqApiServiceConfig = pipe(
  Effect.all({
    apiKey: Config.string('ORQ_API_KEY'),
    baseUrl: Config.string('ORQ_API_URL').pipe(
      Config.optional,
    ),
  }),
  Effect.flatMap(({ apiKey, baseUrl }) =>
    OrqApiServiceLive(apiKey, baseUrl),
  ),
);