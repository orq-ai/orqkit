# @orq-ai/cli

Command-line interface for running evaluations with the @orq-ai/evaluatorq framework. This CLI tool makes it easy to discover and execute evaluation files in your project.

## 🎯 Features

- **Pattern-based Discovery**: Find and run evaluation files using glob patterns
- **Batch Execution**: Run multiple evaluation files in sequence
- **TypeScript Support**: Built-in TypeScript execution with tsx
- **Clear Output**: Formatted console output with status indicators
- **Error Handling**: Graceful error handling with detailed error messages

## 📥 Installation

### Global Installation

```bash
npm install -g @orq-ai/cli
# or
yarn global add @orq-ai/cli
# or
bun add -g @orq-ai/cli
```

### Local Installation

```bash
npm install --save-dev @orq-ai/cli
# or
yarn add -D @orq-ai/cli
# or
bun add -d @orq-ai/cli
```

### Using npx

```bash
npx @orq-ai/cli evaluate "**/*.eval.ts"
```

## 🚀 Usage

### Basic Commands

```bash
# Run all evaluation files in your project
orq evaluate "**/*.eval.ts"

# Run evaluations in a specific directory
orq evaluate "src/evaluations/*.eval.ts"

# Run a single evaluation file
orq evaluate "tests/my-test.eval.ts"

# Show help
orq --help
orq evaluate --help
```

### Evaluation File Convention

The CLI looks for files ending with `.eval.ts`. These files should export or directly execute evaluatorq functions:

```typescript
// my-evaluation.eval.ts
import { evaluatorq } from "@orq-ai/evaluatorq";

await evaluatorq("my-evaluation", {
  data: [
    { inputs: { text: "Hello" } },
    { inputs: { text: "World" } },
  ],
  jobs: [
    async (data) => ({
      name: "uppercase",
      output: data.inputs.text.toUpperCase(),
    }),
  ],
  evaluators: [
    {
      name: "length-check",
      scorer: async ({ output }) => output.length > 3 ? 1 : 0,
    },
  ],
});
```

### Pattern Matching

The CLI uses glob patterns for flexible file matching:

```bash
# All .eval.ts files recursively
orq evaluate "**/*.eval.ts"

# Only in src directory
orq evaluate "src/**/*.eval.ts"

# Multiple patterns
orq evaluate "src/**/*.eval.ts" "tests/**/*.eval.ts"

# Specific subdirectories
orq evaluate "{src,tests}/**/*.eval.ts"
```

### Output Format

The CLI provides clear, formatted output:

```
Running evaluations:

⚡ Running basic-test.eval.ts...
✅ basic-test.eval.ts completed

⚡ Running advanced-test.eval.ts...
✅ advanced-test.eval.ts completed

All evaluations completed successfully!
```

## 🔧 Configuration

### Environment Variables

The CLI respects environment variables used by @orq-ai/evaluatorq:

- `ORQ_API_KEY`: API key for Orq platform integration

### TypeScript Configuration

The CLI uses tsx for TypeScript execution, which supports:
- ESM and CommonJS modules
- TypeScript out of the box
- Path aliases from tsconfig.json
- Node.js built-in modules

## 📚 Examples

### Running Tests in CI/CD

```yaml
# GitHub Actions example
- name: Run Evaluations
  run: npx @orq-ai/cli evaluate "**/*.eval.ts"
  env:
    ORQ_API_KEY: ${{ secrets.ORQ_API_KEY }}
```

### Package.json Scripts

```json
{
  "scripts": {
    "eval": "orq evaluate \"**/*.eval.ts\"",
    "eval:unit": "orq evaluate \"tests/unit/**/*.eval.ts\"",
    "eval:integration": "orq evaluate \"tests/integration/**/*.eval.ts\""
  }
}
```

## 🛠️ Development

```bash
# Build the package
bunx nx build cli

# Run type checking
bunx nx typecheck cli

# Run locally without installing
bunx tsx packages/cli/src/bin/cli.ts evaluate "**/*.eval.ts"
```

## 📄 License

This is free and unencumbered software released into the public domain. See [UNLICENSE](https://unlicense.org) for details.