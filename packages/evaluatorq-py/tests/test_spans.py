"""Tests for tracing/spans."""
# pyright: reportUnannotatedClassAttribute=false, reportMissingParameterType=false, reportUnusedParameter=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnusedImport=false, reportUnknownLambdaType=false

import json
from typing import cast
from unittest.mock import MagicMock

import pytest
from opentelemetry.sdk.trace.export import SpanExporter

from evaluatorq.tracing.spans import (
    EvaluationRunSpanOptions,
    EvaluationSpanOptions,
    JobSpanOptions,
    set_evaluation_attributes,
    with_evaluation_run_span,
    with_evaluation_span,
    with_job_span,
)


@pytest.fixture()
def mock_span():
    """Create a mock span that tracks set_attribute calls."""
    attributes: dict[str, object] = {}
    span = MagicMock()

    def _set_attribute(key: str, value: object):
        attributes[key] = value

    span.set_attribute = MagicMock(side_effect=_set_attribute)
    span._attributes = attributes
    return span


class TestSetEvaluationAttributes:
    """Mirrors TS setEvaluationAttributes tests."""

    def test_sets_number_score_as_string(self, mock_span: MagicMock):
        set_evaluation_attributes(mock_span, 0.85, "good score", True)

        assert mock_span._attributes["orq.score"] == "0.85"
        assert mock_span._attributes["orq.explanation"] == "good score"
        assert mock_span._attributes["orq.pass"] is True

    def test_sets_boolean_score_as_string(self, mock_span: MagicMock):
        set_evaluation_attributes(mock_span, True)

        assert mock_span._attributes["orq.score"] == "True"

    def test_sets_string_score_directly(self, mock_span: MagicMock):
        set_evaluation_attributes(mock_span, "excellent")

        assert mock_span._attributes["orq.score"] == "excellent"

    def test_json_serializes_dict_score(self, mock_span: MagicMock):
        cell = {
            "type": "bert_score",
            "value": {"precision": 0.9, "recall": 0.8, "f1": 0.85},
        }
        set_evaluation_attributes(mock_span, cell)

        assert mock_span._attributes["orq.score"] == json.dumps(cell)

    def test_does_not_set_optional_attributes_when_none(self, mock_span: MagicMock):
        set_evaluation_attributes(mock_span, 1.0)

        assert mock_span.set_attribute.call_count == 1
        assert "orq.explanation" not in mock_span._attributes
        assert "orq.pass" not in mock_span._attributes

    def test_handles_none_span_gracefully(self):
        # Should not throw
        set_evaluation_attributes(None, 1.0, "test", True)


class _InMemoryExporter:
    """Simple in-memory span exporter for testing."""

    def __init__(self):
        self._spans = []

    def export(self, spans):
        self._spans.extend(spans)
        from opentelemetry.sdk.trace.export import SpanExportResult
        return SpanExportResult.SUCCESS

    def shutdown(self):
        pass

    def force_flush(self, timeout_millis=None):
        return True

    def get_finished_spans(self):
        return list(self._spans)


def _make_test_provider():
    """Create a TracerProvider with an in-memory exporter for tests."""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor

    exporter = _InMemoryExporter()
    provider = TracerProvider()
    provider.add_span_processor(
        SimpleSpanProcessor(cast(SpanExporter, cast(object, exporter)))
    )
    return provider, exporter


class TestWithEvaluationRunSpan:
    """Tests for with_evaluation_run_span context manager."""

    @pytest.mark.asyncio()
    async def test_creates_span_with_correct_name_and_attributes(self):
        """Verify span name is 'orq.evaluation_run' with expected attributes."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            options = EvaluationRunSpanOptions(
                run_id="run-123",
                run_name="my-eval",
                data_points_count=10,
                jobs_count=2,
                evaluators_count=3,
            )
            async with with_evaluation_run_span(options) as span:
                assert span is not None
        finally:
            spans_mod.get_tracer = original

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        run_span = spans[0]
        assert run_span.name == "orq.evaluation_run"
        assert run_span.attributes["orq.run_id"] == "run-123"
        assert run_span.attributes["orq.run_name"] == "my-eval"
        assert run_span.attributes["orq.data_points_count"] == 10
        assert run_span.attributes["orq.jobs_count"] == 2
        assert run_span.attributes["orq.evaluators_count"] == 3

    @pytest.mark.asyncio()
    async def test_job_span_is_child_of_run_span(self):
        """Verify job spans created inside become children of the run span."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            run_options = EvaluationRunSpanOptions(
                run_id="run-456",
                run_name="parent-test",
                data_points_count=1,
                jobs_count=1,
                evaluators_count=0,
            )
            async with with_evaluation_run_span(run_options):
                from opentelemetry import context as otel_context

                job_options = JobSpanOptions(
                    run_id="run-456",
                    row_index=0,
                    parent_context=otel_context.get_current(),
                )
                async with with_job_span(job_options):
                    pass
        finally:
            spans_mod.get_tracer = original

        spans = exporter.get_finished_spans()
        assert len(spans) == 2

        job_span = next(s for s in spans if s.name == "orq.job")
        run_span = next(s for s in spans if s.name == "orq.evaluation_run")

        # Job span's parent should be the run span
        assert job_span.parent is not None
        assert job_span.parent.span_id == run_span.context.span_id

    @pytest.mark.asyncio()
    async def test_yields_none_when_tracer_unavailable(self):
        """When tracing is not set up, yields None without error."""
        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: None
        try:
            options = EvaluationRunSpanOptions(
                run_id="run-789",
                run_name="no-trace",
                data_points_count=0,
                jobs_count=0,
                evaluators_count=0,
            )
            async with with_evaluation_run_span(options) as span:
                assert span is None
        finally:
            spans_mod.get_tracer = original

    @pytest.mark.asyncio()
    async def test_run_span_has_ok_status_on_success(self):
        """Run span should have OK status when body succeeds."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            options = EvaluationRunSpanOptions(
                run_id="run-ok",
                run_name="ok-run",
                data_points_count=1,
                jobs_count=1,
                evaluators_count=0,
            )
            async with with_evaluation_run_span(options):
                pass  # success
        finally:
            spans_mod.get_tracer = original

        from opentelemetry.trace import StatusCode

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].status.status_code == StatusCode.OK

    @pytest.mark.asyncio()
    async def test_run_span_has_error_status_on_exception(self):
        """Run span should record ERROR status and exception when body raises."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            options = EvaluationRunSpanOptions(
                run_id="run-err",
                run_name="error-run",
                data_points_count=0,
                jobs_count=0,
                evaluators_count=0,
            )
            with pytest.raises(ValueError, match="boom"):
                async with with_evaluation_run_span(options):
                    raise ValueError("boom")
        finally:
            spans_mod.get_tracer = original

        from opentelemetry.trace import StatusCode

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].status.status_code == StatusCode.ERROR
        assert "boom" in (spans[0].status.description or "")
        # Exception event should be recorded
        events = spans[0].events
        assert any(e.name == "exception" for e in events)

    @pytest.mark.asyncio()
    async def test_full_three_level_hierarchy(self):
        """Verify the complete span hierarchy: run -> job -> evaluation."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            run_opts = EvaluationRunSpanOptions(
                run_id="run-hierarchy",
                run_name="hierarchy-test",
                data_points_count=1,
                jobs_count=1,
                evaluators_count=1,
            )
            async with with_evaluation_run_span(run_opts):
                from opentelemetry import context as otel_context

                run_ctx = otel_context.get_current()

                job_opts = JobSpanOptions(
                    run_id="run-hierarchy",
                    row_index=0,
                    job_name="my-job",
                    parent_context=run_ctx,
                )
                async with with_job_span(job_opts):
                    eval_opts = EvaluationSpanOptions(
                        run_id="run-hierarchy",
                        evaluator_name="length-check",
                    )
                    async with with_evaluation_span(eval_opts):
                        pass  # evaluator body
        finally:
            spans_mod.get_tracer = original

        spans = exporter.get_finished_spans()
        assert len(spans) == 3

        run_span = next(s for s in spans if s.name == "orq.evaluation_run")
        job_span = next(s for s in spans if s.name == "orq.job")
        eval_span = next(s for s in spans if s.name == "orq.evaluation")

        # run is root (no parent)
        assert run_span.parent is None

        # job is child of run
        assert job_span.parent is not None
        assert job_span.parent.span_id == run_span.context.span_id

        # evaluation is child of job
        assert eval_span.parent is not None
        assert eval_span.parent.span_id == job_span.context.span_id

        # All share the same trace
        assert run_span.context.trace_id == job_span.context.trace_id
        assert job_span.context.trace_id == eval_span.context.trace_id

    @pytest.mark.asyncio()
    async def test_multiple_jobs_share_same_run_parent(self):
        """Multiple job spans inside a run span all share the same parent."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            run_opts = EvaluationRunSpanOptions(
                run_id="run-multi",
                run_name="multi-job-test",
                data_points_count=3,
                jobs_count=1,
                evaluators_count=0,
            )
            async with with_evaluation_run_span(run_opts):
                from opentelemetry import context as otel_context

                run_ctx = otel_context.get_current()

                for i in range(3):
                    job_opts = JobSpanOptions(
                        run_id="run-multi",
                        row_index=i,
                        parent_context=run_ctx,
                    )
                    async with with_job_span(job_opts):
                        pass
        finally:
            spans_mod.get_tracer = original

        spans = exporter.get_finished_spans()
        assert len(spans) == 4  # 1 run + 3 jobs

        run_span = next(s for s in spans if s.name == "orq.evaluation_run")
        job_spans = [s for s in spans if s.name == "orq.job"]
        assert len(job_spans) == 3

        for job_span in job_spans:
            assert job_span.parent is not None
            assert job_span.parent.span_id == run_span.context.span_id
            assert job_span.context.trace_id == run_span.context.trace_id

    @pytest.mark.asyncio()
    async def test_run_span_uses_provided_parent_context(self):
        """When parent_context is explicitly set, the run span uses it as parent."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        tracer = provider.get_tracer("test")
        spans_mod.get_tracer = lambda: tracer
        try:
            # Create an explicit parent span
            from opentelemetry import trace

            with tracer.start_as_current_span("external-parent") as _parent:
                from opentelemetry import context as otel_context

                parent_ctx = otel_context.get_current()

            # Now create the run span with that explicit parent context
            run_opts = EvaluationRunSpanOptions(
                run_id="run-with-parent",
                run_name="parent-provided",
                data_points_count=0,
                jobs_count=0,
                evaluators_count=0,
                parent_context=parent_ctx,
            )
            async with with_evaluation_run_span(run_opts):
                pass
        finally:
            spans_mod.get_tracer = original

        spans = exporter.get_finished_spans()
        external = next(s for s in spans if s.name == "external-parent")
        run_span = next(s for s in spans if s.name == "orq.evaluation_run")

        # Run span's parent should be the external span
        assert run_span.parent is not None
        assert run_span.parent.span_id == external.context.span_id
        assert run_span.context.trace_id == external.context.trace_id

    @pytest.mark.asyncio()
    async def test_span_attributes_have_correct_types(self):
        """Verify attribute types: run_id/run_name are strings, counts are ints."""
        provider, exporter = _make_test_provider()

        import evaluatorq.tracing.spans as spans_mod

        original = spans_mod.get_tracer
        spans_mod.get_tracer = lambda: provider.get_tracer("test")
        try:
            options = EvaluationRunSpanOptions(
                run_id="run-types",
                run_name="types-test",
                data_points_count=5,
                jobs_count=2,
                evaluators_count=3,
            )
            async with with_evaluation_run_span(options):
                pass
        finally:
            spans_mod.get_tracer = original

        spans = exporter.get_finished_spans()
        attrs = spans[0].attributes
        assert isinstance(attrs["orq.run_id"], str)
        assert isinstance(attrs["orq.run_name"], str)
        assert isinstance(attrs["orq.data_points_count"], int)
        assert isinstance(attrs["orq.jobs_count"], int)
        assert isinstance(attrs["orq.evaluators_count"], int)
