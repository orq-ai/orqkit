import asyncio
from typing import Any

from .types import (
    DataPoint,
    DataPointResult,
    Evaluator,
    EvaluationResult,
    EvaluatorScore,
    Job,
    JobResult,
    Output,
    ScorerParameter,
)


async def process_data_point(
    data_promise: DataPoint | asyncio.Future[DataPoint],
    row_index: int,
    jobs: list[Job],
    evaluators: list[Evaluator],
    parallelism: int,
    progress_service: Any = None,
) -> list[DataPointResult]:
    """
    Process a single data point through all jobs and evaluators.

    Args:
        data_promise: A DataPoint or an awaitable that resolves to a DataPoint
        row_index: Index of this data point in the dataset
        jobs: List of jobs to execute
        evaluators: List of evaluators to run on job outputs
        parallelism: Number of jobs to run in parallel
        progress_service: Optional progress tracking service

    Returns:
        List containing a single DataPointResult with job results and evaluator scores
    """
    try:
        # Await the data point if it's a promise/future
        if asyncio.isfuture(data_promise) or asyncio.iscoroutine(data_promise):
            data_point = await data_promise
        else:
            data_point = data_promise

        # Update progress for this data point
        if progress_service:
            await progress_service.update_progress(
                current_data_point=row_index + 1, phase="processing"
            )

        # Process jobs with concurrency control
        semaphore = asyncio.Semaphore(parallelism)

        async def run_job_with_semaphore(job: Job) -> JobResult:
            async with semaphore:
                return await process_job(
                    job, data_point, row_index, evaluators, progress_service
                )

        # Execute all jobs with controlled parallelism
        job_results = await asyncio.gather(
            *[run_job_with_semaphore(job) for job in jobs],
            return_exceptions=False,
        )

        return [
            DataPointResult(
                data_point=data_point,
                job_results=list(job_results),
                error=None,
            )
        ]

    except Exception as error:
        # Return error result with placeholder data point
        return [
            DataPointResult(
                data_point=DataPoint(inputs={}, expected_output=None),
                error=str(error),
                job_results=None,
            )
        ]


async def process_job(
    job: Job,
    data_point: DataPoint,
    row_index: int,
    evaluators: list[Evaluator],
    progress_service: Any = None,
) -> JobResult:
    """
    Process a single job and optionally run evaluators on its output.

    Args:
        job: The job function to execute
        data_point: The data point to pass to the job
        row_index: Index of the data point
        evaluators: List of evaluators to run on the job output
        progress_service: Optional progress tracking service

    Returns:
        JobResult containing job output and evaluator scores
    """
    job_name = "job"  # Default name
    output: Output = None
    error: str | None = None

    try:
        # Execute the job
        result = await job(data_point, row_index)
        job_name = result["name"]
        output = result["output"]

        # Update progress with current job name
        if progress_service:
            await progress_service.update_progress(current_job=job_name)

    except Exception as e:
        # Extract job name from error if available
        if hasattr(e, "job_name"):
            job_name = e.job_name  # type: ignore
        error = str(e)

        # Return early with error if job failed
        return JobResult(
            job_name=job_name,
            output=None,
            error=error,
            evaluator_scores=[],
        )

    # Process evaluators if any and job was successful
    evaluator_scores: list[EvaluatorScore] = []

    if evaluators and len(evaluators) > 0:
        # Update phase to evaluating
        if progress_service:
            await progress_service.update_progress(phase="evaluating")

        # Run all evaluators concurrently (unbounded concurrency)
        evaluator_tasks = [
            process_evaluator(evaluator, data_point, output, progress_service)
            for evaluator in evaluators
        ]

        evaluator_scores = await asyncio.gather(*evaluator_tasks)

    return JobResult(
        job_name=job_name,
        output=output,
        error=None,
        evaluator_scores=evaluator_scores,
    )


async def process_evaluator(
    evaluator: Evaluator,
    data_point: DataPoint,
    output: Output,
    progress_service: Any = None,
) -> EvaluatorScore:
    """
    Process a single evaluator.

    Args:
        evaluator: The evaluator configuration with name and scorer function
        data_point: The original data point
        output: The job output to evaluate
        progress_service: Optional progress tracking service

    Returns:
        EvaluatorScore with the evaluation result or error
    """
    evaluator_name = evaluator["name"]

    try:
        # Update current evaluator in progress
        if progress_service:
            await progress_service.update_progress(current_evaluator=evaluator_name)

        # Execute the scorer
        scorer_param: ScorerParameter = {
            "data": data_point,
            "output": output,
        }

        score: EvaluationResult = await evaluator["scorer"](scorer_param)

        return EvaluatorScore(
            evaluator_name=evaluator_name,
            score=score,
            error=None,
        )

    except Exception as error:
        # Return error result with empty score
        return EvaluatorScore(
            evaluator_name=evaluator_name,
            score=EvaluationResult(value=""),
            error=str(error),
        )
