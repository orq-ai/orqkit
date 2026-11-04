const ROUTER_PATH = "/v3/router";

/**
 * The Orq host the environment points at, or undefined when it names none, so
 * each caller keeps its own production default.
 *
 * ROUTER_BASE_URL is the deprecated way to set this. It counts here because a
 * run configured with it alone would otherwise upload to production.
 */
export function configuredOrqHost(): string | undefined {
  const orqBaseUrl = process.env.ORQ_BASE_URL;
  if (orqBaseUrl) {
    const trimmed = orqBaseUrl.replace(/\/+$/, "");
    return trimmed.endsWith(ROUTER_PATH)
      ? trimmed.slice(0, -ROUTER_PATH.length)
      : trimmed;
  }

  const routerBaseUrl = process.env.ROUTER_BASE_URL;
  if (!routerBaseUrl) {
    return undefined;
  }
  const invalid = new Error(
    `ROUTER_BASE_URL is not a valid URL: "${routerBaseUrl}"`,
  );
  let url: URL;
  try {
    url = new URL(routerBaseUrl);
  } catch {
    throw invalid;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid;
  }
  const prefix = url.pathname.match(/^(.*)\/v\d+\/router\/?$/)?.[1] ?? "";
  return `${url.origin}${prefix}`;
}
