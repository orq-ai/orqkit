"""Conversion functions from LangChain messages to OpenResponses format."""

from __future__ import annotations

import json
import math
import time
import uuid
from typing import Any


def generate_item_id(prefix: str = "item") -> str:
    """Generate a unique item ID with the given prefix."""
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def convert_to_open_responses(
    messages: list[Any],
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
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

    input_items: list[dict[str, Any]] = []
    output_items: list[dict[str, Any]] = []

    # Track usage across all messages
    total_input_tokens = 0
    total_output_tokens = 0
    total_tokens = 0
    cached_tokens = 0
    reasoning_tokens = 0
    model_name = "unknown"
    last_finish_reason = "stop"

    for msg in messages:
        # Handle both message objects and dict format
        msg_type = _get_message_type(msg)
        msg_data = _get_message_data(msg)

        if msg_type == "human":
            # User message goes into input
            content_text = _get_content(msg_data)
            input_items.append({
                "type": "message",
                "id": generate_item_id("msg"),
                "role": "user",
                "status": "completed",
                "content": [
                    {
                        "type": "input_text",
                        "text": content_text,
                    }
                ],
            })

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

            # Extract model name from response metadata
            response_metadata = _get_response_metadata(msg_data)
            if response_metadata.get("model_name"):
                model_name = response_metadata["model_name"]
            if response_metadata.get("finish_reason"):
                last_finish_reason = response_metadata["finish_reason"]

            # Check for tool calls
            tool_calls = _get_tool_calls(msg_data)
            if tool_calls:
                # AI message with tool calls -> function_call items
                for tc in tool_calls:
                    call_id = tc.get("id", generate_item_id("call"))
                    output_items.append({
                        "type": "function_call",
                        "id": generate_item_id("fc"),
                        "call_id": call_id,
                        "name": tc.get("name", "unknown"),
                        "arguments": _serialize_args(tc.get("args", {})),
                        "status": "completed",
                    })
            else:
                # Final AI message with text content -> output message
                content_text = _get_content(msg_data)
                if content_text:
                    output_items.append({
                        "type": "message",
                        "id": generate_item_id("msg"),
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "text": content_text,
                                "annotations": [],
                                "logprobs": [],
                            }
                        ],
                    })

        elif msg_type == "tool":
            # Tool output -> function_call_output
            tool_call_id = _get_tool_call_id(msg_data)
            output_content = _get_content(msg_data)

            output_items.append({
                "type": "function_call_output",
                "id": generate_item_id("fco"),
                "call_id": tool_call_id,
                "output": output_content,
                "status": "completed",
            })

    # Build tools array
    tools_array: list[dict[str, Any]] = []
    if tools:
        for tool_def in tools:
            tools_array.append({
                "type": "function",
                "name": tool_def.get("name", "unknown"),
                "description": tool_def.get("description"),
                "parameters": tool_def.get("parameters"),
                "strict": None,
            })

    # Determine status from finish reason
    status = "completed"
    incomplete_details = None
    if last_finish_reason == "error":
        status = "failed"
    elif last_finish_reason in ("length", "content-filter"):
        status = "incomplete"
        incomplete_details = {"reason": last_finish_reason}

    return {
        "id": generate_item_id("resp"),
        "object": "response",
        "created_at": now,
        "completed_at": now if status == "completed" else None,
        "status": status,
        "incomplete_details": incomplete_details,
        "model": model_name,
        "previous_response_id": None,
        "instructions": None,
        "input": input_items,
        "output": output_items,
        "error": {"message": "Agent execution failed"} if status == "failed" else None,
        "tools": tools_array,
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
        "usage": {
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
            "total_tokens": total_tokens,
            "input_tokens_details": {
                "cached_tokens": cached_tokens,
            },
            "output_tokens_details": {
                "reasoning_tokens": reasoning_tokens,
            },
        } if total_tokens > 0 else None,
        "max_output_tokens": None,
        "max_tool_calls": None,
        "store": False,
        "background": False,
        "service_tier": "default",
        "metadata": {},
        "safety_identifier": None,
        "prompt_cache_key": None,
    }


def _get_message_type(msg: Any) -> str:
    """Extract message type from message object or dict."""
    # Dict format (from messages_to_dict)
    if isinstance(msg, dict):
        return msg.get("type", "")

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
        return msg.get("data", msg)

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
            result.append({
                "id": getattr(tc, "id", None),
                "name": getattr(tc, "name", "unknown"),
                "args": getattr(tc, "args", {}),
            })

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
