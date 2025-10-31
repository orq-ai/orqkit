"""Send evaluation results to Orq platform."""

import json
import os
from datetime import datetime

import httpx
from pydantic import BaseModel, Field

from .types import DataPoint, EvaluationResult, EvaluatorqResult, Output


# Same structure as EvaluatorqResult but with Error objects converted to strings for JSON serialization
class SerializedEvaluatorScore(BaseModel):
    """Serialized evaluator score for API transmission."""

    evaluator_name: str = Field(serialization_alias="evaluatorName")
    score: EvaluationResult
    error: str | None = None


class SerializedJobResult(BaseModel):
    """Serialized job result for API transmission."""

    job_name: str = Field(serialization_alias="jobName")
    output: Output
    error: str | None = None
    evaluator_scores: list[SerializedEvaluatorScore] | None = Field(
        default=None, serialization_alias="evaluatorScores"
    )


class SerializedDataPointResult(BaseModel):
    """Serialized data point result for API transmission."""

    data_point: DataPoint = Field(serialization_alias="dataPoint")
    error: str | None = None
    job_results: list[SerializedJobResult] | None = Field(
        default=None, serialization_alias="jobResults"
    )


class SendResultsPayload(BaseModel):
    """The payload format expected by the Orq API."""

    model_config: dict[str, bool] = {"populate_by_name": True}

    name: str = Field(serialization_alias="_name")
    description: str | None = Field(default=None, serialization_alias="_description")
    created_at: str = Field(serialization_alias="_createdAt")
    ended_at: str = Field(serialization_alias="_endedAt")
    evaluation_duration: int = Field(serialization_alias="_evaluationDuration")
    dataset_id: str | None = Field(default=None, serialization_alias="datasetId")
    results: list[SerializedDataPointResult]


class OrqResponse(BaseModel):
    """Response from Orq API when sending results."""

    sheet_id: str
    manifest_id: str
    experiment_name: str
    rows_created: int
    workspace_key: str | None = None
    experiment_url: str | None = None


async def send_results_to_orq(
    api_key: str,
    evaluation_name: str,
    evaluation_description: str | None,
    dataset_id: str | None,
    results: EvaluatorqResult,
    start_time: datetime,
    end_time: datetime,
) -> None:
    """
    Send evaluation results to Orq platform.

    Args:
        api_key: Orq API key for authentication
        evaluation_name: Name of the evaluation
        evaluation_description: Optional description of the evaluation
        dataset_id: Optional dataset ID if using Orq datasets
        results: The evaluation results to send
        start_time: When the evaluation started
        end_time: When the evaluation ended
    """
    try:
        # Convert results to serialized format using list comprehensions
        serialized_results: list[SerializedDataPointResult] = [
            SerializedDataPointResult(
                data_point=result.data_point,
                error=result.error,
                job_results=[
                    SerializedJobResult(
                        job_name=job_result.job_name,
                        output=job_result.output,
                        error=job_result.error,
                        evaluator_scores=[
                            SerializedEvaluatorScore(
                                evaluator_name=score.evaluator_name,
                                score=score.score,
                                error=score.error,
                            )
                            for score in job_result.evaluator_scores
                        ]
                        if job_result.evaluator_scores
                        else None,
                    )
                    for job_result in result.job_results
                ]
                if result.job_results
                else None,
            )
            for result in results
        ]

        # Calculate duration in milliseconds
        duration_ms = int((end_time - start_time).total_seconds() * 1000)

        # Build payload
        payload = SendResultsPayload(
            name=evaluation_name,
            description=evaluation_description,
            created_at=start_time.isoformat(),
            ended_at=end_time.isoformat(),
            evaluation_duration=duration_ms,
            dataset_id=dataset_id,
            results=serialized_results,
        )

        # Get base URL from environment or use default
        base_url = os.getenv("ORQ_BASE_URL", "https://api.orq.ai")
        orq_debug = os.getenv("ORQ_DEBUG", "false").lower() == "true"

        # Serialize with aliases for API field names
        payload_dict = payload.model_dump(mode="json", exclude_none=True, by_alias=True)

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{base_url}/v2/spreadsheets/evaluations/receive",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json=payload_dict,
            )

            if not response.is_success:
                error_text = response.text or "Unknown error"

                # Log warning instead of raising
                print(
                    f"\n⚠️  Warning: Could not send results to Orq platform ({response.status_code} {response.reason_phrase})"
                )

                # Only show detailed error in verbose mode or specific error cases
                if orq_debug or response.status_code >= 500:
                    print(f"   Details: {error_text}")

                return  # Return early but don't raise

            result_data = response.json()
            orq_result = OrqResponse(**result_data)

            print(
                f"✅ Results sent to Orq: {orq_result.experiment_name} ({orq_result.rows_created} rows created)"
            )

            # Display the experiment URL if available
            if orq_result.experiment_url:
                print(f"\n📊 View your evaluation at: {orq_result.experiment_url}")

    except Exception as error:
        # Log warning for network or other errors
        print("\n⚠️  Warning: Could not send results to Orq platform")

        if os.getenv("ORQ_DEBUG", "false").lower() == "true":
            print(f"   Details: {str(error)}")

        # Don't raise - just log the warning
        return
