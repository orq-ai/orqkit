export const MAX_RETRY_ATTEMPTS = 5;
export const RETRY_MIN_WAIT_MS = 2_000;
export const RETRY_MAX_WAIT_MS = 60_000;
export const RETRY_JITTER_FRACTION = 0.25;

const CONNECTION_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
}

interface RetryableClient<T> {
  maxRetries?: unknown;
  withOptions?: (options: { maxRetries: number }) => T;
}

/**
 * A client clone with SDK retries off, for call paths that use `withRetry`.
 * The two budgets multiply, so 5 attempts over a client retrying twice is 15
 * requests. The injected client is never mutated.
 */
export function withoutClientRetries<T>(client: T): T {
  const candidate = client as RetryableClient<T>;
  if (typeof candidate.maxRetries !== "number" || candidate.maxRetries <= 0)
    return client;
  if (typeof candidate.withOptions === "function")
    return candidate.withOptions({ maxRetries: 0 });
  const sdk = client as unknown as {
    _options?: Record<string, unknown>;
    constructor: {
      name: string;
      new (clientOptions: Record<string, unknown>): T;
    };
    apiVersion?: string;
    deploymentName?: string;
    _azureADTokenProvider?: unknown;
  };
  if (
    !sdk._options ||
    !["OpenAI", "AzureOpenAI"].includes(sdk.constructor.name)
  )
    return client;
  // SDK v4 lacks withOptions; its constructor options preserve transport hooks.
  const options = { ...sdk._options, maxRetries: 0 };
  if (sdk.constructor.name === "AzureOpenAI") {
    Object.assign(options, {
      apiVersion: sdk.apiVersion,
      deployment: sdk.deploymentName,
    });
    if (typeof sdk._azureADTokenProvider === "function")
      Object.assign(options, {
        apiKey: null,
        azureADTokenProvider: sdk._azureADTokenProvider,
      });
  }
  return new sdk.constructor(options);
}

// The SDK's error classes never set `.name`, so a real one reads as "Error"
// there and only its constructor tells the classes apart.
function errorClassNames(error: unknown): unknown[] {
  const candidate = error as {
    name?: unknown;
    constructor?: { name?: unknown };
  };
  return [candidate?.name, candidate?.constructor?.name];
}

export function isConnectionError(error: unknown): boolean {
  return errorClassNames(error).some(
    (name) => typeof name === "string" && CONNECTION_ERROR_NAMES.has(name),
  );
}

export function isConnectionTimeoutError(error: unknown): boolean {
  return errorClassNames(error).includes("APIConnectionTimeoutError");
}

function isRetryableStatus(
  status: number,
  retryStatuses: ReadonlySet<number> | undefined,
): boolean {
  return retryStatuses?.has(status) || status === 429 || status >= 500;
}

function isNetworkError(error: ErrorLike): boolean {
  return typeof error.code === "string" && NETWORK_ERROR_CODES.has(error.code);
}

export function isRetryableError(
  error: unknown,
  retryStatuses?: ReadonlySet<number>,
): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as ErrorLike;
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
    return false;
  }
  if (typeof candidate.status === "number") {
    return isRetryableStatus(candidate.status, retryStatuses);
  }
  if (isConnectionError(candidate) || isNetworkError(candidate)) {
    return true;
  }
  return (
    typeof candidate.cause === "object" &&
    candidate.cause !== null &&
    isNetworkError(candidate.cause as ErrorLike)
  );
}

export interface RetryOptions {
  maxAttempts?: number;
  minWaitMs?: number;
  maxWaitMs?: number;
  jitterFraction?: number;
  retryStatuses?: Iterable<number>;
  label?: string;
  signal?: AbortSignal;
}

/**
 * Run `fn` with exponential backoff on 429, 5xx and transport failures. A call
 * path uses this or the SDK's own `maxRetries`, never both.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = MAX_RETRY_ATTEMPTS,
    minWaitMs = RETRY_MIN_WAIT_MS,
    maxWaitMs = RETRY_MAX_WAIT_MS,
    jitterFraction = RETRY_JITTER_FRACTION,
    retryStatuses,
    label = "API call",
  } = options;
  if (maxAttempts < 1) {
    throw new RangeError(
      `withRetry: maxAttempts must be >= 1, got ${maxAttempts}`,
    );
  }
  if (minWaitMs < 0 || maxWaitMs < 0) {
    throw new RangeError(
      `withRetry: waits must be >= 0, got min=${minWaitMs}, max=${maxWaitMs}`,
    );
  }
  if (jitterFraction < 0) {
    throw new RangeError(
      `withRetry: jitterFraction must be >= 0, got ${jitterFraction}`,
    );
  }
  const statuses = retryStatuses ? new Set(retryStatuses) : undefined;

  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt >= maxAttempts ||
        !isRetryableError(error, statuses)
      ) {
        throw error;
      }
      const wait = Math.min(minWaitMs * 2 ** (attempt - 1), maxWaitMs);
      const delay = wait + Math.random() * wait * jitterFraction;
      console.warn(
        `${label}: attempt ${attempt}/${maxAttempts} failed (${(error as Error).name}), retrying in ${(delay / 1000).toFixed(1)}s`,
      );
      await new Promise<void>((resolve, reject) => {
        const signal = options.signal;
        signal?.throwIfAborted();
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            signal?.reason ??
              Object.assign(new Error("Cancelled"), { name: "AbortError" }),
          );
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
