# Evaluatorq-py Examples

This directory contains Python examples demonstrating various features and use cases of the evaluatorq-py library. These examples are ported from the TypeScript examples in the main examples directory.

## Directory Structure

```
examples/
├── README.md                          # This file
└── lib/
    ├── evals.py                       # Reusable evaluator utilities
    ├── examples.py                    # Main entry point
    ├── example_runners.py             # Simulated delay examples
    ├── dataset_example.py             # Dataset-based evaluation
    ├── eval_reuse.py                  # Job and evaluator reuse
    ├── llm_eval_with_results.py       # LLM-based evaluation
    ├── test_job_helper.py             # Job error handling
    └── cli/
        ├── example_using_cli.py       # CLI example 1
        ├── example_using_cli_two.py   # CLI example 2
        ├── example_llm.py             # CLI LLM example
        └── example_cosine_similarity.py  # Cosine similarity (TODO)
```

## Prerequisites

### Installation

Install the evaluatorq-py package and its dependencies:

```bash
cd packages/evaluatorq-py
pip install -e .
```

### API Keys

Some examples require API keys:

- **ANTHROPIC_API_KEY**: Required for LLM-based examples (examples using Claude)
- **ORQ_API_KEY**: Required for dataset examples (fetching data from Orq AI platform)
- **OPENAI_API_KEY**: Alternative for embeddings in cosine similarity examples

Set these in your environment:

```bash
export ANTHROPIC_API_KEY="your-anthropic-key"
export ORQ_API_KEY="your-orq-key"
```

## Examples Overview

### Core Examples

#### 1. **examples.py** - Main Entry Point
Simple entry point that runs the simulated delay example.

```bash
cd examples/lib
python examples.py
```

#### 2. **example_runners.py** - Simulated Delay Example
Demonstrates parallel job execution with simulated processing times. Shows:
- Multiple concurrent jobs
- Different output types (strings and numbers)
- Multiple evaluators running in parallel

```bash
python example_runners.py
```

#### 3. **dataset_example.py** - Dataset-Based Evaluation
Shows how to load data from an Orq dataset and evaluate it.

```bash
python dataset_example.py
```

**Requires**: `ORQ_API_KEY` environment variable

#### 4. **eval_reuse.py** - Job and Evaluator Reuse
Demonstrates defining reusable jobs and evaluators for code modularity.

```bash
python eval_reuse.py
```

#### 5. **llm_eval_with_results.py** - LLM-Based Evaluation
Shows multiple LLM-powered jobs with different personalities and LLM-based evaluators.

```bash
python llm_eval_with_results.py
```

**Requires**: `ANTHROPIC_API_KEY` environment variable

#### 6. **test_job_helper.py** - Job Error Handling
Demonstrates how jobs are named, tracked, and how errors are captured and reported.

```bash
python test_job_helper.py
```

### CLI Examples

Examples in the `cli/` subdirectory demonstrate running evaluations from the command line.

#### 7. **example_using_cli.py** - CLI Example 1
Simple text analysis evaluation.

```bash
python cli/example_using_cli.py
```

#### 8. **example_using_cli_two.py** - CLI Example 2
Similar to example 1 but with different data, showing reusability.

```bash
python cli/example_using_cli_two.py
```

#### 9. **example_llm.py** - CLI LLM Example
LLM-based evaluation from the command line.

```bash
python cli/example_llm.py
```

**Requires**: `ANTHROPIC_API_KEY` environment variable

#### 10. **example_cosine_similarity.py** - Cosine Similarity (TODO)
Demonstrates semantic similarity evaluation using embeddings.

**Note**: This example is a placeholder. Cosine similarity evaluators are not yet implemented in the Python version. You can implement them using:
- `sentence-transformers` for local embeddings
- OpenAI embeddings API
- `sklearn` for cosine similarity calculation

```bash
python cli/example_cosine_similarity.py
```

**Requires**: `ANTHROPIC_API_KEY` and either `ORQ_API_KEY` or `OPENAI_API_KEY`

## Reusable Components

### evals.py - Evaluator Utilities

The `evals.py` module provides reusable evaluator functions:

- **`max_length_validator(max_length)`**: Checks if output length doesn't exceed maximum
- **`min_length_validator(min_length)`**: Checks if string output meets minimum length
- **`contains_name_validator`**: Checks if output contains the name from input data
- **`is_it_polite_llm_eval`**: LLM-based evaluator for politeness scoring

**Usage Example**:

```python
from evals import max_length_validator, min_length_validator, is_it_polite_llm_eval

evaluators = [
    max_length_validator(100),
    min_length_validator(10),
    is_it_polite_llm_eval
]
```

## Running Multiple Examples

You can run all examples sequentially:

```bash
cd examples/lib

# Core examples
python examples.py
python example_runners.py
python eval_reuse.py
python test_job_helper.py

# With API keys
python dataset_example.py  # Requires ORQ_API_KEY
python llm_eval_with_results.py  # Requires ANTHROPIC_API_KEY

# CLI examples
python cli/example_using_cli.py
python cli/example_using_cli_two.py
python cli/example_llm.py  # Requires ANTHROPIC_API_KEY
```

## Key Concepts Demonstrated

### Jobs
Jobs are async functions that process data points. They can be defined using the `@job` decorator:

```python
from evaluatorq_py import job, DataPoint

@job("my-job-name")
async def my_job(data: DataPoint, row: int) -> str:
    # Process the data
    return "result"
```

### Evaluators
Evaluators score the outputs of jobs. They can be defined as:

1. **Inline dictionaries**:
```python
{
    "name": "my-evaluator",
    "scorer": async def scorer(input_data): ...
}
```

2. **Using the Evaluator class**:
```python
from evaluatorq_py import Evaluator

evaluator = Evaluator(name="my-evaluator", scorer=my_scorer_function)
```

### Data Points
Data points contain inputs and optional expected outputs:

```python
from evaluatorq_py import DataPoint

data = DataPoint(
    inputs={"query": "What is Python?"},
    expected_output="Python is a programming language"
)
```

### Parallel Execution
Control parallelism with the `parallelism` parameter:

```python
await evaluatorq(
    "my-eval",
    data=data_points,
    jobs=[job1, job2],
    evaluators=[eval1, eval2],
    parallelism=4  # Process 4 data points at a time
)
```

## Differences from TypeScript Version

The Python examples maintain the same structure and functionality as the TypeScript version, with these adaptations:

1. **Async/Await**: Uses Python's `asyncio` instead of JavaScript promises
2. **Type Hints**: Uses Python type hints instead of TypeScript types
3. **Decorators**: Uses `@job` decorator instead of `job()` function wrapper
4. **Imports**: Uses Python import syntax instead of ES modules
5. **Naming**: Follows Python naming conventions (snake_case instead of camelCase)

## Troubleshooting

### Import Errors
Make sure you've installed the package:
```bash
cd packages/evaluatorq-py
pip install -e .
```

### API Key Errors
Ensure your API keys are set in the environment:
```bash
export ANTHROPIC_API_KEY="your-key"
export ORQ_API_KEY="your-key"
```

### Module Not Found
If running from a subdirectory, make sure Python can find the modules:
```bash
# From examples/lib/cli/
export PYTHONPATH="${PYTHONPATH}:../.."
```

## Contributing

When adding new examples:

1. Follow the existing structure and naming conventions
2. Include docstrings explaining what the example demonstrates
3. Add the example to this README with description and usage
4. Test that the example runs successfully

## Additional Resources

- [Main evaluatorq-py README](../../README.md)
- [TypeScript Examples](../../../../examples/)
- [Orq AI Documentation](https://docs.orq.ai)
