/**
 * Deployment helper example - demonstrates using the deployment helper
 * to easily query Orq deployments within evaluation jobs.
 *
 * Prerequisites:
 *   - Set ORQ_API_KEY environment variable
 *   - Have a deployment configured in your Orq workspace
 *
 * Usage:
 *   ORQ_API_KEY=your-key bun examples/src/lib/deployment-helper-example.ts
 */

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { deployment, evaluatorq, invoke, job } from "@orq-ai/evaluatorq";

// Example: Using the deployment helper in a job
const summarizeJob = job("summarizer", async (data) => {
  const text = data.inputs.text as string;

  // Simple one-liner to invoke a deployment
  const summary = await invoke("summarizer", {
    inputs: { text },
  });

  return summary;
});

// Example: Using deployment() for more control over the response
const analyzeJob = job("analyzer", async (data) => {
  const text = data.inputs.text as string;

  // Get full response with raw data
  const response = await deployment("analyzer", {
    inputs: { text },
    metadata: { source: "evaluatorq" },
  });

  // Access both content and raw response
  console.log("Raw response:", response.raw);

  return response.content;
});

// Example: Chat-style deployment with messages
const chatJob = job("chatbot", async (data) => {
  const question = data.inputs.question as string;

  const response = await invoke("chatbot", {
    messages: [{ role: "user", content: question }],
  });

  return response;
});

// Example: Using thread for conversation tracking
const conversationJob = job("assistant", async (data) => {
  const query = data.inputs.query as string;
  const threadId = data.inputs.threadId as string;

  const response = await invoke("assistant", {
    inputs: { query },
    thread: { id: threadId },
  });

  return response;
});

// Simple evaluator that checks output length
const hasContent: Evaluator = {
  name: "has-content",
  scorer: async ({ output }) => {
    const hasOutput = typeof output === "string" && output.length > 0;
    return {
      value: hasOutput ? 1.0 : 0.0,
      pass: hasOutput,
      explanation: hasOutput
        ? `Output has ${(output as string).length} characters`
        : "No output generated",
    };
  },
};

// Test data
const dataPoints: DataPoint[] = [
  { inputs: { text: "This is a test paragraph that needs summarizing." } },
];

async function run() {
  console.log("\n🚀 Running deployment helper example...\n");

  // Note: This example requires real deployments configured in your workspace
  // Replace 'summarizer' with your actual deployment key

  const results = await evaluatorq("deployment-helper-test", {
    data: dataPoints,
    jobs: [summarizeJob],
    evaluators: [hasContent],
    print: true,
  });

  console.log("\n✅ Evaluation complete!");
  return results;
}

// Only run if executed directly
if (import.meta.main) {
  run().catch(console.error);
}

export { analyzeJob, chatJob, conversationJob, summarizeJob };
