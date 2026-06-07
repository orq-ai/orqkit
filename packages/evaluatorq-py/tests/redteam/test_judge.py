from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from openai import APIConnectionError

from evaluatorq.contracts import LLMCallConfig
from evaluatorq.redteam.judge import EvaluatorResponsePayload, JudgeError, run_judge


def _json_response(content: str) -> MagicMock:
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    return resp


@pytest.mark.asyncio
async def test_success_parses_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('evaluatorq.common.llm_call.get_trace_context_headers', AsyncMock(return_value={}))
    client = MagicMock()
    client.chat.completions.create = AsyncMock(
        return_value=_json_response('{"value": true, "explanation": "resisted"}')
    )
    outcome = await run_judge(
        client=client,
        model='m',
        cfg=LLMCallConfig(),
        prompt_template='Eval {{output.response}}',
        replacements={'output.response': 'hi'},
    )
    assert outcome.error_kind is None
    assert isinstance(outcome.payload, EvaluatorResponsePayload)
    assert outcome.payload.value is True


@pytest.mark.asyncio
async def test_timeout_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('evaluatorq.common.llm_call.get_trace_context_headers', AsyncMock(return_value={}))
    client = MagicMock()
    client.chat.completions.create = AsyncMock(side_effect=asyncio.TimeoutError())
    outcome = await run_judge(
        client=client,
        model='m',
        cfg=LLMCallConfig(timeout_ms=1000),
        prompt_template='x',
        replacements={},
    )
    assert outcome.error_kind is JudgeError.TIMEOUT
    assert outcome.timeout_ms == 1000
    assert outcome.payload is None


@pytest.mark.asyncio
async def test_parse_error_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('evaluatorq.common.llm_call.get_trace_context_headers', AsyncMock(return_value={}))
    client = MagicMock()
    client.chat.completions.create = AsyncMock(return_value=_json_response('not json'))
    outcome = await run_judge(
        client=client,
        model='m',
        cfg=LLMCallConfig(),
        prompt_template='x',
        replacements={},
    )
    assert outcome.error_kind is JudgeError.PARSE
    assert outcome.payload is None


@pytest.mark.asyncio
async def test_api_connection_captured_with_exc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('evaluatorq.common.llm_call.get_trace_context_headers', AsyncMock(return_value={}))
    client = MagicMock()
    exc = APIConnectionError(request=MagicMock())
    client.chat.completions.create = AsyncMock(side_effect=exc)
    outcome = await run_judge(
        client=client,
        model='m',
        cfg=LLMCallConfig(),
        prompt_template='x',
        replacements={},
    )
    assert outcome.error_kind is JudgeError.API_CONNECTION
    assert outcome.error_exc is exc
