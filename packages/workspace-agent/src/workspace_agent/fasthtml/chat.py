"""Chat handlers and state management for the workspace agent chat interface."""

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Any, List, Optional

from fasthtml.common import sse_message

from ..config import LLMConfig, PlatformConfig
from ..agents import WorkspaceAgentFactory
from ..log import logger
from ..tracing import traced, tracer, init_tracing
from .chat_components import render_chat_message, render_typing_indicator

# Initialize tracing on module load
init_tracing(service_name="workspace-agent-chat")


# =============================================================================
# Chat State Management
# =============================================================================


@dataclass
class ChatState:
    """State for a chat session."""

    chat_id: str
    messages: List[Dict[str, Any]] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=lambda: {
        "model": "google/gemini-2.5-flash",
        "temperature": 0.7,
    })
    # SDK config
    customer_api_key: Optional[str] = None
    project_path: str = "Example"
    # Tool backend mode
    use_mcp: bool = False  # If True, use MCP tools (TypeScript server)
    # State tracking
    is_processing: bool = False
    created_at: datetime = field(default_factory=datetime.now)
    last_activity: datetime = field(default_factory=datetime.now)
    error: Optional[str] = None


# In-memory chat session storage
_chat_sessions: Dict[str, ChatState] = {}


def get_or_create_chat(session, form_data: Optional[Dict] = None) -> ChatState:
    """Get existing chat from session or create a new one."""
    chat_id = session.get("chat_id")
    if chat_id and chat_id in _chat_sessions:
        chat = _chat_sessions[chat_id]
        # Update SDK config from form_data if provided
        if form_data:
            chat.customer_api_key = form_data.get("customer_api_key", chat.customer_api_key)
            chat.project_path = form_data.get("project_path", chat.project_path)
            # Update MCP mode if specified
            if "use_mcp" in form_data:
                chat.use_mcp = form_data.get("use_mcp", False)
        return chat

    # Create new chat
    chat_id = str(uuid.uuid4())
    chat = ChatState(chat_id=chat_id)

    # Initialize from form_data if available
    if form_data:
        chat.customer_api_key = form_data.get("customer_api_key")
        chat.project_path = form_data.get("project_path", "Example")
        chat.config["model"] = form_data.get("model", "google/gemini-2.5-flash")
        chat.use_mcp = form_data.get("use_mcp", False)

    _chat_sessions[chat_id] = chat
    session["chat_id"] = chat_id
    return chat


def get_chat(chat_id: str) -> Optional[ChatState]:
    """Get chat by ID."""
    return _chat_sessions.get(chat_id)


def update_chat_config(chat: ChatState, model: Optional[str] = None, temperature: Optional[float] = None):
    """Update chat configuration."""
    if model:
        chat.config["model"] = model
    if temperature is not None:
        chat.config["temperature"] = temperature
    chat.last_activity = datetime.now()


def add_user_message(chat: ChatState, content: str) -> Dict[str, Any]:
    """Add a user message to the chat."""
    message = {
        "role": "user",
        "content": content,
        "timestamp": datetime.now().isoformat(),
    }
    chat.messages.append(message)
    chat.last_activity = datetime.now()
    return message


def add_assistant_message(chat: ChatState, content: str) -> Dict[str, Any]:
    """Add an assistant message to the chat."""
    message = {
        "role": "assistant",
        "content": content,
        "timestamp": datetime.now().isoformat(),
    }
    chat.messages.append(message)
    chat.last_activity = datetime.now()
    return message


def add_tool_message(
    chat: ChatState,
    tool_name: str,
    tool_args: Dict[str, Any],
    tool_result: Optional[str] = None,
    tool_error: Optional[str] = None,
) -> Dict[str, Any]:
    """Add a tool call message to the chat."""
    message = {
        "role": "tool",
        "tool_name": tool_name,
        "tool_args": tool_args,
        "tool_result": tool_result or "",
        "tool_error": tool_error,
        "timestamp": datetime.now().isoformat(),
    }
    chat.messages.append(message)
    chat.last_activity = datetime.now()
    return message


# =============================================================================
# Chat Agent Execution
# =============================================================================


@traced(name="execute_chat_message", type="agent")
async def execute_chat_message(
    chat: ChatState,
    user_message: str,
    platform_config: PlatformConfig,
    use_mcp: bool = False,
) -> Dict[str, Any]:
    """Execute a chat message and get the agent's response.

    Args:
        chat: The chat state
        user_message: The user's message
        platform_config: Platform configuration
        use_mcp: If True, use MCP tools (TypeScript server). If False, use SDK tools.

    Returns:
        Dict with 'response' (str), 'tool_calls' (list), and 'error' (optional str)
    """
    logger.info(f"[Chat {chat.chat_id[:8]}] Processing message: {user_message[:50]}... (use_mcp={use_mcp})")

    # Platform API key is used for LLM inference via Orq
    platform_api_key = platform_config.orq_api_key
    if not platform_api_key:
        return {
            "response": "Platform API key not configured. Please set ORQ_API_KEY environment variable.",
            "tool_calls": [],
            "error": "Missing platform API key",
        }

    # SDK tools use customer API key to manage their workspace
    # Fall back to platform API key if not provided
    sdk_api_key = chat.customer_api_key or platform_api_key

    factory = None
    try:
        # Create LLM config from chat settings
        llm_config = LLMConfig(
            cheap_model=chat.config.get("model", "google/gemini-2.5-flash"),
            expensive_model=chat.config.get("model", "google/gemini-2.5-flash"),
            temperature=chat.config.get("temperature", 0.7),
        )

        # Create agent factory
        factory = WorkspaceAgentFactory(llm_config, platform_config)

        # Initialize tools based on preference
        if use_mcp:
            # MCP uses environment variable set on server init
            await factory.init_mcp_tools(api_key=platform_api_key)
        else:
            # SDK tools use customer's API key to manage their workspace
            factory.init_sdk_tools(
                api_key=chat.customer_api_key,
                project_path=chat.project_path,
            )

        # Create chat agent
        chat_agent = factory.create_chat_agent(use_mcp=use_mcp)

        # Build conversation history for context
        # Note: user_message is already added to chat.messages by chat_stream_generator
        # before calling this function, so we include all stored messages
        history = []
        for msg in chat.messages[-20:]:  # Last 20 messages for context
            if msg["role"] == "user":
                history.append({"role": "user", "content": msg["content"]})
            elif msg["role"] == "assistant":
                history.append({"role": "assistant", "content": msg["content"]})
            elif msg["role"] == "tool":
                # Include tool results as assistant context
                # Format: "Used tool X with args Y, result: Z"
                tool_name = msg.get("tool_name", "unknown")
                tool_result = msg.get("tool_result", "")
                tool_error = msg.get("tool_error")
                if tool_error:
                    tool_summary = f"[Tool: {tool_name}] Error: {tool_error}"
                elif tool_result:
                    # Truncate very long results for context
                    result_preview = tool_result[:500] + "..." if len(tool_result) > 500 else tool_result
                    tool_summary = f"[Tool: {tool_name}] Result: {result_preview}"
                else:
                    tool_summary = f"[Tool: {tool_name}] Executed successfully"
                history.append({"role": "assistant", "content": tool_summary})

        # Build the prompt
        system_prompt = """You are a helpful Workspace Assistant for the Orq.ai platform.
You can help users manage their workspace by creating and managing datasets and prompts.

Available tools:
- create_dataset: Create a new dataset
- add_datapoint: Add a datapoint to an existing dataset
- list_datasets: List all datasets in the workspace
- list_datapoints: List all datapoints in a specific dataset
- delete_dataset: Delete a dataset
- create_prompt: Create a new prompt
- list_prompts: List all prompts in the workspace
- delete_prompt: Delete a prompt

Be helpful, concise, and use tools when appropriate to fulfill user requests.
When using tools, explain what you're doing and report the results clearly."""

        # Invoke the agent
        agent_input = {
            "messages": [{"role": "system", "content": system_prompt}] + history,
        }

        result = await chat_agent.ainvoke(agent_input)

        # Extract response and tool calls from result
        response_text = ""
        tool_calls = []

        messages = result.get("messages", [])
        for msg in messages:
            # Get tool calls from AI messages
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                for tc in msg.tool_calls:
                    tool_calls.append({
                        "name": tc.get("name", "unknown"),
                        "args": tc.get("args", {}),
                    })

            # Get tool results
            if hasattr(msg, "type") and msg.type == "tool":
                tool_name = getattr(msg, "name", "unknown")
                tool_result = msg.content if hasattr(msg, "content") else ""
                tool_calls.append({
                    "name": tool_name,
                    "args": {},
                    "result": tool_result,
                })

            # Get final assistant response (last AI message with content and no tool calls)
            if hasattr(msg, "type") and msg.type == "ai":
                if hasattr(msg, "content") and msg.content:
                    # Only use as response if it's not just a tool call
                    if not (hasattr(msg, "tool_calls") and msg.tool_calls):
                        response_text = msg.content
                    elif isinstance(msg.content, str) and msg.content.strip():
                        # AI might provide explanation alongside tool calls
                        response_text = msg.content

        # If no explicit response, generate one
        if not response_text and tool_calls:
            response_text = "I've completed the requested actions. See the tool results above."

        logger.success(f"[Chat {chat.chat_id[:8]}] Response generated")

        return {
            "response": response_text,
            "tool_calls": tool_calls,
            "error": None,
        }

    except Exception as e:
        logger.error(f"[Chat {chat.chat_id[:8]}] Error: {e}")
        return {
            "response": f"Sorry, I encountered an error: {str(e)}",
            "tool_calls": [],
            "error": str(e),
        }

    finally:
        # Cleanup MCP resources if initialized
        if factory and use_mcp:
            try:
                await factory.cleanup_mcp()
            except Exception as cleanup_error:
                logger.warning(f"[Chat {chat.chat_id[:8]}] MCP cleanup error: {cleanup_error}")


# =============================================================================
# SSE Streaming Generator
# =============================================================================


async def chat_stream_generator(chat: ChatState, user_message: str, platform_config: PlatformConfig):
    """Generator for SSE streaming during chat response."""
    # Use tracer context for the entire stream lifecycle
    with tracer.start_as_current_span("chat_stream") as span:
        span.set_attribute("chat.id", chat.chat_id[:8])
        span.set_attribute("chat.model", chat.config.get("model", "unknown"))
        span.set_attribute("chat.use_mcp", chat.use_mcp)

        try:
            chat.is_processing = True
            chat.error = None

            # Add user message immediately
            user_msg = add_user_message(chat, user_message)
            span.set_attribute("chat.user_message_length", len(user_message))
            yield sse_message(
                render_chat_message(user_msg),
                event="user_message",
            )

            # Show typing indicator
            yield sse_message(
                render_typing_indicator(),
                event="typing",
            )

            # Execute the chat in background (use MCP tools if configured)
            result = await execute_chat_message(chat, user_message, platform_config, use_mcp=chat.use_mcp)

            # Remove typing indicator (send empty div to replace)
            yield sse_message(
                "",
                event="typing_done",
            )

            # Add tool call messages - show all tool interactions
            tool_calls = result.get("tool_calls", [])
            span.set_attribute("chat.tool_calls_count", len(tool_calls))
            for tc in tool_calls:
                tool_msg = add_tool_message(
                    chat,
                    tool_name=tc.get("name", "unknown"),
                    tool_args=tc.get("args", {}),
                    tool_result=tc.get("result"),
                )
                yield sse_message(
                    render_chat_message(tool_msg),
                    event="tool_message",
                )
                await asyncio.sleep(0.05)  # Small delay between messages

            # Add assistant response
            if result.get("response"):
                assistant_msg = add_assistant_message(chat, result["response"])
                span.set_attribute("chat.response_length", len(result["response"]))
                yield sse_message(
                    render_chat_message(assistant_msg),
                    event="assistant_message",
                )

            # Handle errors
            if result.get("error"):
                chat.error = result["error"]
                span.set_attribute("chat.error", result["error"])

            # Signal completion
            span.set_attribute("chat.status", "success" if not chat.error else "error")
            yield sse_message("", event="done")

        except Exception as e:
            logger.error(f"[Chat {chat.chat_id[:8]}] Stream error: {e}")
            chat.error = str(e)
            span.set_attribute("chat.error", str(e))
            span.set_attribute("chat.status", "exception")
            error_msg = add_assistant_message(chat, f"Sorry, an error occurred: {str(e)}")
            yield sse_message(
                render_chat_message(error_msg),
                event="error",
            )
            yield sse_message("", event="done")

        finally:
            chat.is_processing = False


# =============================================================================
# Cleanup
# =============================================================================


def cleanup_old_chats(max_age_hours: int = 24):
    """Remove chat sessions older than max_age_hours."""
    now = datetime.now()
    to_remove = []

    for chat_id, chat in _chat_sessions.items():
        age = (now - chat.last_activity).total_seconds() / 3600
        if age > max_age_hours:
            to_remove.append(chat_id)

    for chat_id in to_remove:
        del _chat_sessions[chat_id]
        logger.debug(f"Cleaned up old chat session: {chat_id}")

    if to_remove:
        logger.info(f"Cleaned up {len(to_remove)} old chat sessions")
