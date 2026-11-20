import { getField } from "../../common/fields.js";
import { pythonStrip } from "../../common/sanitize.js";
import {
  extractStatusCode,
  type MappedError,
} from "../../common/target-call.js";
export function extractProviderErrorCode(error: unknown): string | null {
  for (const key of ["code", "error_code", "type"]) {
    const value = getField(error, key);
    if (typeof value === "string" && pythonStrip(value))
      return pythonStrip(value).toLowerCase();
  }
  const body = getField(error, "body");
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const inner = getField(body, "error");
    const data =
      inner !== null && typeof inner === "object" && !Array.isArray(inner)
        ? inner
        : body;
    for (const key of ["code", "type", "error_code"]) {
      const value = getField(data, key);
      if (typeof value === "string" && pythonStrip(value))
        return pythonStrip(value).toLowerCase();
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  for (const pattern of [
    /\b(?:error_)?code\s*[=:]\s*["']?([a-z0-9_.-]+)["']?/i,
    /\btype\s*[=:]\s*["']?([a-z0-9_.-]+)["']?/i,
  ]) {
    const match = pattern.exec(text);
    if (match?.[1]) return pythonStrip(match[1]).toLowerCase();
  }
  return null;
}
export function mapProviderError(
  provider: "openai" | "orq" | "openresponses",
  error: unknown,
): MappedError {
  const ctorName = (error as { constructor?: { name?: unknown } } | null)
    ?.constructor?.name;
  const name =
    typeof ctorName === "string" &&
    ctorName !== "Error" &&
    ctorName !== "Object"
      ? ctorName
      : typeof getField(error, "name") === "string"
        ? String(getField(error, "name"))
        : typeof ctorName === "string"
          ? ctorName
          : "Error";
  const message = `${name}: ${error instanceof Error ? error.message : typeof getField(error, "message") === "string" ? getField(error, "message") : String(error)}`;
  const status = extractStatusCode(error);
  if (status !== null) return { code: `${provider}.http.${status}`, message };
  const symbolic = extractProviderErrorCode(error);
  if (symbolic) return { code: `${provider}.code.${symbolic}`, message };
  const lower = name.toLowerCase();
  if (provider === "orq") {
    const text = message.toLowerCase();
    const suffix =
      lower.includes("timeout") || text.includes("timed out")
        ? "timeout"
        : lower.includes("auth") ||
            text.includes("unauthorized") ||
            text.includes("forbidden")
          ? "auth"
          : lower.includes("ratelimit") || text.includes("429")
            ? "rate_limit"
            : "unknown";
    return { code: `orq.${suffix}`, message };
  }
  const suffix = lower.includes("ratelimit")
    ? "rate_limit"
    : lower.includes("authentication")
      ? "auth"
      : lower.includes("timeout")
        ? "timeout"
        : "unknown";
  return { code: `${provider}.${suffix}`, message };
}
