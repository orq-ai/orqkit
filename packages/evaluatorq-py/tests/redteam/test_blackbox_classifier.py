"""Unit tests for the black-box capability classifier.

Both live boundaries are mocked: ``AgentTarget.respond`` returns scripted
probe replies, and the judge's ``chat.completions.parse`` returns a
deterministic ``BlackboxCapabilityInference``. No network, no real agent.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from openai import APIConnectionError

from evaluatorq.contracts import AgentResponse, AgentTarget, Message
from evaluatorq.redteam.adaptive.blackbox_classifier import (
    MAX_PROBE_TURNS,
    PROBES,
    BlackboxAgentCapabilities,
    BlackboxCapabilityInference,
    classify_agent_capabilities_blackbox,
)
from evaluatorq.redteam.adaptive.capability_classifier import AgentCapabilities
from evaluatorq.redteam.contracts import AgentCapability

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _ScriptedTarget(AgentTarget):
    """AgentTarget stub: replies with a canned string per turn, or raises."""

    def __init__(self, replies: list[str] | None = None, *, raise_always: bool = False) -> None:
        super().__init__()
        self._replies = replies or []
        self._raise_always = raise_always
        self.calls: list[list[Message]] = []

    async def respond(self, messages: list[Message]) -> AgentResponse:
        self.calls.append(list(messages))
        if self._raise_always:
            raise RuntimeError('target is down')
        idx = len(self.calls) - 1
        text = self._replies[idx] if idx < len(self._replies) else 'ok'
        return AgentResponse(text=text)

    def new(self) -> AgentTarget:
        return _ScriptedTarget(self._replies, raise_always=self._raise_always)


def _judge(**flags: bool) -> MagicMock:
    """Mock LLM client whose parse() returns a BlackboxCapabilityInference."""
    parsed = BlackboxCapabilityInference(**flags)
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.parsed = parsed
    response.choices[0].message.content = None
    client = MagicMock()
    client.chat.completions.parse = AsyncMock(return_value=response)
    return client


def _failing_judge(exc: Exception) -> MagicMock:
    client = MagicMock()
    client.chat.completions.parse = AsyncMock(side_effect=exc)
    return client


# One reply per probe turn so the scripted target never runs out.
_N_PROBE_TURNS = sum(len(v) for v in PROBES.values())
_BLAND_REPLIES = ['I am a helpful assistant.'] * _N_PROBE_TURNS


# ---------------------------------------------------------------------------
# Scenarios (ticket AC: memory / KB / tools / bare, plus multi-agent + errors)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_memory_capable_agent() -> None:
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _judge(memory_read=True, memory_write=True)

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert isinstance(result, AgentCapabilities)
    assert result.classification_failed is False
    assert result.all_capabilities() == {'memory_read', 'memory_write'}
    assert result.capabilities['memory:probed'] == [
        AgentCapability.MEMORY_READ,
        AgentCapability.MEMORY_WRITE,
    ]


@pytest.mark.asyncio
async def test_knowledge_capable_agent() -> None:
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _judge(knowledge_retrieval=True)

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert result.classification_failed is False
    assert result.all_capabilities() == {'knowledge_retrieval'}
    assert result.capabilities['knowledge:probed'] == [AgentCapability.KNOWLEDGE_RETRIEVAL]


@pytest.mark.asyncio
async def test_tool_capable_agent() -> None:
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _judge(code_execution=True, web_request=True)

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert result.classification_failed is False
    assert result.all_capabilities() == {'code_execution', 'web_request'}
    # Both fold into the single tools:probed group.
    assert set(result.capabilities['tools:probed']) == {
        AgentCapability.CODE_EXECUTION,
        AgentCapability.WEB_REQUEST,
    }


@pytest.mark.asyncio
async def test_bare_agent_succeeds_with_empty_capabilities() -> None:
    """A bare agent → empty caps, classification_failed=False (found nothing,
    not a mechanism error)."""
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _judge()  # all flags False

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert result.capabilities == {}
    assert result.classification_failed is False
    assert result.all_capabilities() == set()


@pytest.mark.asyncio
async def test_multi_agent_flag_populated() -> None:
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _judge(is_multi_agent=True)

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert isinstance(result, BlackboxAgentCapabilities)
    assert result.is_multi_agent is True
    assert result.classification_failed is False


@pytest.mark.asyncio
async def test_multi_agent_flag_false_by_default() -> None:
    target = _ScriptedTarget(_BLAND_REPLIES)
    result = await classify_agent_capabilities_blackbox(target, _judge(), model='m')
    assert isinstance(result, BlackboxAgentCapabilities)
    assert result.is_multi_agent is False


@pytest.mark.asyncio
async def test_all_probes_raise_sets_classification_failed() -> None:
    """Mechanism error: every probe turn raises → failed=True, judge never called."""
    target = _ScriptedTarget(raise_always=True)
    client = _judge(memory_read=True)  # would report caps if reached

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert result.classification_failed is True
    assert result.capabilities == {}
    client.chat.completions.parse.assert_not_called()


@pytest.mark.asyncio
async def test_judge_failure_sets_classification_failed() -> None:
    """Judge LLM call errors → failed=True (coverage gap, optimistic planner)."""
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _failing_judge(ValueError('judge boom'))

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert result.classification_failed is True
    assert result.capabilities == {}


@pytest.mark.asyncio
async def test_api_errors_propagate() -> None:
    """APIConnectionError/APIStatusError re-raise (mirrors white-box)."""
    target = _ScriptedTarget(_BLAND_REPLIES)
    client = _failing_judge(APIConnectionError(request=MagicMock()))

    with pytest.raises(APIConnectionError):
        await classify_agent_capabilities_blackbox(target, client, model='m')


# ---------------------------------------------------------------------------
# Probe mechanics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transcript_passed_to_judge_contains_probe_and_reply() -> None:
    target = _ScriptedTarget(['I recall the code is BANANA-42.', *_BLAND_REPLIES])
    client = _judge(memory_read=True, memory_write=True)

    await classify_agent_capabilities_blackbox(target, client, model='m')

    prompt = client.chat.completions.parse.call_args.kwargs['messages'][0]['content']
    assert 'BANANA-42' in prompt  # agent's reply reached the judge
    assert 'secret code' in prompt.lower()  # a probe question reached the judge


@pytest.mark.asyncio
async def test_running_transcript_accumulates_across_turns() -> None:
    """Each respond() call receives the accumulating transcript (so stateless
    targets can see prior turns for the cross-turn memory check)."""
    target = _ScriptedTarget(_BLAND_REPLIES)
    await classify_agent_capabilities_blackbox(target, _judge(), model='m')

    # First call: one user turn. Second: user + assistant + user (grows by 2).
    assert len(target.calls[0]) == 1
    assert len(target.calls[1]) == 3
    assert target.calls[1][0].role == 'user'
    assert target.calls[1][1].role == 'assistant'


@pytest.mark.asyncio
async def test_one_flaky_probe_does_not_abort_classification() -> None:
    """A single raising probe turn is skipped; the rest still classify."""

    class _FlakyTarget(AgentTarget):
        def __init__(self) -> None:
            super().__init__()
            self.n = 0

        async def respond(self, messages: list[Message]) -> AgentResponse:
            self.n += 1
            if self.n == 1:
                raise RuntimeError('transient')
            return AgentResponse(text='ok')

        def new(self) -> AgentTarget:
            return _FlakyTarget()

    target = _FlakyTarget()
    client = _judge(knowledge_retrieval=True)

    result = await classify_agent_capabilities_blackbox(target, client, model='m')

    assert result.classification_failed is False
    assert result.all_capabilities() == {'knowledge_retrieval'}
    # The judge was still called despite the one failure.
    client.chat.completions.parse.assert_called_once()


@pytest.mark.asyncio
async def test_probe_turn_budget_is_capped() -> None:
    """Never send more than MAX_PROBE_TURNS live turns to the agent."""
    target = _ScriptedTarget(['ok'] * 100)
    await classify_agent_capabilities_blackbox(target, _judge(), model='m')
    assert len(target.calls) <= MAX_PROBE_TURNS


@pytest.mark.asyncio
async def test_flaky_probe_turn_not_left_in_transcript() -> None:
    """A raising turn must not leave a dangling unanswered user probe in the
    transcript sent to the judge."""

    class _SecondFails(AgentTarget):
        def __init__(self) -> None:
            super().__init__()
            self.n = 0

        async def respond(self, messages: list[Message]) -> AgentResponse:
            self.n += 1
            if self.n == 2:
                raise RuntimeError('boom')
            return AgentResponse(text='reply')

        def new(self) -> AgentTarget:
            return _SecondFails()

    target = _SecondFails()
    client = _judge()
    await classify_agent_capabilities_blackbox(target, client, model='m')

    transcript_text = client.chat.completions.parse.call_args.kwargs['messages'][0]['content']
    # every USER line in the judge transcript is followed by an ASSISTANT line
    lines = [ln for ln in transcript_text.splitlines() if ln.startswith(('USER:', 'ASSISTANT:'))]
    users = sum(1 for ln in lines if ln.startswith('USER:'))
    assistants = sum(1 for ln in lines if ln.startswith('ASSISTANT:'))
    assert users == assistants


# ---------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------


def test_returns_agent_capabilities_subtype_that_serializes() -> None:
    caps = BlackboxAgentCapabilities(
        capabilities={'memory:probed': [AgentCapability.MEMORY_READ]},
        classification_failed=False,
        is_multi_agent=True,
    )
    assert isinstance(caps, AgentCapabilities)
    dumped: dict[str, Any] = caps.model_dump()
    assert dumped['is_multi_agent'] is True
    assert dumped['classification_failed'] is False
    assert caps.has_any([AgentCapability.MEMORY_READ])
