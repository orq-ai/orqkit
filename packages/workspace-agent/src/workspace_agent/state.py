"""
Shared state definitions for the LangGraph workflow.
"""

from typing import Annotated, Any, List, Literal, Optional
from pydantic import BaseModel, Field
from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from .schemas import WorkspacePlan, CreatedDataset, CreatedPrompt


class ChatAgentState(BaseModel):
    """Minimal state for the chat agent - only requires ReAct fields."""

    # Required by create_react_agent
    messages: Annotated[List[AnyMessage], add_messages] = Field(default_factory=list)
    remaining_steps: Optional[int] = Field(default=10)

    # Optional for structured output (not typically used in chat)
    structured_response: Optional[Any] = None


class WorkspaceState(BaseModel):
    """Shared state for the workspace setup workflow"""

    # Required by create_react_agent
    messages: Annotated[List[AnyMessage], add_messages] = Field(default_factory=list)
    remaining_steps: Optional[int] = Field(default=10)

    # Required when using response_format in create_react_agent
    structured_response: Optional[Any] = None

    # Input configuration
    company_type: str = ""
    industry: str = ""
    specific_instructions: str = ""
    workspace_key: str
    customer_orq_api_key: str  # Customer's API key for their workspace
    num_dataset_rows: int = 5
    project_path: str = "Example"  # Project/directory path in workspace

    # Planning phase
    workspace_plan: Optional[WorkspacePlan] = None

    # Execution tracking
    datasets_created: List[CreatedDataset] = Field(default_factory=list)
    prompts_created: List[CreatedPrompt] = Field(default_factory=list)

    # Status & control
    current_phase: Literal["planning", "dataset_ops", "prompt_ops", "complete"] = (
        "planning"
    )
    requires_human_input: bool = False
    errors: List[str] = Field(default_factory=list)
    iteration_count: int = 0  # Track number of coordinator loops to prevent infinite recursion
