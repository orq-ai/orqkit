# evaluatorq-py

An evaluation framework library for Python that provides a flexible way to run parallel evaluations and optionally integrate with the Orq AI platform.

## Installation

```bash
pip install evaluatorq
# or
uv add evaluatorq
# or
poetry add evaluatorq
```

## Features

- **Parallel Execution**: Run multiple evaluation jobs concurrently with progress tracking
- **Flexible Data Sources**: Support for inline data, async iterables, and Orq platform datasets
- **Type-safe**: Comprehensively typed with Python type hints and Pydantic models for data validation
- **Rich Terminal UI**: Beautiful progress indicators and result tables powered by Rich

## Quick Start

```python
import asyncio
from evaluatorq import evaluatorq, DataPoint, EvaluationResult

async def text_analyzer(data: DataPoint, row: int):
    """Analyze text data and return analysis results."""
    text = data.inputs["text"]
    analysis = {
        "length": len(text),
        "word_count": len(text.split()),
    }
    return {"name": "text-analyzer", "output": analysis}

async def length_check_scorer(params):
    """Evaluate if output length is sufficient."""
    output = params["output"]
    passes_check = output["length"] > 10

    return EvaluationResult(
        value=1 if passes_check else 0,
        explanation=(
            "Output length is sufficient"
            if passes_check
            else f"Output too short ({output['length']} chars)"
        )
    )

async def main():
    await evaluatorq("text-analysis", {
        "data": [
            DataPoint(inputs={"text": "Hello world"}),
            DataPoint(inputs={"text": "Testing evaluation"}),
        ],
        "jobs": [text_analyzer],
        "evaluators": [
            {
                "name": "length-check",
                "scorer": length_check_scorer,
            }
        ],
    })

if __name__ == "__main__":
    asyncio.run(main())
```

## License

MIT
