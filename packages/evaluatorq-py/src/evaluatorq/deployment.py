"""
Deployment helper functions for invoking Orq deployments.

This module provides convenient functions for calling Orq deployments
from within evaluation jobs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

__all__ = [
    "DeploymentOptions",
    "DeploymentResponse",
    "ThreadConfig",
    "MessageDict",
    "deployment",
    "invoke",
]

from typing_extensions import TypedDict

if TYPE_CHECKING:
    from orq_ai_sdk import Orq

# Cached client instance
_cached_client: "Orq | None" = None


class ThreadConfig(TypedDict, total=False):
    """Thread configuration for conversation tracking."""

    id: str
    tags: list[str] | None


class MessageDict(TypedDict, total=False):
    """Chat message structure compatible with Orq SDK."""

    role: Literal["system", "user", "assistant", "developer", "tool"]
    content: str
    name: str | None


@dataclass
class DeploymentOptions:
    """Options for invoking a deployment."""

    inputs: dict[str, object] | None = None
    """Input variables for the deployment template"""

    context: dict[str, object] | None = None
    """Context attributes for routing"""

    metadata: dict[str, object] | None = None
    """Metadata to attach to the request"""

    thread: ThreadConfig | None = None
    """Thread configuration for conversation tracking. Must include 'id' key."""

    messages: list[MessageDict] | None = None
    """Chat messages for conversational deployments"""


@dataclass
class DeploymentResponse:
    """Response from a deployment invocation."""

    content: str
    """The text content of the response"""

    raw: object
    """The raw response from the API"""


def _get_or_create_client() -> "Orq":
    """
    Get or create an Orq client instance.
    Reuses the same client for the entire process.

    Returns:
        Orq client instance

    Raises:
        ValueError: If ORQ_API_KEY is not set
        ImportError: If orq_ai_sdk is not installed
    """
    global _cached_client

    if _cached_client is not None:
        return _cached_client

    api_key = os.environ.get("ORQ_API_KEY")
    if not api_key:
        raise ValueError(
            "ORQ_API_KEY environment variable must be set to use the deployment helper."
        )

    try:
        from orq_ai_sdk import Orq

        server_url = os.environ.get("ORQ_BASE_URL", "https://my.orq.ai")
        _cached_client = Orq(api_key=api_key, server_url=server_url)
        return _cached_client
    except ModuleNotFoundError as e:
        raise ImportError(
            "The orq_ai_sdk package is not installed. To use deployment features, please install it:\n"
            "  pip install orq-ai-sdk\n"
            "  # or\n"
            "  uv add orq-ai-sdk\n"
            "  # or\n"
            "  poetry add orq-ai-sdk"
        ) from e
    except Exception as e:
        raise RuntimeError(f"Failed to setup ORQ client: {e}") from e


async def deployment(
    key: str,
    options: DeploymentOptions | None = None,
    *,
    inputs: dict[str, object] | None = None,
    context: dict[str, object] | None = None,
    metadata: dict[str, object] | None = None,
    thread: ThreadConfig | None = None,
    messages: list[MessageDict] | None = None,
) -> DeploymentResponse:
    """
    Invoke an Orq deployment and return the response content.

    Args:
        key: The deployment key (name)
        options: Optional DeploymentOptions object with all parameters
        inputs: Input variables for the deployment template
        context: Context attributes for routing
        metadata: Metadata to attach to the request
        thread: Thread configuration for conversation tracking. Must include 'id' key.
        messages: Chat messages for conversational deployments

    Returns:
        DeploymentResponse with content and raw response

    Example:
        # Simple invocation
        response = await deployment("my-deployment")
        print(response.content)

        # With inputs
        response = await deployment("summarizer", inputs={"text": "Long text..."})

        # With messages for chat-style deployments
        response = await deployment("chatbot", messages=[
            {"role": "user", "content": "Hello!"}
        ])

        # With thread tracking
        response = await deployment("assistant",
            inputs={"query": "What is AI?"},
            thread={"id": "conversation-123"}
        )
    """
    client = _get_or_create_client()

    # Merge options object with kwargs (kwargs take precedence)
    final_inputs = inputs
    final_context = context
    final_metadata = metadata
    final_thread = thread
    final_messages = messages

    if options is not None:
        if final_inputs is None:
            final_inputs = options.inputs
        if final_context is None:
            final_context = options.context
        if final_metadata is None:
            final_metadata = options.metadata
        if final_thread is None:
            final_thread = options.thread
        if final_messages is None:
            final_messages = options.messages

    # Convert our types to SDK-compatible types
    from orq_ai_sdk.models import Thread

    sdk_thread: Thread | None = None
    if final_thread is not None:
        sdk_thread = Thread(
            id=final_thread.get("id", ""),
            tags=final_thread.get("tags"),
        )

    # The SDK accepts list of message dicts directly
    completion = await client.deployments.invoke_async(
        key=key,
        inputs=final_inputs,
        context=final_context,
        metadata=final_metadata,
        thread=sdk_thread,
        messages=final_messages,  # pyright: ignore[reportArgumentType]
    )

    # Extract content from the response
    content = _extract_content_from_response(completion)

    return DeploymentResponse(content=content, raw=completion)


def _extract_content_from_response(completion: object) -> str:
    """Extract text content from an Orq deployment response."""
    content = ""
    choices = getattr(completion, "choices", None)

    if not choices or not isinstance(choices, list) or len(choices) == 0:
        return content

    first_choice = choices[0]
    message = getattr(first_choice, "message", None)

    if not message:
        return content

    msg_type = getattr(message, "type", None)
    msg_content = getattr(message, "content", None)

    if msg_type == "content" and isinstance(msg_content, str):
        content = msg_content
    elif msg_type == "content" and isinstance(msg_content, list):
        # Handle array content (e.g., multimodal responses)
        text_parts: list[str] = []
        for part in msg_content:
            if isinstance(part, dict) and part.get("type") == "text":
                text_parts.append(str(part.get("text", "")))
            elif hasattr(part, "type") and getattr(part, "type", None) == "text":
                text_parts.append(str(getattr(part, "text", "")))
        content = "\n".join(text_parts)

    return content


async def invoke(
    key: str,
    options: DeploymentOptions | None = None,
    *,
    inputs: dict[str, object] | None = None,
    context: dict[str, object] | None = None,
    metadata: dict[str, object] | None = None,
    thread: ThreadConfig | None = None,
    messages: list[MessageDict] | None = None,
) -> str:
    """
    Invoke an Orq deployment and return just the text content.
    This is a convenience wrapper around `deployment()` for simple use cases.

    Args:
        key: The deployment key (name)
        options: Optional DeploymentOptions object with all parameters
        inputs: Input variables for the deployment template
        context: Context attributes for routing
        metadata: Metadata to attach to the request
        thread: Thread configuration for conversation tracking. Must include 'id' key.
        messages: Chat messages for conversational deployments

    Returns:
        The text content of the response

    Example:
        # In a job
        @job("my-job")
        async def my_job(data, row):
            return await invoke("summarizer", inputs=data.inputs)
    """
    response = await deployment(
        key,
        options,
        inputs=inputs,
        context=context,
        metadata=metadata,
        thread=thread,
        messages=messages,
    )
    return response.content
