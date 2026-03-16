# @orq-ai/evaluatorq

An evaluation framework library that provides a flexible way to run parallel evaluations and optionally integrate with the Orq AI platform.

## 🎯 Features

- **Parallel Execution**: Run multiple evaluation jobs concurrently with progress tracking
- **Flexible Data Sources**: Support for inline data, promises, and Orq platform datasets
- **Type-safe**: Fully written in TypeScript
- **Orq Platform Integration**: Seamlessly fetch and evaluate datasets from Orq AI (optional)
- **OpenTelemetry Tracing**: Built-in observability with automatic span creation for jobs and evaluators
- **Pass/Fail Tracking**: Evaluators can return pass/fail status for CI/CD integration
- **Integrations**: LangChain, LangGraph, and Vercel AI SDK agent integration

## 📖 Table of Contents

- [Installation](#-installation)
- [Getting Started](#-getting-started)
- [Quick Start](#-quick-start)
- [LangChain Integration](#-langchain-integration)
- [Vercel AI SDK Integration](#-vercel-ai-sdk-integration)
- [Configuration](#-configuration)
- [Orq Platform Integration](#-orq-platform-integration)
- [OpenTelemetry Tracing](#-opentelemetry-tracing)
- [Pass/Fail Tracking](#-passfail-tracking)
- [API Reference](#-api-reference)

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

For LangChain/LangGraph integration:

```bash
npm install langchain @langchain/core @langchain/langgraph
```

For Vercel AI SDK integration:

```bash
npm install ai
```

## 🏁 Getting Started

New to evaluatorq? Follow this path to get up and running:

| Step | What you'll learn | Example |
|------|------------------|---------|
| 1. **Basic eval** | Run your first evaluation with inline data | [`pass-fail-simple.ts`](../../examples/src/lib/basics/pass-fail-simple.ts) |
| 2. **Multiple jobs** | Run multiple jobs in parallel on each data point | [`example-runners.ts`](../../examples/src/lib/basics/example-runners.ts) |
| 3. **Reusable patterns** | Create reusable jobs and evaluators | [`eval-reuse.eval.ts`](../../examples/src/lib/basics/eval-reuse.eval.ts) |
| 4. **Datasets** | Load data from the Orq platform | [`dataset-example.eval.ts`](../../examples/src/lib/datasets/dataset-example.eval.ts) |
| 5. **Structured scores** | Return multi-dimensional metrics | [`structured-rubric.eval.ts`](../../examples/src/lib/structured/structured-rubric.eval.ts) |
| 6. **LangChain agent** | Evaluate a LangChain/LangGraph agent | [`langchain-agent-eval.ts`](../../examples/src/lib/integrations/langchain/langchain-agent-eval.ts) |
| 7. **Vercel AI SDK** | Evaluate a Vercel AI SDK agent | [`vercel_ai_sdk_integration_example.ts`](../../examples/src/lib/integrations/vercel/vercel_ai_sdk_integration_example.ts) |

> **Tip:** Start with step 1 and work your way up. Each example builds on concepts from the previous one.

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

> **Tip:** The `job()` helper preserves the job name in error messages. Always prefer `job("name", fn)` over raw functions for better debugging.

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

> **Tip:** Use `parallelism` to control how many data points are processed concurrently. Start with a low value (3-5) when calling external APIs to avoid rate limits.

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

#### Dashboard Organization with `path`

Use the `path` parameter to organize evaluation results into folders on the Orq dashboard:

```typescript
await evaluatorq("my-evaluation", {
  path: "MyProject/Evaluations/Unit Tests",
  data: [...],
  jobs: [...],
  evaluators: [...],
});
```

> **Tip:** Use paths like `"Team/Sprint-42/Feature-X"` to keep experiments organized across teams and sprints.

See [`path-organization.eval.ts`](../../examples/src/lib/structured/path-organization.eval.ts) for a complete example.

#### Evaluation Description

Add a description to document the purpose of each evaluation run:

```typescript
await evaluatorq("model-comparison", {
  description: "Compare GPT-4o vs Claude on customer support responses",
  data: [...],
  jobs: [...],
  evaluators: [...],
});
```

#### Structured Evaluation Results

Evaluators can return structured, multi-dimensional metrics using `EvaluationResultCell`. This is useful for metrics like BERT scores, ROUGE-N scores, or any evaluation that produces multiple sub-scores.

See the runnable examples in the `examples/` directory:

- [`structured-rubric.eval.ts`](../../examples/src/lib/structured/structured-rubric.eval.ts) - Multi-criteria quality rubric (relevance, coherence, fluency)
- [`structured-sentiment.eval.ts`](../../examples/src/lib/structured/structured-sentiment.eval.ts) - Sentiment distribution breakdown (positive, negative, neutral)
- [`structured-safety.eval.ts`](../../examples/src/lib/structured/structured-safety.eval.ts) - Toxicity/safety severity scores with pass/fail tracking

For a BERT score example using the Orq platform, see [`llm-eval-with-results.ts`](../../examples/src/lib/basics/llm-eval-with-results.ts).

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

## 🔗 LangChain Integration

Evaluatorq provides integration with LangChain and LangGraph agents, converting their outputs to the OpenResponses format for standardized evaluation.

The LangChain integration allows you to:
- Wrap LangChain agents created with `createAgent()` for use in evaluatorq jobs
- Wrap LangGraph compiled graphs for stateful agent evaluation
- Automatically convert agent outputs to OpenResponses format
- Evaluate agent behavior using standard evaluatorq evaluators

### System Instructions

Use the `instructions` option to inject a system prompt into the agent. It can be a static string or a function that builds instructions dynamically from the dataset row:

```typescript
import { wrapLangChainAgent } from "@orq-ai/evaluatorq/langchain";

// Static instructions
const job = wrapLangChainAgent(agent, {
  name: "my-agent",
  instructions: "You are a helpful weather assistant.",
});

// Dynamic instructions from dataset inputs
const job = wrapLangChainAgent(agent, {
  name: "research-agent",
  instructions: (data) =>
    `Research the topic: ${data.inputs.topic}. Focus on ${data.inputs.focus}.`,
});
```

### Input Modes

The wrapper reads the user input from `data.inputs` in three ways:

- **`prompt`** (default): `data.inputs.prompt` — a single string, sent as one user message.
- **`messages`**: `data.inputs.messages` — an array of `{ role, content }` objects, sent as-is.
- **Both**: when both are present, `messages` are sent first, followed by `prompt` as a final user message.

Change the prompt key with the `promptKey` option (e.g., `{ promptKey: "question" }`).

### Extracting Text

Agent wrappers return a full OpenResponses object. Use `extractText()` to pull out the assistant's reply:

```typescript
import { extractText } from "@orq-ai/evaluatorq/openresponses";

const scorer = async ({ output }) => {
  const text = extractText(output);
  return { value: text.length > 0 ? 1 : 0 };
};
```

### Examples

Complete examples are available in the examples folder:

- **LangChain Agent**: [`examples/src/lib/integrations/langchain/langchain-agent-eval.ts`](../../examples/src/lib/integrations/langchain/langchain-agent-eval.ts)
- **LangGraph Agent**: [`examples/src/lib/integrations/langchain/langgraph-agent-eval.ts`](../../examples/src/lib/integrations/langchain/langgraph-agent-eval.ts)
- **LangChain Research Agent (advanced)**: [`examples/src/lib/integrations/langchain/langchain-research-eval.ts`](../../examples/src/lib/integrations/langchain/langchain-research-eval.ts) — Dataset-driven research agent with dynamic `instructions` and multi-criteria evaluators
- **LangGraph Research Agent (advanced)**: [`examples/src/lib/integrations/langchain/langgraph-research-eval.ts`](../../examples/src/lib/integrations/langchain/langgraph-research-eval.ts) — Multi-tool research agent with correctness, tool chain, quality, completeness, and efficiency evaluators

> **Tip:** Pass the `instructions` option to `wrapLangChainAgent` for dynamic system prompts — no need to write a custom job function.

## 🤖 Vercel AI SDK Integration

Evaluatorq integrates with the Vercel AI SDK, allowing you to wrap AI SDK agents and evaluate them using the standard evaluatorq framework.

The Vercel AI SDK integration allows you to:
- Wrap Vercel AI SDK `ToolLoopAgent` instances for use in evaluatorq jobs
- Automatically convert agent outputs to OpenResponses format
- Evaluate agent behavior using standard evaluatorq evaluators

The same `instructions`, `messages` input, and `extractText` support described in the LangChain section also applies to `wrapAISdkAgent`.

### Examples

Complete examples are available in the examples folder:

- **Vercel AI SDK Agent**: [`examples/src/lib/integrations/vercel/vercel_ai_sdk_integration_example.ts`](../../examples/src/lib/integrations/vercel/vercel_ai_sdk_integration_example.ts)
- **Vercel AI SDK Dataset Eval**: [`examples/src/lib/integrations/vercel/vercel_ai_sdk_dataset_example.ts`](../../examples/src/lib/integrations/vercel/vercel_ai_sdk_dataset_example.ts) — Dataset-based weather agent evaluation with expected output comparison
- **Vercel Multi-Agent Eval (advanced)**: [`examples/src/lib/integrations/vercel/vercel-multi-agent-eval.ts`](../../examples/src/lib/integrations/vercel/vercel-multi-agent-eval.ts) — Research + math agents with `instructions` parameter, scored on correctness, tool usage, quality rubric, and safety

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
  - `parallelism`: Number of concurrent jobs (default: 1)
  - `path`: Optional string for organizing results on the Orq dashboard (e.g., `"Project/Category"`)
  - `description`: Optional string describing the evaluation run

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

// Integration wrappers
import { wrapLangChainAgent, wrapLangGraphAgent } from "@orq-ai/evaluatorq/langchain";
import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";
import type { ResponseResource } from "@orq-ai/evaluatorq/openresponses";
import { extractText } from "@orq-ai/evaluatorq/openresponses";

// Extract the assistant's text reply from an OpenResponses output
function extractText(output: unknown): string;

// Options accepted by wrapLangChainAgent, wrapLangGraphAgent, and wrapAISdkAgent
interface AgentJobOptions {
  /** Job name (defaults to "agent" or agent.id) */
  name?: string;
  /** Key in data.inputs to use as the prompt (defaults to "prompt") */
  promptKey?: string;
  /** Static string or function returning system instructions */
  instructions?: string | ((data: DataPoint) => string);
}

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
