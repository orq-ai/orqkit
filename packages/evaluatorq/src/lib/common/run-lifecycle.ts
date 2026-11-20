import { AsyncLocalStorage } from "node:async_hooks";

import type { DataPointResult, EvaluatorParams } from "../types.js";
import { llmConcurrencyLimit } from "./llm-limit.js";

interface RunWork {
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
}
const runWork = new AsyncLocalStorage<RunWork>();
export function runAbortSignal(): AbortSignal | undefined {
  return runWork.getStore()?.signal;
}
export function checkRunActive(): void {
  runAbortSignal()?.throwIfAborted();
}
export function trackRunWork<T>(fn: () => Promise<T>): Promise<T> {
  const scope = runWork.getStore();
  if (!scope) return fn();
  const task = Promise.resolve().then(() => {
    scope.signal.throwIfAborted();
    return fn();
  });
  scope.pending.add(task);
  void task.then(
    () => scope.pending.delete(task),
    () => scope.pending.delete(task),
  );
  return task;
}
export async function withRunLifecycle<T>(
  limit: number | undefined,
  fn: () => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController(),
    parent = runAbortSignal(),
    signals = [
      controller.signal,
      ...(parent ? [parent] : []),
      ...(externalSignal ? [externalSignal] : []),
    ],
    scope: RunWork = {
      signal:
        signals.length === 1 ? controller.signal : AbortSignal.any(signals),
      pending: new Set(),
    };
  return runWork.run(scope, () =>
    llmConcurrencyLimit(limit, async () => {
      try {
        scope.signal.throwIfAborted();
        return await fn();
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      }
    }),
  );
}
export async function notifyDatapointComplete(
  callback: EvaluatorParams["onDatapointComplete"],
  results: readonly DataPointResult[],
): Promise<void> {
  if (callback)
    for (const result of results) {
      checkRunActive();
      await callback(result);
    }
}
