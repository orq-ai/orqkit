import {
  AgentResponse,
  type AgentResponseError,
  type Message,
  type Usage,
  UsageSchema,
} from "../contracts.js";
import { dropUnreplayableToolRecords, jsonWithFallback } from "./messages.js";

const ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/content[_ ]filter|content management policy/, "content_filter"],
  [/rate limit|(?<!\d)429(?!\d)/, "rate_limit"],
  [/timed out|timeout/, "timeout"],
  [/status[ _]?5\d\d/, "server_error"],
  [/status[ _]?4\d\d/, "client_error"],
  [/connection/, "network_error"],
];

const STATUS_CHAIN_DEPTH = 5;
const STATUS_TEXT_PATTERNS = [
  /\bstatus(?:_code)?\s*[=:]\s*(\d{3})\b/i,
  /\bHTTP\s*(\d{3})\b/i,
  /\bcode\s*[=:]\s*(\d{3})\b/i,
];

export function classifyErrorType(
  error: string | null | undefined,
  options: { existingType?: string | null } = {},
): string | null {
  if (options.existingType) {
    return options.existingType;
  }
  if (!error) {
    return null;
  }
  const lower = error.toLowerCase();
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(lower)) {
      return type;
    }
  }
  return "unknown";
}

export interface MappedError {
  code: string;
  message: string;
}

const className = (value: unknown): string =>
  (value as object | null | undefined)?.constructor?.name ?? "Error";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function defaultMapError(error: unknown): MappedError {
  return {
    code: "target_error",
    message: `${className(error)}: ${messageOf(error)}`,
  };
}

export async function closeTarget(target: unknown): Promise<void> {
  try {
    await (target as { close?: () => unknown } | null | undefined)?.close?.();
  } catch (error) {
    console.warn(
      `Failed to close target ${className(target)}: ${messageOf(error)}`,
    );
  }
}

const isStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599;

interface StatusCarrier {
  response?: {
    status_code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  } | null;
  rawResponse?: {
    status_code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  } | null;
  statusCode?: unknown;
  status_code?: unknown;
  status?: unknown;
  cause?: unknown;
}

/**
 * The one status extractor: retry and `mapError` must classify an error alike,
 * or a reported 4xx gets retried anyway. The real HTTP response wins over fields.
 */
export function extractStatusCode(error: unknown): number | null {
  let current = error as StatusCarrier | null | undefined;
  for (let depth = 0; depth < STATUS_CHAIN_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") {
      break;
    }
    const found = [
      current.response?.status_code,
      current.response?.status,
      current.response?.statusCode,
      current.rawResponse?.status_code,
      current.rawResponse?.status,
      current.rawResponse?.statusCode,
      current.status_code,
      current.status,
      current.statusCode,
    ].find(isStatus);
    if (found !== undefined) {
      return found;
    }
    current = current.cause as StatusCarrier | null | undefined;
  }
  const text = messageOf(error);
  for (const pattern of STATUS_TEXT_PATTERNS) {
    const code = Number(pattern.exec(text)?.[1]);
    if (isStatus(code)) {
      return code;
    }
  }
  return null;
}

function coerceToAgentResponse(raw: unknown): AgentResponse {
  if (raw instanceof AgentResponse) {
    return raw;
  }
  const text =
    raw === null || raw === undefined
      ? ""
      : typeof raw === "object"
        ? jsonWithFallback(raw)
        : String(raw);
  return new AgentResponse({ text });
}

export interface TargetErrorPayload {
  error: string | null;
  errorType: string | null;
  errorStage: string | null;
  errorCode: string | null;
  errorTurn: number | null;
  errorDetails: Record<string, unknown> | null;
}

/** `response` is always set: the target's own, or a synthetic one after a failure. */
export class TargetCallResult {
  constructor(
    readonly response: AgentResponse,
    readonly attempts: number,
    readonly error: AgentResponseError | null,
    readonly errorDetails: Record<string, unknown> | null,
  ) {}

  get succeeded(): boolean {
    return this.error === null;
  }

  /** Flat fields for reports, whose `error` column is a string. */
  errorPayload(
    options: { context?: string; turn?: number } = {},
  ): TargetErrorPayload {
    if (this.error === null) {
      return {
        error: null,
        errorType: null,
        errorStage: null,
        errorCode: null,
        errorTurn: null,
        errorDetails: null,
      };
    }
    return {
      error: `Target agent failed after ${this.attempts} attempt(s)${options.context ?? ""}: ${this.error.message}`,
      errorType: this.error.errorType,
      errorStage: "target_call",
      errorCode: this.error.code || "target_error",
      errorTurn: options.turn ?? 1,
      errorDetails: this.errorDetails,
    };
  }
}

function synthetic(
  text: string,
  errorType: string,
  code: string,
  usage: Usage | null = null,
): AgentResponse {
  return new AgentResponse({
    text,
    usage,
    error: { message: text, errorType, code },
  });
}

function errorUsage(error: unknown): Usage | null {
  const parsed = UsageSchema.safeParse(
    (error as { usage?: unknown } | null)?.usage,
  );
  return parsed.success ? parsed.data : null;
}

/** Raise a subclass from `respond()` for failures a retry would only replay. */
export class NonRetryableTargetError extends Error {}

class AttemptTimeout extends Error {
  override name = "TimeoutError";
}

const isNamed = (error: unknown, name: string): boolean =>
  (error as { name?: unknown } | null)?.name === name;

// The signal is the only way to stop a call: a target that ignores it keeps
// running after the timeout, which Python's `wait_for` would have cancelled.
async function raceTimeout<T>(
  start: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number | null,
  externalSignal?: AbortSignal,
): Promise<T> {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort(externalSignal?.reason);
      reject(
        Object.assign(new Error("Target call cancelled"), {
          name: "AbortError",
          cause: externalSignal?.reason,
        }),
      );
    };
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== null)
      timer = setTimeout(() => {
        reject(new AttemptTimeout());
        controller.abort();
      }, timeoutMs);
  });
  try {
    return await Promise.race([start(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) externalSignal?.removeEventListener("abort", onAbort);
  }
}

export interface RetryTarget {
  respond(
    messages: Message[],
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  readonly managesOwnTimeout?: boolean;
  readonly timeoutMs?: number;
}

export interface CallTargetOptions {
  targetAgentTimeoutMs: number;
  maxTargetRetries: number;
  signal?: AbortSignal;
  mapError?: (error: unknown) => MappedError | null | undefined;
  /** Wraps one attempt, for a per-attempt span. `attempt` is 0-based. */
  onAttempt?: (
    attempt: number,
    run: (context: unknown) => Promise<void>,
  ) => Promise<void>;
  onAttemptResponse?: (context: unknown, response: AgentResponse) => void;
}

/**
 * Calls `target.respond` with bounded retry and a per-call timeout. A returned
 * `.error`, a timeout or a generic error retries; `NonRetryableTargetError` and
 * 4xx other than 408/429 do not. An `AbortError` is cancellation and propagates.
 */
export async function callTargetWithRetry(
  target: RetryTarget,
  messages: readonly Message[],
  options: CallTargetOptions,
): Promise<TargetCallResult> {
  const replayed = dropUnreplayableToolRecords(messages);
  const {
    targetAgentTimeoutMs: timeoutMs,
    maxTargetRetries,
    mapError = defaultMapError,
    onAttempt,
    onAttemptResponse,
  } = options;
  const managesOwnTimeout = target.managesOwnTimeout === true;
  if (
    !managesOwnTimeout &&
    typeof target.timeoutMs === "number" &&
    target.timeoutMs >= timeoutMs
  ) {
    console.warn(
      `${className(target)}.timeoutMs (${target.timeoutMs.toFixed(0)} ms) is not below targetAgentTimeoutMs (${timeoutMs.toFixed(0)} ms); the retry helper will time out first and retry a hung call instead of surfacing the target's own non-retryable timeout`,
    );
  }
  const maxAttempts = Math.max(1, maxTargetRetries + 1);
  let lastResponse = new AgentResponse();
  let lastError: AgentResponseError | null = null;
  let lastDetails: Record<string, unknown> | null = null;
  let attempt = 0;
  for (attempt = 0; attempt < maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    let response: AgentResponse | undefined;
    const run = async (context: unknown): Promise<void> => {
      let raw: unknown;
      try {
        raw = await raceTimeout(
          (signal) => target.respond(replayed, { signal }),
          managesOwnTimeout ? null : timeoutMs,
          options.signal,
        );
      } catch (error) {
        const usage = errorUsage(error);
        if (usage) onAttemptResponse?.(context, new AgentResponse({ usage }));
        throw error;
      }
      response = coerceToAgentResponse(raw);
      onAttemptResponse?.(context, response);
    };
    try {
      if (onAttempt) {
        await onAttempt(attempt, run);
      } else {
        await run(undefined);
      }
      const answered = response as AgentResponse;
      if (answered.error === null) {
        return new TargetCallResult(answered, attempt + 1, null, null);
      }
      lastResponse = answered;
      lastError = answered.error;
      lastDetails = {
        responseErrorType: answered.error.errorType,
        rawMessage: answered.error.message,
        attempts: attempt + 1,
      };
    } catch (error) {
      const usage = errorUsage(error);
      if (isNamed(error, "AbortError")) {
        throw error;
      }
      if (
        isNamed(error, "TimeoutError") &&
        !(error instanceof NonRetryableTargetError)
      ) {
        lastResponse = managesOwnTimeout
          ? synthetic(
              "[ERROR: Target agent raised TimeoutError]",
              "timeout",
              "target.timeout",
              usage,
            )
          : synthetic(
              `[ERROR: Target agent timed out after ${(timeoutMs / 1000).toFixed(0)}s]`,
              "timeout",
              "target.timeout",
              usage,
            );
        lastError = lastResponse.error;
        lastDetails = managesOwnTimeout
          ? {
              exceptionType: className(error),
              rawMessage: messageOf(error),
              attempts: attempt + 1,
            }
          : { timeoutMs, attempts: attempt + 1 };
      } else {
        const mapped = mapError(error) ?? defaultMapError(error);
        const classified = classifyErrorType(mapped.message);
        lastResponse = synthetic(
          `[ERROR: ${mapped.message}]`,
          classified && classified !== "unknown" ? classified : "target_error",
          mapped.code,
          usage,
        );
        lastError = lastResponse.error;
        lastDetails = {
          exceptionType: className(error),
          rawMessage: messageOf(error),
          attempts: attempt + 1,
        };
        if (error instanceof NonRetryableTargetError) {
          console.warn(
            `Target call failed with non-retryable error (${className(error)}); not retrying`,
          );
          break;
        }
        const status = extractStatusCode(error);
        if (
          status !== null &&
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 429
        ) {
          console.warn(
            `Target call failed with non-retryable client error (${status}); not retrying`,
          );
          break;
        }
      }
    }
    if (attempt + 1 < maxAttempts) {
      console.warn(
        `Target call failed (attempt ${attempt + 1}/${maxAttempts}); retrying same exchange`,
      );
    }
  }
  return new TargetCallResult(
    lastResponse,
    Math.min(attempt + 1, maxAttempts),
    lastError,
    lastDetails,
  );
}
