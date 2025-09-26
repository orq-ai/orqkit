import OpenAI from "openai";

import type { Evaluator } from "@orq-ai/evaluatorq";

import { cosineSimilarity } from "./vector-utils.js";

/**
 * Creates an OpenAI client configured for either direct OpenAI API access or Orq proxy
 * @throws {Error} If neither OPENAI_API_KEY nor ORQ_API_KEY is defined
 */
function createOpenAIClient(): OpenAI {
  const orqApiKey = process.env.ORQ_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (orqApiKey) {
    // Use Orq proxy when ORQ_API_KEY is available
    return new OpenAI({
      baseURL: "https://api.orq.ai/v2/proxy",
      apiKey: orqApiKey,
    });
  }

  if (openaiApiKey) {
    // Use direct OpenAI API
    return new OpenAI({
      apiKey: openaiApiKey,
    });
  }

  throw new Error(
    "Cosine similarity evaluator requires either ORQ_API_KEY or OPENAI_API_KEY environment variable to be set for embeddings",
  );
}

/**
 * Configuration options for the cosine similarity evaluator
 */
export interface CosineSimilarityConfig {
  /**
   * The expected text to compare against the output
   */
  expectedText: string;
  /**
   * The embedding model to use
   * @default "text-embedding-3-small" for OpenAI, "openai/text-embedding-3-small" for Orq
   */
  model?: string;
  /**
   * Optional name for the evaluator
   * @default "cosine-similarity"
   */
  name?: string;
}

/**
 * Configuration options for the cosine similarity threshold evaluator
 */
export interface CosineSimilarityThresholdConfig
  extends CosineSimilarityConfig {
  /**
   * Threshold for similarity score (0-1)
   * The evaluator will return true if similarity meets the threshold
   */
  threshold: number;
}

/**
 * Creates a cosine similarity evaluator that returns the raw similarity score
 * between the output and expected text using OpenAI embeddings
 *
 * @example
 * ```typescript
 * const evaluator = cosineSimilarityEvaluator({
 *   expectedText: "The capital of France is Paris"
 * });
 * ```
 */
export function cosineSimilarityEvaluator(
  config: CosineSimilarityConfig,
): Evaluator {
  const { expectedText, model: userModel, name = "cosine-similarity" } = config;

  // Lazy initialization of OpenAI client
  let openaiClient: OpenAI | null = null;

  const getClient = () => {
    if (!openaiClient) {
      openaiClient = createOpenAIClient();
    }
    return openaiClient;
  };

  // Determine the appropriate model based on the environment
  const getModel = () => {
    if (userModel) return userModel;
    const isOrq = !!process.env.ORQ_API_KEY;
    return isOrq ? "openai/text-embedding-3-small" : "text-embedding-3-small";
  };

  return {
    name,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) {
        return {
          value: 0,
          explanation: "Output is null or undefined",
        };
      }

      const outputText = String(output);
      const client = getClient(); // This will throw if no API keys
      const model = getModel();

      // Get embeddings for both texts
      const [outputEmbedding, expectedEmbedding] = await Promise.all([
        client.embeddings.create({
          input: outputText,
          model,
        }),
        client.embeddings.create({
          input: expectedText,
          model,
        }),
      ]);

      // Extract the embedding vectors
      const outputVector = outputEmbedding.data[0].embedding;
      const expectedVector = expectedEmbedding.data[0].embedding;

      // Calculate cosine similarity
      const similarity = cosineSimilarity(outputVector, expectedVector);

      return {
        value: similarity,
        explanation: `Cosine similarity: ${similarity.toFixed(3)}`,
      };
    },
  };
}

/**
 * Creates a cosine similarity evaluator that returns a boolean based on
 * whether the similarity meets a threshold
 *
 * @example
 * ```typescript
 * const evaluator = cosineSimilarityThresholdEvaluator({
 *   expectedText: "The capital of France is Paris",
 *   threshold: 0.8
 * });
 * ```
 */
export function cosineSimilarityThresholdEvaluator(
  config: CosineSimilarityThresholdConfig,
): Evaluator {
  const {
    expectedText,
    threshold,
    model: userModel,
    name = "cosine-similarity-threshold",
  } = config;

  // Lazy initialization of OpenAI client
  let openaiClient: OpenAI | null = null;

  const getClient = () => {
    if (!openaiClient) {
      openaiClient = createOpenAIClient();
    }
    return openaiClient;
  };

  // Determine the appropriate model based on the environment
  const getModel = () => {
    if (userModel) return userModel;
    const isOrq = !!process.env.ORQ_API_KEY;
    return isOrq ? "openai/text-embedding-3-small" : "text-embedding-3-small";
  };

  return {
    name,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) {
        return {
          value: false,
          explanation: "Output is null or undefined",
        };
      }

      const outputText = String(output);
      const client = getClient(); // This will throw if no API keys
      const model = getModel();

      // Get embeddings for both texts
      const [outputEmbedding, expectedEmbedding] = await Promise.all([
        client.embeddings.create({
          input: outputText,
          model,
        }),
        client.embeddings.create({
          input: expectedText,
          model,
        }),
      ]);

      // Extract the embedding vectors
      const outputVector = outputEmbedding.data[0].embedding;
      const expectedVector = expectedEmbedding.data[0].embedding;

      // Calculate cosine similarity
      const similarity = cosineSimilarity(outputVector, expectedVector);
      const meetsThreshold = similarity >= threshold;

      return {
        value: meetsThreshold,
        explanation: meetsThreshold
          ? `Similarity (${similarity.toFixed(3)}) meets threshold (${threshold})`
          : `Similarity (${similarity.toFixed(3)}) below threshold (${threshold})`,
      };
    },
  };
}

/**
 * Creates a simple cosine similarity evaluator with default settings
 * @param expectedText The expected text to compare against
 * @returns An evaluator that returns the cosine similarity score (0-1)
 */
export function simpleCosineSimilarity(expectedText: string): Evaluator {
  return cosineSimilarityEvaluator({ expectedText });
}
