import type { DataPoint } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

// Simulate delays for realistic async operations
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Example with simulated delays for jobs and evaluators
export async function runSimulatedDelayExample() {
  const dataPoints: Promise<DataPoint>[] = [
    Promise.resolve({
      inputs: { query: "What is the capital of France?", userId: "user-123" },
      expectedOutput: "Paris",
    }),
    Promise.resolve({
      inputs: { query: "Calculate 42 * 17", userId: "user-456" },
      expectedOutput: 714,
    }),
    Promise.resolve({
      inputs: {
        query: "What year was JavaScript created?",
        userId: "user-789",
      },
      expectedOutput: 1995,
    }),
    Promise.resolve({
      inputs: { query: "Name the largest planet", userId: "user-012" },
      expectedOutput: "Jupiter",
    }),
  ];

  const result = await evaluatorq("simulated-llm-evaluation", {
    data: dataPoints,
    jobs: [
      // Job 1: Simulated LLM response (takes 500-1500ms)
      job("llm-response", async (data) => {
        const processingTime = 500 + Math.random() * 1000;
        await delay(processingTime);

        // Simulate different responses based on query
        const query = data.inputs.query as string;
        let output: string | number;

        if (query.includes("capital of France")) {
          output = "Paris";
        } else if (query.includes("42 * 17")) {
          output = 714;
        } else if (query.includes("JavaScript created")) {
          output = 1995;
        } else if (query.includes("largest planet")) {
          output = "Jupiter";
        } else {
          output = "Unknown query";
        }

        return output;
      }),

      // Job 2: Simulated context retrieval (takes 200-800ms)
      job("context-retrieval", async (data) => {
        const processingTime = 200 + Math.random() * 600;
        await delay(processingTime);

        return `Retrieved context for user ${data.inputs.userId}`;
      }),
    ],
    evaluators: [
      {
        name: "accuracy-checker",
        scorer: async ({ data, output }) => {
          // Simulate evaluator processing time (100-400ms)
          await delay(100 + Math.random() * 300);

          // Check if the output matches expected
          const isCorrect = output === data.expectedOutput;
          return {
            value: isCorrect ? 1.0 : 0.0,
            explanation: isCorrect
              ? "Output matches expected result"
              : `Expected ${data.expectedOutput}, got ${output}`,
          };
        },
      },
      {
        name: "response-validator",
        scorer: async ({ output }) => {
          // Simulate validation processing time (150-350ms)
          await delay(150 + Math.random() * 200);

          // Simple validation: check if output is not empty
          if (typeof output === "string" && output.length > 0) {
            return {
              value: true,
              explanation: "Valid string response",
            };
          } else if (typeof output === "number") {
            return {
              value: true,
              explanation: "Valid numeric response",
            };
          }
          return {
            value: false,
            explanation: "Invalid or empty response",
          };
        },
      },
      {
        name: "latency-scorer",
        scorer: async () => {
          // Simulate scoring based on response time (50-150ms)
          await delay(50 + Math.random() * 100);

          // Return a simulated latency score
          const score = 0.85 + Math.random() * 0.15; // Score between 0.85 and 1.0
          return {
            value: score,
            explanation: score >= 0.95 ? "Excellent latency" : "Good latency",
          };
        },
      },
    ],
    parallelism: 2, // Process 2 data points at a time
    print: true, // Display the table
  });

  return result;
}
