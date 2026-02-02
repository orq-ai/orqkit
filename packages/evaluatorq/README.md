# @orq-ai/evaluatorq

An evaluation framework library that provides a flexible way to run parallel evaluations and optionally integrate with the Orq AI platform.

## 🎯 Features

- **Parallel Execution**: Run multiple evaluation jobs concurrently with progress tracking
- **Flexible Data Sources**: Support for inline data, promises, and Orq platform datasets
- **Type-safe**: Fully written in TypeScript
- **Orq Platform Integration**: Seamlessly fetch and evaluate datasets from Orq AI (optional)
- **OpenTelemetry Tracing**: Built-in observability with automatic span creation for jobs and evaluators
- **Pass/Fail Tracking**: Evaluators can return pass/fail status for CI/CD integration

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

For OpenTelemetry tracing (optional):

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
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

#### Structured Evaluation Results

Evaluators can return structured, multi-dimensional metrics using `EvaluationResultCell`. This is useful for metrics like BERT scores, ROUGE-N scores, or any evaluation that produces multiple sub-scores.

See the runnable examples in the `examples/` directory:

- [`structured-rubric.eval.ts`](../../examples/src/lib/structured-rubric.eval.ts) - Multi-criteria quality rubric (relevance, coherence, fluency)
- [`structured-sentiment.eval.ts`](../../examples/src/lib/structured-sentiment.eval.ts) - Sentiment distribution breakdown (positive, negative, neutral)
- [`structured-safety.eval.ts`](../../examples/src/lib/structured-safety.eval.ts) - Toxicity/safety severity scores with pass/fail tracking

For a BERT score example using the Orq platform, see [`llm-eval-with-results.ts`](../../examples/src/lib/llm-eval-with-results.ts).

> **Note:** Structured results display as `[structured]` in the terminal summary table but are preserved in full when sent to the Orq platform and OpenTelemetry spans.

#### Deployment Helper

Easily invoke Orq deployments within your evaluation jobs:

```typescript
import { evaluatorq, job, invoke, deployment } from "@orq-ai/evaluatorq";

// Simple one-liner with invoke()
const summarizeJob = job("summarizer", async (data) => {
  const text = data.inputs.text as string;
  return await invoke("my-deployment", { inputs: { text } });
});

// Full response with deployment()
const analyzeJob = job("analyzer", async (data) => {
  const response = await deployment("my-deployment", {
    inputs: { text: data.inputs.text },
    metadata: { source: "evaluatorq" },
  });
  console.log("Raw:", response.raw);
  return response.content;
});

// Chat-style with messages
const chatJob = job("chatbot", async (data) => {
  return await invoke("chatbot", {
    messages: [{ role: "user", content: data.inputs.question as string }],
  });
});

// Thread tracking for conversations
const conversationJob = job("assistant", async (data) => {
  return await invoke("assistant", {
    inputs: { query: data.inputs.query },
    thread: { id: "conversation-123" },
  });
});
```

The `invoke()` function returns the text content directly, while `deployment()` returns an object with both `content` and `raw` response for more control.

## 🔧 Configuration

### Environment Variables

- `ORQ_API_KEY`: API key for Orq platform integration (required for dataset access and sending results). Also enables automatic OTEL tracing to Orq.
- `ORQ_BASE_URL`: Base URL for Orq platform (default: `https://my.orq.ai`)
- `OTEL_EXPORTER_OTLP_ENDPOINT`: Custom OpenTelemetry collector endpoint (overrides default Orq endpoint)
- `OTEL_EXPORTER_OTLP_HEADERS`: Headers for OTEL exporter (format: `key1=value1,key2=value2`)
- `ORQ_DEBUG`: Enable debug logging for tracing setup

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

## 🔍 OpenTelemetry Tracing

Evaluatorq automatically creates OpenTelemetry spans for observability into your evaluation runs.

### Span Hierarchy

```
orq.job (independent root per job execution)
└── orq.evaluation (child span per evaluator)
```

### Auto-Enable with Orq

When `ORQ_API_KEY` is set, traces are automatically sent to the Orq platform:

```bash
ORQ_API_KEY=your-api-key bun run my-eval.ts
```

### Custom OTEL Endpoint

Send traces to any OpenTelemetry-compatible backend:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector:4318 \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer token" \
bun run my-eval.ts
```

## ✅ Pass/Fail Tracking

Evaluators can return a `pass` field to indicate pass/fail status:

```typescript
const qualityEvaluator: Evaluator = {
  name: "quality-check",
  scorer: async ({ output }) => {
    const score = calculateQuality(output);
    return {
      value: score,
      pass: score >= 0.8,  // Pass if meets threshold
      explanation: `Quality score: ${score}`,
    };
  },
};
```

**CI/CD Integration:** When any evaluator returns `pass: false`, the process exits with code 1. This enables fail-fast behavior in CI/CD pipelines.

**Pass Rate Display:** The summary table shows pass rate when evaluators use the `pass` field:

```
┌──────────────────────┬─────────────────┐
│ Pass Rate            │ 75% (3/4)       │
└──────────────────────┴─────────────────┘
```

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

type EvaluationResultCellValue =
  | string
  | number
  | Record<string, string | number | Record<string, string | number>>;

type EvaluationResultCell = {
  type: string;
  value: Record<string, EvaluationResultCellValue>;
};

interface EvaluatorScore {
  evaluatorName: string;
  score: EvaluationResult<number | boolean | string | EvaluationResultCell>;
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
  pass?: boolean;  // Optional pass/fail indicator for CI/CD integration
};

type Scorer = (
  params: ScorerParameter,
) => Promise<
  EvaluationResult<string | number | boolean | EvaluationResultCell>
>;

// Deployment helper types
interface DeploymentOptions {
  inputs?: Record<string, unknown>;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  thread?: { id: string; tags?: string[] };
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

interface DeploymentResponse {
  content: string;  // Text content of the response
  raw: unknown;     // Raw API response
}

// Invoke deployment and get text content
function invoke(key: string, options?: DeploymentOptions): Promise<string>;

// Invoke deployment and get full response
function deployment(key: string, options?: DeploymentOptions): Promise<DeploymentResponse>;
```

## 🛠️ Development

```bash
# Build the package
bunx nx build evaluatorq

# Run type checking
bunx nx typecheck evaluatorq
```
