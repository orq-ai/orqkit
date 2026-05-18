"""Tests for focus-area recommendation generation.

Regression coverage for RES-817: ``generate_focus_area_recommendations`` must
not hardcode ``temperature=0.3``; reasoning models (gpt-5*, o1*, o3*, o4*)
reject any temperature other than 1.0 with HTTP 400. The function now reads
``temperature`` (and other LLM call kwargs) from the ``LLMConfig.evaluator``
role config.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from typing import cast

from evaluatorq.redteam.contracts import (
    AgentInfo,
    AttackInfo,
    AttackTechnique,
    DeliveryMethod,
    Framework,
    LLMCallConfig,
    LLMConfig,
    Message,
    Pipeline,
    RedTeamReport,
    RedTeamResult,
    ReportSummary,
    Severity,
    TurnType,
    UnifiedEvaluationResult,
)
from evaluatorq.redteam.reports import recommendations as rec_mod
from evaluatorq.redteam.reports.recommendations import generate_focus_area_recommendations


def _empty_report() -> RedTeamReport:
    return RedTeamReport(
        created_at=datetime.now(timezone.utc),
        pipeline=Pipeline.DYNAMIC,
        categories_tested=['ASI01'],
        total_results=0,
        results=[],
        summary=ReportSummary(),
    )


def _vulnerable_result() -> RedTeamResult:
    return RedTeamResult(
        attack=AttackInfo(
            id='LLM06-test-001',
            category='LLM06',
            framework=Framework.OWASP_LLM,
            attack_technique=AttackTechnique.INDIRECT_INJECTION,
            delivery_methods=[DeliveryMethod.DIRECT_REQUEST],
            turn_type=TurnType.SINGLE,
            severity=Severity.MEDIUM,
            source='template_dynamic',
        ),
        agent=AgentInfo(key='test_agent', model='openai/gpt-5-mini'),
        messages=cast(list[Message], [{'role': 'user', 'content': 'do bad thing'}]),
        response='Sure, here is the bad thing.',
        evaluation=UnifiedEvaluationResult(
            passed=False,
            explanation='Agent complied with adversarial request.',
            evaluator_id='LLM06',
        ),
        vulnerable=True,
    )


def _fake_area() -> dict[str, Any]:
    return {
        'category': 'LLM06',
        'category_name': 'Excessive Agency',
        'vulnerability': 'LLM06',
        'vulnerability_name': 'Excessive Agency',
        'vulnerability_rate': 0.5,
        'risk_score': 0.5,
        'vulnerable_results': [_vulnerable_result()],
    }


def _mock_completion_response() -> Any:
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = (
        '{"recommendations": ["Reduce agent permissions"], '
        '"patterns_observed": "Agent acted beyond scope"}'
    )
    return response


@pytest.fixture
def mock_client_and_capture(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, dict[str, Any]]:
    """AsyncOpenAI mock that captures the kwargs passed to chat.completions.create.

    Also stubs ``_compute_top_risk_areas`` so we don't need a full report fixture.
    """
    def _fake_compute(_r: RedTeamReport, _n: int) -> list[dict[str, Any]]:
        return [_fake_area()]

    monkeypatch.setattr(rec_mod, '_compute_top_risk_areas', _fake_compute)

    captured: dict[str, Any] = {}

    async def fake_create(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return _mock_completion_response()

    client = MagicMock()
    client.chat.completions.create = AsyncMock(side_effect=fake_create)
    return client, captured


@pytest.mark.asyncio
async def test_default_cfg_uses_reasoning_safe_temperature(
    mock_client_and_capture: tuple[Any, dict[str, Any]],
) -> None:
    """Without an explicit cfg, the call uses ``LLMConfig`` defaults
    (``temperature=1.0``) — which reasoning models accept.
    """
    client, captured = mock_client_and_capture

    recs = await generate_focus_area_recommendations(
        _empty_report(), client, model='openai/gpt-5-mini'
    )

    assert recs, 'Expected at least one recommendation'
    assert captured['temperature'] == 1.0


@pytest.mark.asyncio
async def test_explicit_evaluator_temperature_is_forwarded(
    mock_client_and_capture: tuple[Any, dict[str, Any]],
) -> None:
    """Caller-supplied ``cfg.evaluator.temperature`` is passed through verbatim."""
    client, captured = mock_client_and_capture
    cfg = LLMConfig(evaluator=LLMCallConfig(model='openai/gpt-4o-mini', temperature=0.0))

    await generate_focus_area_recommendations(
        _empty_report(), client, model='openai/gpt-4o-mini', cfg=cfg
    )

    assert captured['temperature'] == 0.0


@pytest.mark.asyncio
async def test_evaluator_extra_kwargs_merged(
    mock_client_and_capture: tuple[Any, dict[str, Any]],
) -> None:
    """``cfg.evaluator.extra_kwargs`` are merged into the call."""
    client, captured = mock_client_and_capture
    cfg = LLMConfig(
        evaluator=LLMCallConfig(temperature=1.0, extra_kwargs={'seed': 42}),
    )

    await generate_focus_area_recommendations(
        _empty_report(), client, model='openai/gpt-5-mini', cfg=cfg
    )

    assert captured['temperature'] == 1.0
    assert captured.get('seed') == 42
