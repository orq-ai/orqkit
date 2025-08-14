import type { DataPoint } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

await evaluatorq("dataset-evaluation 2", {
  data: [
    Promise.resolve({
      inputs: { text: "Hello worlds" },
      expectedOutput: {
        length: 12,
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

        if (data.expectedOutput !== null && data.expectedOutput !== undefined) {
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

          const matches = output === data.expectedOutput;
          return {
            value: matches,
            explanation: matches
              ? "Output matches expected value"
              : `Expected ${data.expectedOutput}, got ${output}`,
          };
        }

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
