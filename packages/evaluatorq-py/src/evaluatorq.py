from collections.abc import Awaitable, Sequence
import asyncio
from typing import cast
from datetime import datetime, UTC
import os

from src.send_results import send_results_to_orq
from src.fetch_data import setup_orq_client, fetch_dataset_as_datapoints

from .table_display import display_results_table
from .types import DataPoint, EvaluatorParams, EvaluatorqResult
from src.processings import process_data_point
from src.progress import ProgressService, with_progress, Phase


async def evaluatorq(name: str, params: EvaluatorParams) -> EvaluatorqResult:
    """
    Run an evaluation with the given parameters.

    Args:
        name: Name of the evaluation run
        params: Evaluation parameters including data, jobs, evaluators, etc.

    Returns:
        List of DataPointResult objects
    """
    # Destructure with .get() for defaults
    data = params["data"]
    evaluators = params.get("evaluators", [])
    jobs = params["jobs"]
    parallelism = params.get("parallelism", 1)
    print_results = params.get("print", True)
    description = params.get("description")

    orq_api_key = os.environ.get("ORQ_API_KEY")

    start_time = datetime.now(UTC)

    data_promises: Sequence[Awaitable[DataPoint] | DataPoint]
    dataset_id: str | None = None

    # Handle dataset_id case
    if isinstance(data, dict) and "dataset_id" in data:
        orq_client = None

        if orq_api_key:
            orq_client = setup_orq_client(orq_api_key)

        if not orq_api_key or not orq_client:
            raise ValueError(
                "ORQ_API_KEY environment variable must be set to fetch datapoints from Orq platform."
            )
        dataset_id = data["dataset_id"]
        data_promises = await fetch_dataset_as_datapoints(orq_client, dataset_id)

    else:
        data_promises = cast(list[DataPoint], data)

    # Create progress service
    progress = ProgressService()

    # Define the main evaluation coroutine
    async def run_evaluation() -> EvaluatorqResult:
        # Initialize progress
        await progress.update_progress(
            total_data_points=len(data_promises),
            current_data_point=0,
            phase=Phase.INITIALIZING,
        )

        # Process data points with controlled concurrency
        # Use a semaphore to limit concurrent data points to avoid overwhelming the system
        # This allows parallelism within each data point (controlled by the parallelism param)
        # while also having multiple data points in flight
        data_point_semaphore = asyncio.Semaphore(max(1, parallelism // len(jobs)))

        async def process_with_semaphore(
            index: int, data_promise: Awaitable[DataPoint] | DataPoint
        ):
            async with data_point_semaphore:
                return await process_data_point(
                    data_promise, index, jobs, evaluators, parallelism, progress
                )

        tasks = [
            process_with_semaphore(index, data_promise)
            for index, data_promise in enumerate(data_promises)
        ]

        # Gather all results
        results_nested = await asyncio.gather(*tasks)

        # Flatten results (each process_data_point returns a list)
        results: EvaluatorqResult = []
        for result_list in results_nested:
            results.extend(result_list)

        return results

    # Run evaluation with progress tracking
    results = await with_progress(
        run_evaluation(), progress, show_progress=print_results
    )

    # Display results table
    if print_results:
        await display_results_table(results)

    # Upload results to Orq platform if API key is available
    if orq_api_key:
        _ = await send_results_to_orq(
            orq_api_key,
            name,
            description,
            dataset_id,
            results,
            start_time,
            datetime.now(UTC),
        )

    return results
