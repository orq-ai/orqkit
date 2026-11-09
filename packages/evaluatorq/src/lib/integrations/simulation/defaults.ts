/**
 * Shared defaults for the simulation integration.
 */

import { configuredOrqHost } from "../../orq-host.js";

/** Model used for the user simulator, judge and generators. */
export const DEFAULT_SIMULATION_MODEL = "openai/gpt-6-luna";

const DEFAULT_LLM_MAX_TOKENS = 10_000;

const warnedLLMMaxTokens = new Set<string>();

/**
 * Output tokens for one simulator or judge call. Reasoning models spend these
 * before they answer, so a small budget ends the call with no answer at all.
 */
export function resolveLLMMaxTokens(): number {
  const raw = process.env.EVALUATORQ_LLM_MAX_TOKENS;
  if (raw === undefined) {
    return DEFAULT_LLM_MAX_TOKENS;
  }
  const value = /^\d+$/.test(raw.trim()) ? Number(raw) : 0;
  if (Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  if (!warnedLLMMaxTokens.has(raw)) {
    warnedLLMMaxTokens.add(raw);
    console.warn(
      `EVALUATORQ_LLM_MAX_TOKENS must be a positive integer, got "${raw}"; using ${DEFAULT_LLM_MAX_TOKENS}.`,
    );
  }
  return DEFAULT_LLM_MAX_TOKENS;
}

const DEFAULT_ORQ_BASE_URL = "https://my.orq.ai";
const ROUTER_PATH = "/v3/router";

let warnedRouterBaseUrl = false;

/** The Orq host, for calls outside the router. */
export function resolveOrqHost(): string {
  return configuredOrqHost() ?? DEFAULT_ORQ_BASE_URL;
}

/**
 * Resolve the router URL.
 *
 * ORQ_BASE_URL wins. ROUTER_BASE_URL still works with a warning, because
 * ignoring it would silently move staging users onto production.
 */
export function resolveRouterBaseUrl(): string {
  if (process.env.ORQ_BASE_URL) {
    return `${configuredOrqHost()}${ROUTER_PATH}`;
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
