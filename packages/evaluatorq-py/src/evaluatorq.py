from collections.abc import Awaitable
import os
import time

from .table_display import display_results_table
from .types import DataPoint, EvaluatorParams, EvaluatorqResult
from src.processings import process_data_point
from src.progress import ProgressService, with_progress, Phase


def setup_orq_client(api_key: str):
    pass


def fetch_dataset_as_datapoints(orq_client, dataset_id: str):
    pass


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

    orq_client = None
    orq_api_key = os.environ.get("ORQ_API_KEY")

    if orq_api_key:
        orq_client = setup_orq_client(orq_api_key)

    start_time = time.time()

    data_promises: list[Awaitable[DataPoint] | DataPoint]
    dataset_id: str | None = None

    # Handle dataset_id case
    if "dataset_id" in data:
        if not orq_api_key or not orq_client:
            raise ValueError(
                "ORQ_API_KEY environment variable must be set to fetch datapoints from Orq platform."
            )
        pass
        # dataset_id = data["dataset_id"]
        # data_promises = fetch_dataset_as_datapoints(orq_client, dataset_id)
    else:
        data_promises = data

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

        # Process all data points
        results: EvaluatorqResult = []

        for index, data_promise in enumerate(data_promises):
            result = await process_data_point(
                data_promise, index, jobs, evaluators, parallelism, progress
            )
            results.extend(result)

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
        # TODO: Upload results to Orq platform
        pass

    return results
