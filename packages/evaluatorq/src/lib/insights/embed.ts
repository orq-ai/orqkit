import { createHash } from "node:crypto";

import type OpenAI from "openai";

import { llmSlot } from "../common/llm-limit.js";
import { priceUsage } from "../common/model-catalogue.js";
import { withoutClientRetries, withRetry } from "../common/retry.js";
import {
  checkRunActive,
  runAbortSignal,
  withRunLifecycle,
} from "../common/run-lifecycle.js";
import {
  warnConfigRedirect,
  warnUnreadConfigFields,
} from "../common/structured-output.js";
import { recordTokenUsage, withLlmSpan } from "../common/tracing.js";
import { extractUsage, LLMCallConfig } from "../contracts.js";
import type { InsightsCache } from "./cache.js";
import type { UsageLedger } from "./usage.js";
export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}
export function vectorCacheModel(
  client: { baseURL?: unknown },
  model: string,
): string {
  if (client.baseURL == null) return model;
  const endpoint = String(client.baseURL).replace(/\/+$/, "");
  return `${model}@${createHash("sha256").update(endpoint, "utf8").digest("hex")}`;
}
export interface EmbedOptions {
  client: OpenAI;
  model: string;
  cache: InsightsCache;
  usage?: UsageLedger;
  batchSize?: number;
  cfg?: LLMCallConfig;
  signal?: AbortSignal;
}
export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions,
): Promise<Record<string, number[]>> {
  const batchSize = options.batchSize ?? 256;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batch_size must be positive");
  const unique = [...new Set(texts)];
  if (!unique.length) return {};
  const client = withoutClientRetries(options.client),
    cacheModel = vectorCacheModel(client, options.model),
    cfg = options.cfg ?? new LLMCallConfig({ model: options.model });
  if (options.cfg) {
    warnConfigRedirect(cfg, {
      resolvedModel: options.model,
      caller: "insights.embed_texts",
    });
    warnUnreadConfigFields(cfg, ["retryCount"], {
      caller: "insights.embed_texts",
    });
  }
  return withRunLifecycle(
    undefined,
    async () => {
      const cached = options.cache.getVectors(cacheModel, unique),
        vectors = new Map(Object.entries(cached)),
        missing = unique.filter((text) => !vectors.has(text)),
        newVectors = new Map<string, number[]>();
      let unpriced = false;
      for (let start = 0; start < missing.length; start += batchSize) {
        checkRunActive();
        const batch = missing.slice(start, start + batchSize);
        try {
          const [response, batchUsage] = await withRetry(
            async () => {
              try {
                return await withLlmSpan(
                  {
                    model: options.model,
                    operation: "embeddings",
                    attributes: { "orq.llm.purpose": "insights.embed" },
                  },
                  async (span) => {
                    const signal = runAbortSignal(),
                      response = await llmSlot(
                        () =>
                          client.embeddings.create(
                            {
                              model: options.model,
                              input: batch,
                              encoding_format: "base64",
                            },
                            { signal },
                          ),
                        { signal },
                      );
                    checkRunActive();
                    if (!response.usage)
                      throw new Error("embedding response is missing usage");
                    recordTokenUsage(span, {
                      promptTokens: response.usage.prompt_tokens,
                      totalTokens: response.usage.total_tokens,
                      calls: 1,
                    });
                    const priced = await priceUsage(
                      extractUsage(response.usage),
                      options.model,
                      client,
                      { servedModel: response.model },
                    );
                    options.usage?.add("embed", priced);
                    return [response, priced] as const;
                  },
                );
              } catch (error) {
                checkRunActive();
                options.usage?.add("embed", null);
                throw error;
              }
            },
            {
              maxAttempts: cfg.retryCount + 1,
              label: "insights embed",
              signal: runAbortSignal(),
            },
          );
          if (batchUsage !== null && batchUsage.totalCost === null)
            unpriced = true;
          if (response.data.length !== batch.length)
            throw new Error("embedding response length does not match batch");
          for (const [index, text] of batch.entries()) {
            const item = response.data[index];
            const raw: unknown = item?.embedding;
            let vector: number[];
            if (typeof raw === "string") {
              const bytes = Buffer.from(raw, "base64");
              if (bytes.length % 4 !== 0)
                throw new Error("embedding response has invalid base64 vector");
              vector = Array.from({ length: bytes.length / 4 }, (_, offset) =>
                bytes.readFloatLE(offset * 4),
              );
            } else if (
              Array.isArray(raw) &&
              raw.every((value) => typeof value === "number")
            )
              vector = raw;
            else throw new Error("embedding response has no vector");
            newVectors.set(text, vector);
          }
        } catch (error) {
          checkRunActive();
          throw new EmbeddingError(
            `embedding batch failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      if (
        unpriced &&
        (!options.usage ||
          options.usage.claimWarning("unpriced_embedding_cost"))
      )
        console.warn(
          `Insights embedding model ${options.model} is not priced in the Orq catalogue; embed cost stays unknown`,
        );
      for (const [text, vector] of newVectors) vectors.set(text, vector);
      const dimensions = new Set(
        [...vectors.values()].map((vector) => vector.length),
      );
      if (dimensions.size > 1 || (dimensions.size === 1 && dimensions.has(0))) {
        options.cache.deleteVectors(cacheModel);
        throw new EmbeddingError(
          `embedding vectors have inconsistent dimensions ([${[...dimensions].sort((a, b) => a - b).join(", ")}]); the affected cache entries were cleared`,
        );
      }
      if (newVectors.size)
        options.cache.putVectors(cacheModel, Object.fromEntries(newVectors));
      return Object.fromEntries(
        unique.map((text) => [text, vectors.get(text) as number[]]),
      );
    },
    options.signal,
  );
}
