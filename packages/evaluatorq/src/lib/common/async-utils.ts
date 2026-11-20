export type MaybeAsync<T> = T | Promise<T>;

type Hooks = Record<string, unknown>;

const isAbort = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "AbortError";

const typeName = (value: unknown): string =>
  (value as { constructor?: { name?: string } } | null)?.constructor?.name ??
  typeof value;

const firstOf = (errors: unknown[]): void => {
  if (errors.length > 0) {
    throw errors[0];
  }
};

/** Calls `methodName` on every child, re-raising the first error after all ran. */
export async function fanOut(
  children: Iterable<unknown>,
  methodName: string,
  ...args: unknown[]
): Promise<void> {
  const errors: unknown[] = [];
  for (const child of children) {
    try {
      const method = (child as Hooks)[methodName] as (
        ...params: unknown[]
      ) => unknown;
      await method.apply(child, args);
    } catch (error) {
      if (isAbort(error)) {
        throw error;
      }
      if (errors.length > 0) {
        console.warn(
          `fanOut(${methodName}): child ${typeName(child)} raised after an earlier exception; suppressed (the first exception is re-raised).`,
          error,
        );
      }
      errors.push(error);
    }
  }
  firstOf(errors);
}

/** Runs `onConfirm` on every child; the run proceeds only if every child approves. */
export async function combineConfirm(
  children: Iterable<unknown>,
  ...args: unknown[]
): Promise<boolean> {
  const verdicts: boolean[] = [];
  const errors: unknown[] = [];
  for (const child of children) {
    try {
      const method = (child as Hooks).onConfirm as (
        ...params: unknown[]
      ) => unknown;
      verdicts.push(Boolean(await method.apply(child, args)));
    } catch (error) {
      if (isAbort(error)) {
        throw error;
      }
      if (errors.length > 0) {
        console.warn(
          `combineConfirm: child ${typeName(child)} raised after an earlier exception; suppressed (the first exception is re-raised).`,
          error,
        );
      }
      errors.push(error);
    }
  }
  firstOf(errors);
  return verdicts.every(Boolean);
}

export function normalizeToList(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value];
}

export function warnIfSyncHooks(
  hooks: unknown,
  methodNames: readonly string[],
): void {
  const sync = methodNames.filter((name) => {
    const method = (hooks as Hooks)[name];
    return typeof method === "function" && typeName(method) !== "AsyncFunction";
  });
  if (sync.length > 0) {
    console.warn(
      `${typeName(hooks)} implements sync hook(s) ${JSON.stringify(sync)}; sync hooks are supported but deprecated; define them as async functions.`,
    );
  }
}
