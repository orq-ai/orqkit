import type { DataPoint } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

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
  jobs: [
    // Job 1: Text analysis job
    job("text-analyzer", async (data: DataPoint, _row: number) => {
      const text = data.inputs.text || data.inputs.input || "";
      const analysis = {
        length: String(text).length,
        wordCount: String(text).split(/\s+/).filter(Boolean).length,
        hasNumbers: /\d/.test(String(text)),
        hasSpecialChars: /[^a-zA-Z0-9\s]/.test(String(text)),
      };

      return analysis;
    }),
  ],
  evaluators: [
    {
      name: "output-validator",
      scorer: async ({ data, output }) => {
        // Check if output is valid (not null/undefined)
        if (output === null || output === undefined) {
          return {
            value: false,
            explanation: "Output is null or undefined",
          };
        }

        // If there's an expected output, compare
        if (data.expectedOutput !== null && data.expectedOutput !== undefined) {
          // For objects, check if they have the expected structure
          if (
            typeof output === "object" &&
            typeof data.expectedOutput === "object"
          ) {
            const matches =
              JSON.stringify(output) === JSON.stringify(data.expectedOutput);
            return {
              value: matches,
              explanation: matches
                ? "Output matches expected structure"
                : "Output does not match expected structure",
            };
          }
          // For primitives, direct comparison
          const matches = output === data.expectedOutput;
          return {
            value: matches,
            explanation: matches
              ? "Output matches expected value"
              : `Expected ${data.expectedOutput}, got ${output}`,
          };
        }

        // No expected output, just validate the output exists
        return {
          value: true,
          explanation: "Output exists (no expected output to compare)",
        };
      },
    },
  ],
  parallelism: 2,
  print: true,
});
