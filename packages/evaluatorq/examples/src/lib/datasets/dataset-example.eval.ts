import type { DataPoint } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

await evaluatorq("dataset-evaluation", {
  data: {
    datasetId: "01K1B6PRNRZ4YWS81H017VECS4",
  },
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

    // Job 2: Simple transformation job
    job("text-normalizer", async (data: DataPoint, _row: number) => {
      const input = data.inputs.text || data.inputs.input || "";
      const transformed = String(input)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return transformed;
    }),
  ],
  evaluators: [
    {
      name: "output-validator",
      scorer: async ({ data, output }) => {
        // Check if output is valid (not null/undefined)
        if (output === null || output === undefined) {
          return {
            value: 0,
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
              value: matches ? 1 : 0.5,
              explanation: matches
                ? "Output exactly matches expected structure"
                : "Output structure partially matches expected",
            };
          }
          // For primitives, direct comparison
          const matches = output === data.expectedOutput;
          return {
            value: matches ? 1 : 0,
            explanation: matches
              ? "Output matches expected value"
              : `Expected ${data.expectedOutput}, got ${output}`,
          };
        }

        // No expected output, just validate the output exists
        return {
          value: 1,
          explanation: "Output exists (no expected output to compare)",
        };
      },
    },
    {
      name: "performance-scorer",
      scorer: async ({ output }) => {
        // Simple performance score based on output characteristics
        if (typeof output === "object" && output !== null) {
          // For object outputs (like from text-analyzer)
          const obj = output as Record<string, unknown>;
          const keyCount = Object.keys(obj).length;
          const score = (keyCount > 0 ? 0.8 : 0.2) + Math.random() * 0.2;
          return {
            value: score,
            explanation: `Object with ${keyCount} properties analyzed`,
          };
        } else if (typeof output === "string") {
          // For string outputs (like from text-normalizer)
          const score = output.length > 0 ? 0.9 : 0.1;
          return {
            value: score,
            explanation:
              output.length > 0 ? "Non-empty string output" : "Empty string",
          };
        }
        return {
          value: 0.5,
          explanation: "Neutral performance score",
        };
      },
    },
    {
      name: "contains the word joke",
      scorer: async ({ output, data }) => {
        const hasJoke =
          (data.expectedOutput?.toString().includes("joke") ||
            output?.toString().includes("joke")) ??
          false;
        return {
          value: hasJoke,
          explanation: hasJoke
            ? "Contains the word 'joke'"
            : "Does not contain the word 'joke'",
        };
      },
    },
  ],
  parallelism: 2,
  print: true,
});
