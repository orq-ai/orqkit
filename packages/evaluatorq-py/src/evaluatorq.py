from collections.abc import Awaitable

from src.table_display import display_results_table
from .types import DataPoint, DataPointResult, EvaluatorParams
import os
import time
from .processings import process_data_point


def setup_orq_client(api_key: str):
    pass


def fetch_dataset_as_datapoints(orq_client, dataset_id: str):
    pass


async def evaluatorq(name: str, params: EvaluatorParams):
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
    dataset_id: str | None

    # Handle dataset_id case
    if "dataset_id" in data:
        # gather dataset from Orq platform
        pass
    else:
        data_promises = data

    # process all data points flow
    # progress = ProgresService()
    # Initialize progress
    # progress.UpdateProgress(0)
    #
    results: list[DataPointResult] = []

    for index, data_promise in enumerate(data_promises):
        results.extend(
            await process_data_point(data_promise, index, jobs, evaluators, parallelism)
        )
        pass

    # Add table display
    if print_results:
        await display_results_table(results)

    if orq_api_key:
        # Upload results to Orq platform
        pass
