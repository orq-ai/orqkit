# @orq-ai/evaluators

Reusable evaluators for AI evaluation frameworks. This package provides a collection of pre-built evaluators that can be imported and used in your `.eval` files.

## Installation

```bash
npm install @orq-ai/evaluators
```

## Usage

### Cosine Similarity Evaluator

Compare semantic similarity between output and expected text using OpenAI embeddings:

```typescript
import { 
  cosineSimilarityEvaluator, 
  cosineSimilarityThresholdEvaluator,
  simpleCosineSimilarity 
} from "@orq-ai/evaluators";

// Simple usage - returns similarity score (0-1)
const evaluator = simpleCosineSimilarity("The capital of France is Paris");

// With threshold - returns boolean based on threshold
const thresholdEvaluator = cosineSimilarityThresholdEvaluator({
  expectedText: "The capital of France is Paris",
  threshold: 0.8,
  name: "semantic-match"
});

// Advanced configuration
const customEvaluator = cosineSimilarityEvaluator({
  expectedText: "Expected output text",
  model: "text-embedding-3-large", // optional: custom embedding model
  name: "custom-similarity"
});
```

#### Environment Variables

The cosine similarity evaluator requires one of:
- `OPENAI_API_KEY` - For direct OpenAI API access
- `ORQ_API_KEY` - For Orq proxy access (automatically uses `https://api.orq.ai/v2/proxy`)

When using Orq proxy, models should be prefixed with `openai/` (e.g., `openai/text-embedding-3-small`).


## License

UNLICENSE