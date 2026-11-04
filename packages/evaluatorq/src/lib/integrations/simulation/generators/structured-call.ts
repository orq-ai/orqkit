/**
 * Shared LLM call for generators that return a JSON list.
 *
 * Asks for a JSON schema response and raises instead of returning an empty
 * list, so a failed generation cannot pass as a run with nothing to test.
 */

import OpenAI from "openai";

import {
  getTraceContextHeaders,
  recordLLMInput,
  recordLLMResponse,
  withLLMSpan,
} from "../tracing.js";
import { extractJsonFromResponse } from "../utils/extract-json.js";

/** Raised when a generator cannot produce usable output. */
export class SimulationGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SimulationGenerationError";
  }
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
  itemSchema: Record<string, unknown>;
  /** Used in error messages, e.g. "PersonaGenerator". */
  label: string;
}

/**
 * Request a JSON list from the LLM.
 *
 * A 400 retries once without response_format, for models that reject it. The
 * prompts still ask for JSON, so the plain response is parsed the same way.
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

      let res: OpenAI.Chat.Completions.ChatCompletion;
      try {
        res = await client.chat.completions.create(
          {
            ...params,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: listKey,
                strict: false,
                schema: {
                  type: "object",
                  properties: {
                    [listKey]: { type: "array", items: itemSchema },
                  },
                  required: [listKey],
                },
              },
            },
          },
          { headers: traceHeaders },
        );
      } catch (err) {
        if (!(err instanceof OpenAI.APIError) || err.status !== 400) {
          throw err;
        }
        console.warn(
          `${label}: model rejected response_format, retrying without it: ${err.message}`,
        );
        res = await client.chat.completions.create(params, {
          headers: traceHeaders,
        });
      }

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
