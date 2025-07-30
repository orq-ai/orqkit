import { Effect, pipe, Option } from 'effect';
import type { 
  OutputHandler, 
  EvaluationResult,
  ConfigService,
  LoggerService,
} from '@evaluatorq/shared';
import { OrqApiService } from './client.js';
import { transformToOrqFormat } from './transformer.js';

export class OrqOutputHandler implements OutputHandler {
  constructor(
    private readonly apiService: OrqApiService,
    private readonly logger: LoggerService,
  ) {}

  handle<TInput, TOutput>(
    result: EvaluationResult<TInput, TOutput>,
  ): Effect.Effect<void, Error> {
    return pipe(
      this.logger.info('Uploading results to orq.ai...'),
      Effect.flatMap(() => transformToOrqFormat(result)),
      Effect.flatMap((data) => this.apiService.submitExperiment(data)),
      Effect.tap((response) =>
        pipe(
          this.logger.info(`✓ Results uploaded to orq.ai`),
          Effect.flatMap(() =>
            this.logger.info(`  View at: ${response.url}`),
          ),
        ),
      ),
      Effect.catchAll((error) =>
        pipe(
          this.logger.error('Failed to upload to orq.ai', error),
          Effect.flatMap(() =>
            Effect.fail(new Error(`orq.ai upload failed: ${String(error)}`)),
          ),
        ),
      ),
      Effect.asVoid,
    );
  }
}

// Factory function that checks for API key
export const createOrqOutputHandler = Effect.gen(function* () {
  const config = yield* ConfigService;
  const logger = yield* LoggerService;
  
  const apiKey = yield* config.getOrqApiKey;
  
  if (!apiKey) {
    yield* logger.info('ORQ_API_KEY not found, skipping orq.ai integration');
    return Option.none();
  }
  
  const apiService = yield* OrqApiService.make(
    apiKey,
    config.config.orq?.apiUrl,
  );
  
  return Option.some(new OrqOutputHandler(apiService, logger));
});

// Composite handler that falls back to local output
export const createCompositeOutputHandler = (
  handlers: OutputHandler[],
): OutputHandler => ({
  handle: <TInput, TOutput>(result: EvaluationResult<TInput, TOutput>) =>
    pipe(
      handlers,
      Effect.forEach(
        (handler) => handler.handle(result),
        { concurrency: 'sequential', discard: true },
      ),
    ),
});