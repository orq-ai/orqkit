"""Tests for _send_cleaned_results URL persistence on the report."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from evaluatorq.redteam.contracts import Pipeline, RedTeamReport, ReportSummary
from evaluatorq.redteam.runner import _send_cleaned_results
from evaluatorq.send_results import OrqResponse
from evaluatorq.types import DataPoint, DataPointResult, JobResult


def _make_response(rows_created: int = 1, url: str | None = "https://orq.example/experiments/abc") -> OrqResponse:
    return OrqResponse(
        sheet_id="sheet-1",
        manifest_id="manifest-1",
        experiment_name="n",
        rows_created=rows_created,
        experiment_url=url,
    )


def _make_report() -> RedTeamReport:
    return RedTeamReport(  # pyright: ignore[reportArgumentType]
        created_at=datetime.now(tz=timezone.utc),
        description="test",
        pipeline=Pipeline.DYNAMIC,
        framework=None,
        categories_tested=["ASI01"],
        tested_agents=["agent:test"],
        total_results=0,
        results=[],
        summary=ReportSummary(),
    )


def _make_result() -> DataPointResult:
    return DataPointResult(
        data_point=DataPoint(inputs={"x": 1}),
        job_results=[JobResult(job_name="j", output="ok")],  # pyright: ignore[reportArgumentType]
    )


@pytest.mark.asyncio
async def test_sets_experiment_url_on_success() -> None:
    """Successful upload populates report.experiment_url — guards the order
    of upload-before-save so URL lands in the persisted summary report."""
    report = _make_report()
    with (
        patch.dict(os.environ, {"ORQ_API_KEY": "test"}),
        patch(
            "evaluatorq.redteam.runner.send_results_to_orq",
            new_callable=AsyncMock,
            return_value=_make_response(),
        ),
    ):
        await _send_cleaned_results(
            results=[_make_result()],
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.experiment_url == "https://orq.example/experiments/abc"


@pytest.mark.asyncio
async def test_no_url_when_api_key_missing() -> None:
    report = _make_report()
    with patch.dict(os.environ, {}, clear=True):
        await _send_cleaned_results(
            results=[_make_result()],
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.experiment_url is None


@pytest.mark.asyncio
async def test_no_url_when_upload_returns_none() -> None:
    report = _make_report()
    with (
        patch.dict(os.environ, {"ORQ_API_KEY": "test"}),
        patch(
            "evaluatorq.redteam.runner.send_results_to_orq",
            new_callable=AsyncMock,
            return_value=None,
        ),
    ):
        await _send_cleaned_results(
            results=[_make_result()],
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.experiment_url is None


@pytest.mark.asyncio
async def test_upload_exception_does_not_break_report() -> None:
    """Upload failures are swallowed; report.experiment_url stays None."""
    report = _make_report()
    with (
        patch.dict(os.environ, {"ORQ_API_KEY": "test"}),
        patch(
            "evaluatorq.redteam.runner.send_results_to_orq",
            new_callable=AsyncMock,
            side_effect=RuntimeError("boom"),
        ),
    ):
        await _send_cleaned_results(
            results=[_make_result()],
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.experiment_url is None


@pytest.mark.asyncio
async def test_persists_upload_diagnostics_on_report() -> None:
    """uploaded_count + rows_created land on the report alongside the URL, so a
    local JSON is enough to diagnose an Explorer sample-count mismatch."""
    report = _make_report()
    with (
        patch.dict(os.environ, {"ORQ_API_KEY": "test"}),
        patch(
            "evaluatorq.redteam.runner.send_results_to_orq",
            new_callable=AsyncMock,
            return_value=_make_response(rows_created=1),
        ),
    ):
        await _send_cleaned_results(
            results=[_make_result()],
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.uploaded_count == 1
    assert report.rows_created == 1
    assert report.experiment_url == "https://orq.example/experiments/abc"


@pytest.mark.asyncio
async def test_diagnostics_none_when_upload_returns_none() -> None:
    """A failed upload leaves rows_created unset but records the attempt count."""
    report = _make_report()
    with (
        patch.dict(os.environ, {"ORQ_API_KEY": "test"}),
        patch(
            "evaluatorq.redteam.runner.send_results_to_orq",
            new_callable=AsyncMock,
            return_value=None,
        ),
    ):
        await _send_cleaned_results(
            results=[_make_result()],
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.uploaded_count == 1
    assert report.rows_created is None
    assert report.experiment_url is None


@pytest.mark.asyncio
async def test_url_persisted_even_when_rows_created_gap() -> None:
    """A rows_created < uploaded gap still persists all three diagnostics."""
    report = _make_report()
    results = [_make_result(), _make_result()]
    with (
        patch.dict(os.environ, {"ORQ_API_KEY": "test"}),
        patch(
            "evaluatorq.redteam.runner.send_results_to_orq",
            new_callable=AsyncMock,
            return_value=_make_response(rows_created=1),
        ),
    ):
        await _send_cleaned_results(
            results=results,
            name="n",
            description="d",
            start_time=datetime.now(tz=timezone.utc),
            report=report,
        )
    assert report.uploaded_count == 2
    assert report.rows_created == 1
    assert report.experiment_url == "https://orq.example/experiments/abc"


@pytest.mark.asyncio
async def test_report_json_roundtrips_diagnostics() -> None:
    """The new optional fields serialize into the run JSON and old JSONs
    without them still validate."""
    report = _make_report()
    report.uploaded_count = 17
    report.rows_created = 8
    data = report.model_dump(mode="json")
    assert data["uploaded_count"] == 17
    assert data["rows_created"] == 8
    # backward compat: a legacy payload without the new keys still validates
    data.pop("uploaded_count")
    data.pop("rows_created")
    legacy = RedTeamReport.model_validate(data)
    assert legacy.uploaded_count is None
    assert legacy.rows_created is None
