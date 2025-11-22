"""
Configuration models for the workspace agent system.
"""

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings
from typing import Literal, Dict, List, Any, Optional


class LLMConfig(BaseModel):
    """Configuration for LLM models"""

    cheap_model: str = Field(
        default="google/gemini-2.5-flash", description="Model for routine tasks"
    )
    expensive_model: str = Field(
        default="google/gemini-2.5-flash", description="Model for complex tasks"
    )
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=5000, ge=1)


class PlatformConfig(BaseSettings):
    """Platform configuration - loaded from environment"""

    orq_api_key: str = Field(..., description="Orq API key for platform LLM usage")
    orq_base_url: str = Field(
        default="https://my.orq.ai/v2/proxy",
        description="Orq OpenAI-compatible endpoint",
    )

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


class WorkspaceSetupRequest(BaseModel):
    """Input parameters for workspace setup"""

    company_type: str = Field(
        ..., description="Type of company (e.g., E-commerce, SaaS)"
    )
    industry: str = Field(
        ..., description="Specific industry (e.g., Fashion Retail, Healthcare)"
    )
    specific_instructions: str = Field(
        default="", description="Additional setup instructions"
    )
    workspace_key: str = Field(..., description="Unique workspace identifier")
    customer_orq_api_key: str = Field(
        ..., description="Customer's Orq API key for their workspace"
    )
    num_dataset_rows: int = Field(
        default=10, ge=1, le=20, description="Number of sample rows per dataset"
    )
    num_datasets: int = Field(
        default=2,
        ge=0,
        le=5,
        description="Number of datasets to create",
    )
    num_prompts: int = Field(
        default=2,
        ge=0,
        le=5,
        description="Number of prompts to create",
    )
    project_path: str = Field(
        default="Example",
        description="Project/directory path in workspace for resources",
    )
    default_prompt_model: str = Field(
        default="gpt-4o-mini",
        description="Default model for created prompts in Orq",
    )
    input_keys: Optional[List[str]] = Field(
        default=None,
        description="Optional list of input variable names to use in datapoints. "
        "If provided, only these keys will be used. If empty/None, AI generates up to 3 keys.",
    )

    @field_validator("num_dataset_rows")
    @classmethod
    def cap_dataset_rows(cls, v: int) -> int:
        return min(v, 20)


class WorkspaceComponent(BaseModel):
    """Base model for workspace components"""

    name: str
    description: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class DatasetSpec(WorkspaceComponent):
    """Dataset specification"""

    data_schema: Dict[str, Any]  # JSON schema for the dataset
    sample_data: List[Dict[str, Any]]  # Sample data rows


class PromptSpec(WorkspaceComponent):
    """Prompt specification"""

    template: str
    model: str = "google/gemini-2.5-flash"
    temperature: float = 0.7
    max_tokens: int = 2000
    system_prompt: str = ""
