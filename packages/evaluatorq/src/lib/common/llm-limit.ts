import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_LLM_PARALLELISM = 10;
export const UNBOUNDED = -1;

export function checkLlmParallelism(
  value: number | undefined,
): number | undefined {
  if (
    value !== undefined &&
    value !== UNBOUNDED &&
    (!Number.isInteger(value) || value < 1)
  ) {
    throw new RangeError(
      `llmParallelism must be >= 1, or -1 for no limit, got ${value}`,
    );
  }
  return value;
}

class Budget {
  private active = 0;
  private readonly waiting: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.limit === UNBOUNDED) {
      return;
    }
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: {
        resolve: () => void;
        reject: (reason: unknown) => void;
        signal?: AbortSignal;
        abort?: () => void;
      } = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    if (this.limit === UNBOUNDED) {
      return;
    }
    const next = this.waiting.shift();
    if (next) {
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.resolve();
    } else {
      this.active -= 1;
    }
  }
}

const DEFAULT_BUDGET = new Budget(DEFAULT_LLM_PARALLELISM);
const budgets = new AsyncLocalStorage<readonly Budget[]>();

function activeBudgets(): readonly Budget[] {
  const current = budgets.getStore();
  return current && current.length > 0 ? current : [DEFAULT_BUDGET];
}

export function activeLlmParallelism(): number | undefined {
  const finite = activeBudgets()
    .map((budget) => budget.limit)
    .filter((limit) => limit !== UNBOUNDED);
  return finite.length > 0 ? Math.min(...finite) : undefined;
}

/**
 * Bound concurrent LLM requests inside `fn`. Nested limits stack, so an inner
 * limit cannot raise an outer one. `undefined` leaves the enclosing limit alone.
 */
export function llmConcurrencyLimit<T>(
  maxConcurrent: number | undefined,
  fn: () => T,
): T {
  if (checkLlmParallelism(maxConcurrent) === undefined) {
    return fn();
  }
  const stacked = [
    ...(budgets.getStore() ?? []),
    new Budget(maxConcurrent as number),
  ];
  return budgets.run(stacked, fn);
}

/**
 * Hold one slot from every active budget while `fn` runs. Wrap only the request
 * itself: holding a slot across parsing shrinks the budget without reducing
 * load on the provider.
 */
export async function llmSlot<T>(
  fn: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const held: Budget[] = [];
  try {
    for (const budget of activeBudgets()) {
      await budget.acquire(options.signal);
      held.push(budget);
      options.signal?.throwIfAborted();
    }
    return await fn();
  } finally {
    for (const budget of held.reverse()) {
      budget.release();
    }
  }
}
