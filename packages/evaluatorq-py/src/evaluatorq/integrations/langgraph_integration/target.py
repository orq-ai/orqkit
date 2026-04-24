"""Red teaming target wrapper for LangGraph agents."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import uuid4

from langchain_core.runnables import RunnableConfig

from evaluatorq.redteam.backends.base import AgentTarget
from evaluatorq.redteam.contracts import AgentContext, MemoryStoreInfo, TokenUsage, ToolInfo

if TYPE_CHECKING:
    from langgraph.graph.state import CompiledStateGraph


def _aggregate_langchain_usage(messages: list[Any]) -> TokenUsage | None:
    """Sum ``usage_metadata`` across LangChain messages.

    Each AI message emitted by a chat model carries a ``usage_metadata`` dict
    (``input_tokens`` / ``output_tokens`` / ``total_tokens``). Messages without
    usage (humans, tool results, models that did not report usage) are skipped.
    Returns ``None`` when no message reports usage — callers use this to
    preserve the "usage unavailable" signal.
    """
    prompt_total = completion_total = token_total = calls = 0
    found = False
    for msg in messages:
        meta = msg.get("usage_metadata") if isinstance(msg, dict) else getattr(msg, "usage_metadata", None)
        if not meta:
            continue
        prompt = int(meta.get("input_tokens", 0) or 0)
        completion = int(meta.get("output_tokens", 0) or 0)
        total = int(meta.get("total_tokens", prompt + completion) or 0)
        prompt_total += prompt
        completion_total += completion
        token_total += total
        calls += 1
        found = True
    if not found:
        return None
    return TokenUsage(
        prompt_tokens=prompt_total,
        completion_tokens=completion_total,
        total_tokens=token_total,
        calls=calls,
    )


class LangGraphTarget(AgentTarget):
    """Wraps a LangGraph CompiledStateGraph as a red teaming target.

    Each instance generates its own ``memory_entity_id`` used as the LangGraph
    ``thread_id`` — this is the checkpointer's isolation key, so parallel
    attacks never share thread state. The pipeline reads ``memory_entity_id``
    off the target rather than injecting it.

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
        agent_context: AgentContext | None = None,
    ) -> None:
        """Create a LangGraph red teaming target.

        Args:
            graph: A compiled LangGraph state graph.
            config: Optional extra LangGraph RunnableConfig keys
                (e.g. ``{"recursion_limit": 50}``). The ``thread_id``
                is managed automatically — do not pass it here.
            agent_context: Optional :class:`AgentContext` override. When
                provided, this context is returned from
                :meth:`get_agent_context` verbatim. When omitted, the target
                introspects the compiled graph (tools from a ``ToolNode``,
                checkpointer presence) on a best-effort basis.
        """
        self._graph = graph
        self._extra_config = config or {}
        self.memory_entity_id: str = uuid4().hex
        self._agent_context = agent_context
        graph_name: str = getattr(graph, "name", None) or "langgraph_target"
        self._key = f"{graph_name}_{uuid4().hex[:8]}"
        # Token usage is captured off the last ainvoke result. Checkpointer-backed
        # graphs return the full cumulative message history per call, so we track
        # how many messages we have already accounted for and only aggregate usage
        # from messages added by the most recent turn.
        self._last_token_usage: TokenUsage | None = None
        self._seen_message_count: int = 0

    def _build_config(self) -> RunnableConfig:
        """Build the RunnableConfig with the current thread_id."""
        extra = {k: v for k, v in self._extra_config.items() if k != "configurable"}
        return RunnableConfig(
            **extra,
            configurable={
                **self._extra_config.get("configurable", {}),
                "thread_id": self.memory_entity_id,
            },
        )

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
        if not messages:
            raise ValueError(
                "LangGraphTarget: graph returned an empty 'messages' list. "
                "Ensure every execution path appends at least one AI message."
            )
        new_messages = messages[self._seen_message_count:]
        self._last_token_usage = _aggregate_langchain_usage(new_messages)
        self._seen_message_count = len(messages)
        last = messages[-1]
        # Support both dict and LangChain BaseMessage
        content = last.get("content", "") if isinstance(last, dict) else getattr(last, "content", "")
        if not isinstance(content, str):
            content = str(content)
        return content

    def consume_last_token_usage(self) -> TokenUsage | None:
        """Return and clear usage captured during the last ``send_prompt`` call."""
        usage = self._last_token_usage
        self._last_token_usage = None
        return usage

    async def get_agent_context(self) -> AgentContext:
        """Return agent context introspected from the compiled graph.

        If an ``agent_context`` was passed at construction time, returns it
        unchanged. Otherwise performs best-effort introspection:

        * tools: extracted from any node whose ``bound`` is a ``ToolNode`` via
          ``tools_by_name``
        * memory_stores: single synthetic entry pointing at the checkpointer
          thread when a checkpointer is attached

        Callers needing stronger guarantees (custom graph shapes, non-standard
        tool nodes) should pass ``agent_context`` explicitly.
        """
        if self._agent_context is not None:
            return self._agent_context

        tools = _introspect_tools(self._graph)
        memory_stores = _introspect_memory_stores(self._graph, self.memory_entity_id)

        return AgentContext(
            key=self._key,
            description="LangGraph compiled state graph target",
            tools=tools,
            memory_stores=memory_stores,
        )

    def new(self) -> LangGraphTarget:
        """Return an independent instance for parallel red teaming jobs.

        Each call gets a fresh ``memory_entity_id`` (and thus a fresh LangGraph
        thread), so parallel workers never share checkpointer state.
        """
        cloned = LangGraphTarget(
            self._graph,
            config=dict(self._extra_config),
            agent_context=self._agent_context,
        )
        cloned._key = self._key
        return cloned


def _introspect_tools(graph: CompiledStateGraph[Any, Any, Any, Any]) -> list[ToolInfo]:
    """Best-effort extraction of tool metadata from a compiled graph.

    Looks for nodes whose ``bound`` attribute exposes ``tools_by_name``
    (LangGraph's ``ToolNode``). Falls back to an empty list on anything else.
    """
    tools: list[ToolInfo] = []
    seen: set[str] = set()
    nodes = getattr(graph, "nodes", None)
    if not nodes:
        return tools
    for node in nodes.values():
        bound = getattr(node, "bound", None)
        tools_by_name = getattr(bound, "tools_by_name", None)
        if not isinstance(tools_by_name, dict):
            continue
        for name, tool in tools_by_name.items():
            name_str = str(name)
            if name_str in seen:
                continue
            seen.add(name_str)
            tools.append(
                ToolInfo(
                    name=name_str,
                    description=getattr(tool, "description", None),
                    parameters=None,
                )
            )
    return tools


def _introspect_memory_stores(
    graph: CompiledStateGraph[Any, Any, Any, Any], thread_id: str
) -> list[MemoryStoreInfo]:
    """Return a single synthetic memory store entry when a checkpointer is attached."""
    checkpointer = getattr(graph, "checkpointer", None)
    if checkpointer is None:
        return []
    return [
        MemoryStoreInfo(
            id=thread_id,
            key="langgraph_checkpointer",
            description=f"LangGraph checkpointer ({type(checkpointer).__name__})",
        )
    ]
