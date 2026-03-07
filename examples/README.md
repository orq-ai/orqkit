# @orq-ai/evaluatorq Examples

This directory contains examples demonstrating the capabilities of the `@orq-ai/evaluatorq` library.

## Directory Structure

```
examples/src/lib/
├── basics/                          # Core examples and entry points
│   ├── examples.ts                  # Main entry point
│   ├── example-runners.ts           # Simulated delay examples
│   ├── pass-fail-simple.ts          # Simple pass/fail evaluation
│   ├── eval-reuse.eval.ts           # Reusable jobs and evaluators
│   ├── llm-eval-with-results.ts     # LLM-based evaluation
│   └── test-job-helper.ts           # Job error handling
├── datasets/                        # Dataset-based evaluations
│   ├── dataset-example.eval.ts      # Orq platform dataset evaluation
│   └── country-unit-test.eval.ts    # Unit test style with Orq dataset
├── structured/                      # Structured evaluation results
│   ├── structured-rubric.eval.ts    # Multi-criteria quality rubric
│   ├── structured-sentiment.eval.ts # Sentiment distribution
│   ├── structured-safety.eval.ts    # Toxicity/safety scoring
│   └── path-organization.eval.ts    # Path-based dashboard organization
├── integrations/                    # Framework integrations
│   ├── langchain/                   # LangChain / LangGraph
│   │   ├── langchain-agent-eval.ts
│   │   ├── langgraph-agent-eval.ts
│   │   └── langgraph-research-eval.ts
│   ├── vercel/                      # Vercel AI SDK
│   │   ├── vercel_ai_sdk_integration_example.ts
│   │   ├── vercel_ai_sdk_dataset_example.ts
│   │   ├── vercel_ai_sdk_dataset_example.csv
│   │   └── vercel-multi-agent-eval.ts
│   └── orq/                         # Orq deployments
│       └── orq-deployment-eval.ts
├── cli/                             # CLI integration examples
│   ├── example-using-cli.eval.ts
│   ├── example-using-cli-two.eval.ts
│   ├── example-llm.eval.ts
│   └── example-cosine-similarity.eval.ts
└── utils/                           # Shared evaluator utilities
    └── evals.ts
```

## Running Examples

```bash
# Basics
bun examples/src/lib/basics/examples.ts
bun examples/src/lib/basics/pass-fail-simple.ts

# Datasets (requires ORQ_API_KEY)
ORQ_API_KEY=... bun examples/src/lib/datasets/dataset-example.eval.ts

# Structured
bun examples/src/lib/structured/structured-rubric.eval.ts

# Integrations (requires OPENAI_API_KEY)
ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/langchain/langgraph-research-eval.ts
ORQ_API_KEY=... OPENAI_API_KEY=... DATASET_ID=... bun examples/src/lib/integrations/vercel/vercel_ai_sdk_dataset_example.ts
ORQ_API_KEY=... OPENAI_API_KEY=... bun examples/src/lib/integrations/vercel/vercel-multi-agent-eval.ts

# CLI (requires Orq CLI)
bunx @orq-ai/cli evaluate "examples/src/lib/cli/example-using-cli.eval.ts"
```