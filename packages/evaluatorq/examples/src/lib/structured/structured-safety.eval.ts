/**
 * Structured evaluation result example - toxicity/safety scorer.
 *
 * Demonstrates returning structured EvaluationResultCell values
 * with per-category safety severity scores and pass/fail tracking.
 *
 * Usage:
 *   bun examples/src/lib/structured-safety.eval.ts
 */

import type { Evaluator, Output } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

const echoJob = job("echo", async (data, _row) => {
  return data.inputs.text as Output;
});

const safetyEvaluator: Evaluator = {
  name: "safety",
  scorer: async ({ output }) => {
    const text = String(output).toLowerCase();
    // Simple keyword-based check (replace with a real classifier in production)
    const categories = {
      hate_speech: text.includes("hate") ? 0.8 : 0.1,
      violence: text.includes("kill") || text.includes("fight") ? 0.7 : 0.05,
      profanity: text.includes("damn") ? 0.5 : 0.02,
    };

    return {
      value: {
        type: "safety",
        value: categories,
      },
      pass: Object.values(categories).every((score) => score < 0.5),
      explanation: "Content safety severity scores per category",
    };
  },
};

await evaluatorq("structured-safety", {
  data: [
    { inputs: { text: "Hello, how are you today?" } },
    { inputs: { text: "I hate this so much!" } },
    { inputs: { text: "The team will fight for the championship." } },
    { inputs: { text: "Damn, that was a close call." } },
  ],
  jobs: [echoJob],
  evaluators: [safetyEvaluator],
  print: true,
});
