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
import { evaluatorq } from "@orq-ai/evaluatorq";

await evaluatorq("text-analysis", {
  data: [
    { inputs: { text: "Hello world" } },
    { inputs: { text: "Testing evaluation" } },
  ],
  jobs: [
    async (data) => {
      const text = data.inputs.text;
      const analysis = {
        length: text.length,
        wordCount: text.split(" ").length,
        uppercase: text.toUpperCase(),
      };
      
      return {
        name: "text-analyzer",
        output: analysis,
      };
    },
  ],
  evaluators: [
    {
      name: "length-check",
      scorer: async ({ output }) => {
        return output.length > 10 ? 1 : 0;
      },
    },
  ],
});
```

### Using Orq Platform Datasets

```typescript
import { evaluatorq } from "@orq-ai/evaluatorq";

// Requires ORQ_API_KEY environment variable
await evaluatorq("dataset-evaluation", {
  data: {
    datasetId: "your-dataset-id", // From Orq platform
  },
  jobs: [
    async (data) => {
      // Process each data point from the dataset
      return {
        name: "processor",
        output: processData(data),
      };
    },
  ],
  evaluators: [
    {
      name: "accuracy",
      scorer: async ({ data, output }) => {
        // Compare output with expected results
        return calculateScore(output, data.expectedOutput);
      },
    },
  ],
});
```

### Advanced Features

#### Multiple Jobs

Run multiple jobs in parallel for each data point:

```typescript
await evaluatorq("multi-job-eval", {
  data: [...],
  jobs: [
    async (data) => ({
      name: "preprocessor",
      output: preprocess(data),
    }),
    async (data) => ({
      name: "analyzer",
      output: analyze(data),
    }),
    async (data) => ({
      name: "transformer",
      output: transform(data),
    }),
  ],
  evaluators: [...],
});
```

#### Custom Error Handling

```typescript
await evaluatorq("error-handling", {
  data: [...],
  jobs: [
    async (data) => {
      try {
        const result = await riskyOperation(data);
        return { name: "risky-job", output: result };
      } catch (error) {
        // Errors are captured and included in the evaluation results
        throw new Error(`Failed to process: ${error.message}`);
      }
    },
  ],
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

- `ORQ_API_KEY`: API key for Orq platform integration (required for dataset access)

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
interface DataPoint {
  inputs: Record<string, any>;
  expectedOutput?: any;
  metadata?: Record<string, any>;
}

interface JobResult {
  name: string;
  output: any;
}

interface Evaluator {
  name: string;
  scorer: (context: EvaluatorContext) => Promise<number>;
}

interface EvaluatorContext {
  data: DataPoint;
  output: any;
  row: number;
}
```

## 🛠️ Development

```bash
# Build the package
bunx nx build evaluatorq

# Run type checking
bunx nx typecheck evaluatorq

# Run tests
bunx nx test evaluatorq
```

## 📄 License

This is free and unencumbered software released into the public domain. See [UNLICENSE](https://unlicense.org) for details.