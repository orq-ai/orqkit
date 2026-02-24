"""Tests for the red team report Rich display."""

from datetime import datetime, timezone

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
from evaluatorq.redteam.reports.display import (
    _format_category_label,
    print_report_summary,
)


def _make_result(category: str, passed: bool | None, error: str | None = None) -> RedTeamResult:
    return RedTeamResult(
        attack=AttackInfo(
            id=f"{category}-test",
            category=category,
            framework=Framework.OWASP_AGENTIC,
            attack_technique=AttackTechnique.DIRECT_INJECTION,
            delivery_methods=[DeliveryMethod.DIRECT_REQUEST],
            turn_type=TurnType.SINGLE,
            severity=Severity.MEDIUM,
            source="test",
        ),
        agent=AgentInfo(key="test-agent"),
        messages=[],
        response="test response",
        evaluation=UnifiedEvaluationResult(
            passed=passed,
            explanation="test",
            evaluator_id=category,
        ),
        vulnerable=passed is False,
        error=error,
        error_type="runtime" if error else None,
    )


def _make_report(
    results: list[RedTeamResult] | None = None,
    duration: float | None = 42.5,
) -> RedTeamReport:
    if results is None:
        results = [
            _make_result("ASI01", passed=False),
            _make_result("ASI01", passed=True),
            _make_result("ASI03", passed=True),
            _make_result("ASI03", passed=True),
            _make_result("ASI03", passed=None, error="timeout"),
        ]

    by_cat: dict[str, CategorySummary] = {}
    by_technique: dict[str, int] = {}
    errors_by_type: dict[str, int] = {}
    total_errors = 0

    for r in results:
        cat = r.attack.category
        if cat not in by_cat:
            by_cat[cat] = CategorySummary(
                category=cat,
                category_name=cat,
                total_attacks=0,
                vulnerabilities_found=0,
                resistance_rate=1.0,
            )
        by_cat[cat].total_attacks += 1
        if r.vulnerable:
            by_cat[cat].vulnerabilities_found += 1
            tech = r.attack.attack_technique
            by_technique[tech] = by_technique.get(tech, 0) + 1
        if r.error:
            total_errors += 1
            etype = r.error_type or "unknown"
            errors_by_type[etype] = errors_by_type.get(etype, 0) + 1

    for cs in by_cat.values():
        evaluated = cs.total_attacks - sum(
            1 for r in results if r.attack.category == cs.category and (r.evaluation is None or r.evaluation.passed is None)
        )
        resistant = evaluated - cs.vulnerabilities_found
        cs.resistance_rate = resistant / evaluated if evaluated > 0 else 1.0

    evaluated = [r for r in results if r.evaluation and isinstance(r.evaluation.passed, bool)]
    vulns = sum(1 for r in evaluated if r.evaluation and r.evaluation.passed is False)

    summary = ReportSummary(
        total_attacks=len(results),
        evaluated_attacks=len(evaluated),
        unevaluated_attacks=len(results) - len(evaluated),
        evaluation_coverage=len(evaluated) / len(results) if results else 0.0,
        vulnerabilities_found=vulns,
        resistance_rate=(len(evaluated) - vulns) / len(evaluated) if evaluated else 1.0,
        total_errors=total_errors,
        errors_by_type=errors_by_type,
        by_category=by_cat,
        by_technique=by_technique,
    )

    return RedTeamReport(
        created_at=datetime.now(tz=timezone.utc),
        description="Test report",
        pipeline=Pipeline.DYNAMIC,
        framework=Framework.OWASP_AGENTIC,
        categories_tested=sorted(by_cat.keys()),
        total_results=len(results),
        results=results,
        summary=summary,
        duration_seconds=duration,
    )


class TestFormatCategoryLabel:
    def test_known_category(self) -> None:
        label = _format_category_label("ASI01")
        assert label.startswith("ASI01 - ")
        assert len(label) > len("ASI01 - ")

    def test_unknown_category(self) -> None:
        assert _format_category_label("UNKNOWN99") == "UNKNOWN99"


class TestPrintReportSummary:
    def test_does_not_raise(self) -> None:
        report = _make_report()
        print_report_summary(report)

    def test_empty_report(self) -> None:
        report = _make_report(results=[], duration=0.0)
        print_report_summary(report)

    def test_no_duration(self) -> None:
        report = _make_report(duration=None)
        print_report_summary(report)

    def test_all_resistant(self) -> None:
        results = [_make_result("ASI01", passed=True) for _ in range(3)]
        report = _make_report(results=results)
        print_report_summary(report)

    def test_all_vulnerable(self) -> None:
        results = [_make_result("ASI01", passed=False) for _ in range(3)]
        report = _make_report(results=results)
        print_report_summary(report)
