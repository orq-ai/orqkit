# @orq-ai/evaluatorq

An evaluation framework library that provides a flexible way to run parallel evaluations and optionally integrate with the Orq AI platform.

## 🎯 Features

- **Parallel Execution**: Run multiple evaluation jobs concurrently with progress tracking
- **Flexible Data Sources**: Support for inline data, promises, and Orq platform datasets
- **Type-safe**: Fully written in TypeScript
- **Orq Platform Integration**: Seamlessly fetch and evaluate datasets from Orq AI (optional)

## 📥 Installation

```bash
npm install @orq-ai/evaluatorq
# or
yarn add @orq-ai/evaluatorq
# or
bun add @orq-ai/evaluatorq
```

### Peer Dependencies

If you want to use the Orq platform integration:

```bash
npm install @orq-ai/node
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { evaluatorq, job } from "@orq-ai/evaluatorq";

const textAnalyzer = job("text-analyzer", async (data) => {
  const text = data.inputs.text;
  const analysis = {
    length: text.length,
    wordCount: text.split(" ").length,
    uppercase: text.toUpperCase(),
  };
  
  return analysis;
});

await evaluatorq("text-analysis", {
  data: [
    { inputs: { text: "Hello world" } },
    { inputs: { text: "Testing evaluation" } },
  ],
  jobs: [textAnalyzer],
  evaluators: [
    {
      name: "length-check",
      scorer: async ({ output }) => {
        const passesCheck = output.length > 10;
        return {
          value: passesCheck ? 1 : 0,
          explanation: passesCheck
            ? "Output length is sufficient"
            : `Output too short (${output.length} chars, need >10)`,
        };
      },
    },
  ],
});
```

### Using Orq Platform Datasets

```typescript
import { evaluatorq, job } from "@orq-ai/evaluatorq";

const processor = job("processor", async (data) => {
  // Process each data point from the dataset
  return processData(data);
});

// Requires ORQ_API_KEY environment variable
await evaluatorq("dataset-evaluation", {
  data: {
    datasetId: "your-dataset-id", // From Orq platform
  },
  jobs: [processor],
  evaluators: [
    {
      name: "accuracy",
      scorer: async ({ data, output }) => {
        // Compare output with expected results
        const score = calculateScore(output, data.expectedOutput);
        return {
          value: score,
          explanation: score > 0.8
            ? "High accuracy match"
            : score > 0.5
              ? "Partial match"
              : "Low accuracy match",
        };
      },
    },
  ],
});
```

### Advanced Features

#### Multiple Jobs

Run multiple jobs in parallel for each data point:

```typescript
import { job } from "@orq-ai/evaluatorq";

const preprocessor = job("preprocessor", async (data) => preprocess(data));
const analyzer = job("analyzer", async (data) => analyze(data));
const transformer = job("transformer", async (data) => transform(data));

await evaluatorq("multi-job-eval", {
  data: [...],
  jobs: [preprocessor, analyzer, transformer],
  evaluators: [...],
});
```

#### Custom Error Handling

```typescript
import { job } from "@orq-ai/evaluatorq";

const riskyJob = job("risky-job", async (data) => {
  // Errors are captured and included in the evaluation results
  // The job name is preserved even when errors occur
  const result = await riskyOperation(data);
  return result;
});

await evaluatorq("error-handling", {
  data: [...],
  jobs: [riskyJob],
  evaluators: [...],
});
```

#### Async Data Sources

```typescript
// Create an array of promises for async data
const dataPromises = Array.from({ length: 1000 }, (_, i) => 
  Promise.resolve({ inputs: { value: i } })
);

await evaluatorq("async-eval", {
  data: dataPromises,
  jobs: [...],
  evaluators: [...],
});
```

## 🔧 Configuration

### Environment Variables

- `ORQ_API_KEY`: API key for Orq platform integration (required for dataset access and sending results)

## 📊 Orq Platform Integration

### Automatic Result Sending

When the `ORQ_API_KEY` environment variable is set, evaluatorq automatically sends evaluation results to the Orq platform for visualization and analysis.

```typescript
import { evaluatorq, job } from "@orq-ai/evaluatorq";

// Results are automatically sent when ORQ_API_KEY environment variable is present
await evaluatorq("my-evaluation", {
  data: [...],
  jobs: [...],
  evaluators: [...],
});
```

#### What Gets Sent

When the `ORQ_API_KEY` is set, the following information is sent to Orq:
- Evaluation name
- Dataset ID (when using Orq datasets)
- Job results with outputs and errors
- Evaluator scores with values and explanations
- Execution timing information

Note: Evaluator explanations are included in the data sent to Orq but are not displayed in the terminal output to keep the console clean.

#### Result Visualization

After successful submission, you'll see a console message with a link to view your results:

```
📊 View your evaluation results at: <url to the evaluation>
```

The Orq platform provides:
- Interactive result tables
- Score statistics
- Performance metrics
- Historical comparisons


## 📚 API Reference

### `evaluatorq(name, options)`

Main function to run evaluations.

#### Parameters:

- `name`: String identifier for the evaluation run
- `options`: Configuration object with:
  - `data`: Array of data points, async iterable, or Orq dataset config
  - `jobs`: Array of job functions to run on each data point
  - `evaluators`: Array of evaluator configurations

#### Returns:

Promise that resolves when evaluation is complete.

### Types

```typescript
type Output = string | number | boolean | Record<string, unknown> | null;

interface DataPoint {
  inputs: Record<string, unknown>;
  expectedOutput?: Output;
}

interface JobResult {
  jobName: string;
  output: Output;
  error?: Error;
  evaluatorScores?: EvaluatorScore[];
}

interface EvaluatorScore {
  evaluatorName: string;
  score: EvaluationResult<number | boolean | string>;
  error?: Error;
}

type Job = (
  data: DataPoint,
  row: number,
) => Promise<{
  name: string;
  output: Output;
}>;

// Helper function for creating jobs with preserved names on errors
function job(
  name: string,
  fn: (data: DataPoint, row: number) => Promise<Output> | Output,
): Job;

type ScorerParameter = {
  data: DataPoint;
  output: Output;
};

type EvaluationResult<T> = {
  value: T;
  explanation?: string;
};

type Scorer =
  | ((params: ScorerParameter) => Promise<EvaluationResult<string>>)
  | ((params: ScorerParameter) => Promise<EvaluationResult<number>>)
  | ((params: ScorerParameter) => Promise<EvaluationResult<boolean>>);
```

## 🛠️ Development

```bash
# Build the package
bunx nx build evaluatorq

# Run type checking
bunx nx typecheck evaluatorq
```
