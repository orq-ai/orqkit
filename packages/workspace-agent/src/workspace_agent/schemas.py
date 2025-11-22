"""
Pydantic models for structured outputs from agents.
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field, ConfigDict


class DatasetField(BaseModel):
    """Schema for a dataset field"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Field name")
    type: str = Field(description="Field type (string, number, boolean, etc.)")
    description: Optional[str] = Field(description="Field description", default="")


class DatasetSchema(BaseModel):
    """Schema for a dataset to be created.

    Note: system_prompt is not included here - it comes from the 1:1 matched prompt.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Dataset name")
    description: str = Field(description="What this dataset is for")
    fields: List[DatasetField] = Field(description="Dataset field definitions")
    sample_data: List[Dict[str, Any]] = Field(
        description="Sample data rows", default_factory=list
    )


class PromptSchema(BaseModel):
    """Schema for a prompt to be created.

    A prompt defines the AI's behavior via a system prompt.
    This is the instruction that tells the AI who it is and how to behave.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Prompt name")
    description: str = Field(description="What this prompt does")
    system_prompt: str = Field(
        description="The system prompt that defines the AI's role and behavior. "
        "This is the instruction that tells the AI who it is and how to respond."
    )
    model: str = Field(description="Model to use (will be set by user config)")
    temperature: float = Field(description="Temperature setting", default=0.7)
    max_tokens: int = Field(description="Maximum tokens", default=2000)


class WorkspacePlan(BaseModel):
    """Complete workspace plan output from planning agent"""

    model_config = ConfigDict(extra="forbid")

    reasoning: str = Field(description="Explanation of the plan choices")
    datasets: List[DatasetSchema] = Field(description="Datasets to create")
    prompts: List[PromptSchema] = Field(description="Prompts to create")


class CreatedDataset(BaseModel):
    """Information about a successfully created dataset"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Dataset ID")
    name: str = Field(description="Dataset name")
    description: str = Field(description="Dataset description")
    datapoint_count: int = Field(default=0, description="Number of datapoints in the dataset")


class CreatedPrompt(BaseModel):
    """Information about a successfully created prompt"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Prompt ID")
    name: str = Field(description="Prompt name")
    description: str = Field(description="Prompt description")


class DatasetAgentResult(BaseModel):
    """Result from dataset creation agent"""

    model_config = ConfigDict(extra="forbid")

    created_datasets: List[CreatedDataset] = Field(
        description="Successfully created datasets"
    )
    errors: List[str] = Field(
        description="Any errors encountered", default_factory=list
    )


class PromptAgentResult(BaseModel):
    """Result from prompt creation agent"""

    model_config = ConfigDict(extra="forbid")

    created_prompts: List[CreatedPrompt] = Field(
        description="Successfully created prompts"
    )
    errors: List[str] = Field(
        description="Any errors encountered", default_factory=list
    )


class ClarificationQuestion(BaseModel):
    """A single clarification question with suggested options"""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(description="The clarification question to ask")
    options: List[str] = Field(
        description="Three suggested options for the user to choose from",
        default_factory=list,
    )


class ClarificationDecision(BaseModel):
    """Decision from clarification agent about readiness to plan"""

    model_config = ConfigDict(extra="forbid")

    ready_to_plan: bool = Field(
        description="True when enough information has been gathered to create a good plan"
    )
    questions: List[ClarificationQuestion] = Field(
        description="Up to 3 clarification questions to ask the user (if ready_to_plan=False)",
        default_factory=list,
    )
    summary: str = Field(
        description="Summary of understood requirements (if ready_to_plan=True)",
        default="",
    )
    reasoning: str = Field(
        description="Explanation of why asking these questions or why ready to proceed"
    )


class CoordinatorDecision(BaseModel):
    """Decision from coordinator about next action"""

    model_config = ConfigDict(extra="forbid")

    action: str = Field(
        description="Next action to take: 'delegate_planning', 'delegate_dataset', 'delegate_prompt', 'request_human_input', or 'complete'"
    )
    request: str = Field(
        description="Context/request to pass to the delegated agent (empty for 'complete')",
        default="",
    )
    question: str = Field(
        description="Question to ask the user (only used when action is 'request_human_input')",
        default="",
    )
    reasoning: str = Field(
        description="Explanation of why this action was chosen"
    )


# =============================================================================
# Hierarchical Dataset Creation Schemas
# =============================================================================


class DatapointPlan(BaseModel):
    """High-level plan for a single datapoint, created by DatasetAgent."""

    model_config = ConfigDict(extra="forbid")

    description: str = Field(
        description="Brief description of what this datapoint represents (e.g., 'Angry customer complaining about late delivery')"
    )
    scenario: str = Field(
        description="Specific scenario details (e.g., 'Customer ordered 5 days ago, package is stuck in transit')"
    )
    tone: str = Field(
        description="Tone of the interaction (e.g., 'frustrated', 'polite', 'confused', 'demanding')"
    )
    key_elements: List[str] = Field(
        description="Key elements to include in the datapoint",
        default_factory=list
    )


class DatapointPlansResult(BaseModel):
    """Result from datapoint planning: a list of plans for datapoints to generate."""

    model_config = ConfigDict(extra="forbid")

    datapoint_plans: List[DatapointPlan] = Field(
        description="High-level plans for each datapoint to create"
    )


class DatasetCreationResult(BaseModel):
    """Result from DatasetAgent: dataset created + plans for datapoints."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(description="ID of the created dataset")
    dataset_name: str = Field(description="Name of the created dataset")
    datapoint_plans: List[DatapointPlan] = Field(
        description="High-level plans for each datapoint to create"
    )


class GeneratedDatapoint(BaseModel):
    """Concrete datapoint generated by DatapointAgent.

    The `inputs` field maps template variable names to their values.
    These variables are referenced in `messages` using {{variable_name}} syntax.

    Example:
        inputs: {"question": "How do I reset my password?", "customer_name": "John"}
        messages: [{"role": "user", "content": "{{question}}"}]

    At runtime, {{question}} will be replaced with "How do I reset my password?"
    """

    model_config = ConfigDict(extra="forbid")

    inputs: Dict[str, str] = Field(
        description="Key-value mapping of template variables to inject into messages. "
        "Keys are variable names (e.g., 'question', 'customer_name'), values are the actual content. "
        "These map to {{variable_name}} placeholders in the messages."
    )
    messages: List[Dict[str, str]] = Field(
        description="Conversation messages with 'role' (user/assistant/system) and 'content' keys. "
        "Content can include {{variable_name}} placeholders that reference keys from 'inputs'."
    )
    expected_output: str = Field(
        description="The ideal/expected response for this scenario"
    )
