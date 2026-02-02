/**
 * Path Organization Example
 *
 * Demonstrates how to use the `path` parameter to organize experiment
 * results into specific projects and folders on the Orq platform.
 *
 * The `path` parameter accepts a string in the format "Project/Folder/Subfolder"
 * where the first segment is the project name and subsequent segments are
 * folders/subfolders within that project.
 *
 * Examples:
 *   - "MyProject" - places results in MyProject (root level)
 *   - "MyProject/Evaluations" - places results in the Evaluations folder of MyProject
 *   - "MyProject/Evaluations/Unit Tests" - nested subfolder
 *
 * Prerequisites:
 *   - Set ORQ_API_KEY environment variable
 *
 * Usage:
 *   ORQ_API_KEY=your-key bun examples/src/lib/path-organization.eval.ts
 */

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

// Simple evaluator that checks if output matches expected
const matchesExpected: Evaluator = {
  name: "matches-expected",
  scorer: async ({ data, output }) => {
    const matches = output === data.expectedOutput;
    return {
      value: matches ? 1.0 : 0.0,
      pass: matches,
      explanation: matches ? "Correct!" : `Expected ${data.expectedOutput}`,
    };
  },
};

// Simple text processing job
const textProcessorJob = job("text-processor", async (data) => {
  const text = data.inputs.text as string;
  const operation = data.inputs.operation as string;

  switch (operation) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "reverse":
      return text.split("").reverse().join("");
    default:
      return text;
  }
});

// Test data
const dataPoints: DataPoint[] = [
  {
    inputs: { text: "Hello", operation: "uppercase" },
    expectedOutput: "HELLO",
  },
  {
    inputs: { text: "WORLD", operation: "lowercase" },
    expectedOutput: "world",
  },
  { inputs: { text: "abc", operation: "reverse" }, expectedOutput: "cba" },
];

async function run() {
  console.log("\n📁 Path Organization Example\n");
  console.log("Experiment results will be stored in: MyProject/TextProcessing");
  console.log("  - Project: MyProject");
  console.log("  - Folder: TextProcessing");
  console.log("------------------------------------------\n");

  const results = await evaluatorq("text-processor-eval", {
    data: dataPoints,
    jobs: [textProcessorJob],
    evaluators: [matchesExpected],
    print: true,
    description: "Text processing evaluation with path organization",
    // The path parameter: first segment is project, rest are folders
    // Format: "Project/Folder/Subfolder/..."
    path: "MyProject/TextProcessing",
  });

  console.log("\n✅ Evaluation complete!");
  return results;
}

run().catch(console.error);
