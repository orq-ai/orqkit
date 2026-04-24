"""Unit tests for LangGraph red teaming target."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

pytest.importorskip("langgraph")

from evaluatorq.integrations.langgraph_integration import LangGraphTarget  # noqa: E402


def _make_graph(response_content: str = "I'm fine") -> MagicMock:
    graph = MagicMock()
    graph.name = "test_graph"
    msg = MagicMock()
    msg.content = response_content
    graph.ainvoke = AsyncMock(return_value={"messages": [msg]})
    return graph


class TestLangGraphTarget:
    @pytest.mark.asyncio
    async def test_send_prompt_returns_response(self) -> None:
        graph = _make_graph("hello back")
        target = LangGraphTarget(graph)
        result = await target.send_prompt("hello")
        assert result == "hello back"

    @pytest.mark.asyncio
    async def test_send_prompt_passes_user_message(self) -> None:
        graph = _make_graph()
        target = LangGraphTarget(graph)
        await target.send_prompt("test prompt")

        call_args = graph.ainvoke.call_args
        messages = call_args[0][0]["messages"]
        assert messages == [{"role": "user", "content": "test prompt"}]

    @pytest.mark.asyncio
    async def test_send_prompt_passes_memory_entity_id(self) -> None:
        graph = _make_graph()
        target = LangGraphTarget(graph)
        await target.send_prompt("hi")

        config = graph.ainvoke.call_args[1]["config"]
        assert "thread_id" in config["configurable"]

    @pytest.mark.asyncio
    async def test_reset_preserves_memory_entity_id(self) -> None:
        graph = _make_graph()
        target = LangGraphTarget(graph)
        old_thread = target.memory_entity_id
        target.new()
        assert target.memory_entity_id == old_thread

    @pytest.mark.asyncio
    async def test_extra_config_is_preserved(self) -> None:
        graph = _make_graph()
        target = LangGraphTarget(graph, config={"recursion_limit": 50})
        await target.send_prompt("hi")

        config = graph.ainvoke.call_args[1]["config"]
        assert config["recursion_limit"] == 50

    @pytest.mark.asyncio
    async def test_raises_on_missing_messages_key(self) -> None:
        graph = MagicMock()
        graph.ainvoke = AsyncMock(return_value={"output": "no messages here"})
        target = LangGraphTarget(graph)

        with pytest.raises(ValueError, match="'messages' key"):
            await target.send_prompt("hi")

    @pytest.mark.asyncio
    async def test_raises_on_empty_messages_list(self) -> None:
        graph = MagicMock()
        graph.ainvoke = AsyncMock(return_value={"messages": []})
        target = LangGraphTarget(graph)

        with pytest.raises(ValueError, match="empty 'messages' list"):
            await target.send_prompt("hi")

    @pytest.mark.asyncio
    async def test_handles_dict_messages(self) -> None:
        graph = MagicMock()
        graph.ainvoke = AsyncMock(
            return_value={"messages": [{"role": "assistant", "content": "dict msg"}]}
        )
        target = LangGraphTarget(graph)
        result = await target.send_prompt("hi")
        assert result == "dict msg"

    def test_clone_returns_independent_instance(self) -> None:
        graph = _make_graph()
        target = LangGraphTarget(graph, config={"recursion_limit": 50})
        cloned = target.new()
        assert cloned is not target
        assert cloned.memory_entity_id != target.memory_entity_id
        assert cloned._graph is graph
        assert cloned._extra_config is not target._extra_config
        assert cloned._extra_config == {"recursion_limit": 50}

    def test_clone_gets_fresh_memory_entity_id(self) -> None:
        graph = _make_graph()
        target = LangGraphTarget(graph)
        cloned = target.new()
        assert cloned.memory_entity_id != target.memory_entity_id
        assert cloned.memory_entity_id  # non-empty

    @pytest.mark.asyncio
    async def test_configurable_key_collision_preserves_user_keys(self) -> None:
        """config={"configurable": {"custom_key": "val"}} must not be overwritten by memory_entity_id injection."""
        graph = _make_graph()
        target = LangGraphTarget(graph, config={"configurable": {"custom_key": "val"}})
        await target.send_prompt("hi")

        config = graph.ainvoke.call_args[1]["config"]
        assert config["configurable"]["custom_key"] == "val"
        assert "thread_id" in config["configurable"]

    @pytest.mark.asyncio
    async def test_non_string_content_is_coerced_to_str(self) -> None:
        """List-type content (e.g. multimodal messages) must be coerced to str."""
        graph = MagicMock()
        msg = MagicMock()
        msg.content = [{"type": "text", "text": "multimodal content"}]
        graph.ainvoke = AsyncMock(return_value={"messages": [msg]})
        target = LangGraphTarget(graph)
        result = await target.send_prompt("hi")
        assert isinstance(result, str)
        assert "multimodal content" in result


class TestLangGraphTargetAgentContext:
    @pytest.mark.asyncio
    async def test_get_agent_context_from_react_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Tools bound via create_react_agent show up in the agent context."""
        from langchain_core.tools import tool
        from langchain_openai import ChatOpenAI
        from langgraph.prebuilt import create_react_agent

        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-stub")

        @tool
        def add(a: int, b: int) -> int:
            """Add two integers."""
            return a + b

        graph = create_react_agent(ChatOpenAI(model="gpt-4o-mini"), tools=[add])
        target = LangGraphTarget(graph)

        ctx = await target.get_agent_context()
        assert ctx.key.startswith("LangGraph_")
        tool_names = ctx.get_tool_names()
        assert "add" in tool_names
        # create_react_agent does not set a checkpointer by default → no memory entries
        assert ctx.memory_stores == []

    @pytest.mark.asyncio
    async def test_get_agent_context_handles_graph_without_tools_node(self) -> None:
        graph = _make_graph()
        graph.nodes = {}
        graph.checkpointer = None
        target = LangGraphTarget(graph)
        ctx = await target.get_agent_context()
        assert ctx.key.startswith("test_graph_")
        assert ctx.tools == []
        assert ctx.memory_stores == []

    @pytest.mark.asyncio
    async def test_get_agent_context_emits_memory_store_when_checkpointer_present(self) -> None:
        from evaluatorq.redteam.contracts import MemoryStoreInfo

        graph = _make_graph()
        graph.nodes = {}
        checkpointer = MagicMock()
        checkpointer.__class__.__name__ = "InMemorySaver"
        graph.checkpointer = checkpointer
        target = LangGraphTarget(graph)

        ctx = await target.get_agent_context()
        assert len(ctx.memory_stores) == 1
        assert isinstance(ctx.memory_stores[0], MemoryStoreInfo)
        assert ctx.memory_stores[0].id == target.memory_entity_id

    @pytest.mark.asyncio
    async def test_get_agent_context_dedupes_tools_across_nodes(self) -> None:
        """Same tool registered in multiple ToolNodes must yield a single entry."""
        shared_tool = MagicMock()
        shared_tool.description = "shared"
        bound_a = MagicMock()
        bound_a.tools_by_name = {"shared": shared_tool}
        bound_b = MagicMock()
        bound_b.tools_by_name = {"shared": shared_tool, "extra": MagicMock(description=None)}
        node_a = MagicMock(bound=bound_a)
        node_b = MagicMock(bound=bound_b)

        graph = _make_graph()
        graph.nodes = {"tools_a": node_a, "tools_b": node_b}
        graph.checkpointer = None
        target = LangGraphTarget(graph)

        ctx = await target.get_agent_context()
        names = [t.name for t in ctx.tools]
        assert names.count("shared") == 1
        assert sorted(names) == ["extra", "shared"]

    @pytest.mark.asyncio
    async def test_get_agent_context_override_returns_verbatim(self) -> None:
        from evaluatorq.redteam.contracts import AgentContext, ToolInfo

        override = AgentContext(
            key="my-custom-agent",
            tools=[ToolInfo(name="custom_tool")],
            description="explicitly-provided context",
        )
        graph = _make_graph()
        target = LangGraphTarget(graph, agent_context=override)

        ctx = await target.get_agent_context()
        assert ctx is override


class TestLangGraphTargetTokenUsage:
    """Token usage capture mirrors the ORQ/OpenAI backends so the red team
    pipeline's ``consume_last_token_usage`` hook picks up usage from LangGraph
    agents."""

    def _ai_msg(self, *, content: str, usage: dict[str, int] | None) -> MagicMock:
        msg = MagicMock()
        msg.content = content
        # ``usage_metadata`` is a dict on LangChain AIMessage; set to None when
        # the model did not report usage.
        msg.usage_metadata = usage
        return msg

    @pytest.mark.asyncio
    async def test_consume_returns_aggregated_usage_for_turn(self) -> None:
        # Two AI messages in the same turn (e.g. tool call + final answer):
        # both should be summed.
        tool_msg = self._ai_msg(
            content="",
            usage={"input_tokens": 100, "output_tokens": 10, "total_tokens": 110},
        )
        final_msg = self._ai_msg(
            content="done",
            usage={"input_tokens": 120, "output_tokens": 30, "total_tokens": 150},
        )
        graph = MagicMock()
        graph.name = "test_graph"
        graph.ainvoke = AsyncMock(return_value={"messages": [tool_msg, final_msg]})

        target = LangGraphTarget(graph)
        await target.send_prompt("hi")

        usage = target.consume_last_token_usage()
        assert usage is not None
        assert usage.prompt_tokens == 220
        assert usage.completion_tokens == 40
        assert usage.total_tokens == 260
        assert usage.calls == 2

        # Consume clears state — second call must return None.
        assert target.consume_last_token_usage() is None

    @pytest.mark.asyncio
    async def test_consume_returns_none_when_no_usage_reported(self) -> None:
        msg = self._ai_msg(content="hi", usage=None)
        graph = MagicMock()
        graph.name = "test_graph"
        graph.ainvoke = AsyncMock(return_value={"messages": [msg]})

        target = LangGraphTarget(graph)
        await target.send_prompt("hi")

        assert target.consume_last_token_usage() is None

    @pytest.mark.asyncio
    async def test_checkpointer_cumulative_history_counts_only_new_messages(self) -> None:
        # Simulate a checkpointed graph: each ainvoke returns the full cumulative
        # history. Only usage from the newly appended messages should be counted
        # per turn, otherwise we would double-count tokens on multi-turn attacks.
        turn1 = self._ai_msg(
            content="turn1",
            usage={"input_tokens": 50, "output_tokens": 5, "total_tokens": 55},
        )
        turn2 = self._ai_msg(
            content="turn2",
            usage={"input_tokens": 60, "output_tokens": 7, "total_tokens": 67},
        )

        graph = MagicMock()
        graph.name = "test_graph"
        graph.ainvoke = AsyncMock()
        graph.ainvoke.return_value = {"messages": [turn1]}

        target = LangGraphTarget(graph)
        await target.send_prompt("first")
        first_usage = target.consume_last_token_usage()
        assert first_usage is not None
        assert first_usage.prompt_tokens == 50
        assert first_usage.completion_tokens == 5

        # Second turn: checkpointer returns both historical and new message.
        graph.ainvoke.return_value = {"messages": [turn1, turn2]}
        await target.send_prompt("second")
        second_usage = target.consume_last_token_usage()
        assert second_usage is not None
        assert second_usage.prompt_tokens == 60
        assert second_usage.completion_tokens == 7
        assert second_usage.calls == 1
