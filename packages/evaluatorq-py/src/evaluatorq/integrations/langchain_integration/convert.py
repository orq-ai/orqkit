"""Conversion functions from LangChain messages to OpenResponses format."""

from __future__ import annotations

import json
import math
import time
import uuid
from typing import Any

from evaluatorq.openresponses import ResponseResourceDict
from evaluatorq.openresponses.convert_models import (
    FunctionCall,
    FunctionCallOutput,
    FunctionCallOutputStatusEnum,
    FunctionCallStatus,
    FunctionTool,
    IncompleteDetails,
    InputTextContent,
    InputTokensDetails,
    Message,
    MessageRole,
    MessageStatus,
    OutputTextContent,
    OutputTokensDetails,
    Usage,
)


def generate_item_id(prefix: str = "item") -> str:
    """Generate a unique item ID with the given prefix."""
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


# Map constructor ID to message type (for lc serialization format)
CONSTRUCTOR_TYPE_MAP = {
    "HumanMessage": "human",
    "AIMessage": "ai",
    "ToolMessage": "tool",
    "SystemMessage": "system",
}


def convert_to_open_responses(
    messages: list[Any],
    tools: list[dict[str, Any]] | None = None,
) -> ResponseResourceDict:
    """
    Convert LangChain agent messages to OpenResponses format.

    This function handles both LangChain message objects and dict representations
    (from messages_to_dict).

    Args:
        messages: List of LangChain messages from agent execution.
        tools: Optional list of tool definitions used by the agent.

    Returns:
        A ResponseResourceDict in OpenResponses format.
    """
    now = math.floor(time.time())

    input_items: list[Message] = []
    output_items: list[FunctionCall | FunctionCallOutput | Message] = []

    # Track usage across all messages
    total_input_tokens = 0
    total_output_tokens = 0
    total_tokens = 0
    cached_tokens = 0
    reasoning_tokens = 0
    model_name = "unknown"
    last_finish_reason = "stop"
    last_ai_message_id: str | None = None
    model_provider: str | None = None
    system_fingerprint: str | None = None

    for msg in messages:
        # Handle both message objects and dict format
        msg_type = _get_message_type(msg)
        msg_data = _get_message_data(msg)

        if msg_type == "human":
            # User message goes into input
            content_text = _get_content(msg_data)
            input_message = Message(
                type="message",
                id=generate_item_id("msg"),
                role=MessageRole.user,
                status=MessageStatus.completed,
                content=[InputTextContent(type="input_text", text=content_text)],
            )
            input_items.append(input_message)

        elif msg_type == "ai":
            # Extract usage metadata
            usage = _extract_usage(msg_data)
            if usage:
                total_input_tokens += usage.get("input_tokens", 0)
                total_output_tokens += usage.get("output_tokens", 0)
                total_tokens += usage.get("total_tokens", 0)
                input_details = usage.get("input_token_details", {})
                cached_tokens += input_details.get("cache_read", 0)
                output_details = usage.get("output_token_details", {})
                reasoning_tokens += output_details.get("reasoning", 0)

            # Extract model name and other metadata from response metadata
            response_metadata = _get_response_metadata(msg_data)
            if response_metadata.get("model_name"):
                model_name = response_metadata["model_name"]
            if response_metadata.get("finish_reason"):
                last_finish_reason = response_metadata["finish_reason"]
            if response_metadata.get("model_provider"):
                model_provider = response_metadata["model_provider"]
            if response_metadata.get("system_fingerprint"):
                system_fingerprint = response_metadata["system_fingerprint"]

            # Extract message ID (e.g., chatcmpl-... from OpenAI)
            message_id = _get_message_id(msg_data)
            if message_id:
                last_ai_message_id = message_id

            # Check for tool calls
            tool_calls = _get_tool_calls(msg_data)
            if tool_calls:
                # AI message with tool calls -> function_call items
                for tc in tool_calls:
                    call_id = tc.get("id", generate_item_id("call"))
                    function_call = FunctionCall(
                        type="function_call",
                        id=generate_item_id("fc"),
                        call_id=call_id,
                        name=tc.get("name", "unknown"),
                        arguments=_serialize_args(tc.get("args", {})),
                        status=FunctionCallStatus.completed,
                    )
                    output_items.append(function_call)
            else:
                # Final AI message with text content -> output message
                content_text = _get_content(msg_data)
                if content_text:
                    output_message = Message(
                        type="message",
                        id=generate_item_id("msg"),
                        role=MessageRole.assistant,
                        status=MessageStatus.completed,
                        content=[
                            OutputTextContent(
                                type="output_text",
                                text=content_text,
                                annotations=[],
                                logprobs=[],
                            )
                        ],
                    )
                    output_items.append(output_message)

        elif msg_type == "tool":
            # Tool output -> function_call_output
            tool_call_id = _get_tool_call_id(msg_data)
            output_content = _get_content(msg_data)

            function_call_output = FunctionCallOutput(
                type="function_call_output",
                id=generate_item_id("fco"),
                call_id=tool_call_id,
                output=output_content,
                status=FunctionCallOutputStatusEnum.completed,
            )
            output_items.append(function_call_output)

    # Build tools array
    tools_array: list[FunctionTool] = []
    if tools:
        for tool_def in tools:
            tool = FunctionTool(
                type="function",
                name=tool_def.get("name", "unknown"),
                description=tool_def.get("description"),
                parameters=tool_def.get("parameters"),
                strict=None,
            )
            tools_array.append(tool)

    # Determine status from finish reason
    status = "completed"
    incomplete_details: IncompleteDetails | None = None
    if last_finish_reason == "error":
        status = "failed"
    elif last_finish_reason in ("length", "content-filter"):
        status = "incomplete"
        incomplete_details = IncompleteDetails(reason=last_finish_reason)

    # Build usage
    usage_data: Usage | None = None
    if total_tokens > 0:
        usage_data = Usage(
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            total_tokens=total_tokens,
            input_tokens_details=InputTokensDetails(cached_tokens=cached_tokens),
            output_tokens_details=OutputTokensDetails(
                reasoning_tokens=reasoning_tokens
            ),
        )

    # Use the last AI message ID as the response ID if available
    response_id = last_ai_message_id or generate_item_id("resp")

    # Build metadata with optional fields
    metadata: dict[str, Any] = {"framework": "langchain"}
    if model_provider:
        metadata["model_provider"] = model_provider
    if system_fingerprint:
        metadata["system_fingerprint"] = system_fingerprint

    # Serialize Pydantic models to dicts for the response
    return {
        "id": response_id,
        "object": "response",
        "created_at": now,
        "completed_at": now if status == "completed" else None,
        "status": status,
        "incomplete_details": incomplete_details.model_dump()
        if incomplete_details
        else None,
        "model": model_name,
        "previous_response_id": None,
        "instructions": None,
        "input": [msg.model_dump() for msg in input_items],
        "output": [item.model_dump() for item in output_items],
        "error": {"message": "Agent execution failed"} if status == "failed" else None,
        "tools": [tool.model_dump() for tool in tools_array],
        "tool_choice": "auto",
        "truncation": "disabled",
        "parallel_tool_calls": True,
        "text": {
            "format": {"type": "text"},
        },
        "top_p": 1.0,
        "presence_penalty": 0.0,
        "frequency_penalty": 0.0,
        "top_logprobs": 0,
        "temperature": 1.0,
        "reasoning": None,
        "usage": usage_data.model_dump() if usage_data else None,
        "max_output_tokens": None,
        "max_tool_calls": None,
        "store": False,
        "background": False,
        "service_tier": "default",
        "metadata": metadata,
        "safety_identifier": None,
        "prompt_cache_key": None,
    }


def _get_message_type(msg: Any) -> str:
    """Extract message type from message object or dict."""
    # Dict format (from messages_to_dict)
    if isinstance(msg, dict):
        # Check for constructor format (lc serialization)
        # Format: { lc: 1, type: "constructor", id: ["langchain_core", "messages", "HumanMessage"], kwargs: {...} }
        if msg.get("type") == "constructor" and isinstance(msg.get("id"), list):
            id_array = msg.get("id")
            # The message type is the last element in the id array (e.g., "HumanMessage")
            if id_array:
                constructor_name = id_array[-1]
                if constructor_name in CONSTRUCTOR_TYPE_MAP:
                    return CONSTRUCTOR_TYPE_MAP[constructor_name]

        # Check explicit type property (direct message format)
        msg_type = msg.get("type", "")
        if msg_type and msg_type != "constructor":
            return msg_type

        # Check for nested data.type in dict format
        data = msg.get("data")
        if isinstance(data, dict) and data.get("type"):
            return data["type"]

        return "unknown"

    # LangChain message objects
    type_attr = getattr(msg, "type", None)
    if type_attr:
        return type_attr

    # Fallback: check class name
    class_name = msg.__class__.__name__.lower()
    if "human" in class_name:
        return "human"
    if "ai" in class_name:
        return "ai"
    if "tool" in class_name:
        return "tool"
    if "system" in class_name:
        return "system"

    return "unknown"


def _get_message_data(msg: Any) -> dict[str, Any]:
    """Extract message data from message object or dict."""
    # Dict format (from messages_to_dict)
    if isinstance(msg, dict):
        # Constructor format (lc serialization) has data in "kwargs" property
        # Format: { lc: 1, type: "constructor", id: [...], kwargs: { content, response_metadata, ... } }
        if msg.get("type") == "constructor" and msg.get("kwargs"):
            return msg["kwargs"]

        # Dict format has nested "data" property
        if isinstance(msg.get("data"), dict):
            return msg["data"]

        return msg

    # LangChain message object - convert to dict-like access
    return msg


def _get_content(msg_data: Any) -> str:
    """Extract content from message data."""
    if isinstance(msg_data, dict):
        content = msg_data.get("content", "")
    else:
        content = getattr(msg_data, "content", "")

    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Handle content blocks
        text_parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_parts.append(item.get("text", ""))
            elif isinstance(item, str):
                text_parts.append(item)
        return "".join(text_parts)

    return str(content) if content else ""


def _get_tool_calls(msg_data: Any) -> list[dict[str, Any]]:
    """Extract tool calls from AI message data."""
    if isinstance(msg_data, dict):
        tool_calls = msg_data.get("tool_calls", [])
    else:
        tool_calls = getattr(msg_data, "tool_calls", [])

    if not tool_calls:
        return []

    result = []
    for tc in tool_calls:
        if isinstance(tc, dict):
            result.append(tc)
        else:
            # LangChain ToolCall object
            result.append(
                {
                    "id": getattr(tc, "id", None),
                    "name": getattr(tc, "name", "unknown"),
                    "args": getattr(tc, "args", {}),
                }
            )

    return result


def _get_tool_call_id(msg_data: Any) -> str:
    """Extract tool call ID from tool message data."""
    if isinstance(msg_data, dict):
        return msg_data.get("tool_call_id", generate_item_id("call"))
    return getattr(msg_data, "tool_call_id", generate_item_id("call"))


def _get_response_metadata(msg_data: Any) -> dict[str, Any]:
    """Extract response metadata from message data."""
    if isinstance(msg_data, dict):
        return msg_data.get("response_metadata", {})
    return getattr(msg_data, "response_metadata", {}) or {}


def _get_message_id(msg_data: Any) -> str | None:
    """Extract message ID from message data."""
    if isinstance(msg_data, dict):
        return msg_data.get("id")
    return getattr(msg_data, "id", None)


def _extract_usage(msg_data: Any) -> dict[str, Any] | None:
    """Extract usage metadata from message data."""
    if isinstance(msg_data, dict):
        return msg_data.get("usage_metadata")
    return getattr(msg_data, "usage_metadata", None)


def _serialize_args(args: Any) -> str:
    """Serialize tool arguments to JSON string."""
    if isinstance(args, str):
        return args
    return json.dumps(args)
