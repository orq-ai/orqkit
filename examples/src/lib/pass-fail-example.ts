/**
 * Example demonstrating the pass/fail feature in evaluatorq.
 *
 * This example shows how to use the `pass` field in scorer results
 * to track pass/fail status and exit with code 1 if any test fails.
 *
 * Usage:
 *   bun examples/src/lib/pass-fail-example.ts
 *
 * To see the pass rate in the summary and exit code 1 behavior,
 * run with some failing tests.
 */

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

// Evaluator that checks if output matches expected and sets pass/fail
const exactMatchEvaluator: Evaluator = {
  name: "exact-match",
  scorer: async ({ data, output }) => {
    const matches = output === data.expectedOutput;
    return {
      value: matches ? 1.0 : 0.0,
      pass: matches, // This determines pass/fail status
      explanation: matches
        ? "Output matches expected value"
        : `Expected "${data.expectedOutput}", got "${output}"`,
    };
  },
};

// Evaluator that checks minimum length and sets pass/fail
const minLengthEvaluator = (minLength: number): Evaluator => ({
  name: `min-length-${minLength}`,
  scorer: async ({ output }) => {
    const length = typeof output === "string" ? output.length : 0;
    const passes = length >= minLength;
    return {
      value: length,
      pass: passes, // Pass if meets minimum length
      explanation: passes
        ? `Length ${length} meets minimum of ${minLength}`
        : `Length ${length} is below minimum of ${minLength}`,
    };
  },
});

// Evaluator that checks if output contains a keyword
const containsKeywordEvaluator = (keyword: string): Evaluator => ({
  name: `contains-${keyword}`,
  scorer: async ({ output }) => {
    const contains =
      typeof output === "string" &&
      output.toLowerCase().includes(keyword.toLowerCase());
    return {
      value: contains,
      pass: contains, // Pass if contains keyword
      explanation: contains
        ? `Output contains "${keyword}"`
        : `Output does not contain "${keyword}"`,
    };
  },
});

// Simple job that echoes the input with a greeting
const greetingJob = job("greeting", async (data) => {
  const name = data.inputs.name as string;
  return `Hello, ${name}! Welcome to our service.`;
});

// Job that returns a short response (will fail min-length check)
const shortResponseJob = job("short-response", async (data) => {
  const name = data.inputs.name as string;
  return `Hi ${name}`;
});

// Test data
const dataPoints: DataPoint[] = [
  {
    inputs: { name: "Alice" },
    expectedOutput: "Hello, Alice! Welcome to our service.",
  },
  {
    inputs: { name: "Bob" },
    expectedOutput: "Hello, Bob! Welcome to our service.",
  },
  {
    inputs: { name: "Charlie" },
    expectedOutput: "Hello, Charlie! Welcome to our service.",
  },
];

async function runPassFailExample() {
  console.log("\n📊 Running pass/fail example...\n");
  console.log("This example demonstrates:");
  console.log("  - Evaluators with pass/fail status");
  console.log("  - Pass rate displayed in summary");
  console.log("  - Exit code 1 if any evaluator fails\n");

  const results = await evaluatorq("pass-fail-demo", {
    data: dataPoints,
    jobs: [greetingJob, shortResponseJob],
    evaluators: [
      exactMatchEvaluator,
      minLengthEvaluator(20), // greeting passes, short-response fails
      containsKeywordEvaluator("Hello"), // greeting passes, short-response fails
    ],
    parallelism: 2,
    print: true,
  });

  console.log("\n✅ Results returned (if you see this, no failures)");
  return results;
}

// Run the example
runPassFailExample().catch(console.error);
