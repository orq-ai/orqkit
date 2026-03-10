"""Markdown renderer for red team reports.

``export_markdown(report)`` converts a ``RedTeamReport`` to a plain-text
Markdown string suitable for sharing in pull requests, wikis, or any text
editor.  Output is text-only — no images, no embedded HTML charts.

Collapsible prompt/response blocks use standard ``<details>``/``<summary>``
HTML tags that GitHub-Flavored Markdown and most modern renderers support.
"""

from __future__ import annotations

import textwrap
from typing import Any

from evaluatorq.redteam.contracts import RedTeamReport
from evaluatorq.redteam.reports.sections import ReportSection, build_report_sections


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _pct(rate: float) -> str:
    """Format a float rate as a percentage string, e.g. ``0.75`` → ``'75%'``."""
    return f"{rate:.0%}"


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    """Render a Markdown table from headers and string rows.

    All values are coerced to strings.
    """
    lines: list[str] = []
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        sanitized = [str(cell).replace("|", "\\|").replace("\n", " ") for cell in row]
        lines.append("| " + " | ".join(sanitized) + " |")
    return "\n".join(lines)


def _truncate(text: str, max_chars: int = 800) -> str:
    """Truncate long text with an ellipsis indicator."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n*[truncated — full text in report JSON]*"


def _details_block(summary: str, body: str) -> str:
    """Wrap content in a collapsible ``<details>`` block."""
    inner = textwrap.indent(body.strip(), "  ")
    return f"<details>\n<summary>{summary}</summary>\n\n{inner}\n\n</details>"


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------


def _render_header(data: dict[str, Any]) -> str:
    """Render the document header with run metadata."""
    target = data.get("target", "unknown")
    pipeline = data.get("pipeline", "unknown")
    created_at = data.get("created_at")
    resistance_rate = data.get("resistance_rate", 0.0)

    date_str = created_at.strftime("%Y-%m-%d %H:%M UTC") if created_at else "unknown"
    lines = [
        "# Red Team Security Report",
        "",
        f"**Target:** {target}  ",
        f"**Mode:** {pipeline}  ",
        f"**Date:** {date_str}  ",
        f"**Resistance Rate:** {_pct(resistance_rate)}  ",
    ]
    return "\n".join(lines)


def _render_summary_section(section: ReportSection) -> str:
    """Render the executive summary table."""
    data = section.data
    rows = [
        ["Total Attacks", str(data.get("total_attacks", 0))],
        ["Evaluated", str(data.get("evaluated_attacks", 0))],
        ["Vulnerabilities Found", str(data.get("vulnerabilities_found", 0))],
        ["Vulnerability Rate", _pct(data.get("vulnerability_rate", 0.0))],
        ["Resistance Rate", _pct(data.get("resistance_rate", 1.0))],
        ["Evaluation Coverage", _pct(data.get("evaluation_coverage", 0.0))],
    ]
    if data.get("total_errors"):
        rows.append(["Errors", str(data["total_errors"])])
    if data.get("duration_seconds") is not None:
        mins, secs = divmod(int(data["duration_seconds"]), 60)
        rows.append(["Duration", f"{mins}m {secs}s"])

    table = _md_table(["Metric", "Value"], rows)
    return f"## {section.title}\n\n{table}"


def _render_focus_areas_section(section: ReportSection) -> str:
    """Render the focus areas (top risks) section with remediation guidance."""
    focus_areas = section.data.get("focus_areas", [])
    if not focus_areas:
        return f"## {section.title}\n\nNo significant risk areas identified."

    lines = [f"## {section.title}", ""]
    for i, area in enumerate(focus_areas, start=1):
        cat = area["category"]
        cat_name = area.get("category_name", cat)
        vuln = area.get("vulnerabilities_found", 0)
        vuln_rate = _pct(area.get("vulnerability_rate", 0.0))
        risk_score = area.get("risk_score", 0.0)
        remediation = area.get("remediation", "")

        lines.append(f"### {i}. {cat} — {cat_name}")
        lines.append("")
        lines.append(
            f"- **Vulnerabilities:** {vuln} ({vuln_rate} of attacks succeeded)"
        )
        lines.append(f"- **Risk Score:** {risk_score:.2f}")
        lines.append("")
        if remediation:
            lines.append("**Remediation guidance:**")
            lines.append("")
            lines.append(f"> {remediation}")
            lines.append("")

    return "\n".join(lines)


def _render_category_breakdown_section(section: ReportSection) -> str:
    """Render the per-category breakdown table."""
    rows = section.data.get("rows", [])
    if not rows:
        return f"## {section.title}\n\nNo category data available."

    table_rows = [
        [
            f"{r['category']} — {r['category_name']}",
            str(r["total_attacks"]),
            str(r["vulnerabilities_found"]),
            _pct(r["vulnerability_rate"]),
            _pct(r["resistance_rate"]),
        ]
        for r in rows
    ]
    table = _md_table(
        ["Category", "Attacks", "Vulnerabilities", "Vuln Rate", "Resistance"],
        table_rows,
    )
    return f"## {section.title}\n\n{table}"


def _render_technique_breakdown_section(section: ReportSection) -> str:
    """Render the per-technique breakdown table."""
    rows = section.data.get("rows", [])
    if not rows:
        return f"## {section.title}\n\nNo technique data available."

    table_rows = [
        [
            r["technique"],
            str(r["total_attacks"]),
            str(r["vulnerabilities_found"]),
            _pct(r["vulnerability_rate"]),
            _pct(r["resistance_rate"]),
        ]
        for r in rows
    ]
    table = _md_table(
        ["Technique", "Attacks", "Vulnerabilities", "Vuln Rate", "Resistance"],
        table_rows,
    )
    return f"## {section.title}\n\n{table}"


def _render_individual_results_section(section: ReportSection) -> str:
    """Render individual attack results with collapsible prompt/response blocks."""
    entries = section.data.get("entries", [])
    if not entries:
        return f"## {section.title}\n\nNo individual results available."

    lines = [f"## {section.title}", ""]
    for entry in entries:
        status = "VULNERABLE" if entry["vulnerable"] else "RESISTANT"
        attack_id = entry.get("id", "unknown")
        cat = entry.get("category", "")
        cat_name = entry.get("category_name", cat)
        technique = entry.get("technique", "")
        severity = entry.get("severity", "")
        explanation = entry.get("explanation", "")
        prompt_text = entry.get("prompt", "")
        response_text = entry.get("response", "")
        error = entry.get("error")

        lines.append(f"### [{status}] {attack_id}")
        lines.append("")
        lines.append(f"- **Category:** {cat} — {cat_name}")
        lines.append(f"- **Technique:** {technique}")
        lines.append(f"- **Severity:** {severity}")
        if explanation:
            lines.append(f"- **Evaluation:** {explanation}")
        if error:
            lines.append(f"- **Error:** {error}")
        lines.append("")

        if prompt_text:
            prompt_block = _details_block(
                "Attack Prompt",
                f"```\n{_truncate(prompt_text)}\n```",
            )
            lines.append(prompt_block)
            lines.append("")

        if response_text:
            response_block = _details_block(
                "Agent Response",
                f"```\n{_truncate(response_text)}\n```",
            )
            lines.append(response_block)
            lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Section dispatch
# ---------------------------------------------------------------------------

_SECTION_RENDERERS = {
    "summary": _render_summary_section,
    "focus_areas": _render_focus_areas_section,
    "category_breakdown": _render_category_breakdown_section,
    "technique_breakdown": _render_technique_breakdown_section,
    "individual_results": _render_individual_results_section,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def export_markdown(report: RedTeamReport) -> str:
    """Convert a ``RedTeamReport`` to a Markdown string.

    The output is text-only (no images, no embedded charts).  Collapsible
    prompt/response blocks use ``<details>`` tags supported by GitHub-Flavored
    Markdown and most modern renderers.

    Args:
        report: The red team report to render.

    Returns:
        A Markdown string representing the full report.
    """
    sections = build_report_sections(report)

    # Build header from summary section data
    summary_section = next((s for s in sections if s.kind == "summary"), None)
    header = _render_header(summary_section.data if summary_section else {})

    parts: list[str] = [header, ""]

    for section in sections:
        renderer = _SECTION_RENDERERS.get(section.kind)
        if renderer is not None:
            rendered = renderer(section)
            parts.append(rendered)
            parts.append("")

    parts.append("---")
    parts.append("")
    parts.append("*Generated by evaluatorq red team suite.*")

    return "\n".join(parts)
