"""Tests for HTML export functionality."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from evaluatorq.redteam.contracts import (
    AgentInfo,
    AttackInfo,
    AttackTechnique,
    DeliveryMethod,
    Framework,
    Message,
    Pipeline,
    RedTeamReport,
    RedTeamResult,
    VulnerabilityDomain,
    Severity,
    TurnType,
    UnifiedEvaluationResult,
)
from evaluatorq.redteam.reports.converters import compute_report_summary


# ---------------------------------------------------------------------------
# Shared test fixtures (same pattern as test_export_md.py)
# ---------------------------------------------------------------------------


def _make_result(
    category: str = "ASI01",
    passed: bool | None = True,
    agent_key: str = "test-agent",
    technique: AttackTechnique = AttackTechnique.INDIRECT_INJECTION,
    severity: Severity = Severity.HIGH,
    framework: Framework = Framework.OWASP_ASI,
    prompt: str = "Attack prompt",
    response: str = "Agent response",
) -> RedTeamResult:
    return RedTeamResult(
        attack=AttackInfo(
            id=f"{category}-test-001",
            category=category,
            framework=framework,
            attack_technique=technique,
            delivery_methods=[DeliveryMethod.DIRECT_REQUEST],
            turn_type=TurnType.SINGLE,
            severity=severity,
            vulnerability_domain=VulnerabilityDomain.MODEL,
            source="test",
        ),
        agent=AgentInfo(key=agent_key),
        messages=[
            Message(role="user", content=prompt),
            Message(role="assistant", content=response),
        ],
        response=response,
        vulnerable=passed is False,
        evaluation=UnifiedEvaluationResult(
            passed=passed, explanation="test evaluation"
        )
        if passed is not None
        else None,
    )


def _make_report(
    results: list[RedTeamResult] | None = None,
    pipeline: Pipeline = Pipeline.DYNAMIC,
    framework: Framework | None = Framework.OWASP_ASI,
    categories: list[str] | None = None,
    agents: list[str] | None = None,
    target: str = "test-agent",
    created_at: datetime | None = None,
) -> RedTeamReport:
    results = results or []
    return RedTeamReport(
        created_at=created_at or datetime(2025, 1, 15, 10, 30, tzinfo=timezone.utc),
        pipeline=pipeline,
        framework=framework,
        categories_tested=categories or sorted({r.attack.category for r in results}) or ["ASI01"],
        tested_agents=agents or [target],
        total_results=len(results),
        results=results,
        summary=compute_report_summary(results),
    )


def _make_multi_category_report() -> RedTeamReport:
    results = [
        _make_result("ASI01", passed=False, severity=Severity.CRITICAL),
        _make_result("ASI01", passed=False, severity=Severity.HIGH),
        _make_result("ASI01", passed=True, severity=Severity.HIGH),
        _make_result("ASI02", passed=False, severity=Severity.MEDIUM),
        _make_result("ASI02", passed=True, severity=Severity.MEDIUM),
        _make_result("LLM01", passed=True, severity=Severity.LOW, framework=Framework.OWASP_LLM),
        _make_result("LLM01", passed=True, severity=Severity.LOW, framework=Framework.OWASP_LLM),
        _make_result("LLM01", passed=True, severity=Severity.LOW, framework=Framework.OWASP_LLM),
    ]
    return _make_report(results=results, categories=["ASI01", "ASI02", "LLM01"])


# ---------------------------------------------------------------------------
# Tests for export_html.py
# ---------------------------------------------------------------------------


class TestHTMLExport:
    """Tests for the HTML renderer."""

    def test_export_returns_non_empty_string(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert isinstance(html, str)
        assert len(html) > 0

    def test_export_is_valid_html_structure(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "<!DOCTYPE html>" in html
        assert "<html" in html
        assert "</html>" in html
        assert "<head>" in html
        assert "</head>" in html
        assert "<body>" in html
        assert "</body>" in html

    def test_export_contains_target(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(
            results=[_make_result()],
            agents=["my-target-agent"],
        )
        html = export_html(report)
        assert "my-target-agent" in html

    def test_export_contains_tables(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "<table>" in html
        assert "<th>" in html

    def test_export_contains_focus_areas(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "Focus Areas" in html

    def test_export_contains_inline_styles(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "<style>" in html

    def test_export_no_script_tags(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "<script" not in html

    def test_export_empty_report(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[])
        html = export_html(report)
        assert isinstance(html, str)
        assert len(html) > 0
        assert "<!DOCTYPE html>" in html

    def test_export_contains_category_names(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "ASI01" in html
        assert "ASI02" in html

    def test_export_contains_individual_results(self):
        """Individual results section is rendered in the HTML report."""
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[_make_result("ASI01", passed=False)])
        html = export_html(report)
        assert "Individual Attack Results" in html

    def test_export_badge_css_present_in_stylesheet(self):
        """Badge CSS classes are defined in the stylesheet even without individual results."""
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[_make_result("ASI01", passed=False)])
        html = export_html(report)
        assert "badge-vulnerable" in html
        assert "badge-resistant" in html

    def test_export_contains_vulnerability_breakdown(self):
        """Vulnerability breakdown table is present for reports with results."""
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[_make_result("ASI01", passed=False)])
        html = export_html(report)
        assert "Per-Vulnerability Breakdown" in html

    def test_export_contains_technique_breakdown(self):
        """Technique breakdown table is present for reports with results."""
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "Per-Technique Breakdown" in html

    def test_export_has_print_css(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "@media print" in html

    def test_export_contains_date(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(
            results=[_make_result()],
            created_at=datetime(2025, 6, 15, 12, 0, tzinfo=timezone.utc),
        )
        html = export_html(report)
        assert "2025" in html

    def test_export_contains_resistance_rate(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert re.search(r"\d+%", html) is not None

    def test_export_contains_severity_classes(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[_make_result("ASI01", passed=False, severity=Severity.CRITICAL)])
        html = export_html(report)
        assert "severity-critical" in html

    def test_export_mode_in_metadata(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[_make_result()], pipeline=Pipeline.DYNAMIC)
        html = export_html(report)
        assert "dynamic" in html.lower()

    def test_export_single_category(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(results=[_make_result("ASI01", passed=False)])
        html = export_html(report)
        assert "ASI01" in html

    def test_export_html_escapes_special_chars(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_report(
            results=[_make_result("ASI01", passed=False, prompt="<script>alert('xss')</script>")],
            agents=["agent<br>xss"],
        )
        html = export_html(report)
        assert "<script>alert" not in html
        assert "<br>xss" not in html
        assert "&lt;br&gt;" in html

    def test_export_focus_areas_include_remediation(self):
        from evaluatorq.redteam.reports.export_html import export_html
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        report = _make_multi_category_report()
        html = export_html(report)

        found_guidance = any(
            snippet[:40] in html
            for snippet in REMEDIATION_GUIDANCE.values()
        )
        assert found_guidance, "No remediation guidance found in HTML output"

    def test_export_footer(self):
        from evaluatorq.redteam.reports.export_html import export_html

        report = _make_multi_category_report()
        html = export_html(report)
        assert "evaluatorq red team suite" in html


# ---------------------------------------------------------------------------
# Tests for chart helpers
# ---------------------------------------------------------------------------


class TestChartHelpers:
    """Tests for chart rendering graceful degradation."""

    def test_charts_available_returns_bool(self):
        from evaluatorq.redteam.reports.export_html import _charts_available

        result = _charts_available()
        assert isinstance(result, bool)

    def test_donut_chart_empty_data(self):
        from evaluatorq.redteam.reports.export_html import _render_donut_chart

        result = _render_donut_chart({"total_attacks": 0})
        assert result == ""

    def test_severity_bar_chart_no_vulnerable(self):
        from evaluatorq.redteam.reports.export_html import _render_severity_bar_chart

        # Empty by_severity dict means no vulnerabilities to chart.
        result = _render_severity_bar_chart({})
        assert result == ""

    def test_severity_bar_chart_zero_found(self):
        from evaluatorq.redteam.reports.export_html import _render_severity_bar_chart

        # All severities present but none with vulnerabilities_found > 0.
        result = _render_severity_bar_chart({"low": {"vulnerabilities_found": 0, "total_attacks": 5}})
        assert result == ""

    def test_category_bar_chart_empty(self):
        from evaluatorq.redteam.reports.export_html import _render_category_bar_chart

        result = _render_category_bar_chart([])
        assert result == ""

    def test_technique_bar_chart_empty(self):
        from evaluatorq.redteam.reports.export_html import _render_technique_bar_chart

        result = _render_technique_bar_chart([])
        assert result == ""

    def test_vulnerability_bar_chart_empty(self):
        from evaluatorq.redteam.reports.export_html import _render_vulnerability_bar_chart

        result = _render_vulnerability_bar_chart([])
        assert result == ""


# ---------------------------------------------------------------------------
# Tests for CLI integration
# ---------------------------------------------------------------------------


class TestCLIExportHTML:
    """Tests for CLI --export-html integration."""

    def test_cli_run_has_export_html_option(self):
        from typer.testing import CliRunner

        from evaluatorq.redteam.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["run", "--help"])
        assert "--export-html" in result.output

    def test_generate_report_filename(self):
        from evaluatorq.redteam.cli import _generate_report_filename

        filename = _generate_report_filename(target="my-agent", timestamp="20250615_103000", ext=".html")
        assert filename == "redteam-report-my-agent-20250615_103000.html"

    def test_generate_report_filename_sanitizes(self):
        from evaluatorq.redteam.cli import _generate_report_filename

        filename = _generate_report_filename(target="agent:my/target", timestamp="20250615_103000", ext=".html")
        assert "/" not in filename
        assert ":" not in filename
        assert filename.endswith(".html")

    def test_write_html_report(self, tmp_path: Path):
        from evaluatorq.redteam.cli import write_html_report

        report = _make_multi_category_report()
        output_path = write_html_report(report, output_dir=tmp_path, target="test-agent")

        assert output_path.exists()
        assert output_path.suffix == ".html"
        content = output_path.read_text()
        assert "<!DOCTYPE html>" in content

    def test_write_html_report_creates_dir(self, tmp_path: Path):
        from evaluatorq.redteam.cli import write_html_report

        nested_dir = tmp_path / "reports" / "subdir"
        assert not nested_dir.exists()

        report = _make_multi_category_report()
        output_path = write_html_report(report, output_dir=nested_dir, target="test-agent")

        assert nested_dir.exists()
        assert output_path.exists()

    def test_write_html_report_filename_pattern(self, tmp_path: Path):
        from evaluatorq.redteam.cli import write_html_report

        report = _make_multi_category_report()
        output_path = write_html_report(report, output_dir=tmp_path, target="my-target")

        assert output_path.name.startswith("redteam-report-my-target-")
        assert output_path.name.endswith(".html")

