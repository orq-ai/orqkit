/**
 * Simple pass/fail example - all tests pass.
 *
 * Usage:
 *   bun examples/src/lib/pass-fail-simple.ts
 */

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq, job } from "@orq-ai/evaluatorq";

// Evaluator that checks if output matches expected
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

// Simple calculator job
const calculatorJob = job("calculator", async (data) => {
  const { a, b, op } = data.inputs as { a: number; b: number; op: string };
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    default:
      return 0;
  }
});

// Test data - all should pass
const dataPoints: DataPoint[] = [
  { inputs: { a: 2, b: 3, op: "+" }, expectedOutput: 5 },
  { inputs: { a: 10, b: 4, op: "-" }, expectedOutput: 6 },
  { inputs: { a: 7, b: 8, op: "*" }, expectedOutput: 56 },
  { inputs: { a: 20, b: 4, op: "/" }, expectedOutput: 5 },
];

async function run() {
  console.log("\n🧮 Running calculator evaluation...\n");

  const results = await evaluatorq("calculator-test", {
    data: dataPoints,
    jobs: [calculatorJob],
    evaluators: [matchesExpected],
    print: true,
  });

  console.log("\n✅ All tests passed!");
  return results;
}

run().catch(console.error);
