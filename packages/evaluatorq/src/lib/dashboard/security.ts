import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_FIELD = "csrf";
const TOKEN = randomBytes(32).toString("base64url");
export function csrfToken(): string {
  return TOKEN;
}
export function csrfField(): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${TOKEN}">`;
}
export function requestRejected(
  request: Pick<Request, "headers">,
  form?: Pick<FormData, "get">,
): string | null {
  const site = request.headers.get("sec-fetch-site") || "";
  if (site && site !== "same-origin" && site !== "none")
    return "Cross-origin request rejected.";
  const supplied = Buffer.from(
      String(
        (form ? form.get(CSRF_FIELD) : request.headers.get("x-csrf-token")) ||
          "",
      ),
    ),
    expected = Buffer.from(TOKEN);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return "Stale or missing form token; reload the page and try again.";
  return null;
}
