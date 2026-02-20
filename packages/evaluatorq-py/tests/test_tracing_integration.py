"""Integration tests verifying that evaluatorq() produces the correct trace hierarchy.

These tests run evaluatorq() end-to-end with a real OTEL TracerProvider and
in-memory exporter, then verify the exported spans form the expected tree:

    orq.evaluation_run
    ├── orq.job (datapoint 0)
    │   └── orq.evaluation (evaluator)
    ├── orq.job (datapoint 1)
    │   └── orq.evaluation (evaluator)
    └── ...
"""

import asyncio

import pytest

from evaluatorq import evaluatorq
from evaluatorq.types import DataPoint, EvaluationResult, ScorerParameter

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

class _InMemoryExporter:
    """Collect finished spans in memory for assertions."""

    def __init__(self):
        self.spans = []

    def export(self, spans):
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self):
        pass

    def force_flush(self, timeout_millis=None):
        return True


def _patch_tracing(provider, exporter):
    """Patch evaluatorq's tracing internals to use our test provider.

    Returns a cleanup function that restores the original state.
    """
    import evaluatorq.tracing.setup as setup_mod
    import evaluatorq.tracing.spans as spans_mod

    # Save originals
    orig_setup = {
        "_sdk": setup_mod._sdk,
        "_tracer": setup_mod._tracer,
        "_is_initialized": setup_mod._is_initialized,
        "_initialization_attempted": setup_mod._initialization_attempted,
    }
    orig_spans_get_tracer = spans_mod.get_tracer

    test_tracer = provider.get_tracer("evaluatorq-test")

    # Patch setup module so init_tracing_if_needed() returns True immediately
    setup_mod._sdk = provider
    setup_mod._tracer = test_tracer
    setup_mod._is_initialized = True
    setup_mod._initialization_attempted = True

    # Patch spans module so span functions use our tracer
    spans_mod.get_tracer = lambda: test_tracer

    def restore():
        setup_mod._sdk = orig_setup["_sdk"]
        setup_mod._tracer = orig_setup["_tracer"]
        setup_mod._is_initialized = orig_setup["_is_initialized"]
        setup_mod._initialization_attempted = orig_setup["_initialization_attempted"]
        spans_mod.get_tracer = orig_spans_get_tracer

    return restore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def tracing_env(monkeypatch):
    """Set up a test TracerProvider with in-memory exporter, patched into evaluatorq."""
    exporter = _InMemoryExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    # evaluatorq checks ORQ_API_KEY / OTEL_EXPORTER_OTLP_ENDPOINT to decide if tracing is enabled.
    # We set a dummy endpoint so is_tracing_enabled() returns True.
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    # Remove ORQ_API_KEY to avoid sending results to the real platform.
    monkeypatch.delenv("ORQ_API_KEY", raising=False)

    restore = _patch_tracing(provider, exporter)
    yield exporter
    restore()
    provider.shutdown()


# ---------------------------------------------------------------------------
# Sample jobs and evaluators
# ---------------------------------------------------------------------------

async def simple_job(data: DataPoint, _row: int):
    await asyncio.sleep(0.001)
    return {
        "name": "echo-job",
        "output": {"echo": data.inputs.get("text", "")},
    }


async def length_scorer(params: ScorerParameter) -> EvaluationResult:
    output = params["output"]
    length = len(str(output.get("echo", ""))) if isinstance(output, dict) else 0
    return EvaluationResult(
        value=length,
        explanation=f"Length is {length}",
        pass_=length >= 0,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestEvaluatorqTracingIntegration:
    """Verify evaluatorq() produces the correct trace spans end-to-end."""

    @pytest.mark.asyncio()
    async def test_run_creates_evaluation_run_span(self, tracing_env):
        """evaluatorq() should produce an orq.evaluation_run root span."""
        exporter = tracing_env

        await evaluatorq(
            "trace-test",
            data=[DataPoint(inputs={"text": "hello world"})],
            jobs=[simple_job],
            print_results=False,
        )

        span_names = [s.name for s in exporter.spans]
        assert "orq.evaluation_run" in span_names

    @pytest.mark.asyncio()
    async def test_run_span_attributes(self, tracing_env):
        """The run span should have correct metadata attributes."""
        exporter = tracing_env

        await evaluatorq(
            "attr-test",
            data=[
                DataPoint(inputs={"text": "one"}),
                DataPoint(inputs={"text": "two"}),
            ],
            jobs=[simple_job],
            evaluators=[{"name": "length", "scorer": length_scorer}],
            print_results=False,
        )

        run_span = next(s for s in exporter.spans if s.name == "orq.evaluation_run")
        assert run_span.attributes["orq.run_name"] == "attr-test"
        assert run_span.attributes["orq.data_points_count"] == 2
        assert run_span.attributes["orq.jobs_count"] == 1
        assert run_span.attributes["orq.evaluators_count"] == 1

    @pytest.mark.asyncio()
    async def test_job_spans_are_children_of_run_span(self, tracing_env):
        """All orq.job spans should be children of the orq.evaluation_run span."""
        exporter = tracing_env

        await evaluatorq(
            "hierarchy-test",
            data=[
                DataPoint(inputs={"text": "aaa"}),
                DataPoint(inputs={"text": "bbb"}),
                DataPoint(inputs={"text": "ccc"}),
            ],
            jobs=[simple_job],
            print_results=False,
        )

        run_span = next(s for s in exporter.spans if s.name == "orq.evaluation_run")
        job_spans = [s for s in exporter.spans if s.name == "orq.job"]

        assert len(job_spans) == 3
        for job_span in job_spans:
            assert job_span.parent is not None, "Job span should have a parent"
            assert job_span.parent.span_id == run_span.context.span_id
            assert job_span.context.trace_id == run_span.context.trace_id

    @pytest.mark.asyncio()
    async def test_evaluation_spans_are_children_of_job_spans(self, tracing_env):
        """orq.evaluation spans should be children of their orq.job span."""
        exporter = tracing_env

        await evaluatorq(
            "eval-hierarchy-test",
            data=[DataPoint(inputs={"text": "hello"})],
            jobs=[simple_job],
            evaluators=[{"name": "length", "scorer": length_scorer}],
            print_results=False,
        )

        run_span = next(s for s in exporter.spans if s.name == "orq.evaluation_run")
        job_span = next(s for s in exporter.spans if s.name == "orq.job")
        eval_span = next(s for s in exporter.spans if s.name == "orq.evaluation")

        # run is root
        assert run_span.parent is None

        # job -> run
        assert job_span.parent is not None
        assert job_span.parent.span_id == run_span.context.span_id

        # evaluation -> job
        assert eval_span.parent is not None
        assert eval_span.parent.span_id == job_span.context.span_id

        # All in the same trace
        assert run_span.context.trace_id == job_span.context.trace_id == eval_span.context.trace_id

    @pytest.mark.asyncio()
    async def test_full_hierarchy_with_parallelism(self, tracing_env):
        """Parallel execution still produces the correct parent-child hierarchy."""
        exporter = tracing_env

        await evaluatorq(
            "parallel-trace-test",
            data=[DataPoint(inputs={"text": f"item-{i}"}) for i in range(5)],
            jobs=[simple_job],
            evaluators=[{"name": "length", "scorer": length_scorer}],
            parallelism=5,
            print_results=False,
        )

        run_spans = [s for s in exporter.spans if s.name == "orq.evaluation_run"]
        job_spans = [s for s in exporter.spans if s.name == "orq.job"]
        eval_spans = [s for s in exporter.spans if s.name == "orq.evaluation"]

        assert len(run_spans) == 1
        assert len(job_spans) == 5
        assert len(eval_spans) == 5

        run_span = run_spans[0]
        trace_id = run_span.context.trace_id

        # Every job is a child of the run span, every eval is a child of a job
        for job_span in job_spans:
            assert job_span.parent.span_id == run_span.context.span_id
            assert job_span.context.trace_id == trace_id

        job_span_ids = {s.context.span_id for s in job_spans}
        for eval_span in eval_spans:
            assert eval_span.parent.span_id in job_span_ids
            assert eval_span.context.trace_id == trace_id

    @pytest.mark.asyncio()
    async def test_run_span_has_ok_status(self, tracing_env):
        """Successful evaluation should produce a run span with OK status."""
        from opentelemetry.trace import StatusCode

        exporter = tracing_env

        await evaluatorq(
            "status-test",
            data=[DataPoint(inputs={"text": "ok"})],
            jobs=[simple_job],
            print_results=False,
        )

        run_span = next(s for s in exporter.spans if s.name == "orq.evaluation_run")
        assert run_span.status.status_code == StatusCode.OK
