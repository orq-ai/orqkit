"""Unit tests for red teaming target integrations (CallableTarget — no optional deps)."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock

import pytest

from evaluatorq.contracts import Message
from evaluatorq.integrations.callable_integration import CallableTarget
from evaluatorq.redteam.contracts import AgentResponse, OutputMessage, TextOutputItem, TokenUsage, ToolCallOutputItem


def _last_user(messages: list[dict[str, Any]]) -> str:
    """Read the last user turn's content off a chat-format message list."""
    return messages[-1]["content"]


class TestCallableTarget:
    @pytest.mark.asyncio
    async def test_sync_function(self) -> None:
        target = CallableTarget(lambda messages: f"echo: {_last_user(messages)}")
        result = await target.respond([Message(role="user", content="hello")])
        assert result.text == "echo: hello"
        assert result.tool_calls == []

    @pytest.mark.asyncio
    async def test_async_function(self) -> None:
        async def my_agent(messages: list[dict[str, Any]]) -> str:
            return f"async: {_last_user(messages)}"

        target = CallableTarget(my_agent)
        result = await target.respond([Message(role="user", content="hello")])
        assert result.text == "async: hello"
        assert result.tool_calls == []

    @pytest.mark.asyncio
    async def test_agent_response_return_is_passed_through(self) -> None:
        out: list[OutputMessage] = []
        out.append(ToolCallOutputItem(name="search", arguments=json.dumps({"query": "hello"})))
        out.append(TextOutputItem(text="done", annotations=[]))
        response = AgentResponse(output=out)

        target = CallableTarget(lambda messages: response)
        result = await target.respond([Message(role="user", content="hello")])

        assert result is response
        assert result.tool_calls[0].name == "search"

    @pytest.mark.asyncio
    async def test_timeout_is_not_wrapped(self) -> None:
        async def my_agent(messages: list[dict[str, Any]]) -> str:
            raise asyncio.TimeoutError

        target = CallableTarget(my_agent)
        with pytest.raises(asyncio.TimeoutError):
            await target.respond([Message(role="user", content="hello")])

    @pytest.mark.asyncio
    async def test_reset_calls_reset_fn(self) -> None:
        reset = MagicMock()
        target = CallableTarget(lambda messages: _last_user(messages), reset_fn=reset)
        target.new()
        reset.assert_called_once()

    @pytest.mark.asyncio
    async def test_reset_without_reset_fn_is_noop(self) -> None:
        target = CallableTarget(lambda messages: _last_user(messages))
        target.new()  # should not raise

    def test_clone_returns_independent_instance(self) -> None:
        def fn(messages: list[dict[str, Any]]) -> str:
            return _last_user(messages)

        reset = MagicMock()
        target = CallableTarget(fn, reset_fn=reset)
        cloned = target.new()
        assert cloned is not target
        assert cloned._fn is fn
        assert cloned._reset_fn is reset

    def test_clone_preserves_usage_fn(self) -> None:
        def fn(messages: list[dict[str, Any]]) -> str:
            return _last_user(messages)

        def usage_fn(prompt: str, response: str) -> TokenUsage:
            return TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2, calls=1)

        target = CallableTarget(fn, usage_fn=usage_fn)
        cloned = target.new()
        assert cloned._usage_fn is usage_fn

    @pytest.mark.asyncio
    async def test_get_agent_context_default_is_minimal(self) -> None:
        def my_fn(messages: list[dict[str, Any]]) -> str:
            return _last_user(messages)

        target = CallableTarget(my_fn)
        ctx = await target.get_agent_context()
        assert ctx.key == "my_fn"
        assert ctx.tools == []
        assert ctx.memory_stores == []
        assert ctx.description == "opaque callable target"

    @pytest.mark.asyncio
    async def test_get_agent_context_returns_override(self) -> None:
        from evaluatorq.redteam.contracts import AgentContext, ToolInfo

        override = AgentContext(
            key="wrapped-agent",
            tools=[ToolInfo(name="send_email")],
            description="wraps a real agent",
        )
        target = CallableTarget(lambda messages: _last_user(messages), agent_context=override)
        ctx = await target.get_agent_context()
        assert ctx is override

    def test_clone_preserves_agent_context(self) -> None:
        from evaluatorq.redteam.contracts import AgentContext

        override = AgentContext(key="k")
        target = CallableTarget(lambda messages: _last_user(messages), agent_context=override)
        cloned = target.new()
        assert cloned._agent_context is override


class TestCallableTargetConversation:
    @pytest.mark.asyncio
    async def test_single_message_is_a_list_of_one(self) -> None:
        """Opening turn: the callable receives a one-element chat-format list."""
        seen: list[list[dict[str, Any]]] = []

        def fn(messages: list[dict[str, Any]]) -> str:
            seen.append(messages)
            return "ok"

        target = CallableTarget(fn)
        await target.respond([Message(role="user", content="hello")])
        assert seen == [[{"role": "user", "content": "hello"}]]

    @pytest.mark.asyncio
    async def test_full_transcript_is_forwarded_as_dicts(self) -> None:
        """Later turns: the callable receives the whole conversation in chat format."""
        seen: list[list[dict[str, Any]]] = []

        def fn(messages: list[dict[str, Any]]) -> str:
            seen.append(messages)
            return "ok"

        target = CallableTarget(fn)
        await target.respond([
            Message(role="user", content="first"),
            Message(role="assistant", content="reply"),
            Message(role="user", content="second"),
        ])
        assert seen == [[
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"},
        ]]

    @pytest.mark.asyncio
    async def test_async_callable_sees_full_count(self) -> None:
        async def fn(messages: list[dict[str, Any]]) -> str:
            return f"saw {len(messages)} messages"

        target = CallableTarget(fn)
        result = await target.respond([
            Message(role="user", content="a"),
            Message(role="assistant", content="b"),
            Message(role="user", content="c"),
        ])
        assert result.text == "saw 3 messages"

    @pytest.mark.asyncio
    async def test_tool_turns_preserved_in_chat_format(self) -> None:
        """Assistant tool_calls and tool results survive the conversion."""
        from evaluatorq.contracts import FunctionCall, StrategyToolCall

        seen: list[list[dict[str, Any]]] = []

        def fn(messages: list[dict[str, Any]]) -> str:
            seen.append(messages)
            return "ok"

        target = CallableTarget(fn)
        await target.respond([
            Message(role="user", content="search please"),
            Message(
                role="assistant",
                content=None,
                tool_calls=[
                    StrategyToolCall(
                        id="call_1",
                        function=FunctionCall(name="search", arguments='{"q": "x"}'),
                    )
                ],
            ),
            Message(role="tool", tool_call_id="call_1", name="search", content="result"),
            Message(role="user", content="thanks"),
        ])
        convo = seen[0]
        assert convo[1]["tool_calls"][0]["function"]["name"] == "search"
        assert convo[2] == {"role": "tool", "tool_call_id": "call_1", "content": "result", "name": "search"}


class TestCallableTargetUsage:
    @pytest.mark.asyncio
    async def test_usage_fn_called_with_prompt_and_response(self) -> None:
        """usage_fn receives the last user turn and the response text."""
        captured: list[tuple[str, str]] = []

        def usage_fn(prompt: str, response: str) -> TokenUsage:
            captured.append((prompt, response))
            return TokenUsage(prompt_tokens=3, completion_tokens=2, total_tokens=5, calls=1)

        target = CallableTarget(lambda messages: f"echo:{_last_user(messages)}", usage_fn=usage_fn)
        result = await target.respond([Message(role="user", content="hello")])

        assert result.text == "echo:hello"
        assert isinstance(result.usage, TokenUsage)
        assert result.usage.prompt_tokens == 3
        assert result.usage.completion_tokens == 2
        assert result.usage.total_tokens == 5
        assert result.usage.calls == 1
        assert captured == [("hello", "echo:hello")]

    @pytest.mark.asyncio
    async def test_usage_fn_receives_last_user_turn_in_multi_turn(self) -> None:
        """``prompt`` passed to usage_fn is the last user turn, not the whole transcript."""
        captured: dict[str, str] = {}

        def usage_fn(prompt: str, response: str) -> TokenUsage:
            captured["prompt"] = prompt
            return TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2, calls=1)

        target = CallableTarget(lambda messages: "response", usage_fn=usage_fn)
        await target.respond([
            Message(role="user", content="first"),
            Message(role="assistant", content="reply"),
            Message(role="user", content="last"),
        ])
        assert captured["prompt"] == "last"

    @pytest.mark.asyncio
    async def test_usage_none_when_no_usage_fn(self) -> None:
        """Without usage_fn, AgentResponse.usage is None."""
        target = CallableTarget(lambda messages: "response")
        result = await target.respond([Message(role="user", content="hi")])
        assert result.text == "response"
        assert result.usage is None

    @pytest.mark.asyncio
    async def test_usage_fn_exception_yields_none_and_logs_warning(self, caplog: pytest.LogCaptureFixture) -> None:
        """When usage_fn raises, usage is None and a warning is logged."""
        import logging

        def bad_usage_fn(prompt: str, response: str) -> TokenUsage:
            raise ValueError("boom")

        target = CallableTarget(lambda messages: "reply", usage_fn=bad_usage_fn)
        with caplog.at_level(logging.WARNING):
            result = await target.respond([Message(role="user", content="hi")])

        assert result.text == "reply"
        assert result.usage is None
        assert any("usage_fn raised" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_usage_fn_returning_none_propagates(self) -> None:
        """If usage_fn returns None explicitly, AgentResponse.usage is None."""
        target = CallableTarget(lambda messages: "ok", usage_fn=lambda p, r: None)
        result = await target.respond([Message(role="user", content="hi")])
        assert result.usage is None

    @pytest.mark.asyncio
    async def test_async_callable_with_usage_fn(self) -> None:
        """usage_fn works with async callables too."""
        async def my_agent(messages: list[dict[str, Any]]) -> str:
            return f"async:{_last_user(messages)}"

        def usage_fn(prompt: str, response: str) -> TokenUsage:
            return TokenUsage(prompt_tokens=5, completion_tokens=10, total_tokens=15, calls=1)

        target = CallableTarget(my_agent, usage_fn=usage_fn)
        result = await target.respond([Message(role="user", content="test")])

        assert result.text == "async:test"
        assert isinstance(result.usage, TokenUsage)
        assert result.usage.prompt_tokens == 5
