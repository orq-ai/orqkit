"""
Example demonstrating job helper functionality and error handling.

This example shows how:
- Jobs are named and tracked through the evaluation process
- Job errors are captured and reported
- Results include both successful outputs and error information
"""

import asyncio

from evaluatorq import DataPoint, evaluatorq, job


# Simple job that succeeds
@job("successfulJob")
async def successful_job(data: DataPoint, _row: int = 0) -> str:
    """Job that always succeeds."""
    name = data.inputs.get("name", "")
    return f"Hello {name}!"


# Job that conditionally fails
@job("failingJob")
async def failing_job(data: DataPoint, _row: int = 0) -> str:
    """Job that fails for specific inputs."""
    name = data.inputs.get("name", "")
    if name == "FailMe":
        raise Exception(f"Job failed for {name}")
    return f"Success for {name}"


# Job that always fails
@job("anotherFailingJob")
async def another_failing_job(data: DataPoint, _row: int = 0) -> str:
    """Job that always fails."""
    raise Exception("This job always fails")


async def main():
    """Run evaluation to test job helper functionality."""
    print("Testing job helper functionality:")
    print("==================================\n")

    results = await evaluatorq(
        "test-job-helper",
        {
            "data": [
                DataPoint(inputs={"name": "Alice"}),
                DataPoint(inputs={"name": "FailMe"}),
                DataPoint(inputs={"name": "Bob"}),
            ],
            "jobs": [successful_job, failing_job, another_failing_job],
            "parallelism": 1,
            "print": True,
        },
    )

    # Display the results to show job names are preserved
    print("\n=== Raw Results (showing job names) ===")
    for index, result in enumerate(results):
        name = result.data_point.inputs.get("name", "")
        print(f"\nData Point {index + 1} ({name}):")

        if result.job_results:
            for job_result in result.job_results:
                if job_result.error:
                    print(f"  ❌ {job_result.job_name}: {job_result.error}")
                else:
                    print(f"  ✅ {job_result.job_name}: {job_result.output}")


if __name__ == "__main__":
    asyncio.run(main())
