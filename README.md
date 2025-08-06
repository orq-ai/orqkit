# 🚀 OrqKit

Open source tools from [Orq AI](https://orq.ai) for building robust AI evaluation pipelines. This monorepo contains TypeScript packages designed to help developers evaluate, test, and improve their AI applications.

## 🌟 About Orq AI

[Orq AI](https://orq.ai) is a platform for building, deploying, and monitoring AI applications. We believe in providing developers with powerful, open-source tools that integrate seamlessly with our platform while remaining useful as standalone utilities.

## 📦 Packages

This monorepo contains the following open-source packages:

| Package                                       | Description                                                                                  | Version                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`@orq-ai/evaluatorq`](./packages/evaluatorq) | Core evaluation framework with Effect-based architecture for running parallel AI evaluations | ![npm](https://img.shields.io/npm/v/@orq-ai/evaluatorq) |
| [`@orq-ai/cli`](./packages/cli)               | Command-line interface for discovering and running evaluation files                          | ![npm](https://img.shields.io/npm/v/@orq-ai/cli)        |

## 🎯 Why OrqKit?

- **Developer-Friendly**: Full TypeScript support with comprehensive type definitions
- **Reusability**: Giving back to the community by sharing reusable tools and examples that we wrote initially for in-house use
- **Platform Integration**: Seamlessly works with Orq AI platform, but fully functional standalone
- **Continuous Integration**: Make it part of your CI/CD pipeline in order to run evaluations on every commit or pull request

## 🚀 Quick Start

### Install Evaluatorq

```bash
# Install the core evaluation framework
npm install @orq-ai/evaluatorq

# Install the CLI globally (optional)
npm install -g @orq-ai/cli
```

### Create Your First Evaluation

```typescript
// example-llm.eval.ts
import Anthropic from "@anthropic-ai/sdk";
import { type DataPoint, evaluatorq, type Job } from "@orq/evaluatorq";

import { containsNameValidator, isItPoliteLLMEval } from "../evals.js";

const claude = new Anthropic();

const greet: Job = async (data: DataPoint) => {
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

  return {
    name: "greet",
    output: output.content[0].type === "text" ? output.content[0].text : "",
  };
};

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

💡 Tip: Details are shown below each row. Use print:false to get raw JSON results.

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

# Run examples
cd examples
bun run src/lib/dataset-example.ts
```

## 📚 Documentation

- [Evaluatorq Documentation](./packages/evaluatorq/README.md) - Core evaluation framework
- [CLI Documentation](./packages/cli/README.md) - Command-line interface
- [Examples](./examples) - Sample evaluation implementations
- [Orq AI Platform Docs](https://docs.orq.ai) - Platform documentation

## 🤝 Contributing

We welcome contributions! Whether it's bug fixes, new features, or documentation improvements, please feel free to make a pull request.

### Have an idea?

- **Create an issue**: If you have ideas for improvements or new features, please [create an issue](https://github.com/orq-ai/orqkit/issues/new) to discuss it
- **Check the roadmap**: Take a look at our [public roadmap](https://github.com/orgs/orq-ai/projects/3) to see what we're working on and what's planned

## 📄 License

This is free and unencumbered software released into the public domain. See [UNLICENSE](https://unlicense.org) for details.

---

<p align="center">
  Built with ❤️ by <a href="https://orq.ai">Orq AI</a>
  <br>
  <a href="https://orq.ai">Website</a> • <a href="https://docs.orq.ai">Documentation</a> • <a href="https://github.com/orq-ai">GitHub</a>
</p>