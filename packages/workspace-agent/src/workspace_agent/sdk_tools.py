"""
SDK-based tools for datasets and prompts.
Uses the Orq Python SDK directly with native Pydantic models.
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field, ConfigDict
from langchain_core.tools import StructuredTool
from orq_ai_sdk import Orq

# Native SDK models
from orq_ai_sdk.models import CreateDatasetRequestBody
from orq_ai_sdk.models.createdatasetitemop import (
    CreateDatasetItemRequestBody as DatapointRequestBody,
    CreateDatasetItemMessagesUserMessage,
    CreateDatasetItemMessagesSystemMessage,
    CreateDatasetItemMessagesAssistantMessage,
)
from orq_ai_sdk.models.createpromptop import (
    CreatePromptRequestBody,
    PromptConfiguration,
    CreatePromptMessages,
    ModelParameters,
)

from .log import logger


# =============================================================================
# Pydantic Schemas for Tool Inputs (Gemini-compatible with extra='forbid')
# =============================================================================


class CreateDatasetInput(BaseModel):
    """Input for creating a dataset."""

    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(description="Name of the dataset")
    description: str = Field(default="", description="Description of the dataset")


class ListDatasetsInput(BaseModel):
    """Input for listing datasets."""

    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=10, description="Maximum number of datasets to return")


class AddDatapointInput(BaseModel):
    """Input for adding a single datapoint to a dataset."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(description="ID of the dataset to add the datapoint to")
    inputs: Dict[str, str] = Field(description="Input fields for the datapoint")
    messages: List[Dict[str, str]] = Field(
        description="Conversation messages, each with 'role' and 'content' keys"
    )
    expected_output: str = Field(
        description="Expected output/response for this datapoint"
    )


class ListDatapointsInput(BaseModel):
    """Input for listing datapoints in a dataset."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(description="ID of the dataset to list datapoints from")
    limit: int = Field(default=10, description="Maximum number of datapoints to return (1-50)")


class GetDatasetInput(BaseModel):
    """Input for getting a dataset by ID."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(description="ID of the dataset to retrieve")


class UpdateDatasetInput(BaseModel):
    """Input for updating a dataset."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(description="ID of the dataset to update")
    path: str = Field(description="New organizational path for the dataset")


class GetDatapointInput(BaseModel):
    """Input for getting a datapoint by ID."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(description="ID of the dataset")
    datapoint_id: str = Field(description="ID of the datapoint to retrieve")


class CreatePromptInput(BaseModel):
    """Input for creating a prompt."""

    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(description="Name of the prompt")
    system_prompt: str = Field(
        description="The system prompt that defines the AI's role and behavior"
    )
    model: str = Field(
        default="gpt-4o-mini", description="Model to use for this prompt"
    )
    temperature: float = Field(default=0.7, description="Temperature setting (0.0-2.0)")


class ListPromptsInput(BaseModel):
    """Input for listing prompts."""

    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=10, description="Maximum number of prompts to return")


class GetPromptInput(BaseModel):
    """Input for getting a prompt by ID."""

    model_config = ConfigDict(extra="forbid")

    prompt_id: str = Field(description="ID of the prompt to retrieve")


class UpdatePromptInput(BaseModel):
    """Input for updating a prompt."""

    model_config = ConfigDict(extra="forbid")

    prompt_id: str = Field(description="ID of the prompt to update")
    model: Optional[str] = Field(default=None, description="New model to use")
    temperature: Optional[float] = Field(default=None, description="New temperature setting (0.0-2.0)")
    max_tokens: Optional[int] = Field(default=None, description="New maximum tokens setting")


# =============================================================================
# SDK Tool Factory
# =============================================================================


class OrqSDKTools:
    """Factory for creating SDK-based tools with pre-configured settings."""

    def __init__(self, api_key: str, project_path: str):
        """
        Initialize SDK tools with configuration.

        Args:
            api_key: Customer's Orq API key
            project_path: Default project path for resources
        """
        self.client = Orq(api_key=api_key)
        self.project_path = project_path
        logger.info(f"OrqSDKTools initialized with project_path: {project_path}")

    # -------------------------------------------------------------------------
    # Dataset Operations
    # -------------------------------------------------------------------------

    def _create_dataset(self, display_name: str, description: str = "") -> str:
        """Create a new dataset using native SDK models."""
        try:
            request = CreateDatasetRequestBody(
                display_name=display_name,
                path=self.project_path,
            )
            result = self.client.datasets.create(request=request)
            dataset_id = result.id if hasattr(result, "id") else str(result)
            logger.success(f"Created dataset: {display_name} (ID: {dataset_id})")
            return dataset_id
        except Exception as e:
            logger.error(f"Failed to create dataset: {e}")
            raise

    def _list_datasets(self, limit: int = 10) -> List[Dict[str, Any]]:
        """List datasets in the workspace."""
        try:
            result = self.client.datasets.list(limit=limit)
            if result is None:
                return []
            datasets = []
            for ds in result.data if hasattr(result, "data") else result:
                datasets.append(
                    {
                        "id": ds.id if hasattr(ds, "id") else "",
                        "name": ds.display_name if hasattr(ds, "display_name") else "",
                        "description": getattr(ds, "description", ""),
                    }
                )
            logger.info(f"Listed {len(datasets)} datasets")
            return datasets
        except Exception as e:
            logger.error(f"Failed to list datasets: {e}")
            raise

    def _add_datapoint(
        self,
        dataset_id: str,
        inputs: Dict[str, str],
        messages: List[Dict[str, str]],
        expected_output: str,
    ) -> str:
        """Add a single datapoint to a dataset using native SDK models."""
        try:
            # Convert dict messages to SDK message types
            sdk_messages = []
            for msg in messages:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                if role == "user":
                    sdk_messages.append(CreateDatasetItemMessagesUserMessage(role="user", content=content))
                elif role == "system":
                    sdk_messages.append(CreateDatasetItemMessagesSystemMessage(role="system", content=content))
                elif role == "assistant":
                    sdk_messages.append(CreateDatasetItemMessagesAssistantMessage(role="assistant", content=content))
                else:
                    # Default to user message for unknown roles
                    sdk_messages.append(CreateDatasetItemMessagesUserMessage(role="user", content=content))

            datapoint = DatapointRequestBody(
                inputs=inputs,
                messages=sdk_messages,
                expected_output=expected_output,
            )
            result = self.client.datasets.create_datapoint(
                dataset_id=dataset_id,
                request_body=[datapoint],
            )
            datapoint_id = (
                result[0].id if result and hasattr(result[0], "id") else str(result)
            )
            logger.success(f"Added datapoint to dataset {dataset_id}: {datapoint_id}")
            return datapoint_id
        except Exception as e:
            logger.error(f"Failed to add datapoint: {e}")
            raise

    def _list_datapoints(self, dataset_id: str, limit: int = 10) -> List[Dict[str, Any]]:
        """List datapoints in a dataset."""
        try:
            result = self.client.datasets.list_datapoints(dataset_id=dataset_id, limit=limit)
            if result is None:
                return []
            datapoints = []
            for dp in result.data if hasattr(result, "data") else result:
                datapoints.append(
                    {
                        "id": dp.id if hasattr(dp, "id") else "",
                        "inputs": dp.inputs if hasattr(dp, "inputs") else {},
                        "expected_output": getattr(dp, "expected_output", ""),
                        "messages": getattr(dp, "messages", []),
                    }
                )
            logger.info(f"Listed {len(datapoints)} datapoints for dataset {dataset_id}")
            return datapoints
        except Exception as e:
            logger.error(f"Failed to list datapoints: {e}")
            raise

    def _get_dataset(self, dataset_id: str) -> Dict[str, Any]:
        """Get a dataset by ID."""
        try:
            result = self.client.datasets.retrieve(dataset_id=dataset_id)
            # Return full response - convert Pydantic model to dict
            if result is None:
                return {}
            if hasattr(result, "model_dump"):
                dataset = result.model_dump()
            elif hasattr(result, "dict"):
                dataset = result.dict()
            else:
                dataset = dict(result)
            logger.info(f"Retrieved dataset: {dataset_id}")
            return dataset
        except Exception as e:
            logger.error(f"Failed to get dataset: {e}")
            raise

    def _update_dataset(self, dataset_id: str, path: str) -> Dict[str, Any]:
        """Update a dataset's path."""
        try:
            result = self.client.datasets.update(dataset_id=dataset_id, path=path)
            dataset = {
                "id": result.id if hasattr(result, "id") else "",
                "name": result.display_name if hasattr(result, "display_name") else "",
                "path": getattr(result, "path", ""),
            }
            logger.success(f"Updated dataset: {dataset_id}")
            return dataset
        except Exception as e:
            logger.error(f"Failed to update dataset: {e}")
            raise

    def _get_datapoint(self, dataset_id: str, datapoint_id: str) -> Dict[str, Any]:
        """Get a specific datapoint by ID."""
        try:
            result = self.client.datasets.retrieve_datapoint(
                dataset_id=dataset_id, datapoint_id=datapoint_id
            )
            # Return full response - convert Pydantic model to dict
            if result is None:
                return {}
            if hasattr(result, "model_dump"):
                datapoint = result.model_dump()
            elif hasattr(result, "dict"):
                datapoint = result.dict()
            else:
                datapoint = dict(result)
            logger.info(f"Retrieved datapoint: {datapoint_id}")
            return datapoint
        except Exception as e:
            logger.error(f"Failed to get datapoint: {e}")
            raise

    # -------------------------------------------------------------------------
    # Public Methods for Direct Access (used by orchestrator)
    # -------------------------------------------------------------------------

    def add_datapoint(
        self,
        dataset_id: str,
        inputs: Dict[str, str],
        messages: List[Dict[str, str]],
        expected_output: str,
    ) -> str:
        """Public method to add a datapoint - delegates to _add_datapoint."""
        return self._add_datapoint(dataset_id, inputs, messages, expected_output)

    # -------------------------------------------------------------------------
    # Prompt Operations
    # -------------------------------------------------------------------------

    def _create_prompt(
        self,
        display_name: str,
        system_prompt: str,
        model: str = "gpt-4o-mini",
        temperature: float = 0.7,
    ) -> str:
        """Create a new prompt using native SDK models."""
        try:
            # Build messages with just the system prompt
            sdk_messages = [
                CreatePromptMessages(role="system", content=system_prompt),
            ]

            # Build model parameters
            model_parameters = ModelParameters(temperature=temperature)

            # Build prompt config
            prompt_config = PromptConfiguration(
                messages=sdk_messages,
                model=model,
                model_parameters=model_parameters,
            )

            # Build request
            request = CreatePromptRequestBody(
                display_name=display_name,
                path=self.project_path,
                prompt_config=prompt_config,
            )

            result = self.client.prompts.create(request=request)
            prompt_id = result.id if hasattr(result, "id") else str(result)
            logger.success(f"Created prompt: {display_name} (ID: {prompt_id})")
            return prompt_id
        except Exception as e:
            logger.error(f"Failed to create prompt: {e}")
            raise

    def _list_prompts(self, limit: int = 10) -> List[Dict[str, Any]]:
        """List prompts in the workspace."""
        try:
            result = self.client.prompts.list(limit=limit)
            prompts = []
            for p in result.data if hasattr(result, "data") else result:
                prompts.append(
                    {
                        "id": p.id if hasattr(p, "id") else "",
                        "name": p.display_name if hasattr(p, "display_name") else "",
                        "description": getattr(p, "description", ""),
                    }
                )
            logger.info(f"Listed {len(prompts)} prompts")
            return prompts
        except Exception as e:
            logger.error(f"Failed to list prompts: {e}")
            raise

    def _get_prompt(self, prompt_id: str) -> Dict[str, Any]:
        """Get a prompt by ID."""
        try:
            result = self.client.prompts.retrieve(id=prompt_id)
            # Return full response - convert Pydantic model to dict
            if result is None:
                return {}
            if hasattr(result, "model_dump"):
                prompt = result.model_dump()
            elif hasattr(result, "dict"):
                prompt = result.dict()
            else:
                prompt = dict(result)
            logger.info(f"Retrieved prompt: {prompt_id}")
            return prompt
        except Exception as e:
            logger.error(f"Failed to get prompt: {e}")
            raise

    def _update_prompt(
        self,
        prompt_id: str,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Update a prompt's configuration."""
        try:
            # Build update kwargs - only include non-None values
            update_kwargs: Dict[str, Any] = {"id": prompt_id}

            # Build prompt_config if any model params are being updated
            prompt_config: Dict[str, Any] = {}
            model_parameters: Dict[str, Any] = {}

            if model is not None:
                prompt_config["model"] = model
            if temperature is not None:
                model_parameters["temperature"] = temperature
            if max_tokens is not None:
                model_parameters["max_tokens"] = max_tokens

            if model_parameters:
                prompt_config["model_parameters"] = model_parameters

            if prompt_config:
                update_kwargs["prompt_config"] = prompt_config

            result = self.client.prompts.update(**update_kwargs)
            prompt = {
                "id": result.id if hasattr(result, "id") else "",
                "name": result.display_name if hasattr(result, "display_name") else "",
            }
            logger.success(f"Updated prompt: {prompt_id}")
            return prompt
        except Exception as e:
            logger.error(f"Failed to update prompt: {e}")
            raise

    # -------------------------------------------------------------------------
    # Tool Creation
    # -------------------------------------------------------------------------

    def get_dataset_tools(self) -> List[StructuredTool]:
        """Get all dataset-related tools."""
        return [
            StructuredTool.from_function(
                func=lambda display_name, description="": self._create_dataset(
                    display_name, description
                ),
                name="create_dataset",
                description="Create a new dataset in the workspace. Returns the dataset ID.",
                args_schema=CreateDatasetInput,
            ),
            StructuredTool.from_function(
                func=lambda limit=10: self._list_datasets(limit),
                name="list_datasets",
                description="List all datasets in the workspace.",
                args_schema=ListDatasetsInput,
            ),
            StructuredTool.from_function(
                func=lambda dataset_id: self._get_dataset(dataset_id),
                name="get_dataset",
                description="Get a specific dataset by ID. Returns dataset details.",
                args_schema=GetDatasetInput,
            ),
            StructuredTool.from_function(
                func=lambda dataset_id, path: self._update_dataset(dataset_id, path),
                name="update_dataset",
                description="Update a dataset's organizational path.",
                args_schema=UpdateDatasetInput,
            ),
            StructuredTool.from_function(
                func=lambda dataset_id,
                inputs,
                messages,
                expected_output: self._add_datapoint(
                    dataset_id, inputs, messages, expected_output
                ),
                name="add_datapoint",
                description="Add a single datapoint to a dataset. Call this once for each datapoint.",
                args_schema=AddDatapointInput,
            ),
            StructuredTool.from_function(
                func=lambda dataset_id, limit=10: self._list_datapoints(dataset_id, limit),
                name="list_datapoints",
                description="List all datapoints in a specific dataset. Returns datapoint IDs, inputs, messages, and expected outputs.",
                args_schema=ListDatapointsInput,
            ),
            StructuredTool.from_function(
                func=lambda dataset_id, datapoint_id: self._get_datapoint(dataset_id, datapoint_id),
                name="get_datapoint",
                description="Get a specific datapoint by ID. Returns datapoint details including inputs, messages, and expected output.",
                args_schema=GetDatapointInput,
            ),
        ]

    def get_prompt_tools(self) -> List[StructuredTool]:
        """Get all prompt-related tools."""
        return [
            StructuredTool.from_function(
                func=lambda display_name,
                system_prompt,
                model="gpt-4o-mini",
                temperature=0.7: self._create_prompt(
                    display_name, system_prompt, model, temperature
                ),
                name="create_prompt",
                description="Create a new prompt in the workspace. Returns the prompt ID.",
                args_schema=CreatePromptInput,
            ),
            StructuredTool.from_function(
                func=lambda limit=10: self._list_prompts(limit),
                name="list_prompts",
                description="List all prompts in the workspace.",
                args_schema=ListPromptsInput,
            ),
            StructuredTool.from_function(
                func=lambda prompt_id: self._get_prompt(prompt_id),
                name="get_prompt",
                description="Get a specific prompt by ID. Returns prompt details.",
                args_schema=GetPromptInput,
            ),
            StructuredTool.from_function(
                func=lambda prompt_id, model=None, temperature=None, max_tokens=None: self._update_prompt(
                    prompt_id, model, temperature, max_tokens
                ),
                name="update_prompt",
                description="Update a prompt's configuration (model, temperature, max_tokens).",
                args_schema=UpdatePromptInput,
            ),
        ]

    def get_all_tools(self) -> List[StructuredTool]:
        """Get all SDK tools."""
        return self.get_dataset_tools() + self.get_prompt_tools()


# =============================================================================
# Convenience function
# =============================================================================


def create_sdk_tools(
    api_key: str, project_path: str, tool_type: Optional[str] = None
) -> List[StructuredTool]:
    """
    Create SDK tools with pre-configured settings.

    Args:
        api_key: Customer's Orq API key
        project_path: Default project path for resources
        tool_type: Optional filter - "dataset", "prompt", or None for all

    Returns:
        List of StructuredTool instances
    """
    sdk_tools = OrqSDKTools(api_key, project_path)

    if tool_type == "dataset":
        return sdk_tools.get_dataset_tools()
    elif tool_type == "prompt":
        return sdk_tools.get_prompt_tools()
    else:
        return sdk_tools.get_all_tools()
