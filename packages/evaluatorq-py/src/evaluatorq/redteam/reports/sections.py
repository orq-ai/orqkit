"""Renderer-agnostic section data layer for red team reports.

``build_report_sections()`` converts a ``RedTeamReport`` into a list of
``ReportSection`` objects that can be consumed by any renderer (Markdown, HTML,
PDF, …).  Format-specific renderers should NOT query the report directly; they
should consume the sections produced here.

Section kinds:
    - ``summary``                 — aggregate statistics
    - ``focus_areas``             — top-5 highest-risk categories
    - ``vulnerability_breakdown`` — per-vulnerability table rows (primary)
    - ``category_breakdown``      — per-category table rows (secondary)
    - ``technique_breakdown``     — per-technique table rows
    - ``individual_results``      — one entry per ``RedTeamResult``
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from evaluatorq.redteam.contracts import OWASP_CATEGORY_NAMES, SEVERITY_DEFINITIONS, RedTeamReport, RedTeamResult
from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE

# ---------------------------------------------------------------------------
# Risk scoring weights
# ---------------------------------------------------------------------------

SEVERITY_WEIGHTS: dict[str, int] = {
    "low": 1,
    "medium": 2,
    "high": 4,
    "critical": 8,
}


# ---------------------------------------------------------------------------
# Section data model
# ---------------------------------------------------------------------------


@dataclass
class ReportSection:
    """Renderer-agnostic section of a report.

    Attributes:
        kind:  Machine-readable section identifier (e.g. ``"summary"``).
        title: Human-readable section title.
        data:  Free-form dict of section data consumed by renderers.
    """

    kind: str
    title: str
    data: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _compute_risk_score(vulnerability_rate: float, results: list[RedTeamResult]) -> float:
    """Compute ``risk_score = vulnerability_rate * average_severity_weight``.

    The severity weight is averaged over *vulnerable* results to reflect the
    actual impact of confirmed vulnerabilities.  If there are no vulnerable
    results the score is 0.
    """
    vulnerable = [r for r in results if r.vulnerable]
    if not vulnerable:
        return 0.0
    avg_weight = sum(SEVERITY_WEIGHTS.get(r.attack.severity.value, 1) for r in vulnerable) / len(vulnerable)
    return vulnerability_rate * avg_weight


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------


def _build_summary_section(report: RedTeamReport) -> ReportSection:
    s = report.summary
    targets = sorted(set(report.tested_agents)) if report.tested_agents else ["unknown"]
    return ReportSection(
        kind="summary",
        title="Executive Summary",
        data={
            "target": ", ".join(targets),
            "pipeline": report.pipeline.value,
            "created_at": report.created_at,
            "total_attacks": s.total_attacks,
            "evaluated_attacks": s.evaluated_attacks,
            "vulnerabilities_found": s.vulnerabilities_found,
            "vulnerability_rate": s.vulnerability_rate,
            "resistance_rate": s.resistance_rate,
            "evaluation_coverage": s.evaluation_coverage,
            "total_errors": s.total_errors,
            "duration_seconds": report.duration_seconds,
        },
    )


def _build_focus_areas_section(report: RedTeamReport) -> ReportSection:
    """Build the top-5 highest-risk focus areas section."""
    results_by_category: dict[str, list[RedTeamResult]] = {}
    for r in report.results:
        results_by_category.setdefault(r.attack.category, []).append(r)

    # Build a lookup from vulnerability -> VulnerabilitySummary for enrichment
    vuln_by_category: dict[str, str] = {}
    for vuln_id, vuln_summary in report.summary.by_vulnerability.items():
        for _framework, cat_codes in vuln_summary.framework_categories.items():
            for cat_code in cat_codes:
                vuln_by_category.setdefault(cat_code, vuln_id)

    # Build a lookup from category -> recommendation (when available)
    rec_lookup: dict[str, Any] = {}
    if report.focus_area_recommendations:
        for rec in report.focus_area_recommendations:
            rec_lookup[rec.category] = {
                "recommendations": rec.recommendations,
                "patterns_observed": rec.patterns_observed,
                "traces_analyzed": rec.traces_analyzed,
            }

    focus_areas: list[dict[str, Any]] = []
    for cat_code, cat_summary in report.summary.by_category.items():
        if cat_summary.vulnerabilities_found == 0:
            continue
        cat_results = results_by_category.get(cat_code, [])
        risk_score = _compute_risk_score(cat_summary.vulnerability_rate, cat_results)
        vuln_id = vuln_by_category.get(cat_code, "")
        vuln_summary = report.summary.by_vulnerability.get(vuln_id)
        area: dict[str, Any] = {
            "category": cat_code,
            "category_name": OWASP_CATEGORY_NAMES.get(cat_code, cat_code),
            "vulnerability": vuln_id,
            "vulnerability_name": vuln_summary.vulnerability_name if vuln_summary else "",
            "vulnerabilities_found": cat_summary.vulnerabilities_found,
            "vulnerability_rate": cat_summary.vulnerability_rate,
            "risk_score": risk_score,
            "remediation": REMEDIATION_GUIDANCE.get(cat_code, ""),
        }
        # Attach LLM-generated recommendations when available
        if cat_code in rec_lookup:
            area["llm_recommendations"] = rec_lookup[cat_code]
        focus_areas.append(area)

    # Sort by risk score descending, limit to top 5
    focus_areas.sort(key=lambda x: x["risk_score"], reverse=True)
    top_areas = focus_areas[:5]

    return ReportSection(
        kind="focus_areas",
        title="Focus Areas (Top Risks)",
        data={"focus_areas": top_areas},
    )


def _build_vulnerability_breakdown_section(report: RedTeamReport) -> ReportSection:
    """Build per-vulnerability breakdown rows sorted by vulnerability rate (worst first)."""
    rows: list[dict[str, Any]] = []
    for vuln_id, vuln_summary in report.summary.by_vulnerability.items():
        total = vuln_summary.total_attacks
        found = vuln_summary.vulnerabilities_found
        vulnerability_rate = found / total if total > 0 else 0.0
        rows.append(
            {
                "vulnerability": vuln_id,
                "vulnerability_name": vuln_summary.vulnerability_name,
                "domain": vuln_summary.domain,
                "total_attacks": total,
                "vulnerabilities_found": found,
                "vulnerability_rate": vulnerability_rate,
                "resistance_rate": vuln_summary.resistance_rate,
            }
        )
    # Worst first (highest vulnerability rate)
    rows.sort(key=lambda r: r["vulnerability_rate"], reverse=True)
    return ReportSection(
        kind="vulnerability_breakdown",
        title="Per-Vulnerability Breakdown",
        data={"rows": rows},
    )


def _build_category_breakdown_section(report: RedTeamReport) -> ReportSection:
    """Build per-category breakdown rows sorted by vulnerability rate (worst first)."""
    rows: list[dict[str, Any]] = []
    for cat_code, cat_summary in report.summary.by_category.items():
        rows.append(
            {
                "category": cat_code,
                "category_name": OWASP_CATEGORY_NAMES.get(cat_code, cat_code),
                "total_attacks": cat_summary.total_attacks,
                "vulnerabilities_found": cat_summary.vulnerabilities_found,
                "vulnerability_rate": cat_summary.vulnerability_rate,
                "resistance_rate": cat_summary.resistance_rate,
            }
        )
    # Worst first (highest vulnerability rate)
    rows.sort(key=lambda r: r["vulnerability_rate"], reverse=True)
    return ReportSection(
        kind="category_breakdown",
        title="Per-Category Breakdown",
        data={"rows": rows},
    )


def _build_technique_breakdown_section(report: RedTeamReport) -> ReportSection:
    """Build per-technique breakdown rows sorted by vulnerability rate (worst first)."""
    rows: list[dict[str, Any]] = []
    for technique, tech_summary in report.summary.by_technique.items():
        rows.append(
            {
                "technique": technique,
                "total_attacks": tech_summary.total_attacks,
                "vulnerabilities_found": tech_summary.vulnerabilities_found,
                "vulnerability_rate": tech_summary.vulnerability_rate,
                "resistance_rate": tech_summary.resistance_rate,
            }
        )
    rows.sort(key=lambda r: r["vulnerability_rate"], reverse=True)
    return ReportSection(
        kind="technique_breakdown",
        title="Per-Technique Breakdown",
        data={"rows": rows},
    )


def _extract_prompt(result: RedTeamResult) -> str:
    """Extract the first user message content as the attack prompt."""
    for msg in result.messages:
        if msg.role == "user" and msg.content:
            return msg.content
    return ""


def _extract_response(result: RedTeamResult) -> str:
    """Extract the agent's response text."""
    if result.response:
        return result.response
    # Fall back to last assistant message
    for msg in reversed(result.messages):
        if msg.role == "assistant" and msg.content:
            return msg.content
    return ""


def _build_individual_results_section(report: RedTeamReport) -> ReportSection:
    """Build individual attack result entries."""
    entries: list[dict[str, Any]] = []
    for result in report.results:
        entries.append(
            {
                "id": result.attack.id,
                "vulnerability": result.attack.vulnerability,
                "category": result.attack.category,
                "category_name": OWASP_CATEGORY_NAMES.get(result.attack.category, result.attack.category),
                "technique": result.attack.attack_technique.value,
                "severity": result.attack.severity.value,
                "vulnerable": result.vulnerable,
                "prompt": _extract_prompt(result),
                "response": _extract_response(result),
                "explanation": result.evaluation.explanation if result.evaluation else "",
                "error": result.error,
            }
        )
    return ReportSection(
        kind="individual_results",
        title="Individual Attack Results",
        data={"entries": entries},
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _build_severity_definitions_section() -> ReportSection:
    """Build the severity level definitions section."""
    return ReportSection(
        kind="severity_definitions",
        title="Severity Levels",
        data={
            "definitions": [
                {"level": level, "description": description}
                for level, description in SEVERITY_DEFINITIONS.items()
            ],
            "weights": dict(SEVERITY_WEIGHTS),
        },
    )


def build_report_sections(report: RedTeamReport) -> list[ReportSection]:
    """Convert a ``RedTeamReport`` into renderer-agnostic ``ReportSection`` objects.

    Returns sections in document order:
        1. summary
        2. severity_definitions
        3. focus_areas
        4. vulnerability_breakdown  (primary breakdown)
        5. category_breakdown       (secondary breakdown)
        6. technique_breakdown
        7. individual_results
    """
    sections: list[ReportSection] = [
        _build_summary_section(report),
        _build_severity_definitions_section(),
        _build_focus_areas_section(report),
        _build_vulnerability_breakdown_section(report),
        _build_category_breakdown_section(report),
        _build_technique_breakdown_section(report),
        _build_individual_results_section(report),
    ]
    return sections
