from typing import Any
from pydantic import BaseModel, Field


class LLMJudgeConfig(BaseModel):
    """Configuration for LLM as a Jury evaluation."""

    enabled: bool = Field(description="Whether to use LLM as a jury")
    temperature: float = Field(
        ge=0.0, le=2.0, description="Temperature for LLM jury [0.0, 2.0]"
    )
    number_of_judges: int = Field(ge=1, le=5, description="Number of judges [1, 5]")


class EvaluatorConfig(BaseModel):
    """Evaluator-specific configuration data."""

    allowed_values_categorical: list[str] | None = Field(
        default=None, description="Allowed values for categorical evaluation"
    )
    llm_jury: LLMJudgeConfig | None = Field(
        default=None, description="LLM as a Jury configuration"
    )
    automatic_model_contrasting: bool = Field(
        default=False,
        description="Automatically select different model than agent model to prevent bias",
    )


class DatasetFields(BaseModel):
    """Dataset fields containing log data for evaluation."""

    # Existing fields
    messages: Any = Field(description="Log messages")
    input: Any = Field(description="Log input")
    retrievals: Any = Field(description="Output of the executed retrieval steps")
    response: Any = Field(description="Last generated response")
    reference: Any = Field(description="Ground truth answer")
    last_user_query: Any = Field(description="Last user query")

    # New fields
    system_prompt: Any = Field(description="System prompt")
    history: Any = Field(
        description="Conversation between system, user and assistant without the last assistant and user query"
    )
    all_messages: Any = Field(
        description="All user, assistant, system messages + tool calls, retrievals"
    )
    tool_calls: Any = Field(
        description="Tool calls with base tool types (memory, knowledge-base, web_search, thinking tool)"
    )
    columns: dict[str, Any] = Field(
        description="Contents of all columns minus input, response and messages"
    )


class EvalInput(BaseModel):
    """Input data for evaluation."""

    dataset_data: DatasetFields = Field(
        description="Dataset fields containing log data"
    )
    evaluator_specific_data: EvaluatorConfig = Field(
        description="Evaluator-specific configuration"
    )


class EvalOutput(BaseModel):
    """Output data from evaluation."""

    answer: str | bool | float | int = Field(description="Evaluation answer")
    confidence: float = Field(description="Confidence score")
    reasoning: str = Field(description="Reasoning for the evaluation")
    model_used_for_evaluation: str = Field(description="Model used for evaluation")
    needs_human_review: bool = Field(
        description="Whether this evaluation needs human review"
    )
