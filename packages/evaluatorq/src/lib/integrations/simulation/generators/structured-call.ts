/**
 * Shared LLM call for generators that return a JSON list.
 *
 * Asks for a strict JSON schema response and raises instead of returning an
 * empty list, so a failed generation cannot pass as a run with nothing to test.
 */

import type OpenAI from "openai";
import { z } from "zod/v4";

import {
  getTraceContextHeaders,
  recordLLMInput,
  recordLLMResponse,
  withLLMSpan,
} from "../tracing.js";
import { extractJsonFromResponse } from "../utils/extract-json.js";
import { isSchemaRejection, toStrictSchema } from "../utils/strict-schema.js";

const TIMEOUT_MS = 300_000;

/** Raised when a generator cannot produce usable output. */
export class SimulationGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SimulationGenerationError";
  }
}

/** Output tokens for a list of `count` items, so a longer list is not cut off. */
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
  /** Key the schema wraps the list under, since schemas need an object root. */
  listKey: string;
  itemSchema: z.ZodObject;
  /** Used in error messages, e.g. "PersonaGenerator". */
  label: string;
}

/**
 * Request a JSON list from the LLM.
 *
 * A 400 rejecting the schema steps down from strict to the same schema without
 * strict, then to no response_format. The prompts still ask for JSON, and each
 * generator checks every item by hand, because the last step enforces nothing.
 * A truncated response is never retried: the same limit would truncate again.
 */
export async function requestJsonList(
  request: JsonListRequest,
): Promise<Record<string, unknown>[]> {
  const {
    client,
    model,
    system,
    user,
    temperature,
    maxTokens,
    purpose,
    listKey,
    itemSchema,
    label,
  } = request;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const response = await withLLMSpan(
    { model, temperature, maxTokens, purpose },
    async (llmSpan) => {
      recordLLMInput(llmSpan, [
        { role: "system", content: system },
        { role: "user", content: user },
      ]);

      const traceHeaders = await getTraceContextHeaders();
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
        {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        };

      const schema = toStrictSchema(
        z.object({ [listKey]: z.array(itemSchema) }),
      );
      const send = (
        response_format?: OpenAI.ResponseFormatJSONSchema,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion> =>
        client.chat.completions.create(
          response_format ? { ...params, response_format } : params,
          { headers: traceHeaders, timeout: TIMEOUT_MS },
        );
      const withSchema = (
        strict: boolean,
      ): OpenAI.ResponseFormatJSONSchema => ({
        type: "json_schema",
        json_schema: { name: listKey, strict, schema },
      });
      const stepDown =
        (next: string) =>
        (err: unknown): undefined => {
          if (!isSchemaRejection(err)) {
            throw err;
          }
          console.warn(
            `${label}: model rejected response_format, retrying ${next}: ${(err as Error).message}`,
          );
        };

      const res =
        (await send(withSchema(true)).catch(stepDown("without strict"))) ??
        (await send(withSchema(false)).catch(stepDown("without a schema"))) ??
        (await send());

      recordLLMResponse(llmSpan, res);
      return res;
    },
  );

  const choice = response.choices[0];
  if (choice?.finish_reason === "length") {
    throw new SimulationGenerationError(
      `${label}: response truncated at max_tokens=${maxTokens}`,
    );
  }

  const refusal = choice?.message.refusal;
  if (refusal) {
    throw new SimulationGenerationError(`${label}: model refused: ${refusal}`);
  }

  const content = choice?.message.content;
  if (!content?.trim()) {
    throw new SimulationGenerationError(`${label}: empty response from LLM`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonFromResponse(content));
  } catch (err) {
    throw new SimulationGenerationError(
      `${label}: response was not valid JSON: ${content.slice(0, 200)}`,
      { cause: err },
    );
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown> | null)?.[listKey];
  if (!Array.isArray(list)) {
    throw new SimulationGenerationError(
      `${label}: expected a JSON array or an object with '${listKey}'`,
    );
  }

  return list.filter((item, i) => {
    const isObject =
      typeof item === "object" && item !== null && !Array.isArray(item);
    if (!isObject) {
      console.warn(`${label}: dropping non-object item at index ${i}`);
    }
    return isObject;
  }) as Record<string, unknown>[];
}
