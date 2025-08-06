# 🚀 OrqKit

Open source tools from [Orq AI](https://orq.ai) for building robust AI evaluation pipelines. This monorepo contains TypeScript packages designed to help developers evaluate, test, and improve their AI applications.

## 🌟 About Orq AI

[Orq AI](https://orq.ai) is a platform for building, deploying, and monitoring AI applications. We believe in providing developers with powerful, open-source tools that integrate seamlessly with our platform while remaining useful as standalone utilities.

## 📦 Packages

This monorepo contains the following open-source packages:

| Package                                                   | Description                                                                                  | Version                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`@orq-ai/evaluatorq`](./packages/evaluatorq)            | Core evaluation framework with Effect-based architecture for running parallel AI evaluations | ![npm](https://img.shields.io/npm/v/@orq-ai/evaluatorq)      |
| [`@orq-ai/cli`](./packages/cli)                          | Command-line interface for discovering and running evaluation files                          | ![npm](https://img.shields.io/npm/v/@orq-ai/cli)             |
| [`@orq-ai/vercel-provider`](./packages/vercel-provider)  | Vercel AI SDK provider for seamless integration with Orq AI platform                        | ![npm](https://img.shields.io/npm/v/@orq-ai/vercel-provider) |

## 🎯 Why OrqKit?

- **Developer-Friendly**: Full TypeScript support with comprehensive type definitions
- **Reusability**: Giving back to the community by sharing reusable tools and examples that we wrote initially for in-house use
- **Platform Integration**: Seamlessly works with Orq AI platform, but fully functional standalone
- **Continuous Integration**: Make it part of your CI/CD pipeline in order to run evaluations on every commit or pull request

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
// my-eval.eval.ts
import { evaluatorq } from "@orq-ai/evaluatorq";

await evaluatorq("hello-world", {
  data: [
    { inputs: { name: "Alice" } },
    { inputs: { name: "Bob" } },
  ],
  jobs: [
    async (data) => ({
      name: "greeter",
      output: `Hello, ${data.inputs.name}!`,
    }),
  ],
  evaluators: [
    {
      name: "friendly-check",
      scorer: async ({ output }) => 
        output.includes("Hello"),
    },
  ],
});
```

### Run It

```bash
# Using the CLI
orq evaluate my-eval.eval.ts

# Or directly with a runtime
bun run my-eval.eval.ts
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

#### Output

```bash
orq evaluate ./examples/src/lib/eval-reuse.eval.ts

Running evaluations:

⚡ Running eval-reuse.eval.ts...
⠋ Initializing evaluation...

EVALUATION RESULTS

Summary:
┌──────────────────────┬─────────────────┐
│ Metric               │ Value           │
├──────────────────────┼─────────────────┤
│ Total Data Points    │ 1               │
├──────────────────────┼─────────────────┤
│ Failed Data Points   │ 0               │
├──────────────────────┼─────────────────┤
│ Total Jobs           │ 1               │
├──────────────────────┼─────────────────┤
│ Failed Jobs          │ 0               │
├──────────────────────┼─────────────────┤
│ Success Rate         │ 100%            │
└──────────────────────┴─────────────────┘

Detailed Results:
┌───────────────────────────────────────────────────────────┬─────────────────────────────────────────────┐
│ Evaluators                                                │ text-analyzer                               │
├───────────────────────────────────────────────────────────┼─────────────────────────────────────────────┤
│ max-length-10                                             │ 100.0%                                      │
└───────────────────────────────────────────────────────────┴─────────────────────────────────────────────┘

💡 Tip: Details are shown below each row. Use print:false to get raw JSON results.

✔ ✓ Evaluation completed successfully

✅ eval-reuse.eval.ts completed
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
bunx nx build vercel-provider

# Run examples
cd examples
bun run src/lib/dataset-example.ts
```

## 📚 Documentation

- [Evaluatorq Documentation](./packages/evaluatorq/README.md) - Core evaluation framework
- [CLI Documentation](./packages/cli/README.md) - Command-line interface
- [Vercel Provider Documentation](./packages/vercel-provider/README.md) - Vercel AI SDK provider
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