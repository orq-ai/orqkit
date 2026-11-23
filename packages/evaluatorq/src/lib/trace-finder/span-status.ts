import { getField } from "../common/fields.js";
import { pythonCasefold, pythonString } from "../common/sanitize.js";

const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === "object"
      ? Object.keys(value).length > 0
      : Boolean(value));
export function spanStatusText(span: unknown): string | null {
  const status = getField(span, "status"),
    candidates: string[] = [];
  if (typeof status === "string") {
    if (status) candidates.push(status);
  } else if (status != null)
    for (const key of ["code", "status_code", "state", "name"]) {
      const detail = getField(status, key);
      if (truth(detail)) {
        candidates.push(pythonString(detail));
        break;
      }
    }
  const top = getField(span, "status_code");
  if (truth(top)) candidates.push(pythonString(top));
  return (
    candidates.find((candidate) =>
      ["error", "failed"].some((word) =>
        pythonCasefold(candidate).includes(word),
      ),
    ) ??
    candidates[0] ??
    null
  );
}
export function isErrorSpan(span: unknown): boolean {
  const status = spanStatusText(span);
  return (
    status !== null &&
    ["error", "failed"].some((word) => pythonCasefold(status).includes(word))
  );
}
