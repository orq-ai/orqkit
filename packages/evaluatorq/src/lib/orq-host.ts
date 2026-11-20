const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const warnedPlainHttp = new Set<string>();

export function parseHostUrl(name: string, value: string): URL {
  const invalid = new Error(`${name} is not a valid URL: "${value}"`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid;
  }
  if (
    url.protocol === "http:" &&
    !LOCAL_HOSTNAMES.has(url.hostname) &&
    !warnedPlainHttp.has(url.origin)
  ) {
    warnedPlainHttp.add(url.origin);
    console.warn(
      `${name} uses plain http for ${url.origin}, so ORQ_API_KEY is sent to it unencrypted.`,
    );
  }
  return url;
}

/**
 * The Orq host the environment points at, or undefined when it names none, so
 * each caller keeps its own production default.
 *
 * A versioned ROUTER_BASE_URL can also identify the platform host. Other
 * router URLs require ORQ_BASE_URL so platform data cannot reach a proxy.
 */
export function configuredOrqHost(): string | undefined {
  const orqBaseUrl = process.env.ORQ_BASE_URL;
  if (orqBaseUrl) {
    const url = parseHostUrl("ORQ_BASE_URL", orqBaseUrl);
    const prefix = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/v\d+\/router$/, "");
    return `${url.origin}${prefix}`;
  }

  const routerBaseUrl = process.env.ROUTER_BASE_URL;
  if (!routerBaseUrl) {
    return undefined;
  }
  const url = parseHostUrl("ROUTER_BASE_URL", routerBaseUrl);
  const route = url.pathname.match(/^(.*)\/v\d+\/router\/?$/);
  if (!route) {
    throw new Error(
      "ROUTER_BASE_URL does not identify an Orq platform host; set ORQ_BASE_URL explicitly for platform operations.",
    );
  }
  return `${url.origin}${route[1]}`;
}
