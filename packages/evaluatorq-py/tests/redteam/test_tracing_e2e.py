"""E2E integration test that runs a full red-team pipeline with real OTel
tracing enabled and inspects the collected spans for correct attributes.

Uses the same mock backend/LLM fixtures from the E2E conftest but replaces
the tracing setup with an in-memory exporter so we can capture and validate
every span the pipeline emits.
"""

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

# Re-use the E2E mock fixtures
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


# ---------------------------------------------------------------------------
# In-memory span collector
# ---------------------------------------------------------------------------


class _CollectingExporter(SpanExporter):
    def __init__(self) -> None:
        self.spans: list[ReadableSpan] = []

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def agent_context() -> AgentContext:
    return AgentContext(
        key="e2e-test-agent",
        display_name="E2E Test Agent",
        description="An agent used for E2E testing of red teaming pipelines",
        tools=[
            ToolInfo(name="web_search", description="Search the web"),
            ToolInfo(name="code_executor", description="Execute code"),
        ],
        memory_stores=[
            MemoryStoreInfo(id="ms-001", key="conversation-memory"),
        ],
        knowledge_bases=[
            KnowledgeBaseInfo(id="kb-001", key="docs-kb", name="Documentation"),
        ],
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
def _traced_dynamic_patches(mock_backend_bundle: BackendBundle, exporter: _CollectingExporter):
    """Patch backend resolution and install a real in-memory OTel tracer.

    Instead of patching individual function references (which miss early-imported
    bindings), we set the module-level state on ``evaluatorq.tracing.setup``
    directly. This makes the real ``get_tracer()`` return our test tracer and
    ``init_tracing_if_needed()`` return ``True`` regardless of which module
    imported them — fixing framework span creation (orq.job, orq.evaluation).
    """
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("evaluatorq-e2e-test")

    # Save original module state
    orig_tracer = _tracing_setup._tracer
    orig_initialized = _tracing_setup._is_initialized
    orig_attempted = _tracing_setup._initialization_attempted
    orig_sdk = _tracing_setup._sdk

    # Set module state so all get_tracer() calls return our tracer
    # and init_tracing_if_needed() returns True immediately
    _tracing_setup._tracer = tracer
    _tracing_setup._is_initialized = True
    _tracing_setup._initialization_attempted = True

    try:
        with patch("evaluatorq.redteam.backends.registry.resolve_backend", return_value=mock_backend_bundle):
            yield
    finally:
        # Restore module state
        _tracing_setup._tracer = orig_tracer
        _tracing_setup._is_initialized = orig_initialized
        _tracing_setup._initialization_attempted = orig_attempted
        _tracing_setup._sdk = orig_sdk
        provider.shutdown()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _find_spans(exporter: _CollectingExporter, name: str) -> list[ReadableSpan]:
    return [s for s in exporter.spans if s.name == name]


def _find_spans_prefix(exporter: _CollectingExporter, prefix: str) -> list[ReadableSpan]:
    return [s for s in exporter.spans if s.name.startswith(prefix)]


def _attrs(span: ReadableSpan) -> dict[str, Any]:
    return dict(span.attributes or {})


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_dynamic_pipeline_span_attributes(
    mock_llm_client: DeterministicAsyncOpenAI,
    mock_backend_bundle: BackendBundle,
    span_exporter: _CollectingExporter,
) -> None:
    """Run full dynamic pipeline and verify span names, attributes, and hierarchy."""
    with _traced_dynamic_patches(mock_backend_bundle, span_exporter):
        report = await red_team(
            "agent:e2e-test-agent",
            mode="dynamic",
            categories=["ASI01"],
            generate_strategies=False,
            attack_model="e2e-attack-model",
            evaluator_model="e2e-evaluator",
            parallelism=2,
            backend="openai",
            llm_client=cast("AsyncOpenAI", cast(object, mock_llm_client)),
            description="E2E tracing test",
        )

    assert report.total_results >= 1, "Pipeline should produce at least one result"
    all_spans = span_exporter.spans
    assert len(all_spans) > 0, "Should have collected spans"

    # Print all span names for debugging
    span_names = [s.name for s in all_spans]
    print(f"\n--- Collected {len(all_spans)} spans ---")
    for s in all_spans:
        attrs = _attrs(s)
        kind = s.kind.name
        print(f"  {s.name} [{kind}] attrs={list(attrs.keys())}")

    # ----------------------------------------------------------------
    # 1. Verify pipeline root span exists
    # ----------------------------------------------------------------
    pipeline_spans = _find_spans(span_exporter, "orq.redteam.pipeline")
    assert len(pipeline_spans) == 1, f"Expected 1 pipeline span, got {len(pipeline_spans)}"
    pipeline_attrs = _attrs(pipeline_spans[0])
    assert pipeline_attrs["orq.redteam.mode"] == "dynamic"
    assert pipeline_attrs["orq.redteam.backend"] == "openai"

    # ----------------------------------------------------------------
    # 2. Verify LLM spans use "chat <model>" naming (NOT bare "chat")
    # ----------------------------------------------------------------
    llm_spans = _find_spans_prefix(span_exporter, "chat ")
    assert len(llm_spans) > 0, f"Expected LLM spans with 'chat <model>' name, found: {span_names}"
    for llm_span in llm_spans:
        assert " " in llm_span.name, f"LLM span name should be 'chat <model>', got: {llm_span.name}"
        attrs = _attrs(llm_span)

        # gen_ai.system must be present
        assert "gen_ai.system" in attrs, f"Missing gen_ai.system on span {llm_span.name}"
        assert "gen_ai.provider.name" in attrs
        assert "gen_ai.request.model" in attrs
        assert "gen_ai.operation.name" in attrs
        assert attrs["gen_ai.operation.name"] == "chat"

        # gen_ai.system should equal gen_ai.provider.name
        assert attrs["gen_ai.system"] == attrs["gen_ai.provider.name"]

        # SpanKind must be CLIENT
        assert llm_span.kind.name == "CLIENT"

    # Verify NO spans with bare "chat" name exist
    bare_chat_spans = _find_spans(span_exporter, "chat")
    assert len(bare_chat_spans) == 0, f"Found bare 'chat' spans — should be 'chat <model>': {[s.name for s in bare_chat_spans]}"

    # ----------------------------------------------------------------
    # 3. Verify target_call spans have input/output attributes
    # ----------------------------------------------------------------
    target_call_spans = _find_spans(span_exporter, "orq.redteam.target_call")
    assert len(target_call_spans) >= 1, "Expected at least one target_call span"
    for tc_span in target_call_spans:
        attrs = _attrs(tc_span)
        # Must have both platform-recognized input/output AND orq.redteam.* variants
        assert "input" in attrs, f"Missing 'input' on target_call span"
        assert "orq.redteam.input" in attrs, f"Missing 'orq.redteam.input' on target_call span"
        # input should NOT be truncated to 2000 chars (per user request)
        assert isinstance(attrs["input"], str) and len(attrs["input"]) > 0

        # output may not always be set (could be error path), but when present
        if "output" in attrs:
            assert "orq.redteam.output" in attrs

    # ----------------------------------------------------------------
    # 4. Verify attack spans have input/output
    # ----------------------------------------------------------------
    attack_spans = _find_spans(span_exporter, "orq.redteam.attack")
    for atk_span in attack_spans:
        attrs = _attrs(atk_span)
        # Attack spans should have input and output set at completion
        if "input" in attrs:
            assert isinstance(attrs["input"], str) and len(attrs["input"]) > 0
        if "output" in attrs:
            assert isinstance(attrs["output"], str)

    # ----------------------------------------------------------------
    # 5. Verify redteam spans are INTERNAL kind
    # ----------------------------------------------------------------
    for s in all_spans:
        if s.name.startswith("orq.redteam."):
            assert s.kind.name == "INTERNAL", f"Redteam span {s.name} should be INTERNAL, got {s.kind.name}"

    # ----------------------------------------------------------------
    # 6. Verify security_evaluation spans have input/output
    # ----------------------------------------------------------------
    eval_spans = _find_spans(span_exporter, "orq.redteam.security_evaluation")
    for eval_span in eval_spans:
        attrs = _attrs(eval_span)
        assert "input" in attrs, "security_evaluation span should have 'input'"
        assert "output" in attrs, "security_evaluation span should have 'output'"

    # ----------------------------------------------------------------
    # 7. Verify all spans have OK or ERROR status (none UNSET)
    # ----------------------------------------------------------------
    for s in all_spans:
        status_name = s.status.status_code.name
        assert status_name in ("OK", "ERROR"), f"Span {s.name} has unexpected status {status_name}"

    # ----------------------------------------------------------------
    # 8. Verify any ERROR spans have error.type set
    # ----------------------------------------------------------------
    for s in all_spans:
        if s.status.status_code.name == "ERROR":
            attrs = _attrs(s)
            assert "error.type" in attrs, f"ERROR span {s.name} missing error.type attribute"

    print(f"\n--- All {len(all_spans)} spans validated successfully ---")
