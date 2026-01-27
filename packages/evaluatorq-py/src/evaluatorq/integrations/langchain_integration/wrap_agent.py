"""Wrapper function for LangChain agents to integrate with evaluatorq."""

from __future__ import annotations

from typing import Any, Protocol

from evaluatorq.types import DataPoint

from .convert import convert_to_open_responses
from .types import AgentJobOptions


class LangChainInvocable(Protocol):
    """Protocol for LangChain/LangGraph objects with an invoke method.

    Compatible with:
    - LangChain agents (from create_agent)
    - LangGraph compiled graphs (CompiledStateGraph from StateGraph.compile())
    - Any runnable with an invoke() method returning {"messages": [...]}
    """

    def invoke(
        self, input: dict[str, Any], config: dict[str, Any] | None = None
    ) -> dict[str, Any]: ...


def wrap_langchain_agent(
    agent: LangChainInvocable,
    *,
    name: str = "agent",
    prompt_key: str = "prompt",
    tools: list[dict[str, Any]] | None = None,
) -> Any:
    """
    Creates an evaluatorq Job from a LangChain agent.

    The job will:
    - Execute the agent with the prompt from data.inputs[prompt_key]
    - Convert the result to OpenResponses format (industry standard)
    - Return the OpenResponses resource for backend integration

    Args:
        agent: A LangChain agent or runnable with an invoke() method.
        name: The name of the job (defaults to "agent").
        prompt_key: The key in data.inputs to use as the prompt (defaults to "prompt").
        tools: Optional list of tool definitions for the OpenResponses output.

    Returns:
        An async function compatible with evaluatorq's Job type.

    Example:
        ```python
        from langchain_openai import ChatOpenAI
        from langchain.agents import create_agent
        from langchain_core.tools import tool
        from evaluatorq import evaluatorq
        from evaluatorq.integrations.langchain import wrap_langchain_agent

        @tool
        def weather(location: str) -> dict:
            \"\"\"Get the weather in a location.\"\"\"
            return {"location": location, "temperature": 72}

        model = ChatOpenAI(model="gpt-4o")
        agent = create_agent(model, tools=[weather])

        result = await evaluatorq("weather-agent-eval", {
            "data": [
                {"inputs": {"prompt": "What is the weather in SF?"}},
            ],
            "jobs": [wrap_langchain_agent(agent)],
            "evaluators": [
                {
                    "name": "response-quality",
                    "scorer": async def score(params):
                        result = params["output"]
                        # Access OpenResponses format
                        output_items = result.get("output", [])
                        has_message = any(
                            item.get("type") == "message"
                            for item in output_items
                        )
                        return {
                            "value": 1 if has_message else 0,
                            "explanation": "Agent produced a response",
                        }
                },
            ],
        })
        ```
    """

    async def job(data: DataPoint, _row: int) -> dict[str, Any]:
        prompt = data.inputs.get(prompt_key)

        if not isinstance(prompt, str):
            raise ValueError(
                f"Expected data.inputs.{prompt_key} to be a string, "
                f"got {type(prompt).__name__}"
            )

        # Invoke the LangChain agent
        result = agent.invoke(
            {"messages": [{"role": "user", "content": prompt}]}
        )

        # Extract messages from result
        messages = result.get("messages", [])

        # Convert to OpenResponses format
        open_responses_output = convert_to_open_responses(messages, tools)

        return {
            "name": name,
            "output": open_responses_output,
        }

    return job


def extract_tools_from_agent(agent: Any) -> list[dict[str, Any]]:
    """
    Extract tool definitions from a LangChain agent.

    This is a helper function to automatically extract tool schemas
    from a LangChain agent for use in the OpenResponses output.

    Args:
        agent: A LangChain agent with tools.

    Returns:
        A list of tool definitions in OpenResponses format.
    """
    tools: list[dict[str, Any]] = []

    # Try to access tools from common LangChain agent attributes
    agent_tools = getattr(agent, "tools", None)
    if not agent_tools:
        agent_tools = getattr(agent, "bound", {}).get("tools", [])

    if not agent_tools:
        return tools

    for tool in agent_tools:
        tool_schema: dict[str, Any] = {
            "name": getattr(tool, "name", "unknown"),
            "description": getattr(tool, "description", None),
        }

        # Try to get the input schema
        input_schema = getattr(tool, "args_schema", None)
        if input_schema:
            if hasattr(input_schema, "model_json_schema"):
                tool_schema["parameters"] = input_schema.model_json_schema()
            elif hasattr(input_schema, "schema"):
                tool_schema["parameters"] = input_schema.schema()

        tools.append(tool_schema)

    return tools


# Alias for LangGraph users
wrap_langgraph_agent = wrap_langchain_agent
