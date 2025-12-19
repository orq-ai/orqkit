"""Fetch data from Orq platform."""

from typing import TYPE_CHECKING

from .types import DataPoint

if TYPE_CHECKING:
    from orq_ai_sdk import Orq


def setup_orq_client(api_key: str) -> "Orq":
    """
    Setup and return an Orq client instance.

    Args:
        api_key: Orq API key for authentication

    Returns:
        Orq client instance

    Raises:
        ModuleNotFoundError: If orq_ai_sdk is not installed
        Exception: If client setup fails
    """
    import os

    try:
        # lazy import for orq integration
        from orq_ai_sdk import Orq

        server_url = os.environ.get("ORQ_BASE_URL", "https://my.orq.ai")
        client = Orq(api_key=api_key, server_url=server_url)
        return client
    except ModuleNotFoundError as e:
        raise Exception(
            """orq_ai_sdk is not installed.
            Please install it using:
                * pip install orq_ai_sdk.
                * uv add orq_ai_sdk
                * poetry add orq_ai_sdk"""
        ) from e
    except Exception as e:
        raise Exception(f"Error setting up Orq client: {e}")


async def fetch_dataset_as_datapoints(
    orq_client: "Orq", dataset_id: str
) -> list[DataPoint]:
    """
    Fetch dataset from Orq platform and convert to DataPoint objects.
    Handles pagination to fetch all datapoints.

    Args:
        orq_client: Orq client instance
        dataset_id: ID of the dataset to fetch

    Returns:
        List of DataPoint objects with inputs and expected_output

    Raises:
        Exception: If dataset fetch fails or dataset not found
    """
    try:
        all_datapoints: list[DataPoint] = []
        starting_after: str | None = None
        last_id: str | None = None

        while True:
            response = await orq_client.datasets.list_datapoints_async(
                dataset_id=dataset_id,
                limit=50,
                starting_after=starting_after,
            )

            if not response or not response.data:
                if not all_datapoints:
                    raise Exception(f"Dataset {dataset_id} not found or has no data")
                break

            # Convert and append datapoints
            for point in response.data:
                all_datapoints.append(
                    DataPoint(
                        inputs=point.inputs if point.inputs is not None else {},
                        expected_output=point.expected_output,
                    )
                )
                # Track the last ID for pagination
                last_id = getattr(point, "_id", None) or getattr(point, "id", None)

            # Check if there are more pages
            if not getattr(response, "has_more", False):
                break

            # Set cursor for next page
            starting_after = last_id

        return all_datapoints

    except Exception as e:
        raise Exception(f"Failed to fetch dataset {dataset_id}: {e}")
