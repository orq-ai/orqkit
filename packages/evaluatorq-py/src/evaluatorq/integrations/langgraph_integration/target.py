"""Red teaming target wrapper for LangGraph agents."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from langgraph.graph.state import CompiledStateGraph


class LangGraphTarget:
    """Wraps a LangGraph CompiledStateGraph as a red teaming target.

    Usage::

        from langgraph.prebuilt import create_react_agent
        from evaluatorq.integrations.langgraph_integration import LangGraphTarget

        graph = create_react_agent(model, tools=[...])
        target = LangGraphTarget(graph)

        # Pass to red teaming
        config = DynamicRunConfig(targets=[target])
    """

    def __init__(
        self,
        graph: CompiledStateGraph[Any, Any, Any, Any],
        *,
        config: dict[str, Any] | None = None,
    ) -> None:
        """Create a LangGraph red teaming target.

        Args:
            graph: A compiled LangGraph state graph.
            config: Optional extra LangGraph RunnableConfig keys
                (e.g. ``{"recursion_limit": 50}``). The ``thread_id``
                is managed automatically — do not pass it here.
        """
        self._graph = graph
        self._extra_config = config or {}
        self._thread_id = uuid4().hex

    def _build_config(self) -> dict[str, Any]:
        """Build the RunnableConfig with the current thread_id."""
        return {
            **self._extra_config,
            "configurable": {
                **self._extra_config.get("configurable", {}),
                "thread_id": self._thread_id,
            },
        }

    async def send_prompt(self, prompt: str) -> str:
        """Send a prompt to the LangGraph agent and return its text response."""
        result = await self._graph.ainvoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config=self._build_config(),
        )
        messages = result.get("messages")
        if messages is None:
            raise ValueError(
                "LangGraphTarget requires a graph whose state has a 'messages' key "
                "(e.g. built with MessagesState). Got state keys: "
                + str(list(result.keys()))
            )
        last = messages[-1]
        # Support both dict and LangChain BaseMessage
        if isinstance(last, dict):
            return last.get("content", "")
        return getattr(last, "content", "")

    def reset_conversation(self) -> None:
        """Reset conversation state by starting a new thread."""
        self._thread_id = uuid4().hex

    def clone(self, memory_entity_id: str | None = None) -> LangGraphTarget:
        """Create an independent copy for parallel red teaming jobs."""
        return LangGraphTarget(self._graph, config=dict(self._extra_config))
