import type { DataPoint } from "@orq/evaluatorq";
import { evaluatorq } from "@orq/evaluatorq";

// Example 1: Simple evaluation without scorers
export async function runSimpleExample() {
  const dataPoints: Promise<DataPoint>[] = [
    Promise.resolve({
      inputs: { question: "What is 2 + 2?" },
      expectedOutput: 4,
    }),
    Promise.resolve({
      inputs: { question: "What is the capital of France?" },
      expectedOutput: "Paris",
    }),
  ];

  const result = await evaluatorq("simple-math-evaluation", {
    data: dataPoints,
    jobs: [
      async (data) => {
        // Simulate an LLM call or computation
        await new Promise((resolve) => setTimeout(resolve, 100));

        if (data.inputs.question === "What is 2 + 2?") {
          return { name: "calculator", output: 4 };
        }
        return { name: "knowledge-base", output: "Paris" };
      },
    ],
  });

  return result;
}

// Example 2: Evaluation with multiple jobs and evaluators
export async function runEvaluationWithScorers() {
  const dataPoints: Promise<DataPoint>[] = [
    Promise.resolve({
      inputs: { text: "The quick brown fox" },
      expectedOutput: "THE QUICK BROWN FOX",
    }),
    Promise.resolve({
      inputs: { text: "hello world" },
      expectedOutput: "HELLO WORLD",
    }),
  ];

  const result = await evaluatorq("text-transformation-evaluation", {
    data: dataPoints,
    jobs: [
      // Job 1: Uppercase transformation
      async (data) => {
        const text = data.inputs.text as string;
        return {
          name: "uppercase-transform",
          output: text.toUpperCase(),
        };
      },
      // Job 2: Word count
      async (data) => {
        const text = data.inputs.text as string;
        const wordCount = text.split(" ").length;
        return {
          name: "word-counter",
          output: wordCount,
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
        name: "similarity-score",
        scorer: async ({ data, output }) => {
          // Simple string similarity (in production, use proper similarity metrics)
          if (
            typeof output === "string" &&
            typeof data.expectedOutput === "string"
          ) {
            const outputLower = output.toLowerCase();
            const expectedLower = data.expectedOutput.toLowerCase();
            return outputLower === expectedLower ? 1.0 : 0.0;
          }
          return 0.0;
        },
      },
    ],
  });

  return result;
}

// Example 3: Parallel processing with error handling
export async function runParallelProcessingExample() {
  // Create data points that will have different behaviors
  const dataPoints: Promise<DataPoint>[] = [
    Promise.resolve({ inputs: { id: 1 }, expectedOutput: "success" }),
    Promise.resolve({ inputs: { id: 2 }, expectedOutput: "success" }),
    Promise.reject(new Error("Failed to load data point 3")), // This will error
    Promise.resolve({ inputs: { id: 4 }, expectedOutput: "success" }),
    Promise.resolve({ inputs: { id: 5 }, expectedOutput: "success" }),
  ];

  const result = await evaluatorq("parallel-processing-demo", {
    data: dataPoints,
    jobs: [
      async (data) => {
        // Job that might fail for certain inputs
        if (data.inputs.id === 2) {
          throw new Error("Job failed for id 2");
        }
        return {
          name: "risky-job",
          output: `Processed ${data.inputs.id}`,
        };
      },
      async (data) => {
        // Safe job that always succeeds
        return {
          name: "safe-job",
          output: `Safe processing of ${data.inputs.id}`,
        };
      },
    ],
    evaluators: [
      {
        name: "error-checker",
        scorer: async ({ output }) => {
          // This evaluator might also fail
          if (output === "Processed 4") {
            throw new Error("Evaluator error on id 4");
          }
          return typeof output === "string" ? 1 : 0;
        },
      },
    ],
    parallelism: 2, // Process 2 data points at a time
  });

  return result;
}
