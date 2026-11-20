import type OpenAI from "openai";

import {
  MissingLLMCredentialsError,
  resolveLlmClient,
} from "../../common/llm-client.js";
import type { LLMCallConfig } from "../../contracts.js";
import { BackendError, CredentialError } from "../exceptions.js";
export async function createAsyncLlmClient(
  config?: LLMCallConfig | null,
  options: { maxRetries?: number } = {},
): Promise<OpenAI> {
  try {
    return (
      await resolveLlmClient(config?.client as OpenAI | undefined, {
        maxRetries: options.maxRetries,
      })
    ).client;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MissingLLMCredentialsError)
      throw new CredentialError(message, { cause: error });
    throw new BackendError(message, { cause: error });
  }
}
