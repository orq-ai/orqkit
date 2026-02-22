"""Red teaming span utilities for OpenTelemetry instrumentation.

Span hierarchy:
- orq.redteam.pipeline (root or child of parent context)      [runner.py]
  +-- orq.redteam.context_retrieval                            [runner.py]
  +-- orq.redteam.datapoint_generation                         [runner.py]
  |   +-- orq.redteam.capability_classification                [strategy_planner.py]
  |   +-- orq.redteam.strategy_planning                        [strategy_planner.py]
  +-- orq.job (framework)                                      [processings.py]
  |   +-- orq.redteam.attack                                   [pipeline.py]
  |   |   +-- orq.redteam.attack_turn x N                      [orchestrator.py]
  |   +-- orq.evaluation (framework)                           [processings.py]
  |       +-- orq.redteam.security_evaluation                  [pipeline.py]
  +-- orq.redteam.memory_cleanup                               [runner.py]

All red teaming attributes use the ``orq.redteam.*`` namespace.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

from evaluatorq.tracing.setup import get_tracer

if TYPE_CHECKING:
    from opentelemetry.trace import Span


@asynccontextmanager
async def with_redteam_span(
    name: str,
    attributes: dict[str, Any] | None = None,
    parent_context: Any | None = None,
) -> AsyncGenerator["Span | None", None]:
    """Execute code within a red teaming span.

    Yields the span when tracing is enabled, ``None`` otherwise.
    Exceptions propagate and are recorded on the span with ERROR status.

    Args:
        name: Span name (e.g. ``"orq.redteam.pipeline"``).
        attributes: Initial span attributes set at creation time.
        parent_context: Explicit parent OTEL context. Falls back to the
            current active context when ``None``.
    """
    tracer = get_tracer()
    if tracer is None:
        yield None
        return

    try:
        from opentelemetry import context as otel_context
        from opentelemetry.trace import SpanKind, Status, StatusCode

        ctx = parent_context or otel_context.get_current()

        with tracer.start_as_current_span(
            name,
            context=ctx,
            kind=SpanKind.INTERNAL,
            attributes=attributes or {},
        ) as span:
            try:
                yield span
                span.set_status(Status(StatusCode.OK))
            except Exception as e:
                span.set_status(Status(StatusCode.ERROR, str(e)))
                span.record_exception(e)
                raise

    except ImportError:
        yield None


def set_span_attrs(span: "Span | None", attrs: dict[str, Any]) -> None:
    """Set attributes on a span. Safe no-op when *span* is ``None``."""
    if span is None:
        return
    for key, value in attrs.items():
        if value is not None:
            span.set_attribute(key, value)


def record_token_usage(
    span: "Span | None",
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    calls: int = 0,
) -> None:
    """Record token usage attributes on a span. Safe no-op when *span* is ``None``."""
    if span is None:
        return
    span.set_attribute("orq.redteam.token_usage.prompt_tokens", prompt_tokens)
    span.set_attribute("orq.redteam.token_usage.completion_tokens", completion_tokens)
    span.set_attribute("orq.redteam.token_usage.total_tokens", total_tokens)
    span.set_attribute("orq.redteam.token_usage.calls", calls)
