"""Tests for markdown export functionality (RES-352).

TDD: tests are written before the implementation.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evaluatorq.redteam.contracts import (
    AgentInfo,
    AttackInfo,
    AttackTechnique,
    DeliveryMethod,
    Framework,
    Pipeline,
    RedTeamReport,
    RedTeamResult,
    Scope,
    Severity,
    TurnType,
    UnifiedEvaluationResult,
)
from evaluatorq.redteam.reports.converters import compute_report_summary


# ---------------------------------------------------------------------------
# Shared test fixtures
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
    """Helper to create a minimal RedTeamResult."""
    from evaluatorq.redteam.contracts import Message

    return RedTeamResult(
        attack=AttackInfo(
            id=f"{category}-test-001",
            category=category,
            framework=framework,
            attack_technique=technique,
            delivery_methods=[DeliveryMethod.DIRECT_REQUEST],
            turn_type=TurnType.SINGLE,
            severity=severity,
            scope=Scope.MODEL,
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
    """Helper to create a minimal RedTeamReport."""
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
    """Create a report with multiple categories and mixed vulnerability rates."""
    results = [
        # ASI01 - 3 attacks, 2 vulnerable (high vulnerability)
        _make_result("ASI01", passed=False, severity=Severity.CRITICAL),
        _make_result("ASI01", passed=False, severity=Severity.HIGH),
        _make_result("ASI01", passed=True, severity=Severity.HIGH),
        # ASI02 - 2 attacks, 1 vulnerable
        _make_result("ASI02", passed=False, severity=Severity.MEDIUM),
        _make_result("ASI02", passed=True, severity=Severity.MEDIUM),
        # LLM01 - 3 attacks, 0 vulnerable (good resistance)
        _make_result("LLM01", passed=True, severity=Severity.LOW, framework=Framework.OWASP_LLM),
        _make_result("LLM01", passed=True, severity=Severity.LOW, framework=Framework.OWASP_LLM),
        _make_result("LLM01", passed=True, severity=Severity.LOW, framework=Framework.OWASP_LLM),
    ]
    return _make_report(results=results, categories=["ASI01", "ASI02", "LLM01"])


# ---------------------------------------------------------------------------
# Tests for sections.py (data layer)
# ---------------------------------------------------------------------------


class TestReportSections:
    """Tests for the shared section data layer."""

    def test_build_sections_returns_sections_for_non_empty_report(self):
        """build_report_sections() returns a list of ReportSection objects."""
        from evaluatorq.redteam.reports.sections import ReportSection, build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)

        assert isinstance(sections, list)
        assert len(sections) > 0
        for section in sections:
            assert isinstance(section, ReportSection)
            assert section.title
            assert section.kind

    def test_summary_section_present(self):
        """A 'summary' section is always included."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        kinds = [s.kind for s in sections]
        assert "summary" in kinds

    def test_category_breakdown_section_present(self):
        """A 'category_breakdown' section is present when categories exist."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        kinds = [s.kind for s in sections]
        assert "category_breakdown" in kinds

    def test_technique_breakdown_section_present(self):
        """A 'technique_breakdown' section is present."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        kinds = [s.kind for s in sections]
        assert "technique_breakdown" in kinds

    def test_focus_areas_section_present(self):
        """A 'focus_areas' section is present when there are vulnerabilities."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        kinds = [s.kind for s in sections]
        assert "focus_areas" in kinds

    def test_individual_results_section_present(self):
        """An 'individual_results' section is present."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        kinds = [s.kind for s in sections]
        assert "individual_results" in kinds

    def test_focus_areas_limited_to_top_5(self):
        """Focus areas section contains at most 5 entries."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        focus_section = next(s for s in sections if s.kind == "focus_areas")
        assert len(focus_section.data["focus_areas"]) <= 5

    def test_focus_areas_risk_scoring(self):
        """Focus areas are ordered by risk_score = vulnerability_rate * severity_weight."""
        from evaluatorq.redteam.reports.sections import SEVERITY_WEIGHTS, build_report_sections

        # ASI01 has 2/3 vulnerable at CRITICAL (weight=8) → high risk
        # ASI02 has 1/2 vulnerable at MEDIUM (weight=2) → medium risk
        # LLM01 has 0/3 vulnerable → no risk
        report = _make_multi_category_report()
        sections = build_report_sections(report)
        focus_section = next(s for s in sections if s.kind == "focus_areas")
        focus_areas = focus_section.data["focus_areas"]

        assert len(focus_areas) > 0
        # First focus area should be the highest risk (ASI01)
        assert focus_areas[0]["category"] == "ASI01"
        # Scores should be in descending order
        scores = [fa["risk_score"] for fa in focus_areas]
        assert scores == sorted(scores, reverse=True)

    def test_severity_weights_defined(self):
        """SEVERITY_WEIGHTS dict has expected keys."""
        from evaluatorq.redteam.reports.sections import SEVERITY_WEIGHTS

        assert "low" in SEVERITY_WEIGHTS
        assert "medium" in SEVERITY_WEIGHTS
        assert "high" in SEVERITY_WEIGHTS
        assert "critical" in SEVERITY_WEIGHTS
        assert SEVERITY_WEIGHTS["low"] == 1
        assert SEVERITY_WEIGHTS["medium"] == 2
        assert SEVERITY_WEIGHTS["high"] == 4
        assert SEVERITY_WEIGHTS["critical"] == 8

    def test_empty_report_no_focus_areas(self):
        """An empty report produces no focus areas."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_report(results=[])
        sections = build_report_sections(report)
        focus_section = next((s for s in sections if s.kind == "focus_areas"), None)
        # Either no focus areas section or it has 0 focus areas
        if focus_section is not None:
            assert len(focus_section.data["focus_areas"]) == 0

    def test_section_data_contains_summary_stats(self):
        """Summary section contains expected stats keys."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        summary_section = next(s for s in sections if s.kind == "summary")

        data = summary_section.data
        assert "total_attacks" in data
        assert "vulnerabilities_found" in data
        assert "resistance_rate" in data

    def test_category_section_data_has_rows(self):
        """Category breakdown section data has rows for each category."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        cat_section = next(s for s in sections if s.kind == "category_breakdown")

        assert "rows" in cat_section.data
        rows = cat_section.data["rows"]
        assert len(rows) == 3  # ASI01, ASI02, LLM01
        categories = [r["category"] for r in rows]
        assert "ASI01" in categories
        assert "ASI02" in categories
        assert "LLM01" in categories

    def test_technique_section_data_has_rows(self):
        """Technique breakdown section data has rows for each technique."""
        from evaluatorq.redteam.reports.sections import build_report_sections

        report = _make_multi_category_report()
        sections = build_report_sections(report)
        tech_section = next(s for s in sections if s.kind == "technique_breakdown")

        assert "rows" in tech_section.data
        assert len(tech_section.data["rows"]) > 0


# ---------------------------------------------------------------------------
# Tests for guidance.py
# ---------------------------------------------------------------------------


class TestRemediationGuidance:
    """Tests for the shared remediation guidance module."""

    def test_guidance_importable_from_guidance_module(self):
        """REMEDIATION_GUIDANCE is importable from reports.guidance."""
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        assert isinstance(REMEDIATION_GUIDANCE, dict)
        assert len(REMEDIATION_GUIDANCE) > 0

    def test_guidance_has_asi_entries(self):
        """REMEDIATION_GUIDANCE has entries for ASI categories."""
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        assert "ASI01" in REMEDIATION_GUIDANCE
        assert "ASI02" in REMEDIATION_GUIDANCE

    def test_guidance_has_llm_entries(self):
        """REMEDIATION_GUIDANCE has entries for LLM categories."""
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        assert "LLM01" in REMEDIATION_GUIDANCE

    def test_guidance_values_are_strings(self):
        """All guidance values are non-empty strings."""
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        for key, value in REMEDIATION_GUIDANCE.items():
            assert isinstance(value, str), f"Expected string for {key}"
            assert len(value) > 0, f"Empty guidance for {key}"

    def test_guidance_module_is_canonical_source(self):
        """The guidance module is the canonical source of REMEDIATION_GUIDANCE."""
        # The dashboard imports from guidance.py — verify the module exists and
        # the dict is identical to what guidance.py provides.
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        # Spot-check a few well-known entries remain present
        assert "ASI01" in REMEDIATION_GUIDANCE
        assert "LLM01" in REMEDIATION_GUIDANCE
        assert len(REMEDIATION_GUIDANCE) >= 10


# ---------------------------------------------------------------------------
# Tests for export_md.py
# ---------------------------------------------------------------------------


class TestMarkdownExport:
    """Tests for the markdown renderer."""

    def test_export_returns_string(self):
        """export_markdown() returns a string."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        assert isinstance(md, str)
        assert len(md) > 0

    def test_export_has_header(self):
        """Exported markdown has a top-level header."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        assert md.startswith("#")

    def test_export_contains_target(self):
        """Exported markdown mentions the target agent."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(
            results=[_make_result()],
            agents=["my-target-agent"],
        )
        md = export_markdown(report)
        assert "my-target-agent" in md

    def test_export_contains_date(self):
        """Exported markdown contains the report creation date."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(
            results=[_make_result()],
            created_at=datetime(2025, 6, 15, 12, 0, tzinfo=timezone.utc),
        )
        md = export_markdown(report)
        assert "2025" in md

    def test_export_contains_resistance_rate(self):
        """Exported markdown contains resistance rate."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        # Resistance rate appears somewhere in the doc
        assert re.search(r"\d+%", md) is not None

    def test_export_has_executive_summary_table(self):
        """Exported markdown has an executive summary table."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        # Markdown table: header row with pipes
        assert "|" in md
        # Check for summary section header
        assert re.search(r"#{1,3}\s.*[Ss]ummary", md) is not None

    def test_export_has_focus_areas_section(self):
        """Exported markdown has a focus areas section."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        assert re.search(r"#{1,3}\s.*[Ff]ocus", md) is not None

    def test_export_has_category_breakdown(self):
        """Exported markdown has a per-category breakdown."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        assert re.search(r"#{1,3}\s.*[Cc]ategor", md) is not None
        assert "ASI01" in md
        assert "ASI02" in md

    def test_export_has_technique_breakdown(self):
        """Exported markdown has a per-technique breakdown."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        assert re.search(r"#{1,3}\s.*[Tt]echnique", md) is not None

    def test_export_has_individual_results(self):
        """Exported markdown has an individual results section."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(results=[_make_result("ASI01", passed=False)])
        md = export_markdown(report)
        assert re.search(r"#{1,3}\s.*[Rr]esult", md) is not None

    def test_export_uses_details_tags_for_prompts(self):
        """Prompt/response content is wrapped in <details> tags."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(
            results=[
                _make_result("ASI01", passed=False, prompt="My attack prompt", response="My response")
            ]
        )
        md = export_markdown(report)
        assert "<details>" in md
        assert "</details>" in md

    def test_export_focus_areas_include_remediation(self):
        """Focus areas in markdown include remediation guidance text."""
        from evaluatorq.redteam.reports.export_md import export_markdown
        from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

        report = _make_multi_category_report()
        md = export_markdown(report)

        # At least one known remediation snippet should appear in the markdown
        found_guidance = any(
            snippet[:40] in md
            for snippet in REMEDIATION_GUIDANCE.values()
        )
        assert found_guidance, "No remediation guidance found in markdown output"

    def test_export_empty_report(self):
        """export_markdown() handles an empty report gracefully."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(results=[])
        md = export_markdown(report)
        assert isinstance(md, str)
        assert len(md) > 0

    def test_export_single_category(self):
        """export_markdown() handles a single-category report."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(results=[_make_result("ASI01", passed=False)])
        md = export_markdown(report)
        assert "ASI01" in md

    def test_export_no_images_or_html_charts(self):
        """Markdown output contains no image tags or chart HTML."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        # No img tags (charts), no embedded SVG
        assert "<img" not in md
        assert "<svg" not in md
        # Details/summary tags are allowed for collapsible blocks
        assert "<canvas" not in md

    def test_export_mode_in_metadata(self):
        """Pipeline mode appears in the exported markdown metadata."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_report(
            results=[_make_result()],
            pipeline=Pipeline.DYNAMIC,
        )
        md = export_markdown(report)
        assert "dynamic" in md.lower()


# ---------------------------------------------------------------------------
# Tests for CLI --export-md option
# ---------------------------------------------------------------------------


class TestCLIExportMd:
    """Tests for CLI --export-md integration."""

    def test_cli_run_has_export_md_option(self):
        """The 'run' CLI command accepts --export-md."""
        from typer.testing import CliRunner

        from evaluatorq.redteam.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["run", "--help"])
        assert "--export-md" in result.output

    def test_generate_filename(self):
        """_generate_md_filename() produces a correctly structured filename."""
        from evaluatorq.redteam.cli import _generate_md_filename

        filename = _generate_md_filename(target="my-agent", timestamp="20250615_103000")
        assert filename == "redteam-report-my-agent-20250615_103000.md"

    def test_generate_filename_sanitizes_special_chars(self):
        """_generate_md_filename() sanitizes special characters in target name."""
        from evaluatorq.redteam.cli import _generate_md_filename

        filename = _generate_md_filename(target="agent:my/target", timestamp="20250615_103000")
        # Special chars should be replaced or removed
        assert "/" not in filename
        assert ":" not in filename
        assert filename.endswith(".md")

    def test_write_markdown_report(self, tmp_path: Path):
        """write_markdown_report() writes a file to the given directory."""
        from evaluatorq.redteam.cli import write_markdown_report

        report = _make_multi_category_report()
        output_path = write_markdown_report(report, output_dir=tmp_path, target="test-agent")

        assert output_path.exists()
        assert output_path.suffix == ".md"
        content = output_path.read_text()
        assert len(content) > 0

    def test_write_markdown_report_creates_dir(self, tmp_path: Path):
        """write_markdown_report() creates the output directory if it doesn't exist."""
        from evaluatorq.redteam.cli import write_markdown_report

        nested_dir = tmp_path / "reports" / "subdir"
        assert not nested_dir.exists()

        report = _make_multi_category_report()
        output_path = write_markdown_report(report, output_dir=nested_dir, target="test-agent")

        assert nested_dir.exists()
        assert output_path.exists()

    def test_write_markdown_report_filename_pattern(self, tmp_path: Path):
        """Generated filename matches expected pattern."""
        from evaluatorq.redteam.cli import write_markdown_report

        report = _make_multi_category_report()
        output_path = write_markdown_report(report, output_dir=tmp_path, target="my-target")

        assert output_path.name.startswith("redteam-report-my-target-")
        assert output_path.name.endswith(".md")


# ---------------------------------------------------------------------------
# Tests for dashboard integration
# ---------------------------------------------------------------------------


class TestDashboardIntegration:
    """Tests for the Streamlit dashboard markdown download button."""

    def test_export_markdown_callable_from_dashboard_import(self):
        """export_markdown is importable and callable without dashboard-specific deps."""
        from evaluatorq.redteam.reports.export_md import export_markdown

        report = _make_multi_category_report()
        md = export_markdown(report)
        assert isinstance(md, str)
