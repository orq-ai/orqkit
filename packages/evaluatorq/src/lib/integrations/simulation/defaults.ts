/**
 * Shared defaults for the simulation integration.
 */

/** Model used for the user simulator, judge and generators. */
export const DEFAULT_SIMULATION_MODEL = "openai/gpt-6-luna";

const DEFAULT_ORQ_BASE_URL = "https://my.orq.ai";
const ROUTER_PATH = "/v3/router";

let warnedRouterBaseUrl = false;

/**
 * Resolve the router URL.
 *
 * ORQ_BASE_URL wins. ROUTER_BASE_URL still works with a warning, because
 * ignoring it would silently move staging users onto production.
 */
export function resolveRouterBaseUrl(): string {
  const orqBaseUrl = process.env.ORQ_BASE_URL;
  if (orqBaseUrl) {
    const trimmed = orqBaseUrl.replace(/\/+$/, "");
    const host = trimmed.endsWith(ROUTER_PATH)
      ? trimmed.slice(0, -ROUTER_PATH.length)
      : trimmed;
    return `${host}${ROUTER_PATH}`;
  }

  const routerBaseUrl = process.env.ROUTER_BASE_URL;
  if (routerBaseUrl) {
    if (!warnedRouterBaseUrl) {
      warnedRouterBaseUrl = true;
      console.warn(
        "ROUTER_BASE_URL is deprecated, set ORQ_BASE_URL to the host instead.",
      );
    }
    return routerBaseUrl;
  }

  return `${DEFAULT_ORQ_BASE_URL}${ROUTER_PATH}`;
}
