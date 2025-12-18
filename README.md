# 🚀 OrqKit

Tools from [Orq AI](https://orq.ai) for building robust AI evaluation pipelines, online or offline. The monorepo contains utilities for running evaluations, building with LLMs while optionally integrating with the orq.ai platform.

## 🎯 Why OrqKit?

**The Problem:** Testing LLM applications is hard. You need to:
- Run evaluations across multiple prompts and models
- Track performance over time
- Ensure model updates don't break existing functionality
- Integrate evaluation into CI/CD pipelines

**The Solution:** OrqKit provides tools to:
- **Evaluate at Scale** - Run parallel evaluations across datasets with built-in retry logic
- **Test Like You Deploy** - Use the same evaluation framework locally and in CI/CD
- **Measure What Matters** - Pre-built evaluators for common LLM metrics (coming soon)
- **Track Results** - Automatic result tracking when connected to the orq platform, otherwise build it to your own dashboard

## 🌟 About Orq AI

[Orq AI](https://orq.ai) is a platform for building, deploying, and monitoring AI applications. We believe in providing developers with powerful, open-source tools that integrate seamlessly with our platform while remaining useful as standalone utilities.

## 📦 Packages

This monorepo contains the following open-source packages:

| Package                                                 | Description                                                                                  | Docs                                           | Version                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`@orq-ai/evaluatorq`](./packages/evaluatorq)           | Core evaluation framework with Effect-based architecture for running parallel AI evaluations | [README](./packages/evaluatorq/README.md)      | [![npm](https://img.shields.io/npm/v/@orq-ai/evaluatorq)](https://www.npmjs.com/package/@orq-ai/evaluatorq)           |
| [`evaluatorq`](./packages/evaluatorq-py)                | Python evaluation framework for running parallel AI evaluations                              | [README](./packages/evaluatorq-py/README.md)   | [![PyPI](https://img.shields.io/pypi/v/evaluatorq)](https://pypi.org/project/evaluatorq/)                             |
| [`@orq-ai/evaluators`](./packages/evaluators)           | Reusable evaluators for AI evaluation frameworks                                             | [README](./packages/evaluators/README.md)      | [![npm](https://img.shields.io/npm/v/@orq-ai/evaluators)](https://www.npmjs.com/package/@orq-ai/evaluators)           |
| [`@orq-ai/cli`](./packages/cli)                         | Command-line interface for discovering and running evaluation files                          | [README](./packages/cli/README.md)             | [![npm](https://img.shields.io/npm/v/@orq-ai/cli)](https://www.npmjs.com/package/@orq-ai/cli)                         |
| [`@orq-ai/vercel-provider`](./packages/vercel-provider) | Vercel AI SDK provider for seamless integration with Orq AI platform                         | [README](./packages/vercel-provider/README.md) | [![npm](https://img.shields.io/npm/v/@orq-ai/vercel-provider)](https://www.npmjs.com/package/@orq-ai/vercel-provider) |
| [`@orq-ai/n8n-nodes-orq`](./packages/n8n-nodes-orq)     | n8n community nodes for integrating Orq AI deployments and knowledge bases                   | [README](./packages/n8n-nodes-orq/README.md)   | [![npm](https://img.shields.io/npm/v/@orq-ai/n8n-nodes-orq)](https://www.npmjs.com/package/@orq-ai/n8n-nodes-orq)     |
| [`@orq-ai/tiny-di`](./packages/tiny-di)                 | Minimal dependency injection container with TypeScript support                               | [README](./packages/tiny-di/README.md)         | [![npm](https://img.shields.io/npm/v/@orq-ai/tiny-di)](https://www.npmjs.com/package/@orq-ai/tiny-di)                 |


## 🚀 Quick Start

### Install Packages

```bash
# Install the core evaluation framework
npm install @orq-ai/evaluatorq

# Install the CLI globally (optional)
npm install -g @orq-ai/cli

# Install the Vercel AI SDK provider
npm install @orq-ai/vercel-provider
```

### Create Your First Evaluation

```typescript
// example-llm.eval.ts
import Anthropic from "@anthropic-ai/sdk";
import { type DataPoint, evaluatorq, job } from "@orq/evaluatorq";

import { containsNameValidator, isItPoliteLLMEval } from "../evals.js";

const claude = new Anthropic();

const greet = job("greet", async (data: DataPoint) => {
  const output = await claude.messages.create({
    stream: false,
    max_tokens: 100,
    model: "claude-3-5-haiku-latest",
    system: `For testing purposes please be really lazy and sarcastic in your response, not polite at all.`,
    messages: [
      {
        role: "user",
        content: `Hello My name is ${data.inputs.name}`,
      },
    ],
  });

  // LLM response: *sighs dramatically* Oh great, another Bob. Let me guess, you want me to care about something? Fine. Hi, Bob. What do you want?

  return output.content[0].type === "text" ? output.content[0].text : "";
});

await evaluatorq("dataset-evaluation", {
  data: [
    { inputs: { name: "Alice" } },
    { inputs: { name: "Bob" } },
    Promise.resolve({ inputs: { name: "Márk" } }),
  ],
  jobs: [greet],
  evaluators: [containsNameValidator, isItPoliteLLMEval],
  parallelism: 2,
  print: true,
});
```

### Run It

```bash
# Using the CLI
orq evaluate example-llm.eval.ts

# Or directly with a runtime
bun run example-llm.eval.ts
```

#### Output

```bash
orq evaluate ./examples/src/lib/cli/example-llm.eval.ts
Running evaluations:

⚡ Running example-llm.eval.ts...
⠏ Evaluating results 3/3 (100%) - Running evaluator: is-it-polite

EVALUATION RESULTS

Summary:
┌──────────────────────┬─────────────────┐
│ Metric               │ Value           │
├──────────────────────┼─────────────────┤
│ Total Data Points    │ 3               │
├──────────────────────┼─────────────────┤
│ Failed Data Points   │ 0               │
├──────────────────────┼─────────────────┤
│ Total Jobs           │ 3               │
├──────────────────────┼─────────────────┤
│ Failed Jobs          │ 0               │
├──────────────────────┼─────────────────┤
│ Success Rate         │ 100%            │
└──────────────────────┴─────────────────┘

Detailed Results:
┌──────────────────────────┬────────────────────────┐
│ Evaluators               │ greet                  │
├──────────────────────────┼────────────────────────┤
│ contains-name            │ 100.0%                 │
├──────────────────────────┼────────────────────────┤
│ is-it-polite             │ 0.08                   │
└──────────────────────────┴────────────────────────┘

💡 Tip: Use print:false to get raw JSON results.

✔ ✓ Evaluation completed successfully

✅ example-llm.eval.ts completed
```

## 🔗 Integration with Orq Platform

While our tools work great standalone, they shine when integrated with the [Orq AI platform](https://orq.ai):

- **Dataset Management**: Store and version your evaluation datasets
- **Result Tracking**: Track evaluation results over time
- **Team Collaboration**: Share evaluations and results with your team
- **API Integration**: Use your [Orq API key](https://my.orq.ai/) to access platform features

```typescript
// Using Orq platform datasets
await evaluatorq("platform-eval", {
  data: {
    datasetId: "your-dataset-id", // From Orq platform
  },
  jobs: [...],
  evaluators: [...],
});
```

### Use Vercel AI SDK Provider

```typescript
// ai-integration.ts
import { createOrqAiProvider } from "@orq-ai/vercel-provider";
import { generateText } from "ai";

const orq = createOrqAiProvider({
  apiKey: process.env.ORQ_API_KEY,
});

const { text } = await generateText({
  model: orq("gpt-4"),
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(text);
```


## 🛠️ Development

This is an Nx-based monorepo using Bun as the package manager.

```bash
# Clone the repository
git clone https://github.com/orq-ai/orqkit.git
cd orqkit

# Install dependencies
bun install

# Build all packages
bunx nx build evaluatorq
bunx nx build cli
bunx nx build vercel-provider

# Run examples
cd examples
bun run src/lib/dataset-example.ts
```

## 📚 Documentation

- [Evaluatorq Documentation](./packages/evaluatorq/README.md) - Core evaluation framework
- [CLI Documentation](./packages/cli/README.md) - Command-line interface
- [Vercel Provider Documentation](./packages/vercel-provider/README.md) - Vercel AI SDK provider
- [Examples](./examples/README.md) - Sample evaluation implementations
- [Orq AI Platform Docs](https://docs.orq.ai) - Platform documentation

## 🤝 Contributing

We welcome contributions! Whether it's bug fixes, new features, or documentation improvements, please feel free to make a pull request.

## 📦 Releases

We release all packages to npm using nx under one version number.

```bash
# Publish the packages using nx. this will run the release workflow, increment the version, build the libraries and publish the packages to npm.
# check the docs for more details: https://nx.dev/recipes/nx-release/release-npm-packages
nx release
```

### Have an idea?

- **Create an issue**: If you have ideas for improvements or new features, please [create an issue](https://github.com/orq-ai/orqkit/issues/new) to discuss it
- **Check the roadmap**: Take a look at our [public roadmap](https://github.com/orgs/orq-ai/projects/3) to see what we're working on and what's planned

---

<p align="center">
  Built with ❤️ by <a href="https://orq.ai">Orq AI</a>
  <br>
  <a href="https://orq.ai">Website</a> • <a href="https://docs.orq.ai">Documentation</a> • <a href="https://github.com/orq-ai">GitHub</a>
</p>