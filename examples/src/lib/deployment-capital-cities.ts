/**
 * Deployment helper example - Capital Cities with Environment Routing
 *
 * This example demonstrates:
 * - Using the deployment helper with the `evaluatorq_test_inputs` deployment
 * - Environment-based routing (production -> gpt-4o-mini, other -> groq)
 * - Regex-based scoring for capital city validation
 * - 100% pass rate requirement
 *
 * The deployment takes a `country` input and returns its capital city.
 *
 * Prerequisites:
 *   - Set ORQ_API_KEY environment variable
 *   - Have the `evaluatorq_test_inputs` deployment configured
 *
 * Usage:
 *   # Test with production environment (routes to gpt-4o-mini)
 *   ORQ_API_KEY=your-key bun examples/src/lib/deployment-capital-cities.ts production
 *
 *   # Test with staging environment (routes to groq)
 *   ORQ_API_KEY=your-key bun examples/src/lib/deployment-capital-cities.ts staging
 */

import type { DataPoint, Evaluator } from "@orq-ai/evaluatorq";
import { evaluatorq, invoke, job } from "@orq-ai/evaluatorq";

// Get environment from command line args (default: staging)
const environments = process.argv[2] || "staging";

console.log(`\n🌍 Running with environments: ${environments}`);
console.log(
  environments === "production"
    ? "   → Routing to gpt-4o-mini (OpenAI)"
    : "   → Routing to groq",
);

// Data points with expected capital cities (regex patterns for flexible matching)
const capitalCityData: (DataPoint & { expectedPattern: RegExp })[] = [
  {
    inputs: { country: "France" },
    expectedOutput: "Paris",
    expectedPattern: /\bParis\b/i,
  },
  {
    inputs: { country: "Japan" },
    expectedOutput: "Tokyo",
    expectedPattern: /\bTokyo\b/i,
  },
  {
    inputs: { country: "Australia" },
    expectedOutput: "Canberra",
    expectedPattern: /\bCanberra\b/i,
  },
  {
    inputs: { country: "Brazil" },
    expectedOutput: "Brasilia",
    expectedPattern: /\bBras[íi]lia\b/i, // Handle accent variations
  },
  {
    inputs: { country: "Egypt" },
    expectedOutput: "Cairo",
    expectedPattern: /\bCairo\b/i,
  },
];

// Job that queries the deployment for capital cities
const capitalCityJob = job("capital-city-lookup", async (data) => {
  const country = data.inputs.country as string;

  // Use the deployment helper with environments context for routing
  const response = await invoke("evaluatorq_test_inputs", {
    inputs: { country },
    context: { environments }, // Routes to gpt-4o-mini (production) or groq (other)
  });

  return response;
});

// Regex-based scorer that validates the capital city is mentioned in the response
const capitalCityMatcher: Evaluator = {
  name: "capital-city-regex-match",
  scorer: async ({ data, output }) => {
    // Get the expected pattern from our data (attached as extra property)
    const dataPoint = capitalCityData.find(
      (d) => d.inputs.country === data.inputs.country,
    );

    if (!dataPoint) {
      return {
        value: 0,
        pass: false,
        explanation: `No expected pattern found for country: ${data.inputs.country}`,
      };
    }

    const outputStr = String(output);
    const matches = dataPoint.expectedPattern.test(outputStr);

    return {
      value: matches ? 1.0 : 0.0,
      pass: matches,
      explanation: matches
        ? `Found "${dataPoint.expectedOutput}" in response`
        : `Expected "${dataPoint.expectedOutput}" but got: "${outputStr.substring(0, 100)}..."`,
    };
  },
};

// Alternative scorer using exact match (stricter)
const exactCapitalMatcher: Evaluator = {
  name: "capital-exact-match",
  scorer: async ({ data, output }) => {
    const dataPoint = capitalCityData.find(
      (d) => d.inputs.country === data.inputs.country,
    );

    if (!dataPoint) {
      return {
        value: 0,
        pass: false,
        explanation: `Unknown country: ${data.inputs.country}`,
      };
    }

    const outputStr = String(output).trim();
    const expected = String(dataPoint.expectedOutput);

    // Check if output contains just the city name or starts with it
    const isExactMatch =
      outputStr.toLowerCase() === expected.toLowerCase() ||
      outputStr.toLowerCase().startsWith(expected.toLowerCase());

    return {
      value: isExactMatch ? 1.0 : 0.0,
      pass: isExactMatch,
      explanation: isExactMatch
        ? `Exact match: ${expected}`
        : `Expected "${expected}", got "${outputStr.substring(0, 50)}"`,
    };
  },
};

async function run() {
  console.log("\n🏛️  Capital Cities Evaluation\n");
  console.log("Testing deployment: evaluatorq_test_inputs");
  console.log(`Environments context: ${environments}`);
  console.log("-------------------------------------------\n");

  const results = await evaluatorq("capital-cities-test", {
    data: capitalCityData,
    jobs: [capitalCityJob],
    evaluators: [capitalCityMatcher], // Use regex matcher for flexibility
    parallelism: 2,
    print: true,
    description: `Capital city lookup test with ${environments} environments routing`,
  });

  // Check results
  const allPassed = results.every((r) =>
    r.jobResults?.every((j) =>
      j.evaluatorScores?.every((e) => e.score.pass === true),
    ),
  );

  if (allPassed) {
    console.log("\n✅ All capital cities matched correctly!");
  } else {
    console.log("\n❌ Some capital cities did not match.");
  }

  return results;
}

// Only run if executed directly
if (import.meta.main) {
  run().catch(console.error);
}

export {
  capitalCityData,
  capitalCityJob,
  capitalCityMatcher,
  exactCapitalMatcher,
};
