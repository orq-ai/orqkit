import OpenAI from "openai";

import { resolveRouterBaseUrl } from "./defaults.js";

/** The client every simulation component uses to reach the router. */
export function createRouterClient(apiKey = process.env.ORQ_API_KEY): OpenAI {
  if (!apiKey && process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  }
  if (!apiKey) {
    throw new Error(
      "ORQ_API_KEY environment variable is not set. Set it or pass apiKey or client in config.",
    );
  }
  return new OpenAI({ baseURL: resolveRouterBaseUrl(), apiKey, maxRetries: 0 });
}
