"""Diagnostic test: dump full span hierarchy from a dynamic pipeline run."""

from __future__ import annotations

from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, Sequence, cast
from unittest.mock import patch

if TYPE_CHECKING:
    from openai import AsyncOpenAI

import pytest
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

import evaluatorq.tracing.setup as _tracing_setup
from evaluatorq.redteam import red_team
from evaluatorq.redteam.backends.base import BackendBundle
from tests.redteam.e2e.conftest import (
    DeterministicAsyncOpenAI,
    MockContextProvider,
    MockErrorMapper,
    MockMemoryCleanup,
    MockTargetFactory,
)
from evaluatorq.redteam.contracts import (
    AgentContext,
    KnowledgeBaseInfo,
    MemoryStoreInfo,
    ToolInfo,
)


class _CollectingExporter(SpanExporter):
    def __init__(self) -> None:
        self.spans: list[ReadableSpan] = []

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass


@pytest.fixture()
def agent_context() -> AgentContext:
    return AgentContext(
        key="e2e-test-agent",
        display_name="E2E Test Agent",
        description="An agent for testing",
        tools=[
            ToolInfo(name="web_search", description="Search the web"),
            ToolInfo(name="code_executor", description="Execute code"),
        ],
        memory_stores=[MemoryStoreInfo(id="ms-001", key="conversation-memory")],
        knowledge_bases=[KnowledgeBaseInfo(id="kb-001", key="docs-kb", name="Documentation")],
    )


@pytest.fixture()
def mock_llm_client() -> DeterministicAsyncOpenAI:
    return DeterministicAsyncOpenAI()


@pytest.fixture()
def mock_backend_bundle(agent_context: AgentContext) -> BackendBundle:
    return BackendBundle(
        name="mock",
        target_factory=MockTargetFactory(),
        context_provider=MockContextProvider(agent_context),
        memory_cleanup=MockMemoryCleanup(),
        error_mapper=MockErrorMapper(),
    )


@pytest.fixture()
def span_exporter() -> _CollectingExporter:
    return _CollectingExporter()


@contextmanager
def _traced_patches(bundle: BackendBundle, exporter: _CollectingExporter):
    """Set module-level tracing state so all get_tracer() calls return our
    test tracer and init_tracing_if_needed() returns True immediately."""
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("evaluatorq-e2e-test")

    # Save original module state
    orig_tracer = _tracing_setup._tracer
    orig_initialized = _tracing_setup._is_initialized
    orig_attempted = _tracing_setup._initialization_attempted
    orig_sdk = _tracing_setup._sdk

    _tracing_setup._tracer = tracer
    _tracing_setup._is_initialized = True
    _tracing_setup._initialization_attempted = True

    try:
        with patch("evaluatorq.redteam.backends.registry.resolve_backend", return_value=bundle):
            yield
    finally:
        _tracing_setup._tracer = orig_tracer
        _tracing_setup._is_initialized = orig_initialized
        _tracing_setup._initialization_attempted = orig_attempted
        _tracing_setup._sdk = orig_sdk
        provider.shutdown()


def _print_tree(spans: list[ReadableSpan]) -> None:
    """Print span tree showing parent-child relationships."""
    # Build lookup: span_id -> span
    by_id: dict[int, ReadableSpan] = {}
    for s in spans:
        if s.context is not None:
            by_id[s.context.span_id] = s

    # Build children map
    children: dict[int | None, list[ReadableSpan]] = {}
    root_spans: list[ReadableSpan] = []
    for s in spans:
        parent_id = s.parent.span_id if s.parent else None
        if parent_id is None or parent_id not in by_id:
            root_spans.append(s)
        else:
            children.setdefault(parent_id, []).append(s)

    def _print_span(span: ReadableSpan, indent: int) -> None:
        attrs = dict(span.attributes or {})
        purpose = attrs.get("orq.redteam.llm_purpose", "")
        turn = attrs.get("orq.redteam.turn", "")
        category = attrs.get("orq.redteam.category", "")
        status = span.status.status_code.name
        kind = span.kind.name

        extra_parts = []
        if purpose:
            extra_parts.append(f"purpose={purpose}")
        if turn:
            extra_parts.append(f"turn={turn}")
        if category:
            extra_parts.append(f"cat={category}")
        extra = f" ({', '.join(extra_parts)})" if extra_parts else ""

        prefix = "  " * indent
        print(f"{prefix}{span.name} [{kind}] {status}{extra}")

        for child in children.get(span.context.span_id if span.context else None, []):
            _print_span(child, indent + 1)

    print("\n=== SPAN TREE ===")
    for root in root_spans:
        _print_span(root, 0)

    # Also report orphans (spans whose parent is not in our collection)
    orphan_count = 0
    for s in spans:
        parent_id = s.parent.span_id if s.parent else None
        if parent_id is not None and parent_id not in by_id:
            if orphan_count == 0:
                print("\n=== ORPHAN SPANS (parent not in collected spans) ===")
            orphan_count += 1
            attrs = dict(s.attributes or {})
            print(f"  {s.name} parent_span_id={parent_id:#018x} purpose={attrs.get('orq.redteam.llm_purpose', '')}")

    if orphan_count:
        print(f"\nTotal orphans: {orphan_count}")
    else:
        print("\nNo orphan spans - all parents are in the tree.")


@pytest.mark.asyncio
async def test_dump_span_hierarchy(
    mock_llm_client: DeterministicAsyncOpenAI,
    mock_backend_bundle: BackendBundle,
    span_exporter: _CollectingExporter,
) -> None:
    with _traced_patches(mock_backend_bundle, span_exporter):
        report = await red_team(
            "agent:e2e-test-agent",
            mode="dynamic",
            categories=["ASI01"],
            generate_strategies=False,
            attack_model="e2e-attack-model",
            evaluator_model="e2e-evaluator",
            parallelism=1,  # sequential for cleaner trace
            backend="openai",
            llm_client=cast("AsyncOpenAI", cast(object, mock_llm_client)),
            description="Hierarchy test",
        )

    assert report.total_results >= 1
    _print_tree(span_exporter.spans)
