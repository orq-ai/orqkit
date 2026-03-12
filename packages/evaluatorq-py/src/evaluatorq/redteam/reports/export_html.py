"""HTML renderer for red team reports.

``export_html(report)`` converts a ``RedTeamReport`` to a self-contained HTML
string with inline SVG charts (via Plotly + kaleido), styled tables, and
print-friendly CSS.  No JavaScript is required — charts are static SVGs.

If ``plotly`` or ``kaleido`` are not installed the report degrades gracefully
to a tables-only layout.
"""

from __future__ import annotations

import html
from typing import Any

from evaluatorq.redteam.contracts import RedTeamReport
from evaluatorq.redteam.reports.sections import ReportSection, build_report_sections

# ---------------------------------------------------------------------------
# Brand colors (inline to avoid hard dependency on ui package at import time)
# ---------------------------------------------------------------------------

_COLORS = {
    "orange_300": "#ff8f34",
    "teal_400": "#025558",
    "teal_500": "#01483d",
    "ink_700": "#25232e",
    "ink_800": "#1a1921",
    "sand_100": "#f9f8f6",
    "sand_400": "#e4e2df",
    "success_400": "#2ebd85",
    "yellow_400": "#f2b600",
    "red_400": "#d92d20",
    "blue_400": "#4fd2ff",
}

_SEVERITY_COLORS = {
    "critical": _COLORS["red_400"],
    "high": _COLORS["orange_300"],
    "medium": _COLORS["yellow_400"],
    "low": _COLORS["success_400"],
}

_STATUS_COLORS = {
    "vulnerable": _COLORS["red_400"],
    "resistant": _COLORS["success_400"],
    "error": _COLORS["yellow_400"],
}

# Canonical order for severity labels in charts
_SEVERITY_ORDER = ["critical", "high", "medium", "low"]

# ---------------------------------------------------------------------------
# CSS
# ---------------------------------------------------------------------------

_CSS = """\
:root {
    --ink-700: %(ink_700)s;
    --ink-800: %(ink_800)s;
    --sand-100: %(sand_100)s;
    --sand-400: %(sand_400)s;
    --teal-400: %(teal_400)s;
    --teal-500: %(teal_500)s;
    --orange-300: %(orange_300)s;
    --success-400: %(success_400)s;
    --red-400: %(red_400)s;
    --yellow-400: %(yellow_400)s;
}
*, *::before, *::after { box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink-700);
    background: var(--sand-100);
    margin: 0;
    padding: 2rem;
    line-height: 1.6;
    max-width: 1100px;
    margin-left: auto;
    margin-right: auto;
}
h1 { color: var(--teal-400); border-bottom: 3px solid var(--orange-300); padding-bottom: .5rem; }
h2 { color: var(--teal-500); margin-top: 2.5rem; border-bottom: 1px solid var(--sand-400); padding-bottom: .3rem; }
h3 { color: var(--ink-700); margin-top: 1.5rem; }
table { width: 100%%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: .6rem .8rem; text-align: left; border-bottom: 1px solid var(--sand-400); }
th { background: var(--teal-400); color: white; font-weight: 600; }
tr:nth-child(even) { background: rgba(0,0,0,.02); }
.card {
    background: white;
    border: 1px solid var(--sand-400);
    border-radius: 8px;
    padding: 1.2rem;
    margin: 1rem 0;
    box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
.card h3 { margin-top: 0; }
.badge {
    display: inline-block;
    padding: .15rem .5rem;
    border-radius: 4px;
    font-size: .85em;
    font-weight: 600;
    color: white;
}
.badge-vulnerable { background: var(--red-400); }
.badge-resistant { background: var(--success-400); }
.badge-error { background: var(--yellow-400); color: var(--ink-700); }
.severity-critical { color: var(--red-400); font-weight: 700; }
.severity-high { color: var(--orange-300); font-weight: 700; }
.severity-medium { color: var(--yellow-400); font-weight: 600; }
.severity-low { color: var(--success-400); }
.chart-container { margin: 1.5rem 0; text-align: center; }
.chart-container svg { max-width: 100%%; height: auto; }
details { margin: .5rem 0; }
details summary { cursor: pointer; font-weight: 600; color: var(--teal-400); padding: .3rem 0; }
details pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; font-size: .85em; }
.meta { color: #666; font-size: .9em; }
.recommendations li { margin: .3rem 0; }
.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--sand-400); color: #888; font-size: .85em; text-align: center; }

@media print {
    body { padding: 0; max-width: none; }
    h2 { page-break-before: always; }
    h2:first-of-type { page-break-before: avoid; }
    .card { break-inside: avoid; }
    details[open] { break-inside: avoid; }
}
""" % {k: v for k, v in _COLORS.items()}


# ---------------------------------------------------------------------------
# Chart rendering helpers
# ---------------------------------------------------------------------------


def _try_render_svg_chart(fig: Any) -> str | None:
    """Attempt to render a Plotly figure as inline SVG."""
    try:
        svg_bytes = fig.to_image(format="svg", engine="kaleido")
        return svg_bytes.decode("utf-8") if isinstance(svg_bytes, bytes) else svg_bytes
    except Exception:
        return None


def _charts_available() -> bool:
    """Check if plotly and kaleido are importable."""
    try:
        import plotly  # noqa: F401
        import kaleido  # noqa: F401
        return True
    except ImportError:
        return False


def _render_donut_chart(summary_data: dict[str, Any]) -> str:
    """Render a donut chart: resistant vs vulnerable vs errors."""
    if not _charts_available():
        return ""
    import plotly.graph_objects as go

    vuln = summary_data.get("vulnerabilities_found", 0)
    total = summary_data.get("total_attacks", 0)
    errors = summary_data.get("total_errors", 0)
    resistant = max(0, total - vuln - errors)

    if total == 0:
        return ""

    labels = ["Resistant", "Vulnerable", "Error"]
    values = [resistant, vuln, errors]
    colors = [_STATUS_COLORS["resistant"], _STATUS_COLORS["vulnerable"], _STATUS_COLORS["error"]]

    # Remove zero-value segments
    filtered = [(l, v, c) for l, v, c in zip(labels, values, colors) if v > 0]
    if not filtered:
        return ""
    labels, values, colors = zip(*filtered)

    fig = go.Figure(data=[go.Pie(
        labels=list(labels),
        values=list(values),
        hole=0.5,
        marker=dict(colors=list(colors)),
        textinfo="label+percent",
        textfont=dict(size=12),
    )])
    fig.update_layout(
        width=400, height=300,
        margin=dict(t=30, b=30, l=30, r=30),
        showlegend=False,
        title=dict(text="Overall Results", font=dict(size=14)),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
    )
    svg = _try_render_svg_chart(fig)
    return f'<div class="chart-container">{svg}</div>' if svg else ""


def _render_severity_bar_chart(by_severity: dict[str, Any]) -> str:
    """Render a vertical bar chart of vulnerability counts by severity level.

    Args:
        by_severity: Mapping of severity level -> summary object (or dict) with
            a ``vulnerabilities_found`` attribute/key.  Corresponds to
            ``ReportSummary.by_severity``.
    """
    if not _charts_available():
        return ""
    import plotly.graph_objects as go

    if not by_severity:
        return ""

    # Build ordered lists, keeping only severities that have vulnerabilities.
    labels: list[str] = []
    values: list[int] = []
    colors: list[str] = []
    for sev in _SEVERITY_ORDER:
        entry = by_severity.get(sev)
        if entry is None:
            continue
        # Support both Pydantic model instances and plain dicts.
        found = (
            entry.get("vulnerabilities_found", 0)
            if isinstance(entry, dict)
            else getattr(entry, "vulnerabilities_found", 0)
        )
        if found > 0:
            labels.append(sev)
            values.append(found)
            colors.append(_SEVERITY_COLORS.get(sev, "#999"))

    if not labels:
        return ""

    fig = go.Figure(data=[go.Bar(
        x=labels,
        y=values,
        marker_color=colors,
        text=values,
        textposition="outside",
    )])
    fig.update_layout(
        width=450, height=300,
        margin=dict(t=40, b=40, l=50, r=30),
        title=dict(text="Vulnerabilities by Severity", font=dict(size=14)),
        xaxis_title="Severity",
        yaxis_title="Count",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
    )
    svg = _try_render_svg_chart(fig)
    return f'<div class="chart-container">{svg}</div>' if svg else ""


def _render_category_bar_chart(rows: list[dict[str, Any]]) -> str:
    """Render a horizontal bar chart of per-category vulnerability rate."""
    if not _charts_available():
        return ""
    import plotly.graph_objects as go

    if not rows:
        return ""

    # Take top 10 by vulnerability rate
    sorted_rows = sorted(rows, key=lambda r: r.get("vulnerability_rate", 0), reverse=True)[:10]
    labels = [r.get("category", "?") for r in sorted_rows]
    rates = [r.get("vulnerability_rate", 0) * 100 for r in sorted_rows]

    fig = go.Figure(data=[go.Bar(
        y=labels,
        x=rates,
        orientation="h",
        marker_color=_COLORS["orange_300"],
        text=[f"{r:.0f}%" for r in rates],
        textposition="outside",
    )])
    fig.update_layout(
        width=500, height=max(250, len(labels) * 35 + 80),
        margin=dict(t=40, b=40, l=80, r=50),
        title=dict(text="Vulnerability Rate by Category", font=dict(size=14)),
        xaxis_title="Vulnerability Rate (%)",
        xaxis=dict(range=[0, max(rates) * 1.2 if rates else 100]),
        yaxis=dict(autorange="reversed"),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
    )
    svg = _try_render_svg_chart(fig)
    return f'<div class="chart-container">{svg}</div>' if svg else ""


def _render_technique_bar_chart(rows: list[dict[str, Any]]) -> str:
    """Render a horizontal bar chart of ASR% by technique.

    Mirrors the "ASR by Technique" chart shown in the Streamlit dashboard.
    Techniques are sorted by vulnerability rate (highest first) and capped at
    the top 15 to keep the chart readable.
    """
    if not _charts_available():
        return ""
    import plotly.graph_objects as go

    if not rows:
        return ""

    sorted_rows = sorted(rows, key=lambda r: r.get("vulnerability_rate", 0), reverse=True)[:15]
    labels = [r.get("technique", "?") for r in sorted_rows]
    rates = [r.get("vulnerability_rate", 0) * 100 for r in sorted_rows]
    totals = [r.get("total_attacks", 0) for r in sorted_rows]

    hover_texts = [
        f"{label}<br>ASR: {rate:.1f}%<br>Attacks: {total}"
        for label, rate, total in zip(labels, rates, totals)
    ]

    fig = go.Figure(data=[go.Bar(
        y=labels,
        x=rates,
        orientation="h",
        marker_color=_COLORS["orange_300"],
        text=[f"{r:.0f}%" for r in rates],
        textposition="outside",
        hovertext=hover_texts,
        hoverinfo="text",
    )])
    fig.update_layout(
        width=500, height=max(250, len(labels) * 35 + 80),
        margin=dict(t=40, b=40, l=140, r=60),
        title=dict(text="ASR by Technique", font=dict(size=14)),
        xaxis_title="Attack Success Rate (%)",
        xaxis=dict(range=[0, max(rates) * 1.2 if rates else 100]),
        yaxis=dict(autorange="reversed"),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
    )
    svg = _try_render_svg_chart(fig)
    return f'<div class="chart-container">{svg}</div>' if svg else ""


def _render_vulnerability_bar_chart(rows: list[dict[str, Any]]) -> str:
    """Render a horizontal bar chart of ASR% by vulnerability.

    Mirrors the "ASR by Vulnerability" chart shown in the Streamlit dashboard.
    Vulnerabilities are sorted by vulnerability rate (highest first) and capped
    at the top 15 to keep the chart readable.
    """
    if not _charts_available():
        return ""
    import plotly.graph_objects as go

    if not rows:
        return ""

    sorted_rows = sorted(rows, key=lambda r: r.get("vulnerability_rate", 0), reverse=True)[:15]
    # Prefer the human-readable name; fall back to the ID.
    labels = [r.get("vulnerability_name") or r.get("vulnerability", "?") for r in sorted_rows]
    rates = [r.get("vulnerability_rate", 0) * 100 for r in sorted_rows]
    totals = [r.get("total_attacks", 0) for r in sorted_rows]

    hover_texts = [
        f"{label}<br>ASR: {rate:.1f}%<br>Attacks: {total}"
        for label, rate, total in zip(labels, rates, totals)
    ]

    fig = go.Figure(data=[go.Bar(
        y=labels,
        x=rates,
        orientation="h",
        marker_color=_COLORS["orange_300"],
        text=[f"{r:.0f}%" for r in rates],
        textposition="outside",
        hovertext=hover_texts,
        hoverinfo="text",
    )])
    fig.update_layout(
        width=500, height=max(250, len(labels) * 35 + 80),
        margin=dict(t=40, b=40, l=160, r=60),
        title=dict(text="ASR by Vulnerability", font=dict(size=14)),
        xaxis_title="Attack Success Rate (%)",
        xaxis=dict(range=[0, max(rates) * 1.2 if rates else 100]),
        yaxis=dict(autorange="reversed"),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
    )
    svg = _try_render_svg_chart(fig)
    return f'<div class="chart-container">{svg}</div>' if svg else ""


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _esc(text: str) -> str:
    """HTML-escape text."""
    return html.escape(str(text))


def _pct(rate: float) -> str:
    return f"{rate:.0%}"


def _truncate(text: str, max_chars: int = 800) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n[truncated — full text in report JSON]"


def _html_table(headers: list[str], rows: list[list[str]]) -> str:
    parts = ["<table>", "<thead><tr>"]
    for h in headers:
        parts.append(f"<th>{_esc(h)}</th>")
    parts.append("</tr></thead><tbody>")
    for row in rows:
        parts.append("<tr>")
        for cell in row:
            parts.append(f"<td>{cell}</td>")  # cell may contain HTML (badges)
        parts.append("</tr>")
    parts.append("</tbody></table>")
    return "".join(parts)


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------


def _render_header_html(data: dict[str, Any]) -> str:
    target = _esc(data.get("target", "unknown"))
    pipeline = _esc(data.get("pipeline", "unknown"))
    created_at = data.get("created_at")
    vulnerability_rate = data.get("vulnerability_rate", 0.0)
    date_str = created_at.strftime("%Y-%m-%d %H:%M UTC") if created_at else "unknown"

    return (
        f"<h1>Red Team Security Report</h1>\n"
        f'<p class="meta">'
        f"<strong>Target:</strong> {target} &nbsp;|&nbsp; "
        f"<strong>Mode:</strong> {pipeline} &nbsp;|&nbsp; "
        f"<strong>Date:</strong> {date_str} &nbsp;|&nbsp; "
        f"<strong>ASR:</strong> {_pct(vulnerability_rate)}"
        f"</p>\n"
    )


def _render_summary_html(section: ReportSection) -> str:
    data = section.data
    rows = [
        ["Total Attacks", _esc(str(data.get("total_attacks", 0)))],
        ["Evaluated", _esc(str(data.get("evaluated_attacks", 0)))],
        ["Vulnerabilities Found", _esc(str(data.get("vulnerabilities_found", 0)))],
        ["ASR", _pct(data.get("vulnerability_rate", 0.0))],
        ["Evaluation Coverage", _pct(data.get("evaluation_coverage", 0.0))],
    ]
    if data.get("total_errors"):
        rows.append(["Errors", _esc(str(data["total_errors"]))])
    if data.get("duration_seconds") is not None:
        mins, secs = divmod(int(data["duration_seconds"]), 60)
        rows.append(["Duration", f"{mins}m {secs}s"])

    table = _html_table(["Metric", "Value"], rows)
    donut_chart = _render_donut_chart(data)
    severity_chart = _render_severity_bar_chart(data.get("by_severity", {}))
    return f"<h2>{_esc(section.title)}</h2>\n{donut_chart}\n{severity_chart}\n{table}"


def _render_focus_areas_html(section: ReportSection) -> str:
    focus_areas = section.data.get("focus_areas", [])
    if not focus_areas:
        return f"<h2>{_esc(section.title)}</h2>\n<p>No significant risk areas identified.</p>"

    parts = [f"<h2>{_esc(section.title)}</h2>"]
    for i, area in enumerate(focus_areas, start=1):
        cat = _esc(area["category"])
        cat_name = _esc(area.get("category_name", cat))
        vuln = area.get("vulnerabilities_found", 0)
        vuln_rate = _pct(area.get("vulnerability_rate", 0.0))
        risk_score = area.get("risk_score", 0.0)
        remediation = area.get("remediation", "")

        card_lines = [
            '<div class="card">',
            f"<h3>{i}. {cat} — {cat_name}</h3>",
            f"<p><strong>Vulnerabilities:</strong> {vuln} ({vuln_rate} of attacks succeeded) "
            f"&nbsp;|&nbsp; <strong>Risk Score:</strong> {risk_score:.2f}</p>",
        ]
        if remediation:
            card_lines.append(f"<p><strong>Remediation guidance:</strong></p>")
            card_lines.append(f"<blockquote>{_esc(remediation)}</blockquote>")

        llm_rec = area.get("llm_recommendations")
        if llm_rec:
            recs = llm_rec.get("recommendations", [])
            patterns = llm_rec.get("patterns_observed", "")
            traces_analyzed = llm_rec.get("traces_analyzed", 0)
            if recs:
                card_lines.append(
                    f'<p><strong>Actionable recommendations</strong> (based on {traces_analyzed} trace samples):</p>'
                )
                card_lines.append('<ul class="recommendations">')
                for rec_item in recs:
                    card_lines.append(f"<li>{_esc(rec_item)}</li>")
                card_lines.append("</ul>")
            if patterns:
                card_lines.append(f"<p><em>Patterns observed:</em> {_esc(patterns)}</p>")

        card_lines.append("</div>")
        parts.append("\n".join(card_lines))

    return "\n".join(parts)


def _render_vulnerability_breakdown_html(section: ReportSection) -> str:
    """Render the per-vulnerability breakdown as an HTML table with a bar chart."""
    rows = section.data.get("rows", [])
    if not rows:
        return f"<h2>{_esc(section.title)}</h2>\n<p>No vulnerability data available.</p>"

    chart = _render_vulnerability_bar_chart(rows)
    table_rows = [
        [
            _esc(r["vulnerability_name"] or r["vulnerability"]),
            _esc(r.get("domain", "")),
            _esc(str(r["total_attacks"])),
            _esc(str(r["vulnerabilities_found"])),
            _pct(r["vulnerability_rate"]),
        ]
        for r in rows
    ]
    table = _html_table(
        ["Vulnerability", "Domain", "Attacks", "Vulnerabilities", "ASR"],
        table_rows,
    )
    return f"<h2>{_esc(section.title)}</h2>\n{chart}\n{table}"


def _render_category_breakdown_html(section: ReportSection) -> str:
    rows = section.data.get("rows", [])
    if not rows:
        return f"<h2>{_esc(section.title)}</h2>\n<p>No category data available.</p>"

    chart = _render_category_bar_chart(rows)
    table_rows = [
        [
            _esc(f"{r['category']} — {r['category_name']}"),
            _esc(str(r["total_attacks"])),
            _esc(str(r["vulnerabilities_found"])),
            _pct(r["vulnerability_rate"]),
        ]
        for r in rows
    ]
    table = _html_table(
        ["Category", "Attacks", "Vulnerabilities", "ASR"],
        table_rows,
    )
    return f"<h2>{_esc(section.title)}</h2>\n{chart}\n{table}"


def _render_technique_breakdown_html(section: ReportSection) -> str:
    rows = section.data.get("rows", [])
    if not rows:
        return f"<h2>{_esc(section.title)}</h2>\n<p>No technique data available.</p>"

    chart = _render_technique_bar_chart(rows)
    table_rows = [
        [
            _esc(r["technique"]),
            _esc(str(r["total_attacks"])),
            _esc(str(r["vulnerabilities_found"])),
            _pct(r["vulnerability_rate"]),
        ]
        for r in rows
    ]
    table = _html_table(
        ["Technique", "Attacks", "Vulnerabilities", "ASR"],
        table_rows,
    )
    return f"<h2>{_esc(section.title)}</h2>\n{chart}\n{table}"


# ---------------------------------------------------------------------------
# Section dispatch
# ---------------------------------------------------------------------------

def _render_severity_definitions_html(section: ReportSection) -> str:
    """Render the severity level definitions as an HTML table."""
    definitions = section.data.get("definitions", [])
    weights = section.data.get("weights", {})
    if not definitions:
        return ""

    table_rows = []
    for d in definitions:
        level = d["level"]
        sev_cls = f"severity-{level}"
        weight = weights.get(level, "")
        table_rows.append([
            f'<span class="{sev_cls}">{_esc(level.capitalize())}</span>',
            _esc(d["description"]),
            str(weight),
        ])

    table = _html_table(
        ["Severity", "Description", "Risk Weight"],
        table_rows,
    )
    return f"<h2>{_esc(section.title)}</h2>\n{table}"


_SECTION_RENDERERS = {
    "summary": _render_summary_html,
    "severity_definitions": _render_severity_definitions_html,
    "focus_areas": _render_focus_areas_html,
    "vulnerability_breakdown": _render_vulnerability_breakdown_html,
    "category_breakdown": _render_category_breakdown_html,
    "technique_breakdown": _render_technique_breakdown_html,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def export_html(report: RedTeamReport) -> str:
    """Convert a ``RedTeamReport`` to a self-contained HTML string.

    The output is a single HTML file with inline CSS and optional inline SVG
    charts (if ``plotly`` and ``kaleido`` are installed).  No JavaScript is
    required.

    Args:
        report: The red team report to render.

    Returns:
        A complete HTML document string.
    """
    sections = build_report_sections(report)

    summary_section = next((s for s in sections if s.kind == "summary"), None)
    header = _render_header_html(summary_section.data if summary_section else {})

    # Enrich the summary section data with by_severity so the renderer can
    # produce the severity breakdown chart without sections.py needing to
    # expose it.  We do this here to keep the sections layer renderer-agnostic.
    if summary_section is not None and report.summary.by_severity:
        summary_section.data["by_severity"] = report.summary.by_severity

    body_parts: list[str] = [header]

    for section in sections:
        renderer = _SECTION_RENDERERS.get(section.kind)
        if renderer is not None:
            body_parts.append(renderer(section))

    body_parts.append(
        '<p class="footer">Generated by evaluatorq red team suite.</p>'
    )

    body_html = "\n\n".join(body_parts)

    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>Red Team Security Report</title>\n"
        f"<style>\n{_CSS}</style>\n"
        "</head>\n"
        "<body>\n"
        f"{body_html}\n"
        "</body>\n"
        "</html>\n"
    )
