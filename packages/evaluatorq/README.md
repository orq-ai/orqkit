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

> **Tip:** Use `datapointParallelism` to control concurrent data points and `llmParallelism` to bound requests through evaluatorq's LLM helpers. Start with 3 to 5 concurrent requests when calling an external API.

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

- `ORQ_API_KEY`: API key for Orq platform integration (required for dataset access and sending results). Also enables automatic OTEL tracing to Orq. When it is set, `simulate()` uploads each run as an experiment and starts tracing; pass `uploadResults: false` to skip the upload.
- `ORQ_BASE_URL`: Base URL for Orq platform (default: `https://my.orq.ai`). Must be a full `http` or `https` URL: an invalid value raises, and tracing turns off with a warning. A plain `http` host other than localhost warns, because the API key is sent to it.
- `ROUTER_BASE_URL`: Deprecated way to set the same host, used when `ORQ_BASE_URL` is not set. Validated the same way.
- `EVALUATORQ_LLM_MAX_TOKENS`: Output token budget for each simulator and judge call (default: `10000`). An invalid value warns and uses the default.
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

## Trace inputs

`fetchTraces` uses the v3 trace API and reads every span page and its message-bearing details. Search mode requires an explicit time window. Filters use `{ field, op, values }` from the v3 trace filter grammar.

```typescript
import { fetchTraces, TraceInput } from "@orq-ai/evaluatorq";

const traces = await fetchTraces(new TraceInput({
  startTime: new Date(Date.now() - 60 * 60 * 1000),
  endTime: new Date(),
  limit: 20,
}));
```

An exact lookup, `new TraceInput({ traceId, spanId })`, needs no dates; `spanId` is optional. Unreadable or incomplete span imports carry `importError`. Use `partitionTraces` to separate them from usable traces. Invalid search responses reject the search.

The v3 API does not expose the named trace-level feedback used by the legacy `correction` expected-output mapping. V3 corrections refer to evaluator results and are not imported as expected answers.

Pass a `TraceInput` or `ExperimentInput` directly to `evaluatorq()` to score recorded responses. Both sources default to `inference: false`; setting `inference: true` rejects the call. No jobs are required in replay mode, and supplied jobs are ignored.

```typescript
import { evaluatorq, ExperimentInput, TraceInput } from "@orq-ai/evaluatorq";

await evaluatorq("trace replay", {
  data: new TraceInput({ traceId: "trace-id" }),
  evaluators,
});

await evaluatorq("experiment replay", {
  data: new ExperimentInput({ experimentId: "experiment-id", runId: "run-id" }),
  evaluators,
});
```

Experiment replay requires `ORQ_API_KEY`. Omit `runId` to load the latest run. Trace imports retain their recorded output structure, and failed imports remain failed rows. A trace search with no matches rejects the call.

For arrays or datasets, set `inference: false` explicitly to replay `inputs.recordedOutput` or the last assistant text in `inputs.messages`. Dataset replay loads messages even when `includeMessages` is false. These rules also apply to `evaluatorqEffect()`.


To build simulation inputs from traces, summarize the conversations once and reuse the summaries in either generation mode:

```typescript
import {
  datapointsFromTraces,
  extendFromTraces,
  fetchTraceConversations,
  summarizeConversations,
} from "@orq-ai/evaluatorq/simulation";

const conversations = await fetchTraceConversations({
  startTime: new Date(Date.now() - 60 * 60 * 1000),
  endTime: new Date(),
  limit: 20,
});
const summaries = await summarizeConversations(conversations);
const direct = await datapointsFromTraces(conversations, { summaries });
const extended = await extendFromTraces(conversations, {
  numDatapoints: 20,
  summaries,
});
```

Both outputs can be passed to `simulate({ datapoints, ... })`. `datapointsFromTraces` also accepts a `TraceInput` or loaded `Trace` objects. Fetch credentials use `orqApiKey`; model credentials use `apiKey` or the supplied client.

`TraceAnalysisConfig` controls summary length targets, output budgets, the profile sample cap, redaction instructions and fresh opening messages. Supplied summaries are authoritative: missing entries are dropped without another model call. Only summarization reads raw transcripts; later inference and profiling read summaries. Redaction is a model instruction. With `generateFirstMessage: false`, direct mode replays the recorded opening; a failed fresh-opening call also replays it and warns, matching Python.

Simulation inputs can also come from an Orq dataset or a prior experiment:

```typescript
import {
  datapointsFromDataset,
  datapointsFromExperiment,
  extendFromDataset,
  extendFromExperiment,
  simulate,
} from "@orq-ai/evaluatorq/simulation";

const original = await datapointsFromDataset(datasetId);
const priorRun = await datapointsFromExperiment(experimentId, { runId });
const fresh = await extendFromDataset(datasetId, {
  numPersonas: 2,
  numScenarios: 3,
});
const more = await extendFromExperiment(experimentId, { runId });
await simulate({ datasetId, target });
await simulate({ experimentId, experimentRunId: runId, target });
```

These sources require `ORQ_API_KEY`, or `apiKey` on the loader/extension functions. Extension uses that key for model calls unless `llmConfig.client` supplies a client. Omit the experiment run ID to select the latest run. `datasetId`, `experimentId`, `datapoints` and `personas`/`scenarios` are mutually exclusive inputs to `simulate()`.

Each source row must encode exactly one conversation using `datapoint`, a one-element `datapoints` array, `persona` plus `scenario`, or one-element `personas` plus `scenarios` arrays. Full datapoints include `id`, `user_system_prompt` and `first_message`. JSON strings are accepted for the singular objects and `datapoints`; encode objects as JSON strings when creating scalar dataset columns. Invalid rows reject the load with the source ID and row index. Empty sources and incomplete pagination also fail.

Extension deduplicates identical seed objects while preserving distinct variants with the same name, then asks for new coverage. It returns the grid of personas and scenarios actually generated, so its count can differ from the requested grid. Experiment exports use v3 and are read completely before parsing.

Save and replay simulation runs with their exact cases:

```typescript
import { simulate, SimulationRun } from "@orq-ai/evaluatorq/simulation";

await simulate({ target, datapoints, maxTurns: 3, save: true });
await simulate({ target, previousRun: "latest" });
await simulate({ target, previousRun: "nightly", maxTurns: 5 });
const run = await SimulationRun.load(savedPath);
```

Saved runs go to `.evaluatorq/sim-runs` under the working directory, or `sim-runs` under `EVALUATORQ_DIR`. Automatic filenames avoid collisions. With `save: true`, `reportPath` writes JSON to an explicit path and replaces that file; `report` is its alias. Saving is opt-in. A save failure warns and leaves completed results available to the caller.

`previousRun` accepts a path, filename, saved name, manifest run ID or unique ID prefix, or `latest`. Replay restores the saved turn cap unless `maxTurns` overrides it, and uses the new invocation's target and evaluators. It regenerates neither cases nor opening messages. A prior run without cases or recorded openings cannot be replayed. Newer replay formats and conflicting version fields are rejected.

Saved model fields use Python-compatible snake_case; camelCase run files remain readable. Message content, tool arguments and caller metadata retain their data. Runs include per-turn and conversation usage, aggregate generation/conversation/analysis usage, available pricing, trace handles and the uploaded experiment URL when supplied by the backend. Unknown costs remain null; `pricedCalls` indicates how much of the run was priced. First-opening generation is included in aggregate generation usage. Runtime results keep the legacy `token_usage` counters and expose richer `usage`; saved JSON uses `token_usage`. Custom simulators and judges can supply `getUsageDetails()`; legacy-only counters cannot recover missing prices or exact call counts. Opted-in runs also record completion, cancellation and failures in a manifest.

Recommendations and an executive summary are enabled by default and use the generator model. Set `recommendations: false` or `executiveSummary: false` to skip those model calls. Recommendations run only for concrete criterion, rule or turn-quality failures, and are retained when `save: true`. Customize their thresholds, result/suggestion limits, input caps and output budget with a `recommendations` config object. Capped recommendation inputs warn; an incomplete executive summary is omitted. Saved run totals include analysis calls and reported spend on failures.

Render saved results without further model calls:

```typescript
import { exportSimulationMarkdown, printSimulationSummary } from "@orq-ai/evaluatorq/simulation";

const markdown = await exportSimulationMarkdown(run.results, {
  target: run.target,
  runDate: run.createdAt,
  executiveSummary: run.executiveSummary,
  recommendations: run.recommendations,
  runTokenUsageTotal: run.tokenUsageTotal,
});
printSimulationSummary(run.results, { experimentUrl: run.experimentUrl });
```

Pass `runTokenUsageTotal` only for the full result set; omit it when rendering a filtered subset. Report sections retain unaudited criteria as unknown and separate execution errors from goal failures. Terminal summaries default to stderr and accept an `output` console.

Use `CallableTarget` from the root package for callbacks that need usage extraction, a reset hook or explicit agent capabilities. `fromChatCompletions` also preserves an `AgentResponse` returned by its callback. `fromOrqDeployment` returns an `AgentResponse`, retaining provider usage and forwarding simulation thread/run metadata.

`VercelAISdkTarget` from `@orq-ai/evaluatorq/ai-sdk` or the simulation entry point calls an HTTP endpoint. It accepts plain text, common JSON response shapes and the legacy AI SDK data stream protocol; `messageFormat: "v5"` (default) or `"v4"` controls replayed tool turns. It is separate from `fromAISdkAgent`, which calls an in-process SDK agent. HTTP UI SSE streams are not supported by this target.

`LangGraphTarget` from `@orq-ai/evaluatorq/langgraph` or `@orq-ai/evaluatorq/langchain` wraps a compiled graph. It owns a fresh checkpointer thread per clone, sends only the latest user turn, preserves ordered text/tool results and gathers usage through callbacks. Supply `agentContext` when the graph's capabilities cannot be introspected. `resetConversation()` starts a fresh thread; use independent clones for concurrent conversations.

`criteria_verified` is true only when every scenario criterion has received a valid judge audit, including `must_not_happen` criteria. Partial audits keep their per-criterion evidence in `metadata.criteria_meta`, but leave the run unverified and score `criteria_met` as zero. With no criteria, there is nothing to audit and the flag is true. `criteria_results` is a legacy boolean view; inspect `criteria_meta[].audited` to distinguish an unaudited default from a measured verdict.

## Trace signals

`@orq-ai/evaluatorq/signals` computes 60 deterministic signals on an ATIF trajectory, including tool behavior, autonomy, timing and eight derived tags. Use the format models to convert chat messages, Responses items or OTel spans first.

```typescript
import { ChatConversation } from "@orq-ai/evaluatorq/formats";
import { computeSignals, signalEvaluator, signalEvaluators } from "@orq-ai/evaluatorq/signals";

const trajectory = new ChatConversation({ messages }).toAtif();
const report = computeSignals(trajectory, { only: ["tool_error_count", "stalled"] });
const values = report.values();
const errorRate = signalEvaluator("tool_error_rate", { threshold: 0.1 });
const tagEvaluators = signalEvaluators("tags");
```

Selected tags also compute their metric dependencies. Results retain evidence and preconditions; missing source coverage produces `noBasis`, and `values()` omits those results. Tag evaluators fail when a tag fires. Numeric metrics produce a verdict only when a threshold is supplied, with values at or below it passing. Unsupported evaluator outputs are inconclusive. Evaluators accept native format models, chat message lists and objects containing `messages`.

`classifyToolRoles` and `classifyToolDoors` are separate, opt-in model calls. Role classification sends unknown tool names. Door classification sends each distinct scrubbed tool input and its description, preserving the first and last 2,000 characters of long inputs. An unresolved door stays unknown. Neither classifier executes the tools being classified.

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

**CI/CD Integration:** When any evaluator returns `pass: false`, the process exits with code 1. Set `exitOnFailure: false` to inspect failed results in the calling application. The redteam runner uses this option to save findings and finish cleanup.

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
  - `data`: Array of data points or promises, Orq dataset config, `TraceInput`, or `ExperimentInput`
  - `jobs`: Job functions to run on each data point, required when inference is enabled
  - `inference`: Defaults to false for trace and experiment sources, true otherwise
  - `evaluators`: Array of evaluator configurations
  - `datapointParallelism`: Number of concurrent data points (default: 10)
  - `llmParallelism`: Concurrent requests through evaluatorq's LLM helpers; inherits the enclosing limit when omitted, or use `-1` to remove this run's ceiling
  - `parallelism`: Deprecated alias for `datapointParallelism`; the new name takes precedence
  - `onDatapointComplete`: Optional sync or async callback, awaited once for each terminal result before releasing its datapoint slot. Callback failures fail the run and settle work already started.
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
