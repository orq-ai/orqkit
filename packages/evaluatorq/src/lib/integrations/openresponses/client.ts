import type OpenAI from "openai";

import { resolveLlmClient } from "../../common/llm-client.js";
import { withoutClientRetries } from "../../common/retry.js";

export async function buildSimulationClient(
  configClient?: OpenAI | null,
  options: {
    extraApiKey?: string | null;
    requireOrq?: boolean;
    maxRetries?: number | null;
  } = {},
): Promise<{ client: OpenAI; owned: boolean }> {
  const maxRetries = options.maxRetries === undefined ? 0 : options.maxRetries;
  const resolved = await resolveLlmClient(configClient, {
    extraApiKey: options.extraApiKey,
    requireOrq: options.requireOrq,
    honorOpenaiBaseUrl: false,
    ...(maxRetries === null ? {} : { maxRetries }),
  });
  return {
    client:
      maxRetries === 0
        ? withoutClientRetries(resolved.client)
        : resolved.client,
    owned: resolved.owned,
  };
}
