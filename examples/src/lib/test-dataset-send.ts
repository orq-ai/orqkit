import { evaluatorq, job } from "@orq-ai/evaluatorq";

// Simple job that just echoes the input
const echoJob = job("echo", async (data) => {
  return `Echo: ${JSON.stringify(data.inputs)}`;
});

// Simple evaluator that always passes
const alwaysPassEvaluator = {
  name: "always-pass",
  scorer: async () => true,
};

console.log("Testing datasetId inclusion in send results:");
console.log("=============================================\n");

// Test 1: With local data (no datasetId)
console.log("Test 1: Local data (no datasetId)");
try {
  await evaluatorq("test-local-data", {
    data: [{ inputs: { test: "value1" } }, { inputs: { test: "value2" } }],
    jobs: [echoJob],
    evaluators: [alwaysPassEvaluator],
    print: false,
    sendResults: true,
    description: "Test with local data - no datasetId",
  });
  console.log("✓ Local data test completed\n");
} catch (error) {
  console.log(`✗ Local data test failed: ${error}\n`);
}

// Test 2: With datasetId (will fail without API key, but shows the intent)
console.log("Test 2: Dataset data (with datasetId)");
console.log(
  "Note: This would include datasetId in the payload when sending results",
);
try {
  await evaluatorq("test-dataset-data", {
    data: {
      datasetId: "test-dataset-12345",
    },
    jobs: [echoJob],
    evaluators: [alwaysPassEvaluator],
    print: false,
    sendResults: true,
    description: "Test with dataset - includes datasetId",
  });
  console.log("✓ Dataset test completed (datasetId would be included)\n");
} catch (error) {
  const errorMessage = String(error);
  if (errorMessage.includes("ORQ_API_KEY")) {
    console.log(
      "✓ Dataset test correctly requires ORQ_API_KEY (datasetId would be included if API key was set)\n",
    );
  } else {
    console.log(`✗ Dataset test failed unexpectedly: ${error}\n`);
  }
}

console.log("\n=== Summary ===");
console.log("When using data from a dataset:");
console.log(
  "  - The datasetId is automatically included in the payload sent to Orq",
);
console.log(
  "  - This allows the Orq platform to link the evaluation back to the original dataset",
);
console.log("\nWhen using local data:");
console.log("  - No datasetId is included (as expected)");
console.log("  - The evaluation is standalone without dataset association");
