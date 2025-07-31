import type { DataPoint } from "@orq/evaluatorq";
import { evaluatorq, visualizeResults } from "@orq/evaluatorq";

async function runVisualizationExample() {
  console.log("Running evaluation with visualization...\n");

  // Create test data
  const dataPoints: Promise<DataPoint>[] = [
    // Successful cases
    Promise.resolve({
      inputs: { text: "hello world", operation: "uppercase" },
      expectedOutput: "HELLO WORLD",
    }),
    Promise.resolve({
      inputs: { text: "TypeScript rocks!", operation: "uppercase" },
      expectedOutput: "TYPESCRIPT ROCKS!",
    }),
    // Edge cases
    Promise.resolve({
      inputs: { text: "123 ABC xyz", operation: "uppercase" },
      expectedOutput: "123 ABC XYZ",
    }),
    // Expected failure case
    Promise.resolve({
      inputs: { text: "test failure", operation: "uppercase" },
      expectedOutput: "wrong expectation", // This will fail the exact match
    }),
    // Error simulation
    Promise.reject(new Error("Failed to load test data")),
  ];

  // Run evaluation
  const results = await evaluatorq("text-transformation-evaluation", {
    data: dataPoints,
    jobs: [
      // Job 1: Text transformation
      async (data) => {
        const text = data.inputs.text as string;
        const operation = data.inputs.operation as string;

        if (operation === "uppercase") {
          return {
            name: "text-transformer",
            output: text.toUpperCase(),
          };
        }

        throw new Error(`Unknown operation: ${operation}`);
      },
      // Job 2: Character count
      async (data) => {
        const text = data.inputs.text as string;
        return {
          name: "char-counter",
          output: text.length,
        };
      },
      // Job 3: Word analysis
      async (data) => {
        const text = data.inputs.text as string;
        const words = text.split(/\s+/);

        // Simulate occasional failures
        if (text.includes("TypeScript")) {
          throw new Error("Word analysis failed for TypeScript content");
        }

        return {
          name: "word-analyzer",
          output: {
            wordCount: words.length,
            longestWord: words.reduce((a, b) => (a.length > b.length ? a : b)),
            averageLength:
              words.reduce((sum, word) => sum + word.length, 0) / words.length,
          },
        };
      },
    ],
    evaluators: [
      {
        name: "exact-match",
        scorer: async ({ data, output }) => {
          return output === data.expectedOutput;
        },
      },
      {
        name: "type-check",
        scorer: async ({ output }) => {
          return typeof output === "string" ? 1 : 0;
        },
      },
      {
        name: "quality-score",
        scorer: async ({ data, output }) => {
          // Custom scoring logic
          if (output === data.expectedOutput) return 1.0;
          if (
            typeof output === "string" &&
            typeof data.expectedOutput === "string"
          ) {
            const outputLower = output.toLowerCase();
            const expectedLower = data.expectedOutput.toLowerCase();
            if (outputLower === expectedLower) return 0.8;
          }
          return 0.0;
        },
      },
    ],
    parallelism: 2,
  });

  // Generate visualization
  const reportPath = await visualizeResults(
    "Text Transformation Evaluation",
    results,
    {
      title: "Text Processing Pipeline Evaluation",
      description:
        "Evaluation of text transformation operations with multiple analysis jobs",
      showTimestamp: true,
      outputPath: "./evaluation-report.html",
      autoOpen: true,
    },
  );

  console.log(`\nEvaluation complete! Report saved to: ${reportPath}`);
}

// Run the example
runVisualizationExample().catch(console.error);
