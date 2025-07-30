import { describe, it, expect } from 'vitest';
import { Effect, Exit } from 'effect';
import {
  safeAsync,
  withRetry,
  withTimeout,
  TimeoutError,
  validateSchema,
  parallel,
  sequential,
  measureDuration,
} from './effect-utils.js';
import * as Schema from '@effect/schema/Schema';

describe('Effect Utils', () => {
  describe('safeAsync', () => {
    it('should handle successful promises', async () => {
      const effect = safeAsync(
        () => Promise.resolve('success'),
        (error) => new Error(String(error)),
      );

      const result = await Effect.runPromise(effect);
      expect(result).toBe('success');
    });

    it('should handle failed promises', async () => {
      const effect = safeAsync(
        () => Promise.reject('error'),
        (error) => new Error(String(error)),
      );

      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause._tag).toBe('Fail');
      }
    });
  });

  describe('withRetry', () => {
    it('should retry failed effects', async () => {
      let attempts = 0;
      const effect = Effect.gen(function* () {
        attempts++;
        if (attempts < 3) {
          yield* Effect.fail(new Error('Temporary failure'));
        }
        return 'success';
      });

      const retriedEffect = withRetry(effect, 3, 10);
      const result = await Effect.runPromise(retriedEffect);
      
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });
  });

  describe('withTimeout', () => {
    it('should complete within timeout', async () => {
      const effect = Effect.succeed('fast');
      const timedEffect = withTimeout(effect, 1000);
      
      const result = await Effect.runPromise(timedEffect);
      expect(result).toBe('fast');
    });

    it('should fail on timeout', async () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sleep(200);
        return 'slow';
      });
      
      const timedEffect = withTimeout(effect, 50);
      const exit = await Effect.runPromiseExit(timedEffect);
      
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Exit.causeOption(exit);
        expect(error._tag).toBe('Some');
      }
    });
  });

  describe('validateSchema', () => {
    const PersonSchema = Schema.Struct({
      name: Schema.String,
      age: Schema.Number,
    });

    it('should validate valid data', async () => {
      const effect = validateSchema(PersonSchema, {
        name: 'John',
        age: 30,
      });

      const result = await Effect.runPromise(effect);
      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('should fail on invalid data', async () => {
      const effect = validateSchema(PersonSchema, {
        name: 'John',
        age: 'thirty',
      });

      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  describe('parallel', () => {
    it('should execute effects in parallel', async () => {
      const start = Date.now();
      const effects = Array.from({ length: 5 }, (_, i) =>
        Effect.gen(function* () {
          yield* Effect.sleep(50);
          return i;
        }),
      );

      const results = await Effect.runPromise(parallel(effects, 5));
      const duration = Date.now() - start;

      expect(results).toEqual([0, 1, 2, 3, 4]);
      expect(duration).toBeLessThan(150); // Should be around 50ms, not 250ms
    });
  });

  describe('sequential', () => {
    it('should execute effects sequentially', async () => {
      const start = Date.now();
      const effects = Array.from({ length: 3 }, (_, i) =>
        Effect.gen(function* () {
          yield* Effect.sleep(50);
          return i;
        }),
      );

      const results = await Effect.runPromise(sequential(effects));
      const duration = Date.now() - start;

      expect(results).toEqual([0, 1, 2]);
      expect(duration).toBeGreaterThanOrEqual(150); // Should be around 150ms
    });
  });

  describe('measureDuration', () => {
    it('should measure effect duration', async () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sleep(50);
        return 'done';
      });

      const [result, duration] = await Effect.runPromise(measureDuration(effect));
      
      expect(result).toBe('done');
      expect(duration).toBeGreaterThanOrEqual(50);
      expect(duration).toBeLessThan(100);
    });
  });
});