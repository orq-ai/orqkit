# 🚀 Orqkit

Open source tools from [Orq AI](https://orq.ai) for building robust AI evaluation pipelines. This monorepo contains TypeScript packages designed to help developers evaluate, test, and improve their AI applications.

## 🌟 About Orq AI

[Orq AI](https://orq.ai) is a platform for building, deploying, and monitoring AI applications. We believe in providing developers with powerful, open-source tools that integrate seamlessly with our platform while remaining useful as standalone utilities.

## 📦 Packages

This monorepo contains the following open-source packages:

| Package | Description | Version |
|---------|-------------|---------|
| [`@orq-ai/evaluatorq`](./packages/evaluatorq) | Core evaluation framework with Effect-based architecture for running parallel AI evaluations | ![npm](https://img.shields.io/npm/v/@orq-ai/evaluatorq) |
| [`@orq-ai/cli`](./packages/cli) | Command-line interface for discovering and running evaluation files | ![npm](https://img.shields.io/npm/v/@orq-ai/cli) |

## 🎯 Why Orqkit?

- **Production-Ready**: Built with Effect for robust error handling and composability
- **Developer-Friendly**: Full TypeScript support with comprehensive type definitions
- **Platform Integration**: Seamlessly works with Orq AI platform, but fully functional standalone

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

## 🔗 Integration with Orq Platform

While our tools work great standalone, they shine when integrated with the [Orq AI platform](https://orq.ai):

- **Dataset Management**: Store and version your evaluation datasets
- **Result Tracking**: Track evaluation results over time
- **Team Collaboration**: Share evaluations and results with your team
- **API Integration**: Use your Orq API key to access platform features

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