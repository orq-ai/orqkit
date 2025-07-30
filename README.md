# Evaluatorq 🔍

A lightweight, Effect.ts-powered evaluation framework for testing AI/LLM applications. Inspired by Evalite, but designed for simplicity and integration with the orq.ai platform.

## Features

- 🚀 **Simple API** - Intuitive syntax for defining evaluations
- 📊 **Built-in Evaluators** - CosineSimilarity, ExactMatch, LevenshteinDistance
- 🔌 **Extensible** - Create custom evaluators and tasks
- 📁 **.eval.ts Files** - Automatic discovery and execution of evaluation files
- 🌐 **orq.ai Integration** - Seamlessly upload results to orq.ai for visualization
- ⚡ **Effect.ts Powered** - Robust error handling and functional programming patterns

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Create Your First Evaluation

Create a file named `my-test.eval.ts`:

```typescript
import { Evaluatorq } from '@evaluatorq/core';
import { CosineSimilarity, ExactMatch } from '@evaluatorq/evaluators';

await Evaluatorq('My First Evaluation', {
  data: async () => {
    // Your test data
    return [
      { 
        input: 'What is the capital of France?',
        output: 'The capital of France is Paris.'
      },
    ];
  },
  
  tasks: [
    // Custom analysis
    ({ input, output }) => ({
      inputLength: input.length,
      outputLength: output.length,
    }),
  ],
  
  evaluators: [
    CosineSimilarity,
    ExactMatch,
  ],
});
```

### 3. Run Your Evaluation

```bash
./evaluatorq run
```

This will:
- Discover all `.eval.ts` files
- Execute each evaluation
- Display results in the terminal
- Save detailed results to `./evaluations/` directory

## API

### Core Function

```typescript
Evaluatorq(name: string, config: {
  data: () => Promise<Array<{ input: TInput; output: TOutput }>>,
  tasks: Array<Task<TInput, TOutput>>,
  evaluators: Array<Evaluator<TOutput>>
})
```

### Built-in Evaluators

- **CosineSimilarity**: Measures semantic similarity using TF-IDF (0-1)
- **ExactMatch**: Binary comparison with options for case/whitespace
- **LevenshteinDistance**: Normalized edit distance (0-1)

### Custom Evaluators

```typescript
const MyEvaluator: Evaluator<string> = {
  name: 'MyEvaluator',
  evaluate: (output, expected) => 
    Effect.succeed(output === expected ? 1 : 0)
};
```

## .eval.ts File Pattern

Evaluatorq automatically discovers and runs files ending with `.eval.ts`:

```bash
./evaluatorq run                    # Run all .eval.ts files
./evaluatorq run "tests/*.eval.ts"  # Run specific pattern
./evaluatorq init my-test           # Create example file
```

## orq.ai Integration

Set your API key to automatically upload results:

```bash
ORQ_API_KEY=your-key ./evaluatorq run
```

Results will be uploaded to orq.ai for advanced visualization and tracking.

## Examples

### Basic Q&A Evaluation

```typescript
await Evaluatorq('Q&A Test', {
  data: async () => [
    { input: 'Question', output: 'Answer' }
  ],
  tasks: [],
  evaluators: [CosineSimilarity]
});
```

### Model Comparison

```typescript
const modelA = await callModelA(prompt);
const modelB = await callModelB(prompt);

await Evaluatorq('Model Comparison', {
  data: async () => [
    { input: modelA, output: modelB }
  ],
  tasks: [],
  evaluators: [CosineSimilarity, LevenshteinDistance]
});
```

### LLM Integration

```typescript
await Evaluatorq('LLM Evaluation', {
  data: async () => {
    const questions = ['What is AI?', 'Explain ML'];
    const results = [];
    
    for (const q of questions) {
      const response = await callLLM(q);
      results.push({ input: q, output: response });
    }
    
    return results;
  },
  tasks: [],
  evaluators: [/* your evaluators */]
});
```

## Development

This is an Nx monorepo with the following packages:

- `@evaluatorq/core` - Main evaluation engine
- `@evaluatorq/evaluators` - Built-in evaluators
- `@evaluatorq/shared` - Shared types and utilities
- `@evaluatorq/cli` - Command-line interface
- `@evaluatorq/orq-integration` - orq.ai integration

### Running Tests

```bash
bun test
```

### Building

```bash
npx nx build core
npx nx build evaluators
# etc...
```

## License

MIT

## Credits

Created by the Orquesta team. Inspired by [Evalite](https://evalite.dev).