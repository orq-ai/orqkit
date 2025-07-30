import { Effect, pipe, Schedule, Option } from 'effect';
import * as Schema from '@effect/schema/Schema';
import { DataError, TaskError, EvaluatorError } from './errors.js';

export const safeAsync = <A, E>(
  promise: () => Promise<A>,
  errorHandler: (error: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.tryPromise({
    try: promise,
    catch: errorHandler,
  });

export const withRetry = <A, E>(
  effect: Effect.Effect<A, E>,
  retries = 3,
  delay = 1000,
): Effect.Effect<A, E> =>
  pipe(
    effect,
    Effect.retry(
      pipe(
        Schedule.exponential(delay),
        Schedule.compose(Schedule.recurs(retries)),
      ),
    ),
  );

export const withTimeout = <A, E>(
  effect: Effect.Effect<A, E>,
  millis: number,
): Effect.Effect<A, E | TimeoutError> =>
  pipe(
    effect,
    Effect.timeoutOption(millis),
    Effect.flatMap((option) =>
      Option.match(option, {
        onNone: () =>
          Effect.fail(
            new TimeoutError({
              message: `Operation timed out after ${millis}ms`,
            }),
          ),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );

export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  'TimeoutError',
  {
    message: Schema.String,
  },
) {}

export const handleAllErrors = <A>(
  effect: Effect.Effect<A, DataError | TaskError | EvaluatorError>,
): Effect.Effect<A | null, never> =>
  pipe(
    effect,
    Effect.catchAll((error) => {
      console.error('Error occurred:', error);
      return Effect.succeed(null);
    }),
  );

export const validateSchema = <A, I>(
  schema: Schema.Schema<A, I>,
  value: I,
): Effect.Effect<A, Schema.ParseError> =>
  Schema.decodeUnknown(schema)(value);

export const parallel = <A, E>(
  effects: Array<Effect.Effect<A, E>>,
  concurrency = 5,
): Effect.Effect<Array<A>, E> =>
  Effect.forEach(effects, (effect) => effect, { concurrency });

export const sequential = <A, E>(
  effects: Array<Effect.Effect<A, E>>,
): Effect.Effect<Array<A>, E> =>
  Effect.forEach(effects, (effect) => effect, { concurrency: 1 });

export const tapLog = <A>(
  message: string,
): ((effect: Effect.Effect<A, any>) => Effect.Effect<A, any>) =>
  Effect.tap((value: A) =>
    Effect.sync(() => {
      console.log(message, value);
    }),
  );

export const measureDuration = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<[A, number], E> =>
  Effect.gen(function* () {
    const start = Date.now();
    const result = yield* effect;
    const duration = Date.now() - start;
    return [result, duration] as [A, number];
  });