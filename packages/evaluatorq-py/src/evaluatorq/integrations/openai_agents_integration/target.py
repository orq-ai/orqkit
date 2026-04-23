"""Red teaming target wrapper for OpenAI Agents SDK."""

from __future__ import annotations

import json
from typing import Any

from agents import Agent, Runner

from evaluatorq.redteam.backends.base import AgentTarget
from evaluatorq.redteam.contracts import AgentResponse, ExecutedToolCall


class OpenAIAgentTarget(AgentTarget):
    """Wraps an OpenAI Agents SDK Agent as a red teaming target.

    Usage::

        from agents import Agent
        from evaluatorq.integrations.openai_agents_integration import OpenAIAgentTarget

        agent = Agent(name="my-agent", instructions="You are a helpful assistant.")
        target = OpenAIAgentTarget(agent)

        # Pass to red teaming
        config = DynamicRunConfig(targets=[target])
    """

    def __init__(self, agent: Agent, *, run_kwargs: dict[str, Any] | None = None) -> None:
        """Create an OpenAI Agents SDK red teaming target.

        Args:
            agent: An OpenAI Agents SDK Agent instance.
            run_kwargs: Optional extra keyword arguments passed to ``Runner.run()``
                (e.g. ``{"max_turns": 10}``).
        """
        self._agent = agent
        self._run_kwargs = run_kwargs or {}
        self._history: list[Any] = []

    async def send_prompt(self, prompt: str) -> AgentResponse:
        """Send a prompt to the agent and return its response with tool calls."""
        input_data: str | list[Any] = prompt
        prev_len = len(self._history)
        if self._history:
            input_data = [*self._history, {"role": "user", "content": prompt}]

        try:
            result = await Runner.run(self._agent, input_data, **self._run_kwargs)
        except Exception as exc:
            raise RuntimeError(
                f"OpenAIAgentTarget: Runner.run() raised an error: {exc}"
            ) from exc

        if result.final_output is None:
            raise ValueError(
                "OpenAIAgentTarget: Runner.run() returned final_output=None. "
                "Ensure the agent produces a text response."
            )

        self._history = result.to_input_list()

        # Extract tool calls only from items added in this turn (not accumulated history)
        # prev_len items were present before this call; everything after is new
        tool_calls: list[ExecutedToolCall] = []
        for item in self._history[prev_len:]:
            if isinstance(item, dict) and item.get("role") == "assistant":
                for tc in (item.get("tool_calls") or []):
                    if isinstance(tc, dict):
                        func = tc.get("function", {})
                        name = func.get("name", "") if isinstance(func, dict) else ""
                        args_str = func.get("arguments", "{}") if isinstance(func, dict) else "{}"
                        try:
                            args = json.loads(args_str)
                        except (json.JSONDecodeError, ValueError):
                            args = {"raw": args_str}
                        tool_calls.append(ExecutedToolCall(name=name, arguments=args))

        return AgentResponse(text=str(result.final_output), tool_calls=tool_calls)

    def reset_conversation(self) -> None:
        """Reset conversation state by clearing the message history."""
        self._history = []

    def clone(self) -> OpenAIAgentTarget:
        """Create an independent copy for parallel red teaming jobs."""
        return OpenAIAgentTarget(self._agent, run_kwargs=dict(self._run_kwargs))
