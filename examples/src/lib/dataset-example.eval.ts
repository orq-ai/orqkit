import type { DataPoint } from "@orq-ai/evaluatorq";
import { evaluatorq } from "@orq-ai/evaluatorq";

await evaluatorq("dataset-evaluation", {
  data: {
    datasetId: "01K1B6PRNRZ4YWS81H017VECS4",
  },
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

    // Job 2: Simple transformation job
    async (data: DataPoint, _row: number) => {
      const input = data.inputs.text || data.inputs.input || "";
      const transformed = String(input)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        name: "text-normalizer",
        output: transformed,
      };
    },
  ],
  evaluators: [
    {
      name: "output-validator",
      scorer: async ({ data, output }) => {
        // Check if output is valid (not null/undefined)
        if (output === null || output === undefined) {
          return 0;
        }

        // If there's an expected output, compare
        if (data.expectedOutput !== null && data.expectedOutput !== undefined) {
          // For objects, check if they have the expected structure
          if (
            typeof output === "object" &&
            typeof data.expectedOutput === "object"
          ) {
            return JSON.stringify(output) ===
              JSON.stringify(data.expectedOutput)
              ? 1
              : 0.5;
          }
          // For primitives, direct comparison
          return output === data.expectedOutput ? 1 : 0;
        }

        // No expected output, just validate the output exists
        return 1;
      },
    },
    {
      name: "performance-scorer",
      scorer: async ({ output }) => {
        // Simple performance score based on output characteristics
        if (typeof output === "object" && output !== null) {
          // For object outputs (like from text-analyzer)
          const obj = output as Record<string, unknown>;
          const score = Object.keys(obj).length > 0 ? 0.8 : 0.2;
          return score + Math.random() * 0.2; // Add some variability
        } else if (typeof output === "string") {
          // For string outputs (like from text-normalizer)
          return output.length > 0 ? 0.9 : 0.1;
        }
        return 0.5;
      },
    },
    {
      name: "contains the word joke",
      scorer: async ({ output, data }) => {
        return (
          (data.expectedOutput?.toString().includes("joke") ||
            output?.toString().includes("joke")) ??
          false
        );
      },
    },
  ],
  parallelism: 2,
  print: true,
});
