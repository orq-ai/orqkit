import * as Schema from '@effect/schema/Schema';
import { Effect, Config } from 'effect';

export const OrqConfigSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  apiUrl: Schema.optional(
    Schema.String.pipe(
      Schema.pattern(/^https?:\/\/.+/),
    ),
  ),
  timeout: Schema.optional(
    Schema.Number.pipe(
      Schema.positive(),
      Schema.int(),
    ),
  ),
  maxRetries: Schema.optional(
    Schema.Number.pipe(
      Schema.positive(),
      Schema.int(),
      Schema.lessThanOrEqualTo(10),
    ),
  ),
});

export type OrqConfig = Schema.Schema.Type<typeof OrqConfigSchema>;

export const OutputConfigSchema = Schema.Struct({
  format: Schema.optional(
    Schema.Literal('json', 'table', 'csv'),
  ),
  outputDir: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  pretty: Schema.optional(Schema.Boolean),
  includeTimestamp: Schema.optional(Schema.Boolean),
});

export type OutputConfig = Schema.Schema.Type<typeof OutputConfigSchema>;

export const EvaluatorqConfigSchema = Schema.Struct({
  orq: Schema.optional(OrqConfigSchema),
  output: Schema.optional(OutputConfigSchema),
  concurrency: Schema.optional(
    Schema.Number.pipe(
      Schema.positive(),
      Schema.int(),
      Schema.lessThanOrEqualTo(50),
    ),
  ),
});

export type EvaluatorqConfig = Schema.Schema.Type<typeof EvaluatorqConfigSchema>;

export const loadConfig = Effect.gen(function* () {
  const orqApiKey = yield* Config.string('ORQ_API_KEY').pipe(
    Config.optional,
  );
  
  const orqApiUrl = yield* Config.string('ORQ_API_URL').pipe(
    Config.withDefault('https://api.orq.ai'),
  );
  
  const outputDir = yield* Config.string('EVALUATORQ_OUTPUT_DIR').pipe(
    Config.withDefault('./evaluations'),
  );
  
  const concurrency = yield* Config.number('EVALUATORQ_CONCURRENCY').pipe(
    Config.withDefault(5),
  );
  
  return {
    orq: {
      apiKey: orqApiKey,
      apiUrl: orqApiUrl,
      timeout: 30000,
      maxRetries: 3,
    },
    output: {
      format: 'json' as const,
      outputDir,
      pretty: true,
      includeTimestamp: true,
    },
    concurrency,
  } satisfies EvaluatorqConfig;
});