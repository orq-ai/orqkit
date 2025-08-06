# @orq-ai/evaluatorq Examples

This directory contains various examples demonstrating the capabilities of the `@orq-ai/evaluatorq` library.

## Examples Overview

### Basic Examples

#### [examples.ts](src/lib/examples.ts)
Entry point for running different example types. Run with:
```bash
bun run src/lib/examples.ts [simulated|dataset]
```

#### [example-runners.ts](src/lib/example-runners.ts)
Contains two main example implementations:
- **Simulated Delay Example**: Demonstrates async job processing with simulated LLM responses, context retrieval, and multiple evaluators with realistic delays
- **Dataset Example**: Shows integration with Orq platform datasets (requires `ORQ_API_KEY`)

### Specialized Examples

#### [eval-reuse.eval.ts](src/lib/eval-reuse.eval.ts)
Demonstrates reusable evaluation patterns:
- Creating reusable evaluator functions (`maxLengthValidator`)
- Defining reusable job functions (`textAnalysisJob`)
- Type-safe evaluation with custom validators
- Using Promise-based data points

#### [dataset-example.ts](src/lib/dataset-example.ts)
Shows how to:
- Connect to Orq platform datasets using dataset IDs
- Run multiple parallel jobs on dataset items
- Implement custom evaluators for validation and scoring
- Process evaluation results with summary statistics

### CLI Integration Examples

The `cli/` folder contains examples of using evaluatorq with the Orq CLI:

#### [example-using-cli.eval.ts](src/lib/cli/example-using-cli.eval.ts)
A simple evaluation script that can be run with the Orq CLI. Tests text analysis with expected outputs.

#### [example-using-cli-two.eval.ts](src/lib/cli/example-using-cli-two.eval.ts)
Another CLI-compatible evaluation script demonstrating different test data.

#### [eval-cli.sh](src/lib/cli/eval-cli.sh)
Shell script showing how to run evaluations using the Orq CLI:
```bash
orq evaluate "./*.eval.ts"
```

## Running the Examples

### Prerequisites

For dataset examples, set your Orq API key:
```bash
export ORQ_API_KEY="your-api-key"
```

### Running Individual Examples

```bash
# Run simulated delay example (default)
bun run src/lib/examples.ts

# Run dataset example (requires ORQ_API_KEY)
bun run src/lib/examples.ts dataset

# Run reusable patterns example
bun run src/lib/eval-reuse.eval.ts

# Run CLI examples (requires Orq CLI)
cd src/lib/cli
./eval-cli.sh
```

## Key Concepts Demonstrated

### 1. **Parallel Processing**
All examples use `parallelism` parameter to process multiple data points concurrently, improving performance.

### 2. **Custom Evaluators**
Examples show various evaluator types:
- Boolean scorers (return true/false)
- Numeric scorers (return 0-1 scores)
- String scorers (return descriptive results)

### 3. **Error Handling**
Examples demonstrate graceful error handling with jobs and evaluators that may fail, showing how errors are captured in results.

### 4. **Type Safety**
All examples use TypeScript for full type safety with `DataPoint`, `Job`, and `Evaluator` types.

### 5. **Real-world Patterns**
- Simulated API calls with delays
- Text analysis and transformation
- Data validation and quality scoring
- Integration with external platforms

## Customizing Examples

Feel free to modify these examples to match your use cases:

1. **Change Data Points**: Modify the input data structure and expected outputs
2. **Add Custom Jobs**: Create new job functions for your specific processing needs
3. **Implement Custom Evaluators**: Design evaluators that match your quality metrics
4. **Adjust Parallelism**: Tune the `parallelism` parameter based on your workload

## Notes

- The `evaluatorq` function returns detailed results including job outputs and evaluator scores
- Set `print: true` to display a formatted table of results in the console
- All async operations are properly handled with Promise support