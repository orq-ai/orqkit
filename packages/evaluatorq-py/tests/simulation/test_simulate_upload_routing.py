"""Verify simulate(upload_results=...) propagates to evaluatorq(_send_results=...).

The whole point of RES-598 closure is that auto-upload is inherited from
evaluatorq() rather than re-implemented in simulate(). Without this test the
plumbing could regress silently — simulate() would still return results and
all other tests would pass, but uploads would stop firing.
"""

from __future__ import annotations

import sys
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from evaluatorq.simulation.api import simulate
from evaluatorq.simulation.types import (
    CommunicationStyle,
    Datapoint,
    Persona,
    Scenario,
)


def _make_datapoint() -> Datapoint:
    return Datapoint(
        id="dp-routing",
        persona=Persona(
            name="Test User",
            patience=0.5,
            assertiveness=0.5,
            politeness=0.5,
            technical_level=0.5,
            communication_style=CommunicationStyle.casual,
            background="A test user",
        ),
        scenario=Scenario(name="Test Scenario", goal="Get help"),
        user_system_prompt="system",
        first_message="hi",
    )


async def _capture_evaluatorq_kwargs(
    *, upload_results: bool | None,
) -> dict[str, Any]:
    """Run simulate() with evaluatorq() stubbed; return the kwargs it saw.

    The stub never populates the result cache, so simulate() raises after the
    forwarded call. We only care that the kwargs reached evaluatorq() correctly.
    """
    captured: dict[str, Any] = {}

    async def fake_evaluatorq(*args: Any, **kwargs: Any) -> None:
        captured["kwargs"] = kwargs

    async def target(_messages: list[Any]) -> str:
        return "ok"

    eq_mod = sys.modules["evaluatorq.evaluatorq"]
    call_kwargs: dict[str, Any] = {
        "evaluation_name": "routing-test",
        "target": target,
        "datapoints": [_make_datapoint()],
        "max_turns": 1,
    }
    if upload_results is not None:
        call_kwargs["upload_results"] = upload_results

    with patch.object(eq_mod, "evaluatorq", new=AsyncMock(side_effect=fake_evaluatorq)):
        with pytest.raises(RuntimeError, match="produced no result"):
            await simulate(**call_kwargs)

    return captured["kwargs"]


@pytest.mark.parametrize("upload_results", [True, False])
@pytest.mark.asyncio
async def test_simulate_forwards_upload_results_to_evaluatorq(
    upload_results: bool,
) -> None:
    """simulate(upload_results=X) must reach evaluatorq() as _send_results=X."""
    eq_kwargs = await _capture_evaluatorq_kwargs(upload_results=upload_results)
    assert eq_kwargs["_send_results"] is upload_results


@pytest.mark.asyncio
async def test_simulate_defaults_upload_results_to_true() -> None:
    """RES-594 flipped the default from False to True (CHANGELOG breaking change)."""
    eq_kwargs = await _capture_evaluatorq_kwargs(upload_results=None)
    assert eq_kwargs["_send_results"] is True
