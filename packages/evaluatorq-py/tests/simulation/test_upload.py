"""Tests for the auto-upload helper used by simulate() (RES-598)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from evaluatorq.simulation.types import (
    Message,
    SimulationResult,
    TerminatedBy,
    TokenUsage,
    TurnMetrics,
)
from evaluatorq.simulation.upload import (
    JOB_NAME,
    _to_data_point_result,
    upload_simulation_results,
)


def _make_result(
    *,
    persona: str = "Tester",
    scenario: str = "Smoke",
    evaluator_scores: dict[str, float] | None = None,
    error: str | None = None,
) -> SimulationResult:
    metadata: dict[str, object] = {"persona": persona, "scenario": scenario}
    if evaluator_scores is not None:
        metadata["evaluator_scores"] = evaluator_scores
    if error is not None:
        metadata["error"] = error
    return SimulationResult(
        messages=[
            Message(role="user", content="hi"),
            Message(role="assistant", content="hello"),
        ],
        terminated_by=TerminatedBy.judge,
        reason="done",
        goal_achieved=True,
        goal_completion_score=1.0,
        rules_broken=[],
        turn_count=1,
        turn_metrics=[
            TurnMetrics(turn_number=1, token_usage=TokenUsage(), judge_reason="ok")
        ],
        token_usage=TokenUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
        metadata=metadata,
    )


# ---------------------------------------------------------------------------
# _to_data_point_result
# ---------------------------------------------------------------------------


def test_to_data_point_result_inputs_carry_persona_and_scenario():
    dpr = _to_data_point_result(_make_result(), model="gpt-4o-mini")
    assert dpr.data_point.inputs == {"persona": "Tester", "scenario": "Smoke"}
    assert dpr.error is None
    assert dpr.job_results is not None
    assert len(dpr.job_results) == 1
    assert dpr.job_results[0].job_name == JOB_NAME


def test_to_data_point_result_output_is_open_responses_dict():
    dpr = _to_data_point_result(_make_result(), model="gpt-4o-mini")
    assert dpr.job_results is not None
    output = dpr.job_results[0].output
    assert isinstance(output, dict)
    assert output["object"] == "response"
    assert output["model"] == "gpt-4o-mini"


def test_to_data_point_result_includes_evaluator_scores():
    result = _make_result(evaluator_scores={"goal_achieved": 1.0, "criteria_met": 0.5})
    dpr = _to_data_point_result(result, model="m")
    assert dpr.job_results is not None
    scores = dpr.job_results[0].evaluator_scores or []
    by_name = {s.evaluator_name: s.score.value for s in scores}
    assert by_name == {"goal_achieved": 1.0, "criteria_met": 0.5}


def test_to_data_point_result_propagates_error():
    result = _make_result(error="boom")
    dpr = _to_data_point_result(result, model="m")
    assert dpr.error == "boom"
    assert dpr.job_results is not None
    assert dpr.job_results[0].error == "boom"


def test_to_data_point_result_handles_no_metadata():
    result = SimulationResult(
        messages=[Message(role="user", content="x")],
        terminated_by=TerminatedBy.error,
        reason="r",
        goal_achieved=False,
        goal_completion_score=0,
        rules_broken=[],
        turn_count=0,
        turn_metrics=[],
        token_usage=TokenUsage(),
        metadata={},
    )
    dpr = _to_data_point_result(result, model="m")
    assert dpr.data_point.inputs == {}
    assert dpr.error is None


# ---------------------------------------------------------------------------
# upload_simulation_results
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_calls_send_results_to_orq_with_correct_shape():
    sent: dict[str, object] = {}

    async def fake_send(**kwargs: object) -> None:
        sent.update(kwargs)

    results = [_make_result(persona="A"), _make_result(persona="B")]
    start = datetime(2026, 5, 7, tzinfo=timezone.utc)
    end = datetime(2026, 5, 7, 0, 0, 1, tzinfo=timezone.utc)

    with patch(
        "evaluatorq.simulation.upload.send_results_to_orq",
        side_effect=fake_send,
    ):
        await upload_simulation_results(
            api_key="test-key",
            evaluation_name="my-eval",
            evaluation_description=None,
            results=results,
            start_time=start,
            end_time=end,
            model="gpt-4o-mini",
        )

    assert sent["api_key"] == "test-key"
    assert sent["evaluation_name"] == "my-eval"
    assert sent["evaluation_description"] is None
    assert sent["dataset_id"] is None
    assert sent["start_time"] == start
    assert sent["end_time"] == end
    sent_results = sent["results"]
    assert isinstance(sent_results, list)
    assert len(sent_results) == 2
    assert sent_results[0].data_point.inputs["persona"] == "A"
    assert sent_results[1].data_point.inputs["persona"] == "B"


@pytest.mark.asyncio
async def test_upload_skips_empty_results():
    """An empty list short-circuits without calling send_results_to_orq."""
    fake = AsyncMock()
    with patch("evaluatorq.simulation.upload.send_results_to_orq", new=fake):
        await upload_simulation_results(
            api_key="test-key",
            evaluation_name="x",
            evaluation_description=None,
            results=[],
            start_time=datetime.now(tz=timezone.utc),
            end_time=datetime.now(tz=timezone.utc),
            model="m",
        )
    fake.assert_not_called()


@pytest.mark.asyncio
async def test_upload_skips_per_result_conversion_failures(
    caplog: pytest.LogCaptureFixture,
):
    """One malformed SimulationResult must not drop the whole batch."""
    import logging

    sent: dict[str, object] = {}

    async def fake_send(**kwargs: object) -> None:
        sent.update(kwargs)

    good = _make_result(persona="good")
    bad = _make_result(persona="bad")

    def conversion(result, _model):
        if result is bad:
            raise RuntimeError("boom")
        from evaluatorq.simulation.convert import to_open_responses

        return to_open_responses(result, _model)

    with caplog.at_level(logging.WARNING, logger="evaluatorq.simulation.upload"), patch(
        "evaluatorq.simulation.upload.send_results_to_orq", side_effect=fake_send
    ), patch(
        "evaluatorq.simulation.upload.to_open_responses", side_effect=conversion
    ):
        await upload_simulation_results(
            api_key="k",
            evaluation_name="e",
            evaluation_description=None,
            results=[good, bad],
            start_time=datetime.now(tz=timezone.utc),
            end_time=datetime.now(tz=timezone.utc),
            model="m",
        )

    sent_results = sent["results"]
    assert isinstance(sent_results, list)
    assert len(sent_results) == 1, "good result should still be uploaded"
    assert sent_results[0].data_point.inputs["persona"] == "good"
    assert any(
        "Skipping simulation result" in r.message for r in caplog.records
    )


def test_to_data_point_result_handles_terminated_by_error():
    """An error-terminated SimulationResult still produces a usable DataPointResult."""
    from evaluatorq.simulation.types import (
        Message,
        SimulationResult,
        TerminatedBy,
        TokenUsage,
    )

    result = SimulationResult(
        messages=[Message(role="user", content="hi")],
        terminated_by=TerminatedBy.error,
        reason="kaboom",
        goal_achieved=False,
        goal_completion_score=0,
        rules_broken=[],
        turn_count=0,
        turn_metrics=[],
        token_usage=TokenUsage(),
        metadata={
            "persona": "P",
            "scenario": "S",
            "error": "kaboom",
        },
    )
    dpr = _to_data_point_result(result, model="m")
    assert dpr.error == "kaboom"
    assert dpr.job_results is not None
    assert dpr.job_results[0].error == "kaboom"
    # output is still well-formed (OpenResponses dict)
    output = dpr.job_results[0].output
    assert isinstance(output, dict)
    assert output["object"] == "response"



@pytest.mark.asyncio
async def test_upload_swallows_send_errors(caplog: pytest.LogCaptureFixture):
    """Network failures must NOT propagate — simulation must succeed even
    when Orq upload fails (matches evaluatorq core's contract)."""
    import logging

    async def fake_send(**_: object) -> None:
        raise RuntimeError("network down")

    with caplog.at_level(logging.ERROR, logger="evaluatorq.simulation.upload"), patch(
        "evaluatorq.simulation.upload.send_results_to_orq", side_effect=fake_send
    ):
        await upload_simulation_results(
            api_key="k",
            evaluation_name="x",
            evaluation_description=None,
            results=[_make_result()],
            start_time=datetime.now(tz=timezone.utc),
            end_time=datetime.now(tz=timezone.utc),
            model="m",
        )

    assert any("Failed to upload" in r.message for r in caplog.records)



# ---------------------------------------------------------------------------
# simulate() now routes through evaluatorq() — RES-594. These tests verify
# the wiring (upload_results flag, evaluation_name, description, path) at the
# seam where simulate() calls evaluatorq(), without spinning up the real
# evaluatorq machinery.
# ---------------------------------------------------------------------------


def _make_datapoint():
    from evaluatorq.simulation.types import (
        CommunicationStyle,
        Datapoint,
        Persona,
        Scenario,
    )

    return Datapoint(
        id="dp",
        persona=Persona(
            name="P",
            patience=0.5,
            assertiveness=0.5,
            politeness=0.5,
            technical_level=0.5,
            communication_style=CommunicationStyle.casual,
            background="bg",
        ),
        scenario=Scenario(name="S", goal="g"),
        user_system_prompt="sys",
        first_message="hi",
    )


import sys
import evaluatorq.evaluatorq  # noqa: F401  # ensure submodule registered in sys.modules
_evq_module = sys.modules["evaluatorq.evaluatorq"]


@pytest.mark.asyncio
async def test_simulate_calls_evaluatorq_with_send_results_true_by_default():
    """RES-594: native integration means evaluatorq()'s upload is the canonical
    persistence path, so simulate() defaults to letting it fire."""
    from evaluatorq.simulation import simulate

    async def target_cb(_msgs):
        return "ok"

    eq_mock = AsyncMock(return_value=[])
    with patch.object(_evq_module, "evaluatorq", new=eq_mock):
        await simulate(
            evaluation_name="my-eval",
            target_callback=target_cb,
            datapoints=[_make_datapoint()],
            max_turns=1,
        )

    eq_mock.assert_awaited_once()
    call = eq_mock.await_args
    assert call is not None
    assert call.args[0] == "my-eval"  # type: ignore[index]
    assert call.kwargs["_send_results"] is True


@pytest.mark.asyncio
async def test_simulate_forwards_upload_results_false():
    from evaluatorq.simulation import simulate

    async def target_cb(_msgs):
        return "ok"

    eq_mock = AsyncMock(return_value=[])
    with patch.object(_evq_module, "evaluatorq", new=eq_mock):
        await simulate(
            evaluation_name="my-eval",
            target_callback=target_cb,
            datapoints=[_make_datapoint()],
            max_turns=1,
            upload_results=False,
        )

    assert eq_mock.await_args is not None
    assert eq_mock.await_args.kwargs["_send_results"] is False


@pytest.mark.asyncio
async def test_simulate_synthesises_run_name_when_empty():
    from evaluatorq.simulation import simulate

    async def target_cb(_msgs):
        return "ok"

    eq_mock = AsyncMock(return_value=[])
    with patch.object(_evq_module, "evaluatorq", new=eq_mock):
        await simulate(
            evaluation_name="",
            target_callback=target_cb,
            datapoints=[_make_datapoint()],
            max_turns=1,
        )

    assert eq_mock.await_args is not None
    name = eq_mock.await_args.args[0]
    assert name.startswith("simulation-")
    # YYYYMMDD-HHMMSS-{8 hex} → 8+1+6+1+8 = 24 chars after the "simulation-" prefix
    assert len(name) == len("simulation-") + 24


@pytest.mark.asyncio
async def test_simulate_passes_description_and_path():
    from evaluatorq.simulation import simulate

    async def target_cb(_msgs):
        return "ok"

    eq_mock = AsyncMock(return_value=[])
    with patch.object(_evq_module, "evaluatorq", new=eq_mock):
        await simulate(
            evaluation_name="e",
            target_callback=target_cb,
            datapoints=[_make_datapoint()],
            max_turns=1,
            evaluation_description="my run",
            path="Proj/Folder",
        )

    assert eq_mock.await_args is not None
    kwargs = eq_mock.await_args.kwargs
    assert kwargs["description"] == "my run"
    assert kwargs["path"] == "Proj/Folder"
