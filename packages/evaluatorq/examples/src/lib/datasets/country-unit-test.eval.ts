/**
 * Country Unit Test Example
 *
 * A simple example demonstrating how to quickly assemble an evaluation
 * as a "unit test" for a deployment using a dataset from the platform.
 *
 * This example:
 * - Fetches the "countries" dataset from the Orq platform
 * - Calls the `unit_test_countries` deployment for each country
 * - Validates responses contain the expected capital city (case-insensitive)
 *
 * Prerequisites:
 *   - Set ORQ_API_KEY environment variable
 *
 * Usage:
 *   ORQ_API_KEY=your-key bun examples/src/lib/country-unit-test.ts
 */

import { evaluatorq, invoke, job } from "@orq-ai/evaluatorq";
import { stringContainsEvaluator } from "@orq-ai/evaluators";

const DATASET_ID = "01KE9KKAB119PGHXBXJX9D7DCT";
const DEPLOYMENT_KEY = "unit_test_countries";

// Job that calls the deployment with the country input
const countryLookupJob = job("country-lookup", async (data) => {
  const country = data.inputs.country as string;

  const response = await invoke(DEPLOYMENT_KEY, {
    inputs: { country },
  });

  return response;
});

async function run() {
  console.log("\n🧪 Country Unit Test\n");
  console.log(`Dataset: countries (${DATASET_ID})`);
  console.log(`Deployment: ${DEPLOYMENT_KEY}`);
  console.log("------------------------------------------\n");

  const results = await evaluatorq("country-unit-test", {
    data: { datasetId: DATASET_ID },
    jobs: [countryLookupJob],
    evaluators: [stringContainsEvaluator()],
    parallelism: 6,
    print: true,
    description: "Unit test for unit_test_countries deployment",
  });

  return results;
}

run();
