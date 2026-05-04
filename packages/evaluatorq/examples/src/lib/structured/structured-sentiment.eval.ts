/**
 * Structured evaluation result example - sentiment breakdown scorer.
 *
 * Demonstrates returning structured EvaluationResultCell values
 * with sentiment distribution across categories.
 *
 * Usage:
 *   bun examples/src/lib/structured-sentiment.eval.ts
 */

import type { Evaluator, Output } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

const echoJob = job("echo", async (data, _row) => {
  return data.inputs.text as Output;
});

const sentimentEvaluator: Evaluator = {
  name: "sentiment",
  scorer: async ({ output }) => {
    const text = String(output).toLowerCase();
    const positiveWords = ["good", "great", "excellent", "happy", "love"];
    const negativeWords = ["bad", "terrible", "awful", "sad", "hate"];
    const posCount = positiveWords.filter((w) => text.includes(w)).length;
    const negCount = negativeWords.filter((w) => text.includes(w)).length;
    const total = Math.max(posCount + negCount, 1);

    return {
      value: {
        type: "sentiment",
        value: {
          positive: posCount / total,
          negative: negCount / total,
          neutral: 1 - (posCount + negCount) / total,
        },
      },
      explanation: "Sentiment distribution across categories",
    };
  },
};

await evaluatorq("structured-sentiment", {
  data: [
    { inputs: { text: "This is a great and excellent product!" } },
    { inputs: { text: "Terrible experience, very bad service." } },
    { inputs: { text: "The package arrived on Tuesday." } },
    { inputs: { text: "I love this but hate the price." } },
  ],
  jobs: [echoJob],
  evaluators: [sentimentEvaluator],
  print: true,
});
