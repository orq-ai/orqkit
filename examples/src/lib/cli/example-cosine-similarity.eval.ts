/**
 * Cosine Similarity Evaluator Example
 *
 * This example demonstrates how to use the cosine similarity evaluators
 * from @orq-ai/evaluators to compare semantic similarity between outputs
 * and expected text using OpenAI embeddings.
 *
 * Prerequisites:
 * - Install dependencies: bun add @orq-ai/evaluatorq @orq-ai/evaluators @anthropic-ai/sdk
 * - Set ANTHROPIC_API_KEY environment variable for Claude
 * - Set either ORQ_API_KEY or OPENAI_API_KEY for embeddings
 *
 * Run with: bun run example-cosine-similarity.eval.ts
 */

import Anthropic from "@anthropic-ai/sdk";

import { type DataPoint, evaluatorq, job } from "@orq-ai/evaluatorq";
import {
  cosineSimilarityThresholdEvaluator,
  simpleCosineSimilarity,
} from "@orq-ai/evaluators";

const claude = new Anthropic();

// Job that translates text to French
const translateToFrench = job(
  "translate-to-french",
  async (data: DataPoint) => {
    const response = await claude.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 100,
      system:
        "You are a translator. Translate the given text to French. Respond only with the translation.",
      messages: [
        {
          role: "user",
          content: String(data.inputs.text),
        },
      ],
    });

    return response.content[0].type === "text" ? response.content[0].text : "";
  },
);

// Job that generates capital city descriptions
const describeCapital = job("describe-capital", async (data: DataPoint) => {
  const response = await claude.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 50,
    system:
      "You are a geography expert. Provide a one-sentence description of the capital city of the given country.",
    messages: [
      {
        role: "user",
        content: `What is the capital of ${data.inputs.country}?`,
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
});

// Create evaluators with different thresholds and expected outputs
const frenchTranslationSimilarity = simpleCosineSimilarity(
  "Bonjour, comment allez-vous?",
);

const capitalDescriptionThreshold = cosineSimilarityThresholdEvaluator({
  expectedText: "The capital of France is Paris",
  threshold: 0.7, // Semantic similarity threshold
  name: "capital-semantic-match",
});

const exactTranslationThreshold = cosineSimilarityThresholdEvaluator({
  expectedText: "Le ciel est bleu",
  threshold: 0.85, // Higher threshold for more exact match
  name: "exact-translation-match",
});

// Run evaluation with translation examples
console.log("🌍 Running translation evaluation...\n");

await evaluatorq("translation-evaluation", {
  data: [
    { inputs: { text: "Hello, how are you?" } },
    { inputs: { text: "The sky is blue" } },
    { inputs: { text: "Good morning" } },
  ],
  jobs: [translateToFrench],
  evaluators: [frenchTranslationSimilarity, exactTranslationThreshold],
  parallelism: 2,
  print: true,
});

console.log("\n🗺️ Running capital city evaluation...\n");

// Run evaluation with capital city descriptions
await evaluatorq("capital-evaluation", {
  data: [
    { inputs: { country: "France" } },
    { inputs: { country: "Germany" } },
    { inputs: { country: "Japan" } },
  ],
  jobs: [describeCapital],
  evaluators: [capitalDescriptionThreshold],
  parallelism: 2,
  print: true,
});

console.log("\n✅ Cosine similarity evaluation examples completed!");
