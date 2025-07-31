import type { EvaluatorqResult } from "@orq/evaluatorq";
import {
  runEvaluationWithScorers,
  runParallelProcessingExample,
  runSimpleExample,
} from "./example-runners.js";

// Helper function to print results
function printResults(result: EvaluatorqResult, title: string) {
  console.log(`${title}:`, JSON.stringify(result, null, 2));
}

// Helper function to print parallel processing results
function printParallelResults(result: EvaluatorqResult) {
  console.log("Parallel processing results:");
  result.forEach((dataPointResult, index) => {
    console.log(`\nData point ${index + 1}:`);
    if (dataPointResult.error) {
      console.log("  Error:", dataPointResult.error.message);
    } else {
      console.log("  Inputs:", dataPointResult.dataPoint.inputs);
      dataPointResult.jobResults?.forEach((jobResult) => {
        console.log(`  Job '${jobResult.jobName}':`);
        if (jobResult.error) {
          console.log(`    Error: ${jobResult.error.message}`);
        } else {
          console.log(`    Output: ${jobResult.output}`);
          jobResult.evaluatorScores?.forEach((score) => {
            if (score.error) {
              console.log(
                `    Evaluator '${score.evaluatorName}' error: ${score.error.message}`,
              );
            } else {
              console.log(
                `    Evaluator '${score.evaluatorName}': ${score.score}`,
              );
            }
          });
        }
      });
    }
  });
}

// Run examples
console.log("=== Running Evaluatorq Examples ===\n");

const simpleResult = await runSimpleExample();
printResults(simpleResult, "Simple example results");
console.log(`\n${"=".repeat(50)}\n`);

const scorerResult = await runEvaluationWithScorers();
printResults(scorerResult, "Evaluation with scorers");
console.log(`\n${"=".repeat(50)}\n`);

const parallelResult = await runParallelProcessingExample();
printParallelResults(parallelResult);
