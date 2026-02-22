"""Unit tests for evaluatorq.redteam.tracing module."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch


@pytest.mark.asyncio
async def test_span_noop_without_otel():
    """with_redteam_span yields None when get_tracer() returns None."""
    with patch("evaluatorq.redteam.tracing.get_tracer", return_value=None):
        from evaluatorq.redteam.tracing import with_redteam_span

        async with with_redteam_span("orq.redteam.test") as span:
            assert span is None


@pytest.mark.asyncio
async def test_span_records_exception():
    """Exception propagates and span gets ERROR status when tracer is available."""
    mock_span = MagicMock()
    # MagicMock auto-creates __enter__/__exit__; configure __enter__ to return the span
    mock_span.__enter__ = MagicMock(return_value=mock_span)
    mock_span.__exit__ = MagicMock(return_value=False)

    mock_context_manager = MagicMock()
    mock_context_manager.__enter__ = MagicMock(return_value=mock_span)
    mock_context_manager.__exit__ = MagicMock(return_value=False)

    mock_tracer = MagicMock()
    mock_tracer.start_as_current_span.return_value = mock_context_manager

    with patch("evaluatorq.redteam.tracing.get_tracer", return_value=mock_tracer):
        from evaluatorq.redteam.tracing import with_redteam_span

        with pytest.raises(ValueError, match="test error"):
            async with with_redteam_span("orq.redteam.test") as span:
                raise ValueError("test error")

        # Verify span recorded the exception and was set to ERROR status
        mock_span.record_exception.assert_called_once()
        mock_span.set_status.assert_called()


def test_set_span_attrs_noop():
    """set_span_attrs(None, ...) is a safe no-op."""
    from evaluatorq.redteam.tracing import set_span_attrs

    # Should not raise when span is None
    set_span_attrs(None, {"key": "value", "number": 42})


def test_set_span_attrs_with_span():
    """set_span_attrs sets attributes on a real span, skipping None values."""
    from evaluatorq.redteam.tracing import set_span_attrs

    mock_span = MagicMock()
    set_span_attrs(
        mock_span,
        {
            "orq.redteam.category": "ASI01",
            "orq.redteam.empty": None,
            "orq.redteam.turns": 3,
        },
    )
    # None values should be skipped
    assert mock_span.set_attribute.call_count == 2
    mock_span.set_attribute.assert_any_call("orq.redteam.category", "ASI01")
    mock_span.set_attribute.assert_any_call("orq.redteam.turns", 3)


def test_record_token_usage_noop():
    """record_token_usage(None, ...) is a safe no-op."""
    from evaluatorq.redteam.tracing import record_token_usage

    # Should not raise when span is None
    record_token_usage(None, prompt_tokens=100, completion_tokens=50, total_tokens=150, calls=1)


def test_record_token_usage_with_span():
    """record_token_usage sets all token attributes on a span."""
    from evaluatorq.redteam.tracing import record_token_usage

    mock_span = MagicMock()
    record_token_usage(mock_span, prompt_tokens=100, completion_tokens=50, total_tokens=150, calls=2)
    assert mock_span.set_attribute.call_count == 4
    mock_span.set_attribute.assert_any_call("orq.redteam.token_usage.prompt_tokens", 100)
    mock_span.set_attribute.assert_any_call("orq.redteam.token_usage.completion_tokens", 50)
    mock_span.set_attribute.assert_any_call("orq.redteam.token_usage.total_tokens", 150)
    mock_span.set_attribute.assert_any_call("orq.redteam.token_usage.calls", 2)


@pytest.mark.asyncio
async def test_span_with_mock_tracer():
    """When tracer is available, span is yielded and attributes are set."""
    mock_span = MagicMock()

    mock_context_manager = MagicMock()
    mock_context_manager.__enter__ = MagicMock(return_value=mock_span)
    mock_context_manager.__exit__ = MagicMock(return_value=False)

    mock_tracer = MagicMock()
    mock_tracer.start_as_current_span.return_value = mock_context_manager

    with patch("evaluatorq.redteam.tracing.get_tracer", return_value=mock_tracer):
        from evaluatorq.redteam.tracing import with_redteam_span

        async with with_redteam_span("orq.redteam.test", {"key": "value"}) as span:
            assert span is mock_span

        mock_tracer.start_as_current_span.assert_called_once()
        call_args = mock_tracer.start_as_current_span.call_args
        assert call_args[0][0] == "orq.redteam.test"  # span name
