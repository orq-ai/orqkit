import {
  runDatasetExample,
  runSimulatedDelayExample,
} from "./example-runners.js";

// Choose which example to run
const exampleType = process.argv[2] || "simulated";

if (exampleType === "dataset") {
  // Run dataset example (requires ORQ_API_KEY environment variable)
  await runDatasetExample();
} else {
  // Run simulated delay example (default)
  await runSimulatedDelayExample();
}
