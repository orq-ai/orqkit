"""Unit tests for wrap_langchain_agent / wrap_langgraph_agent."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from evaluatorq.types import DataPoint


# ---------------------------------------------------------------------------
# Helpers — mock agent & convert
# ---------------------------------------------------------------------------

def _make_agent() -> MagicMock:
    """Create a mock CompiledStateGraph with invoke() returning empty messages."""
    agent = MagicMock()
    agent.invoke = MagicMock(return_value={"messages": []})
    agent.nodes = {}
    return agent


def _get_invoke_messages(agent: MagicMock) -> list[dict[str, str]]:
    """Extract the messages list from the first agent.invoke() call."""
    call_args = agent.invoke.call_args
    return call_args[0][0]["messages"]


# ---------------------------------------------------------------------------
# Import with mocked dependencies
# ---------------------------------------------------------------------------

# Mock heavy langchain/langgraph deps before importing the module under test
pytest.importorskip("langchain_core")
pytest.importorskip("langgraph")

from evaluatorq.integrations.langchain_integration.wrap_agent import (  # noqa: E402
    _extract_messages_from_data,
    wrap_langchain_agent,
    wrap_langgraph_agent,
)


# ---------------------------------------------------------------------------
# _extract_messages_from_data tests
# ---------------------------------------------------------------------------

class TestExtractMessagesFromData:
    def test_returns_messages_when_present(self) -> None:
        data = DataPoint(inputs={"messages": [{"role": "user", "content": "hi"}]})
        assert _extract_messages_from_data(data) == [{"role": "user", "content": "hi"}]

    def test_returns_none_when_missing(self) -> None:
        data = DataPoint(inputs={})
        assert _extract_messages_from_data(data) is None

    def test_returns_none_when_empty(self) -> None:
        data = DataPoint(inputs={"messages": []})
        assert _extract_messages_from_data(data) is None

    def test_returns_none_when_not_a_list(self) -> None:
        data = DataPoint(inputs={"messages": "not-a-list"})
        assert _extract_messages_from_data(data) is None


# ---------------------------------------------------------------------------
# wrap_langchain_agent tests
# ---------------------------------------------------------------------------

class TestWrapLangChainAgent:
    @pytest.mark.asyncio
    async def test_1_prompt_only(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t")
        data = DataPoint(inputs={"prompt": "hi"})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert msgs == [{"role": "user", "content": "hi"}]

    @pytest.mark.asyncio
    async def test_2_messages_only(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t")
        data = DataPoint(inputs={"messages": [{"role": "user", "content": "hi"}]})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert msgs == [{"role": "user", "content": "hi"}]

    @pytest.mark.asyncio
    async def test_3_messages_and_prompt(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t")
        data = DataPoint(inputs={
            "prompt": "hi",
            "messages": [{"role": "system", "content": "ctx"}],
        })

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert len(msgs) == 2
        assert msgs[0] == {"role": "system", "content": "ctx"}
        assert msgs[1] == {"role": "user", "content": "hi"}

    @pytest.mark.asyncio
    async def test_4_prompt_with_instructions_string(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t", instructions="be nice")
        data = DataPoint(inputs={"prompt": "hi"})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert len(msgs) == 2
        assert msgs[0] == {"role": "system", "content": "be nice"}
        assert msgs[1] == {"role": "user", "content": "hi"}

    @pytest.mark.asyncio
    async def test_5_messages_with_instructions(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t", instructions="be nice")
        data = DataPoint(inputs={"messages": [{"role": "user", "content": "hi"}]})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert len(msgs) == 2
        assert msgs[0] == {"role": "system", "content": "be nice"}
        assert msgs[1] == {"role": "user", "content": "hi"}

    @pytest.mark.asyncio
    async def test_6_messages_prompt_and_instructions(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t", instructions="be nice")
        data = DataPoint(inputs={
            "prompt": "hi",
            "messages": [{"role": "user", "content": "q"}],
        })

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert len(msgs) == 3
        assert msgs[0] == {"role": "system", "content": "be nice"}
        assert msgs[1] == {"role": "user", "content": "q"}
        assert msgs[2] == {"role": "user", "content": "hi"}

    @pytest.mark.asyncio
    async def test_7_instructions_as_callable(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(
            agent,
            name="t",
            instructions=lambda data: str(data.inputs.get("city", "")),
        )
        data = DataPoint(inputs={"prompt": "hi", "city": "SF"})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert msgs[0] == {"role": "system", "content": "SF"}

    @pytest.mark.asyncio
    async def test_8_no_prompt_no_messages_raises(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t")
        data = DataPoint(inputs={})

        with pytest.raises(ValueError, match="neither was provided"):
            await job(data, 0)

    @pytest.mark.asyncio
    async def test_9_empty_messages_falls_through_to_prompt(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t")
        data = DataPoint(inputs={"prompt": "hi", "messages": []})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert msgs == [{"role": "user", "content": "hi"}]

    @pytest.mark.asyncio
    async def test_10_messages_not_a_list_falls_through(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t")
        data = DataPoint(inputs={"prompt": "hi", "messages": "not-a-list"})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert msgs == [{"role": "user", "content": "hi"}]

    @pytest.mark.asyncio
    async def test_11_custom_prompt_key(self) -> None:
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t", prompt_key="question")
        data = DataPoint(inputs={"question": "hi"})

        await job(data, 0)

        msgs = _get_invoke_messages(agent)
        assert msgs == [{"role": "user", "content": "hi"}]

    @pytest.mark.asyncio
    async def test_8_no_prompt_no_messages_with_instructions_raises(self) -> None:
        """Instructions present but no prompt/messages still raises."""
        agent = _make_agent()
        job = wrap_langchain_agent(agent, name="t", instructions="be nice")
        data = DataPoint(inputs={})

        with pytest.raises(ValueError, match="neither was provided"):
            await job(data, 0)


class TestWrapLangGraphAgentAlias:
    def test_alias_is_same_function(self) -> None:
        assert wrap_langgraph_agent is wrap_langchain_agent
