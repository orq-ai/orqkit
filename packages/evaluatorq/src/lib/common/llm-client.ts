import type OpenAI from "openai";

import { resolveRouterBaseUrl } from "../integrations/simulation/defaults.js";
import { configuredOrqHost } from "../orq-host.js";
import { DEFAULT_ORQ_BASE_URL, envRaw } from "./env-config.js";

export const ORQ_DEFAULT_HOST = DEFAULT_ORQ_BASE_URL;
export const ORQ_ROUTER_SUFFIX = "/v3/router";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

function stripSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function orqBaseUrl(): string {
  return configuredOrqHost() ?? DEFAULT_ORQ_BASE_URL;
}

export class MissingLLMCredentialsError extends Error {
  override name = "MissingLLMCredentialsError";
}

export interface ResolvedClient {
  client: OpenAI;
  owned: boolean;
  routesThroughOrq: boolean;
}

export function clientRoutesThroughOrq(
  client: { baseURL?: unknown } | null | undefined,
): boolean {
  const baseUrl = client?.baseURL;
  return (
    baseUrl !== null &&
    baseUrl !== undefined &&
    stripSlashes(String(baseUrl)).endsWith(ORQ_ROUTER_SUFFIX)
  );
}

export function resolveResultsBaseUrl(
  client?: { baseURL?: unknown } | null,
  options: { defaultOrqHost?: string } = {},
): string {
  if (client && clientRoutesThroughOrq(client)) {
    const host = stripSlashes(String(client.baseURL));
    return stripSlashes(host.slice(0, -ORQ_ROUTER_SUFFIX.length));
  }
  return stripSlashes(
    configuredOrqHost() ?? options.defaultOrqHost ?? DEFAULT_ORQ_BASE_URL,
  );
}

export interface ResolveLlmClientOptions {
  extraApiKey?: string | null;
  orqHost?: string | null;
  defaultOrqHost?: string;
  honorOpenaiBaseUrl?: boolean;
  requireOrq?: boolean;
  maxRetries?: number;
}

export async function resolveLlmClient(
  configClient?: OpenAI | null,
  options: ResolveLlmClientOptions = {},
): Promise<ResolvedClient> {
  if (configClient) {
    return {
      client: configClient,
      owned: false,
      routesThroughOrq: clientRoutesThroughOrq(configClient),
    };
  }
  const {
    extraApiKey,
    orqHost,
    defaultOrqHost = DEFAULT_ORQ_BASE_URL,
    honorOpenaiBaseUrl = true,
    requireOrq = false,
    maxRetries,
  } = options;

  const orqApiKey = extraApiKey || envRaw("ORQ_API_KEY");
  const openaiApiKey = requireOrq ? undefined : envRaw("OPENAI_API_KEY");
  if (!orqApiKey && requireOrq) {
    throw new MissingLLMCredentialsError(
      "ORQ routing is required for this target but no Orq credentials were found. Set ORQ_API_KEY (optionally ORQ_BASE_URL), or pass a pre-built Orq-routed client. The OPENAI_API_KEY fallback is disabled here: ORQ agent targets must run on the Orq router.",
    );
  }
  if (!orqApiKey && !openaiApiKey) {
    throw new MissingLLMCredentialsError(
      "Missing LLM credentials. Set either ORQ_API_KEY (optionally ORQ_BASE_URL) or OPENAI_API_KEY (optionally OPENAI_BASE_URL), or pass a pre-built client.",
    );
  }

  // Dynamic because `openai` is an optional peer and this ships from the root entry.
  const { default: OpenAIClient } = await import("openai");
  const retries = maxRetries === undefined ? {} : { maxRetries };

  if (orqApiKey) {
    const baseURL = orqHost
      ? `${stripSlashes(orqHost)}${ORQ_ROUTER_SUFFIX}`
      : process.env.ORQ_BASE_URL || process.env.ROUTER_BASE_URL
        ? resolveRouterBaseUrl()
        : `${stripSlashes(defaultOrqHost)}${ORQ_ROUTER_SUFFIX}`;
    return {
      client: new OpenAIClient({
        apiKey: orqApiKey,
        baseURL,
        ...retries,
      }),
      owned: true,
      routesThroughOrq: true,
    };
  }

  // The SDK reads OPENAI_BASE_URL itself when baseURL is omitted, so opting out
  // has to name its default host.
  const baseURL = honorOpenaiBaseUrl
    ? envRaw("OPENAI_BASE_URL")
    : OPENAI_DEFAULT_BASE_URL;
  const client = new OpenAIClient({
    apiKey: openaiApiKey,
    ...(baseURL ? { baseURL } : {}),
    ...retries,
  });
  return {
    client,
    owned: true,
    routesThroughOrq: clientRoutesThroughOrq(client),
  };
}
