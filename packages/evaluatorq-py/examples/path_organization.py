"""
Path Organization Example

Demonstrates how to use the `path` parameter to organize experiment
results into specific projects and folders on the Orq platform.

The `path` parameter accepts a string in the format "Project/Folder"
which determines where the experiment results will be stored.

Prerequisites:
  - Set ORQ_API_KEY environment variable

Usage:
  ORQ_API_KEY=your-key python examples/path_organization.py
"""

import asyncio

from evaluatorq import DataPoint, EvaluationResult, evaluatorq, job


async def matches_expected_scorer(params: dict) -> EvaluationResult:
    """Evaluator that checks if output matches expected."""
    data = params["data"]
    output = params["output"]
    matches = output == data.expected_output
    return EvaluationResult(
        value=1.0 if matches else 0.0,
        pass_=matches,
        explanation="Correct!" if matches else f"Expected {data.expected_output}",
    )


matches_expected = {
    "name": "matches-expected",
    "scorer": matches_expected_scorer,
}


@job("text-processor")
async def text_processor_job(data: DataPoint, _row: int) -> str:
    """Simple text processing job."""
    text = str(data.inputs.get("text", ""))
    operation = str(data.inputs.get("operation", ""))

    if operation == "uppercase":
        return text.upper()
    elif operation == "lowercase":
        return text.lower()
    elif operation == "reverse":
        return text[::-1]
    return text


async def run():
    """Run the path organization example."""
    print("\n📁 Path Organization Example\n")
    print("Experiment results will be stored in: evaluatorq")
    print("------------------------------------------\n")

    # Test data
    data = [
        DataPoint(
            inputs={"text": "Hello", "operation": "uppercase"}, expected_output="HELLO"
        ),
        DataPoint(
            inputs={"text": "WORLD", "operation": "lowercase"}, expected_output="world"
        ),
        DataPoint(
            inputs={"text": "abc", "operation": "reverse"}, expected_output="cba"
        ),
    ]

    results = await evaluatorq(
        "text-processor-eval",
        data=data,
        jobs=[text_processor_job],
        evaluators=[matches_expected],
        print_results=True,
        description="Text processing evaluation with path organization",
        # The path parameter organizes results into a project and folder
        path="evaluatorq",
    )

    print("\n✅ Evaluation complete!")
    return results


if __name__ == "__main__":
    _ = asyncio.run(run())
