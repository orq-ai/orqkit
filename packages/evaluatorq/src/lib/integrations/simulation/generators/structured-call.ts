import type OpenAI from "openai";
import { z } from "zod/v4";

import {
  generateStructured,
  StructuredGenerationError,
  usageFromException,
} from "../../../common/structured-output.js";
import type { LLMCallConfig, Usage } from "../../../contracts.js";
import { extractJsonFromResponse } from "../utils/extract-json.js";

export class SimulationGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SimulationGenerationError";
  }
}

export function tokenBudgetForItems(
  count: number,
  perItem: number,
  minimum: number,
): number {
  return Math.max(minimum, perItem * count);
}

export interface JsonListRequest {
  client: OpenAI;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  listKey: string;
  itemSchema: z.ZodObject;
  label: string;
  llmConfig?: LLMCallConfig;
  onUsage?: (usage: Usage | null) => void;
}

export async function requestJsonList(
  request: JsonListRequest,
): Promise<Record<string, unknown>[]> {
  const {
    client,
    model,
    system,
    user,
    maxTokens,
    listKey,
    itemSchema,
    label,
    llmConfig,
    onUsage,
  } = request;
  let raw: string;
  let parsed: unknown;
  try {
    const result = await generateStructured(client, {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      responseFormat: {
        name: listKey,
        schema: z.object({ [listKey]: z.array(itemSchema) }),
      },
      maxTokens,
      label: request.purpose,
      api: "responses",
      timeoutMs: llmConfig?.resolveTimeoutMs(300_000) ?? 300_000,
      config: llmConfig,
    });
    onUsage?.(result.usage);
    raw = result.raw;
    parsed = result.parsed;
  } catch (error) {
    onUsage?.(usageFromException(error));
    if (error instanceof StructuredGenerationError)
      throw Object.assign(
        new SimulationGenerationError(error.message, { cause: error }),
        { usage: error.usage },
      );
    throw error;
  }
  if (parsed === null) {
    try {
      parsed = JSON.parse(extractJsonFromResponse(raw));
    } catch (error) {
      throw new SimulationGenerationError(
        `${label}: response was not valid JSON: ${raw.slice(0, 200)}`,
        { cause: error },
      );
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown> | null)?.[listKey];
  if (!Array.isArray(list))
    throw new SimulationGenerationError(
      `${label}: expected a JSON array or an object with '${listKey}'`,
    );
  return list.filter((item, index) => {
    const valid =
      typeof item === "object" && item !== null && !Array.isArray(item);
    if (!valid)
      console.warn(`${label}: dropping non-object item at index ${index}`);
    return valid;
  }) as Record<string, unknown>[];
}
