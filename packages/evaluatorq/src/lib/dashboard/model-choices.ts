import { resolveLlmClient } from "../common/llm-client.js";
import {
  getModelInfo,
  type ModelInfo,
  type ModelKind,
  modelsByProvider,
} from "../common/model-catalogue.js";
import { buildAuthClients, type DashboardAuth } from "./auth.js";

export async function catalogueClient(auth: DashboardAuth): Promise<unknown> {
  if (auth.method === "cli_oauth") {
    const [, llm] = await buildAuthClients(auth);
    return llm;
  }
  return (
    await resolveLlmClient(null, {
      extraApiKey: auth.apiKey,
      orqHost: auth.baseUrl,
      requireOrq: true,
      maxRetries: 0,
    })
  ).client;
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.constructor.name : typeof error;

export async function modelGroups(
  auth: DashboardAuth,
  kind: ModelKind,
): Promise<Record<string, string[]>> {
  try {
    return await modelsByProvider(await catalogueClient(auth), { kind });
  } catch (error) {
    console.warn(
      `Orq model catalogue unavailable for ${kind} models (${errorName(error)}): ${error instanceof Error ? error.message : error}`,
    );
    return {};
  }
}

export async function catalogueEntry(
  auth: DashboardAuth,
  model: string,
): Promise<ModelInfo | null> {
  try {
    return await getModelInfo(model, await catalogueClient(auth));
  } catch (error) {
    console.warn(
      `Orq model catalogue unavailable for ${model} (${errorName(error)}): ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}
