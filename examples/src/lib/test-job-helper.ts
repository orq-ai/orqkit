import { type DataPoint, evaluatorq, job } from "@orq-ai/evaluatorq";

// Simple jobs that don't require external APIs
const successfulJob = job("successfulJob", async (data: DataPoint) => {
  return `Hello ${data.inputs.name}!`;
});

const failingJob = job("failingJob", async (data: DataPoint) => {
  if (data.inputs.name === "FailMe") {
    throw new Error(`Job failed for ${data.inputs.name}`);
  }
  return `Success for ${data.inputs.name}`;
});

const anotherFailingJob = job("anotherFailingJob", async () => {
  throw new Error("This job always fails");
});

console.log("Testing job helper functionality:");
console.log("==================================\n");

const results = await evaluatorq("test-job-helper", {
  data: [
    { inputs: { name: "Alice" } },
    { inputs: { name: "FailMe" } },
    { inputs: { name: "Bob" } },
  ],
  jobs: [successfulJob, failingJob, anotherFailingJob],
  parallelism: 1,
  print: true,
  sendResults: true, // Send results to see the payload
});

// Display the results to show job names are preserved
console.log("\n=== Raw Results (showing job names) ===");
results.forEach((result, index) => {
  console.log(`\nData Point ${index + 1} (${result.dataPoint.inputs.name}):`);
  result.jobResults?.forEach((jobResult) => {
    if (jobResult.error) {
      console.log(`  ❌ ${jobResult.jobName}: ${jobResult.error}`);
    } else {
      console.log(`  ✅ ${jobResult.jobName}: ${jobResult.output}`);
    }
  });
});
