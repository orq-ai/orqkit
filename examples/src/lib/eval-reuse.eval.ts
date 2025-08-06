import type { DataPoint, Evaluator, Job } from "@orq/evaluatorq";
import { evaluatorq } from "@orq/evaluatorq";

function maxLengthValidator(max: number): Evaluator {
  return {
    name: `max-length-${max}`,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) return false;
      return (
        (typeof output === "object" &&
          "length" in output &&
          Number(output.length) <= max) ??
        false
      );
    },
  };
}

const textAnalysisJob: Job = async (data: DataPoint) => {
  const text = data.inputs.text || data.inputs.input || "";

  const analysis = {
    length: String(text).length,
    wordCount: String(text).split(/\s+/).filter(Boolean).length,
    hasNumbers: /\d/.test(String(text)),
    hasSpecialChars: /[^a-zA-Z0-9\s]/.test(String(text)),
  };

  return {
    name: "text-analyzer",
    output: analysis,
  };
};

await evaluatorq("dataset-evaluation", {
  data: [
    Promise.resolve({
      inputs: { text: "Hello joke" },
      expectedOutput: {
        length: 10,
        wordCount: 2,
        hasNumbers: false,
        hasSpecialChars: false,
      },
    }),
  ],
  jobs: [textAnalysisJob],
  evaluators: [maxLengthValidator(10)],
  parallelism: 2,
  print: true,
});
