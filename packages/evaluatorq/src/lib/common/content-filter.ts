import { getField } from "./fields.js";
import { isConnectionError } from "./retry.js";

export function classifyFinishReason(
  finishReason: string | null | undefined,
): "content_filter" | null {
  return finishReason === "content_filter" ? "content_filter" : null;
}

/** Keys on the structured code, not message prose, so it stays provider-agnostic. */
export function isContentFilterError(error: unknown): boolean {
  if (getField(error, "code") === "content_filter") {
    return true;
  }
  return (
    getField(getField(error, "error"), "code") === "content_filter" ||
    getField(getField(error, "body"), "code") === "content_filter"
  );
}

const isApiError = (error: unknown): boolean =>
  isConnectionError(error) || typeof getField(error, "status") === "number";

/**
 * Regenerates while the provider content-filters the call. When every attempt is
 * filtered, returns the final 200-form response for the caller to inspect; a
 * filter error on the last attempt, and any other error, propagates.
 */
export async function regenerateOnContentFilter<T>(
  call: (attempt: number) => Promise<T>,
  options: { maxAttempts: number; label?: string },
): Promise<T> {
  const { label = "attacker generation" } = options;
  const attempts = Math.max(1, options.maxAttempts);
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= attempts - 1;
    let response: T;
    try {
      response = await call(attempt);
    } catch (error) {
      if (isApiError(error) && isContentFilterError(error) && !last) {
        console.warn(
          `${label} content-filtered (error form); regenerating (${attempt + 1}/${attempts - 1})`,
        );
        continue;
      }
      throw error;
    }
    const choices = getField(response, "choices");
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const finishReason = getField(first, "finish_reason") as string | null;
    if (classifyFinishReason(finishReason) === null || last) {
      return response;
    }
    console.warn(
      `${label} content-filtered (finish_reason); regenerating (${attempt + 1}/${attempts - 1})`,
    );
  }
}
