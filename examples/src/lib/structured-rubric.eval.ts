/**
 * Structured evaluation result example - multi-criteria rubric scorer.
 *
 * Demonstrates returning structured EvaluationResultCell values with
 * multiple sub-scores per evaluator.
 *
 * Usage:
 *   bun examples/src/lib/structured-rubric.eval.ts
 */

import type { Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

const echoJob = job("echo", async (data) => {
  return data.inputs.text;
});

const rubricEvaluator: Evaluator = {
  name: "rubric",
  scorer: async ({ output }) => {
    const text = String(output);
    return {
      value: {
        type: "rubric",
        value: {
          relevance: Math.min(text.length / 100, 1),
          coherence: text.includes(".") ? 0.9 : 0.4,
          fluency: text.split(" ").length > 5 ? 0.85 : 0.5,
        },
      },
      explanation: "Multi-criteria quality rubric",
    };
  },
};

await evaluatorq("structured-rubric", {
  data: [
    { inputs: { text: "The quick brown fox jumps over the lazy dog." } },
    { inputs: { text: "Hi" } },
    {
      inputs: {
        text: "This is a well-structured sentence that demonstrates good fluency and coherence in natural language.",
      },
    },
  ],
  jobs: [echoJob],
  evaluators: [rubricEvaluator],
  print: true,
});
