"""Helper function for creating named jobs with error handling."""

from collections.abc import Awaitable
from typing import Callable
from inspect import isawaitable
from .types import DataPoint, Job, Output, JobReturn


class JobError(Exception):
    """Exception that preserves the job name when a job fails."""

    def __init__(self, job_name: str, original_error: Exception):
        self.job_name: str = job_name
        self.original_error: Exception = original_error
        super().__init__(str(original_error))


def job(
    name: str,
    fn: Callable[[DataPoint, int], Awaitable[Output] | Output],
) -> Job:
    """
    Helper function to create a named job that ensures the job name is preserved
    even when errors occur during execution.

    This wrapper:
    - Automatically formats the return value as {"name": ..., "output": ...}
    - Attaches the job name to errors for better error tracking

    Args:
        name: The name of the job
        fn: The job function that returns the output

    Returns:
        A Job function that always includes the job name

    Example:
        ```python
        # Define a job:
        async def process(row, data):
            do_something(data)

        # Register the job
        my_job = job("my-job", process)

        # Or with lambda for simple cases:
        my_job = job("uppercase", lambda data, row: data.inputs["text"].upper())
        ```
    """

    async def wrapper(data: DataPoint, row: int) -> JobReturn:
        try:
            # Execute the job function
            result = fn(data, row)

            # Await if it's a coroutine, otherwise use directly
            if isawaitable(result):
                output: Output = await result
            else:
                output = result  # type: ignore

            return {
                "name": name,
                "output": output,
            }
        except Exception as error:
            # Wrap error with job name for better tracking
            # This allows process_job to extract the name even on failure
            raise JobError(name, error) from error

    return wrapper
