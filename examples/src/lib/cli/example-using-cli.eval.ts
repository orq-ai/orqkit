import type { DataPoint } from "@orq/evaluatorq";
import { evaluatorq } from "@orq/evaluatorq";

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
    async (data: DataPoint, _row: number) => {
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
    },
  ],
  evaluators: [
    {
      name: "output-validator",
      scorer: async ({ data, output }) => {
        // Check if output is valid (not null/undefined)
        if (output === null || output === undefined) {
          return false;
        }

        // If there's an expected output, compare
        if (data.expectedOutput !== null && data.expectedOutput !== undefined) {
          // For objects, check if they have the expected structure
          if (
            typeof output === "object" &&
            typeof data.expectedOutput === "object"
          ) {
            return (
              JSON.stringify(output) === JSON.stringify(data.expectedOutput)
            );
          }
          // For primitives, direct comparison

          return output === data.expectedOutput;
        }

        // No expected output, just validate the output exists
        return true;
      },
    },
  ],
  parallelism: 2,
  print: true,
});
