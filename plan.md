# Evaluatorq Implementation Plan

## Project Overview

Evaluatorq is a lightweight TypeScript evaluation library built with Effect.ts that executes experiments and evaluations. It provides two modes of operation:
1. **With ORQ_API_KEY**: Sends results to orq.ai platform for visualization and analysis
2. **Without ORQ_API_KEY**: Outputs results locally as JSON file and displays in CLI

The library focuses on being a pure evaluation runner without built-in UI or storage, delegating visualization to orq.ai when available.

## Core API Design

```typescript
Evaluatorq("Experiment007", {
    data: async () => {
        return [{ input: "Hello, how are you?", output: "I'm good, thank you!" }];
    },
    tasks: [
        ({ input, output }) => {
            return input + output;
        },
    ],
    evaluators: [
        CosineSimilarity
    ]
});
```

## Architecture Overview

### 1. Simplified Package Structure

```
packages/
├── core/               # Core evaluation engine
├── evaluators/         # Built-in evaluator implementations  
├── orq-integration/    # Integration with orq.ai API
├── cli/                # CLI output formatting
└── shared/             # Shared types and utilities
```

### 2. Technology Stack

- **Effect.ts (v3.16.16)**: For functional programming, error handling, and composability
- **TypeScript**: Type-safe development
- **@orq-ai/node**: SDK for orq.ai integration
- **Chalk/Ora**: CLI output formatting
- **JSON**: Local result storage format

## Effect.ts Benefits for Lightweight Library

### Why Effect.ts Makes Sense:

1. **Error Handling**: 
   - Graceful fallback from orq.ai to local output
   - Type-safe error boundaries in evaluators
   - Clear error messages for debugging

2. **Composability**:
   - Easy to chain evaluators
   - Compose data transformations
   - Plugin architecture for custom evaluators

3. **Async Control**:
   - Manage concurrent evaluations efficiently
   - Handle rate limiting for orq.ai API
   - Cancellation support

4. **Minimal Dependencies**:
   - Effect.ts can replace multiple libraries
   - Built-in retry logic for API calls
   - Stream processing for large datasets

## Implementation Phases

### Phase 1: Core Foundation (Week 1)

1. **Package Setup**
   - Create monorepo structure with Nx
   - Configure TypeScript with Effect.ts
   - Setup core types and interfaces

2. **Core Types**
   ```typescript
   interface Experiment<TInput, TOutput> {
     name: string;
     data: Effect.Effect<Array<{ input: TInput; output: TOutput }>, DataError>;
     tasks: Array<Task<TInput, TOutput>>;
     evaluators: Array<Evaluator<TOutput>>;
   }

   interface EvaluationResult {
     experimentName: string;
     timestamp: Date;
     results: Array<{
       input: unknown;
       output: unknown;
       taskResults: Array<TaskResult>;
       scores: Record<string, number>;
     }>;
     summary: {
       totalSamples: number;
       averageScores: Record<string, number>;
       executionTime: number;
     };
   }
   ```

3. **Evaluation Engine**
   - Implement core runner with Effect.ts
   - Handle data loading and task execution
   - Apply evaluators and collect scores

### Phase 2: Built-in Evaluators (Week 1-2)

1. **Core Evaluators**
   ```typescript
   // Evaluator interface
   interface Evaluator<T> {
     name: string;
     evaluate: (output: T, expected: T) => Effect.Effect<number, EvaluatorError>;
   }
   ```

2. **Built-in Implementations**
   - Cosine Similarity
   - Levenshtein Distance
   - Exact Match
   - BLEU Score
   - Semantic Similarity (if embeddings available)

3. **Evaluator Utilities**
   - Evaluator composition
   - Custom evaluator creation helpers
   - Score normalization

### Phase 3: Output Management (Week 2)

1. **Result Formatting**
   ```typescript
   interface OutputHandler {
     handle: (results: EvaluationResult) => Effect.Effect<void, OutputError>;
   }
   ```

2. **Local Output**
   - JSON file generation
   - CLI table formatting
   - Summary statistics display

3. **orq.ai Integration**
   ```typescript
   class OrqOutputHandler implements OutputHandler {
     handle(results: EvaluationResult) {
       return Effect.gen(function* () {
         const apiKey = yield* Config.string("ORQ_API_KEY").pipe(
           Config.optional
         );
         
         if (apiKey) {
           yield* sendToOrq(results, apiKey);
         } else {
           yield* localOutput(results);
         }
       });
     }
   }
   ```

### Phase 4: CLI & Developer Experience (Week 3)

1. **CLI Commands**
   ```bash
   # Run evaluation
   npx evaluatorq run experiment.ts
   
   # Watch mode
   npx evaluatorq watch experiment.ts
   
   # List available evaluators
   npx evaluatorq evaluators
   ```

2. **Configuration**
   ```typescript
   // evaluatorq.config.ts
   export default {
     outputDir: './evaluations',
     concurrency: 5,
     orq: {
       endpoint: 'https://api.orq.ai',
       timeout: 30000
     }
   };
   ```

3. **Developer Experience**
   - TypeScript types for all APIs
   - Helpful error messages
   - Progress indicators for long-running evaluations

### Phase 5: orq.ai Integration (Week 3-4)

1. **API Integration**
   ```typescript
   const sendToOrq = (results: EvaluationResult, apiKey: string) =>
     Effect.gen(function* () {
       const client = yield* OrqClient;
       
       // Transform results to orq.ai format
       const orqPayload = transformToOrqFormat(results);
       
       // Send with retry logic
       yield* Effect.retry(
         client.experiments.create(orqPayload),
         Schedule.exponential("1 second")
       );
     });
   ```

2. **Result Transformation**
   - Map Evaluatorq results to orq.ai experiment format
   - Include metadata and traces
   - Preserve evaluation scores

3. **Authentication & Error Handling**
   - Secure API key handling
   - Graceful degradation to local output
   - Clear error messages for API issues

## Key Design Decisions

### 1. No Built-in Storage
- Results are ephemeral unless sent to orq.ai
- Local JSON output for offline analysis
- Reduces complexity and dependencies

### 2. Lightweight Architecture
- Single execution model (no daemon/server)
- Minimal dependencies
- Fast startup time

### 3. Effect.ts Patterns

```typescript
// Example: Main evaluation flow
const runEvaluation = <TInput, TOutput>(
  experiment: Experiment<TInput, TOutput>
) => 
  Effect.gen(function* () {
    const logger = yield* Logger;
    
    // Load data
    const data = yield* experiment.data;
    
    // Run tasks for each data point
    const taskResults = yield* Effect.forEach(
      data,
      (dataPoint) => runTasks(dataPoint, experiment.tasks),
      { concurrency: 5 }
    );
    
    // Evaluate results
    const evaluationResults = yield* Effect.forEach(
      taskResults,
      (result) => applyEvaluators(result, experiment.evaluators),
      { concurrency: "unbounded" }
    );
    
    // Format final results
    const finalResults = formatResults(
      experiment.name,
      data,
      taskResults,
      evaluationResults
    );
    
    // Output results
    yield* outputResults(finalResults);
    
    return finalResults;
  });
```

### 4. Evaluator Converter Utility

Since you mentioned creating a utility to convert orq.ai evaluators:

```typescript
// @orq/evaluators package
export const convertOrqEvaluator = (orqEval: OrqEvaluator): Evaluator => ({
  name: orqEval.name,
  evaluate: (output, expected) => 
    Effect.tryPromise({
      try: () => orqEval.evaluate(output, expected),
      catch: (error) => new EvaluatorError({ cause: error })
    })
});

// Usage
import { sentimentEvaluator } from '@orq/evaluators';
import { convertOrqEvaluator } from '@orq/evaluators/convert';

Evaluatorq("Sentiment Test", {
  // ...
  evaluators: [
    convertOrqEvaluator(sentimentEvaluator),
    CosineSimilarity
  ]
});
```

## Output Examples

### CLI Output (No ORQ_API_KEY)
```
✓ Experiment007 completed in 2.3s

┌─────────┬──────────────────┬─────────────────┬──────────────────┐
│ Sample  │ Input            │ Output          │ Cosine Score     │
├─────────┼──────────────────┼─────────────────┼──────────────────┤
│ 1       │ Hello, how ar... │ I'm good, th... │ 0.87            │
└─────────┴──────────────────┴─────────────────┴──────────────────┘

Summary:
• Total Samples: 1
• Average Cosine Similarity: 0.87
• Execution Time: 2.3s

Results saved to: ./evaluations/Experiment007-2024-01-21T10-30-00.json
```

### JSON Output Format
```json
{
  "experimentName": "Experiment007",
  "timestamp": "2024-01-21T10:30:00.000Z",
  "results": [
    {
      "input": "Hello, how are you?",
      "output": "I'm good, thank you!",
      "taskResults": ["Hello, how are you?I'm good, thank you!"],
      "scores": {
        "CosineSimilarity": 0.87
      }
    }
  ],
  "summary": {
    "totalSamples": 1,
    "averageScores": {
      "CosineSimilarity": 0.87
    },
    "executionTime": 2300
  }
}
```

## Success Criteria

1. **Simple API**
   - Matches proposed syntax exactly
   - Minimal configuration required
   - TypeScript-first with great IntelliSense

2. **Flexible Output**
   - Seamless orq.ai integration when API key present
   - Useful local output when offline
   - Consistent result format

3. **Production Ready**
   - Effect.ts error handling throughout
   - Efficient concurrent execution
   - Well-tested evaluators

## Next Steps

After plan approval:
1. Set up monorepo structure
2. Implement core types and evaluation engine
3. Create basic evaluators
4. Build output handlers for both modes
5. Add CLI interface
6. Integrate with orq.ai API
7. Create @orq/evaluators converter utility

## Open Questions

1. Should we support streaming results to orq.ai for long-running evaluations?
2. What format should the task results take? (The example shows string concatenation)
3. Should we add a dry-run mode to preview what would be sent to orq.ai?
4. Do we need to support custom output formats beyond JSON?