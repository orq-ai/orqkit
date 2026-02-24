"""Tests for report converters and merge_reports."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from evaluatorq.redteam.contracts import (
    AgentInfo,
    AttackInfo,
    AttackTechnique,
    CategorySummary,
    DeliveryMethod,
    ExecutionDetails,
    Framework,
    Pipeline,
    RedTeamReport,
    RedTeamResult,
    ReportSummary,
    Scope,
    Severity,
    TokenUsage,
    TurnType,
    UnifiedEvaluationResult,
)
from evaluatorq.redteam.reports.converters import compute_report_summary, merge_reports


def _make_result(
    category: str = 'ASI01',
    passed: bool | None = True,
    agent_key: str = 'agent-a',
    technique: AttackTechnique = AttackTechnique.INDIRECT_INJECTION,
    delivery_methods: list[DeliveryMethod] | None = None,
    turn_type: TurnType = TurnType.SINGLE,
    severity: Severity = Severity.MEDIUM,
    scope: Scope | None = None,
    framework: Framework = Framework.OWASP_ASI,
    execution: ExecutionDetails | None = None,
    error: str | None = None,
    error_type: str | None = None,
) -> RedTeamResult:
    """Helper to create a minimal RedTeamResult."""
    return RedTeamResult(
        attack=AttackInfo(
            id=f'{category}-test-001',
            category=category,
            framework=framework,
            attack_technique=technique,
            delivery_methods=delivery_methods or [DeliveryMethod.DIRECT_REQUEST],
            turn_type=turn_type,
            severity=severity,
            scope=scope,
            source='test',
        ),
        agent=AgentInfo(key=agent_key),
        messages=[],
        vulnerable=passed is False,
        evaluation=UnifiedEvaluationResult(passed=passed, explanation='test') if passed is not None else None,
        execution=execution,
        error=error,
        error_type=error_type,
    )


def _make_report(
    results: list[RedTeamResult] | None = None,
    pipeline: Pipeline = Pipeline.DYNAMIC,
    framework: Framework | None = Framework.OWASP_ASI,
    categories: list[str] | None = None,
    agents: list[str] | None = None,
    description: str | None = None,
) -> RedTeamReport:
    """Helper to create a minimal RedTeamReport."""
    results = results or []
    return RedTeamReport(
        created_at=datetime.now(tz=timezone.utc),
        description=description,
        pipeline=pipeline,
        framework=framework,
        categories_tested=categories or [],
        tested_agents=agents or [],
        total_results=len(results),
        results=results,
        summary=compute_report_summary(results),
    )


class TestMergeReports:
    """Tests for merge_reports()."""

    def test_merge_no_reports_raises(self):
        with pytest.raises(ValueError, match='at least one report'):
            merge_reports()

    def test_merge_single_report_returns_same(self):
        report = _make_report(description='only one')
        merged = merge_reports(report)
        assert merged is report

    def test_merge_combines_results(self):
        r1 = _make_result(category='ASI01', passed=True)
        r2 = _make_result(category='ASI02', passed=False)
        report_a = _make_report(results=[r1], categories=['ASI01'], agents=['agent-a'])
        report_b = _make_report(results=[r2], categories=['ASI02'], agents=['agent-b'])

        merged = merge_reports(report_a, report_b, description='merged')
        assert merged.total_results == 2
        assert len(merged.results) == 2
        assert set(merged.categories_tested) == {'ASI01', 'ASI02'}
        assert set(merged.tested_agents) == {'agent-a', 'agent-b'}
        assert merged.description == 'merged'

    def test_merge_recomputes_summary(self):
        r1 = _make_result(category='ASI01', passed=True)
        r2 = _make_result(category='ASI01', passed=False)
        report_a = _make_report(results=[r1], categories=['ASI01'])
        report_b = _make_report(results=[r2], categories=['ASI01'])

        merged = merge_reports(report_a, report_b)
        assert merged.summary.total_attacks == 2
        assert merged.summary.vulnerabilities_found == 1
        assert merged.summary.resistance_rate == 0.5

    def test_merge_resolves_pipeline_hybrid(self):
        report_a = _make_report(pipeline=Pipeline.DYNAMIC)
        report_b = _make_report(pipeline=Pipeline.STATIC)

        merged = merge_reports(report_a, report_b)
        assert merged.pipeline == Pipeline.HYBRID

    def test_merge_resolves_pipeline_same(self):
        report_a = _make_report(pipeline=Pipeline.DYNAMIC)
        report_b = _make_report(pipeline=Pipeline.DYNAMIC)

        merged = merge_reports(report_a, report_b)
        assert merged.pipeline == Pipeline.DYNAMIC

    def test_merge_resolves_framework_none_when_mixed(self):
        report_a = _make_report(framework=Framework.OWASP_ASI)
        report_b = _make_report(framework=Framework.OWASP_LLM)

        merged = merge_reports(report_a, report_b)
        assert merged.framework is None

    def test_merge_resolves_framework_same(self):
        report_a = _make_report(framework=Framework.OWASP_ASI)
        report_b = _make_report(framework=Framework.OWASP_ASI)

        merged = merge_reports(report_a, report_b)
        assert merged.framework == Framework.OWASP_ASI


class TestComputeReportSummary:
    """Tests for compute_report_summary() and all summary breakdowns."""

    def test_empty_results(self):
        summary = compute_report_summary([])
        assert summary.total_attacks == 0
        assert summary.vulnerability_rate == 0.0
        assert summary.average_turns_per_attack == 0.0

    def test_vulnerability_rate(self):
        results = [
            _make_result(passed=True),
            _make_result(passed=False),
            _make_result(passed=True),
            _make_result(passed=False),
        ]
        summary = compute_report_summary(results)
        assert summary.vulnerability_rate == 0.5
        assert summary.resistance_rate == 0.5

    def test_average_turns_per_attack(self):
        results = [
            _make_result(execution=ExecutionDetails(turns=3)),
            _make_result(execution=ExecutionDetails(turns=5)),
        ]
        summary = compute_report_summary(results)
        assert summary.average_turns_per_attack == 4.0
        assert summary.total_turns == 8

    def test_by_technique_full_summary(self):
        results = [
            _make_result(technique=AttackTechnique.INDIRECT_INJECTION, passed=True),
            _make_result(technique=AttackTechnique.INDIRECT_INJECTION, passed=False),
            _make_result(technique=AttackTechnique.DAN, passed=False),
        ]
        summary = compute_report_summary(results)
        assert 'indirect-injection' in summary.by_technique
        tech = summary.by_technique['indirect-injection']
        assert tech.total_attacks == 2
        assert tech.vulnerabilities_found == 1
        assert tech.resistance_rate == 0.5
        assert tech.vulnerability_rate == 0.5

        dan = summary.by_technique['DAN']
        assert dan.total_attacks == 1
        assert dan.vulnerability_rate == 1.0

    def test_by_severity(self):
        results = [
            _make_result(severity=Severity.CRITICAL, passed=False),
            _make_result(severity=Severity.CRITICAL, passed=True),
            _make_result(severity=Severity.LOW, passed=True),
        ]
        summary = compute_report_summary(results)
        assert 'critical' in summary.by_severity
        assert summary.by_severity['critical'].total_attacks == 2
        assert summary.by_severity['critical'].vulnerability_rate == 0.5
        assert summary.by_severity['low'].total_attacks == 1
        assert summary.by_severity['low'].vulnerability_rate == 0.0

    def test_by_delivery_method(self):
        results = [
            _make_result(delivery_methods=[DeliveryMethod.DAN, DeliveryMethod.ROLE_PLAY], passed=False),
            _make_result(delivery_methods=[DeliveryMethod.DAN], passed=True),
        ]
        summary = compute_report_summary(results)
        assert summary.by_delivery_method['DAN'].total_attacks == 2
        assert summary.by_delivery_method['DAN'].vulnerabilities_found == 1
        assert summary.by_delivery_method['role-play'].total_attacks == 1
        assert summary.by_delivery_method['role-play'].vulnerabilities_found == 1

    def test_by_turn_type(self):
        results = [
            _make_result(turn_type=TurnType.SINGLE, passed=True, execution=ExecutionDetails(turns=1)),
            _make_result(turn_type=TurnType.MULTI, passed=False, execution=ExecutionDetails(turns=4)),
            _make_result(turn_type=TurnType.MULTI, passed=True, execution=ExecutionDetails(turns=6)),
        ]
        summary = compute_report_summary(results)
        assert summary.by_turn_type['single'].total_attacks == 1
        assert summary.by_turn_type['single'].vulnerability_rate == 0.0
        assert summary.by_turn_type['multi'].total_attacks == 2
        assert summary.by_turn_type['multi'].vulnerability_rate == 0.5
        assert summary.by_turn_type['multi'].average_turns == 5.0

    def test_by_scope(self):
        results = [
            _make_result(scope=Scope.MODEL, passed=False),
            _make_result(scope=Scope.APPLICATION, passed=True),
            _make_result(passed=True),  # no scope
        ]
        summary = compute_report_summary(results)
        assert 'model' in summary.by_scope
        assert summary.by_scope['model'].vulnerability_rate == 1.0
        assert summary.by_scope['application'].vulnerability_rate == 0.0
        # No scope → not in by_scope
        assert len(summary.by_scope) == 2

    def test_by_framework(self):
        results = [
            _make_result(framework=Framework.OWASP_ASI, passed=False),
            _make_result(framework=Framework.OWASP_ASI, passed=True),
            _make_result(framework=Framework.OWASP_LLM, category='LLM01', passed=False),
        ]
        summary = compute_report_summary(results)
        assert summary.by_framework['OWASP-ASI'].total_attacks == 2
        assert summary.by_framework['OWASP-ASI'].vulnerability_rate == 0.5
        assert summary.by_framework['OWASP-LLM'].total_attacks == 1
        assert summary.by_framework['OWASP-LLM'].vulnerability_rate == 1.0

    def test_category_summary_parity_fields(self):
        results = [
            _make_result(category='ASI01', passed=True),
            _make_result(category='ASI01', passed=False),
            _make_result(category='ASI01', passed=None, error='timeout', error_type='timeout'),
        ]
        summary = compute_report_summary(results)
        cat = summary.by_category['ASI01']
        assert cat.evaluated_attacks == 2
        assert cat.unevaluated_attacks == 1
        assert cat.evaluation_coverage == pytest.approx(2 / 3)
        assert cat.total_errors == 1
        assert cat.vulnerability_rate == 0.5

    def test_token_usage_total_aggregation(self):
        results = [
            _make_result(
                execution=ExecutionDetails(
                    turns=1,
                    token_usage=TokenUsage(prompt_tokens=100, completion_tokens=50, total_tokens=150, calls=1),
                ),
            ),
            _make_result(
                execution=ExecutionDetails(
                    turns=1,
                    token_usage=TokenUsage(prompt_tokens=200, completion_tokens=80, total_tokens=280, calls=2),
                ),
            ),
        ]
        summary = compute_report_summary(results)
        assert summary.token_usage_total is not None
        assert summary.token_usage_total.prompt_tokens == 300
        assert summary.token_usage_total.completion_tokens == 130
        assert summary.token_usage_total.total_tokens == 430
        assert summary.token_usage_total.calls == 3

    def test_token_usage_total_none_when_no_usage(self):
        results = [_make_result(), _make_result()]
        summary = compute_report_summary(results)
        assert summary.token_usage_total is None
