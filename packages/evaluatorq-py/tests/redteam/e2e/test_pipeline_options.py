"""E2E tests for pipeline options: callbacks, output artifacts, error handling."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evaluatorq.redteam import red_team
from evaluatorq.redteam.backends.base import BackendBundle

from .conftest import DeterministicAsyncOpenAI


@contextmanager
def _dynamic_patches(mock_backend_bundle: BackendBundle):
    with (
        patch("evaluatorq.redteam.backends.registry.resolve_backend", return_value=mock_backend_bundle),
        patch("evaluatorq.tracing.setup.init_tracing_if_needed", return_value=None),
        patch("evaluatorq.tracing.context.capture_parent_context", return_value=None),
    ):
        yield


# ---------------------------------------------------------------------------
# Confirm callback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_confirm_callback_cancels_dynamic(
    mock_llm_client: DeterministicAsyncOpenAI,
    mock_backend_bundle: BackendBundle,
) -> None:
    """confirm_callback returning False should raise RuntimeError."""
    callback = MagicMock(return_value=False)
    with _dynamic_patches(mock_backend_bundle):
        with pytest.raises(RuntimeError, match="cancelled"):
            await red_team(
                "agent:e2e-test-agent",
                mode="dynamic",
                categories=["ASI01"],
                generate_strategies=False,
                attack_model="e2e-attack-model",
                evaluator_model="e2e-evaluator",
                parallelism=2,
                backend="openai",
                llm_client=mock_llm_client,
                confirm_callback=callback,
            )

    callback.assert_called_once()
    summary = callback.call_args[0][0]
    assert "num_datapoints" in summary
    assert "categories" in summary


@pytest.mark.asyncio
async def test_confirm_callback_cancels_hybrid(
    mock_llm_client: DeterministicAsyncOpenAI,
    mock_backend_bundle: BackendBundle,
    static_dataset_path: Path,
) -> None:
    """confirm_callback returning False in hybrid mode should raise RuntimeError."""
    callback = MagicMock(return_value=False)
    with _dynamic_patches(mock_backend_bundle):
        with pytest.raises(RuntimeError, match="cancelled"):
            await red_team(
                "agent:e2e-test-agent",
                mode="hybrid",
                categories=["ASI01"],
                generate_strategies=False,
                attack_model="e2e-attack-model",
                evaluator_model="e2e-evaluator",
                parallelism=2,
                backend="openai",
                llm_client=mock_llm_client,
                dataset_path=str(static_dataset_path),
                confirm_callback=callback,
            )

    callback.assert_called_once()
    summary = callback.call_args[0][0]
    assert "num_dynamic" in summary
    assert "num_static" in summary


# ---------------------------------------------------------------------------
# Output artifacts
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_static_output_artifacts(
    mock_llm_client: DeterministicAsyncOpenAI,
    static_dataset_path: Path,
    tmp_path: Path,
) -> None:
    """Static mode should write numbered artifact files."""
    output_dir = tmp_path / "static_artifacts"
    await red_team(
        "openai:e2e-static-model",
        mode="static",
        evaluator_model="e2e-evaluator",
        parallelism=2,
        backend="openai",
        dataset_path=str(static_dataset_path),
        llm_client=mock_llm_client,
        output_dir=output_dir,
    )

    assert (output_dir / "01_datapoints.json").exists()
    assert (output_dir / "02_attack_results.json").exists()
    assert (output_dir / "03_summary_report.json").exists()

    # Verify envelope structure on stage files
    import json

    datapoints = json.loads((output_dir / "01_datapoints.json").read_text())
    assert "saved_at" in datapoints
    assert "data" in datapoints


@pytest.mark.asyncio
async def test_dynamic_output_artifacts(
    mock_llm_client: DeterministicAsyncOpenAI,
    mock_backend_bundle: BackendBundle,
    tmp_path: Path,
) -> None:
    """Dynamic mode should write 01 through 04 artifact files."""
    output_dir = tmp_path / "dynamic_artifacts"
    with _dynamic_patches(mock_backend_bundle):
        await red_team(
            "agent:e2e-test-agent",
            mode="dynamic",
            categories=["ASI01"],
            generate_strategies=False,
            attack_model="e2e-attack-model",
            evaluator_model="e2e-evaluator",
            parallelism=2,
            backend="openai",
            llm_client=mock_llm_client,
            output_dir=output_dir,
        )

    assert (output_dir / "01_agent_context.json").exists()
    assert (output_dir / "02_datapoints.json").exists()
    assert (output_dir / "03_attack_results.json").exists()
    assert (output_dir / "04_summary_report.json").exists()


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalid_mode_raises() -> None:
    """Invalid mode should raise ValueError."""
    with pytest.raises(ValueError, match="Invalid mode"):
        await red_team(
            "openai:some-model",
            mode="nonexistent",
            backend="openai",
        )


@pytest.mark.asyncio
async def test_empty_targets_raises() -> None:
    """Empty target list should raise ValueError."""
    with pytest.raises(ValueError, match="at least one target"):
        await red_team(
            [],
            mode="static",
            backend="openai",
        )
