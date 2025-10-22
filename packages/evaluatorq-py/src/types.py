from typing import Any, Callable, TypedDict
from collections.abc import Awaitable
from pydantic import BaseModel

Output = str | int | float | bool | dict[str, Any] | None
"""Output type alias"""


class EvaluationResult(BaseModel):
    value: str | float | bool
    explanation: str | None = None


class EvaluatorScore(BaseModel):
    evaluator_name: str
    score: EvaluationResult
    error: str | None = None


class JobResult(BaseModel):
    job_name: str
    output: Output
    error: str | None = None
    evaluator_scores: list[EvaluatorScore] | None = None


class DataPoint(BaseModel):
    """
    A data point for evaluation.

    Args:
        inputs: The inputs to pass to the job.
        expected_output: The expected output of the data point.
                        Used for evaluation and comparing the output of the job.
    """

    inputs: dict[str, Any]
    expected_output: Output | None = None


class DataPointResult(BaseModel):
    data_point: DataPoint
    error: str | None = None
    job_results: list[JobResult] | None = None


EvaluatorqResult = list[DataPointResult]
"""Type alias for evaluation results"""


class JobReturn(TypedDict):
    """Job return structure"""

    name: str
    output: Output


Job = Callable[[DataPoint, int], Awaitable[JobReturn]]
"""Job function type"""


class ScorerParameter(TypedDict):
    data: DataPoint
    output: Output


Scorer = Callable[[ScorerParameter], Awaitable[EvaluationResult]]


class Evaluator(TypedDict):
    name: str
    scorer: Scorer


class DatasetIdInput(TypedDict):
    dataset_id: str


class EvaluatorParams(TypedDict):
    """
    Parameters for running an evaluation.

    Args:
        data: The data to evaluate. Either a dataset_id dict to fetch from Orq platform,
              or a list of DataPoint instances/promises.
        evaluators: The evaluators to use. If not provided, only jobs will run.
        jobs: The jobs to run on the data.
        parallelism: Number of jobs to run in parallel. Defaults to 1 (sequential).
        print: Whether to print results table to console. Defaults to True.
        description: Optional description for the evaluation run.
    """

    data: DatasetIdInput | list[Awaitable[DataPoint] | DataPoint]
    evaluators: list[Evaluator] | None
    jobs: list[Job]
    parallelism: int
    print: bool
    description: str | None
