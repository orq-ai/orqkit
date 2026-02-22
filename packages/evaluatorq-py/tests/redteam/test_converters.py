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
    Framework,
    Pipeline,
    RedTeamReport,
    RedTeamResult,
    ReportSummary,
    Severity,
    TurnType,
    UnifiedEvaluationResult,
)
from evaluatorq.redteam.reports.converters import compute_report_summary, merge_reports


def _make_result(
    category: str = 'ASI01',
    passed: bool | None = True,
    agent_key: str = 'agent-a',
) -> RedTeamResult:
    """Helper to create a minimal RedTeamResult."""
    return RedTeamResult(
        attack=AttackInfo(
            id=f'{category}-test-001',
            category=category,
            framework=Framework.OWASP_ASI,
            attack_technique=AttackTechnique.INDIRECT_INJECTION,
            delivery_methods=[DeliveryMethod.DIRECT_REQUEST],
            turn_type=TurnType.SINGLE,
            severity=Severity.MEDIUM,
            source='test',
        ),
        agent=AgentInfo(key=agent_key),
        messages=[],
        vulnerable=passed is False,
        evaluation=UnifiedEvaluationResult(passed=passed, explanation='test') if passed is not None else None,
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

    def test_merge_resolves_pipeline_mixed(self):
        report_a = _make_report(pipeline=Pipeline.DYNAMIC)
        report_b = _make_report(pipeline=Pipeline.STATIC)

        merged = merge_reports(report_a, report_b)
        assert merged.pipeline == Pipeline.MIXED

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
