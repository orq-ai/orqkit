"""Interactive Streamlit dashboard for exploring red team reports.

Launch via CLI:  evaluatorq redteam ui /path/to/report.json
Or directly:     streamlit run dashboard.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from evaluatorq.redteam.contracts import (
    OWASP_CATEGORY_NAMES,
    AgentContext,
    RedTeamReport,
    RedTeamResult,
    ReportSummary,
)
from evaluatorq.redteam.reports.converters import compute_report_summary
from evaluatorq.redteam.reports.export_md import export_markdown
from evaluatorq.redteam.reports.guidance import REMEDIATION_GUIDANCE
from evaluatorq.redteam.ui.colors import (
    COLORS,
    ORQ_SCALE_AGENT,
    ORQ_SCALE_HEAT,
    QUALITATIVE,
    SEVERITY_COLORS,
    SEVERITY_ORDER,
    STATUS_COLORS,
)

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="Red Team Report",
    page_icon="\U0001f6e1\ufe0f",
    layout="wide",
    initial_sidebar_state="expanded",
)


def _fmt_category(code: str) -> str:
    name = OWASP_CATEGORY_NAMES.get(code)
    return f"{code} - {name}" if name else code


def _status_icon(rate: float) -> str:
    if rate >= 0.9:
        return "\u2705"
    if rate >= 0.8:
        return "\U0001f7e0"
    return "\u274c"


def _defense_rate_color(rate: float) -> str:
    """Interpolate from red_400 through yellow_400 to success_400 (ORQ brand)."""
    # red_400: #d92d20 (217, 45, 32)
    # yellow_400: #f2b600 (242, 182, 0)
    # success_400: #2ebd85 (46, 189, 133)
    if rate <= 0.5:
        t = rate / 0.5
        r = int(217 + (242 - 217) * t)
        g = int(45 + (182 - 45) * t)
        b = int(32 + (0 - 32) * t)
    else:
        t = (rate - 0.5) / 0.5
        r = int(242 + (46 - 242) * t)
        g = int(182 + (189 - 182) * t)
        b = int(0 + (133 - 0) * t)
    return f"#{r:02X}{g:02X}{b:02X}"


# ---------------------------------------------------------------------------
# Remediation guidance is imported from reports.guidance (single source of truth).
# REMEDIATION_GUIDANCE is re-exported here for backward compatibility with any
# code that imports it directly from this module.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Report loading
# ---------------------------------------------------------------------------


def _find_reports(path: Path) -> list[Path]:
    if path.is_file() and path.suffix == ".json":
        return [path]
    if path.is_dir():
        reports = sorted(path.rglob("report.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not reports:
            reports = sorted(path.rglob("*report*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        return reports
    return []


@st.cache_data
def _load_report(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _parse_report(data: dict[str, Any]) -> RedTeamReport:
    return RedTeamReport.model_validate(data)


# ---------------------------------------------------------------------------
# Helpers for computing per-result aggregations from report.results
# ---------------------------------------------------------------------------


def _weakest_link(results: list[RedTeamResult]) -> tuple[str, int]:
    """Find the category+technique combo with most vulnerabilities."""
    combos: Counter[tuple[str, str]] = Counter()
    for r in results:
        if r.vulnerable:
            combos[(r.attack.category, r.attack.attack_technique.value)] += 1
    if not combos:
        return "None", 0
    (cat, tech), count = combos.most_common(1)[0]
    cat_name = OWASP_CATEGORY_NAMES.get(cat, cat)
    return f"{cat_name} + {tech}", count


def _critical_exposure(results: list[RedTeamResult]) -> int:
    return sum(1 for r in results if r.vulnerable and r.attack.severity.value == "critical")


def _compliant_categories(summary: ReportSummary) -> tuple[int, int]:
    """Return (fully_compliant, total) category counts."""
    total = len(summary.by_category)
    compliant = sum(1 for c in summary.by_category.values() if c.vulnerabilities_found == 0)
    return compliant, total


# ---------------------------------------------------------------------------
# Sidebar agent context
# ---------------------------------------------------------------------------

_AGENT_CARD_CSS = """
<style>
.agent-card {
    background: transparent;
    border: 1px solid rgba(2,85,88,0.2);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 12px;
}
.agent-card h3 {
    margin: 0 0 4px 0;
    font-size: 1.05rem;
}
.agent-card .agent-desc {
    color: #888;
    font-size: 0.82rem;
    margin-bottom: 10px;
    line-height: 1.4;
}
.agent-card .agent-model {
    display: inline-block;
    background: rgba(2,85,88,0.12);
    border: 1px solid rgba(2,85,88,0.25);
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 0.8rem;
    font-family: monospace;
}
.agent-card .ctx-divider {
    border: none;
    border-top: 1px solid rgba(255,255,255,0.1);
    margin: 12px 0 10px 0;
}
.agent-card .ctx-section-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
    margin-bottom: 6px;
}
.agent-card .tool-chip {
    display: inline-block;
    background: rgba(46,189,133,0.12);
    border: 1px solid rgba(46,189,133,0.3);
    color: #2ebd85;
    border-radius: 14px;
    padding: 2px 9px;
    font-size: 0.76rem;
    font-family: monospace;
    margin: 2px 2px;
}
.agent-card .mem-chip {
    display: inline-block;
    background: rgba(126,34,206,0.12);
    border: 1px solid rgba(126,34,206,0.3);
    color: #7e22ce;
    border-radius: 14px;
    padding: 2px 9px;
    font-size: 0.76rem;
    font-family: monospace;
    margin: 2px 2px;
}
.agent-card .kb-chip {
    display: inline-block;
    background: rgba(255,143,52,0.12);
    border: 1px solid rgba(255,143,52,0.3);
    color: #ff8f34;
    border-radius: 14px;
    padding: 2px 9px;
    font-size: 0.76rem;
    font-family: monospace;
    margin: 2px 2px;
}
.agent-card .ctx-group {
    margin-bottom: 8px;
}
.agent-card .ctx-group:last-child {
    margin-bottom: 0;
}
</style>
"""


def _render_sidebar_agent_context(ctx: AgentContext) -> None:
    st.sidebar.markdown(_AGENT_CARD_CSS, unsafe_allow_html=True)

    name = ctx.key or ctx.display_name or "Agent"
    desc_html = f'<div class="agent-desc">{ctx.description}</div>' if ctx.description else ""
    model_html = f'<div class="agent-model">{ctx.model}</div>' if ctx.model else ""

    # Build capability sections
    sections_html = ""
    has_capabilities = ctx.tools or ctx.memory_stores or ctx.knowledge_bases

    if has_capabilities:
        sections_html += '<hr class="ctx-divider">'

    if ctx.tools:
        chips = "".join(f'<span class="tool-chip">{t.name or "unknown"}</span>' for t in ctx.tools)
        sections_html += (
            f'<div class="ctx-group">'
            f'<div class="ctx-section-title">Tools ({len(ctx.tools)})</div>'
            f'{chips}'
            f'</div>'
        )

    if ctx.memory_stores:
        chips = "".join(f'<span class="mem-chip">{m.key or m.id or "unknown"}</span>' for m in ctx.memory_stores)
        sections_html += (
            f'<div class="ctx-group">'
            f'<div class="ctx-section-title">Memory ({len(ctx.memory_stores)})</div>'
            f'{chips}'
            f'</div>'
        )

    if ctx.knowledge_bases:
        chips = "".join(
            f'<span class="kb-chip">{kb.name or kb.key or kb.id or "unknown"}</span>' for kb in ctx.knowledge_bases
        )
        sections_html += (
            f'<div class="ctx-group">'
            f'<div class="ctx-section-title">Knowledge ({len(ctx.knowledge_bases)})</div>'
            f'{chips}'
            f'</div>'
        )

    st.sidebar.markdown(
        f'<div class="agent-card">'
        f'<h3>{name}</h3>'
        f'{desc_html}'
        f'{model_html}'
        f'{sections_html}'
        f'</div>',
        unsafe_allow_html=True,
    )


# ---------------------------------------------------------------------------
# Sidebar filters
# ---------------------------------------------------------------------------


def _render_sidebar_filters(results: list[RedTeamResult]) -> list[RedTeamResult]:
    """Render global filter widgets in a sidebar expander. Returns filtered results."""
    if not results:
        return results

    # Derive available options from full result set
    all_categories = sorted({r.attack.category for r in results})
    all_severities = [s for s in SEVERITY_ORDER if any(r.attack.severity.value == s for r in results)]
    all_techniques = sorted({r.attack.attack_technique.value for r in results})
    all_delivery = sorted({dm.value for r in results for dm in (r.attack.delivery_methods or [])})
    all_agents = sorted({r.agent.key or r.agent.display_name or "unknown" for r in results})

    with st.sidebar.expander("Filters", expanded=False):
        # Result type
        result_filter = st.radio(
            "Result",
            options=["All", "Vulnerable", "Resistant", "Error"],
            index=0,
            horizontal=True,
            key="filter_result",
        )

        # Category
        sel_categories = st.multiselect(
            "Category",
            options=all_categories,
            default=all_categories,
            format_func=lambda c: _fmt_category(c),
            key="filter_categories",
        )

        # Severity
        sel_severities = st.multiselect(
            "Severity",
            options=all_severities,
            default=all_severities,
            key="filter_severities",
        )

        # Technique
        sel_techniques = st.multiselect(
            "Attack Technique",
            options=all_techniques,
            default=all_techniques,
            key="filter_techniques",
        )

        # Delivery method
        if all_delivery:
            sel_delivery = st.multiselect(
                "Delivery Method",
                options=all_delivery,
                default=all_delivery,
                key="filter_delivery",
            )
        else:
            sel_delivery = []

        # Agent (only show when multi-agent)
        if len(all_agents) > 1:
            sel_agents = st.multiselect(
                "Agent",
                options=all_agents,
                default=all_agents,
                key="filter_agents",
            )
        else:
            sel_agents = all_agents

        # Reset button
        if st.button("Reset All Filters", use_container_width=True, key="reset_filters"):
            st.session_state["filter_result"] = "All"
            st.session_state["filter_categories"] = all_categories
            st.session_state["filter_severities"] = all_severities
            st.session_state["filter_techniques"] = all_techniques
            if all_delivery:
                st.session_state["filter_delivery"] = all_delivery
            if len(all_agents) > 1:
                st.session_state["filter_agents"] = all_agents
            st.rerun()

    # Apply filters
    filtered = results

    if result_filter == "Vulnerable":
        filtered = [r for r in filtered if r.vulnerable]
    elif result_filter == "Resistant":
        filtered = [r for r in filtered if not r.vulnerable and not r.error]
    elif result_filter == "Error":
        filtered = [r for r in filtered if r.error]

    if set(sel_categories) != set(all_categories):
        filtered = [r for r in filtered if r.attack.category in sel_categories]

    if set(sel_severities) != set(all_severities):
        filtered = [r for r in filtered if r.attack.severity.value in sel_severities]

    if set(sel_techniques) != set(all_techniques):
        filtered = [r for r in filtered if r.attack.attack_technique.value in sel_techniques]

    if all_delivery and set(sel_delivery) != set(all_delivery):
        filtered = [r for r in filtered if any(dm.value in sel_delivery for dm in (r.attack.delivery_methods or []))]

    if len(all_agents) > 1 and set(sel_agents) != set(all_agents):
        filtered = [r for r in filtered if (r.agent.key or r.agent.display_name or "unknown") in sel_agents]

    # Show count in sidebar
    if len(filtered) != len(results):
        st.sidebar.caption(f"Showing {len(filtered)} of {len(results)} results")

    return filtered


# ---------------------------------------------------------------------------
# Main dashboard
# ---------------------------------------------------------------------------


def _render_dashboard() -> None:
    # Resolve report path from CLI args (passed after -- by streamlit run)
    args = sys.argv[1:]
    report_path_str = args[0] if args else ""
    report_path = Path(report_path_str) if report_path_str else None

    # Sidebar: report selection
    st.sidebar.title("Red Team Dashboard")

    if report_path and report_path.exists():
        report_files = _find_reports(report_path)
    else:
        report_files = []

    # File uploader fallback
    if not report_files:
        uploaded = st.sidebar.file_uploader("Upload report JSON", type=["json"])
        if uploaded is not None:
            data = json.loads(uploaded.read())
            report = _parse_report(data)
        else:
            st.info(
                "**Welcome to the Red Team Dashboard**\n\n"
                "Upload a report JSON file in the sidebar, or launch via CLI:\n\n"
                "```\nevaluatorq redteam ui /path/to/report.json\n```"
            )
            st.stop()
    else:
        if len(report_files) == 1:
            selected_path = report_files[0]
        else:
            labels = [str(p.relative_to(report_path)) if report_path and report_path.is_dir() else str(p) for p in report_files]
            idx = st.sidebar.selectbox("Select report", range(len(labels)), format_func=lambda i: labels[i])
            selected_path = report_files[idx]

        data = _load_report(str(selected_path))
        report = _parse_report(data)

    summary = report.summary

    # Sidebar: report metadata
    st.sidebar.divider()
    st.sidebar.markdown(f"**Pipeline:** {report.pipeline.value}")
    if report.framework:
        st.sidebar.markdown(f"**Framework:** {report.framework.value}")
    st.sidebar.markdown(f"**Created:** {report.created_at:%Y-%m-%d %H:%M}")
    agent_keys = sorted({r.agent.key or r.agent.display_name or "unknown" for r in report.results})
    if agent_keys:
        st.sidebar.markdown(f"**Agents:** {', '.join(agent_keys)}")
    if report.duration_seconds is not None:
        mins, secs = divmod(int(report.duration_seconds), 60)
        st.sidebar.markdown(f"**Duration:** {mins}m {secs}s")

    # Agent context
    if report.agent_context:
        ctx = report.agent_context
        st.sidebar.divider()
        _render_sidebar_agent_context(ctx)

    # Markdown export download button
    st.sidebar.divider()
    _target = ", ".join(sorted({r.agent.key or r.agent.display_name or "unknown" for r in report.results})) or "report"
    _md_content = export_markdown(report)
    _md_filename = f"redteam-report-{_target.replace('/', '-').replace(':', '-')}-{report.created_at:%Y%m%d_%H%M%S}.md"
    st.sidebar.download_button(
        label="Download Markdown Report",
        data=_md_content,
        file_name=_md_filename,
        mime="text/markdown",
    )

    # Global filters
    st.sidebar.divider()
    filtered_results = _render_sidebar_filters(report.results)

    # Recompute summary from filtered results when filters are active
    is_filtered = len(filtered_results) != len(report.results)
    if is_filtered:
        summary = compute_report_summary(filtered_results)
    else:
        summary = report.summary

    # Build a filtered report for render functions that need report.results
    filtered_report = report.model_copy(update={"results": filtered_results, "summary": summary})

    # Title
    framework_name = report.framework.value if report.framework else "OWASP"
    st.title("Red Team Security Report")

    if is_filtered:
        st.caption(f"Showing {len(filtered_results)} of {len(report.results)} results (filtered)")

    # Detect multi-agent
    unique_agents = sorted({r.agent.key or r.agent.display_name or "unknown" for r in filtered_results})
    has_multi_agent = len(unique_agents) >= 2

    # Build tabs
    tab_names = ["\U0001f4ca Summary", "\U0001f50d Breakdown", "\U0001f4c2 Explorer"]
    has_usage = summary.token_usage_total is not None or any(
        r.execution and r.execution.token_usage for r in filtered_results
    )
    if has_usage:
        tab_names.append("\U0001f4b0 Usage")
    if summary.total_errors > 0:
        tab_names.append("\u26a0\ufe0f Error Analysis")
    if has_multi_agent:
        tab_names.append("\U0001f916 Comparison")
    tabs = st.tabs(tab_names)

    tab_idx = 0
    with tabs[tab_idx]:
        _render_executive_summary(filtered_report, summary, framework_name)
    tab_idx += 1

    with tabs[tab_idx]:
        _render_technical_analysis(filtered_report, summary)
    tab_idx += 1

    with tabs[tab_idx]:
        _render_data_explorer(filtered_report, summary)
    tab_idx += 1

    if has_usage:
        with tabs[tab_idx]:
            _render_usage_tab(filtered_report, summary, unique_agents if has_multi_agent else [])
        tab_idx += 1

    if summary.total_errors > 0:
        with tabs[tab_idx]:
            _render_errors_tab(summary, filtered_report)
        tab_idx += 1

    if has_multi_agent:
        with tabs[tab_idx]:
            _render_agent_comparison(filtered_report, summary, unique_agents)


# ---------------------------------------------------------------------------
# Focus Areas (top-3 risk categories with remediation guidance)
# ---------------------------------------------------------------------------

_SEVERITY_WEIGHTS: dict[str, int] = {
    'critical': 8,
    'high': 4,
    'medium': 2,
    'low': 1,
}


def _dominant_severity_for_category(results: list[RedTeamResult], category: str) -> str:
    """Return the most common severity among vulnerable results in the given category.

    Falls back to the most common severity among all results in the category if no
    vulnerable results exist, and finally to 'medium' if the category has no results.
    """
    from collections import Counter as _Counter

    cat_results = [r for r in results if r.attack.category == category]
    vuln_results = [r for r in cat_results if r.vulnerable]
    source = vuln_results if vuln_results else cat_results
    if not source:
        return 'medium'
    counts = _Counter(r.attack.severity.value for r in source)
    return counts.most_common(1)[0][0]


def _render_focus_areas(report: RedTeamReport) -> None:
    """Render top-3 risk focus areas with remediation guidance.

    Risk score formula: vulnerability_rate * severity_weight
    Severity weights: low=1, medium=2, high=4, critical=8
    """
    from evaluatorq.redteam.contracts import normalize_category as _norm_cat

    summary = report.summary
    if not summary.by_category:
        return

    # Compute risk scores
    risk_items = []
    for cat_code, cat_summary in summary.by_category.items():
        if cat_summary.total_attacks == 0:
            continue
        dominant_sev = _dominant_severity_for_category(report.results, cat_summary.category)
        weight = _SEVERITY_WEIGHTS.get(dominant_sev, 2)
        risk_score = cat_summary.vulnerability_rate * weight
        risk_items.append((cat_summary, dominant_sev, risk_score))

    # Sort by risk score descending, take top 3
    risk_items.sort(key=lambda x: x[2], reverse=True)
    top_items = risk_items[:3]

    if not top_items:
        return

    st.subheader("Focus Areas")
    st.caption("Top-3 categories by risk score (vulnerability rate × severity weight). Prioritize these for remediation.")

    for cat_summary, dominant_sev, risk_score in top_items:
        normalized_code = _norm_cat(cat_summary.category)
        accent_color = SEVERITY_COLORS.get(dominant_sev, COLORS['orange_300'])
        remediation = REMEDIATION_GUIDANCE.get(
            normalized_code,
            REMEDIATION_GUIDANCE.get(
                cat_summary.category,
                "Review attack logs for this category and apply the principle of least privilege. "
                "Consult the relevant OWASP framework documentation for specific countermeasures.",
            ),
        )

        st.markdown(
            f"""
<div style="background-color: {COLORS['sand_100']}; border-left: 4px solid {accent_color}; \
padding: 16px; border-radius: 8px; margin-bottom: 12px;">
    <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="font-size: 0.95rem;">{_fmt_category(cat_summary.category)}</strong>
        <span style="color: {accent_color}; font-weight: bold; font-size: 0.85rem;">
            Risk: {risk_score:.1f} &nbsp;|&nbsp; {dominant_sev.upper()}
        </span>
    </div>
    <div style="margin-top: 8px; font-size: 0.9em; color: #666;">
        Vulnerability rate: {cat_summary.vulnerability_rate:.0%} &nbsp;|&nbsp; Samples: {cat_summary.total_attacks:,}
    </div>
    <div style="margin-top: 8px; font-size: 0.85em; color: #444;">
        {remediation}
    </div>
</div>
""",
            unsafe_allow_html=True,
        )


# ---------------------------------------------------------------------------
# Executive Summary
# ---------------------------------------------------------------------------


def _render_executive_summary(report: RedTeamReport, summary: ReportSummary, framework_name: str) -> None:
    critical_count = _critical_exposure(report.results)
    critical_msg = (
        "**Critical vulnerabilities detected** - immediate action required."
        if critical_count > 0
        else "No critical exposures detected."
    )

    st.markdown(
        f"## Executive Summary\n\n"
        f"This dashboard analyzes the security posture of AI agents against the **{framework_name}** "
        f"vulnerability framework. Based on **{summary.total_attacks:,}** attack simulations, your agent "
        f"demonstrates a **{summary.resistance_rate:.1%} defense rate**. {critical_msg}"
    )

    # KPI Cards
    compliant, total_cats = _compliant_categories(summary)
    error_rate = (summary.total_errors / summary.total_attacks * 100) if summary.total_attacks else 0

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Defense Rate", f"{summary.resistance_rate:.1%}", delta="Target: 100%", delta_color="normal")
    col2.metric(
        "Critical Exposure", str(critical_count),
        delta="Requires attention" if critical_count > 0 else "Clear",
        delta_color="inverse",
    )
    col3.metric("Eval Coverage", f"{summary.evaluation_coverage:.1%}")
    col4.metric("Errors", f"{summary.total_errors:,}", delta=f"{error_rate:.1f}% of attacks", delta_color="inverse")

    if summary.total_errors > 0:
        st.warning(f"{summary.total_errors} attacks errored and were excluded from resistance rate calculations.")

    # Datapoint breakdown (hybrid runs)
    if summary.datapoint_breakdown:
        bp = summary.datapoint_breakdown
        parts = []
        if bp.get("static", 0):
            parts.append(f"{bp['static']} static")
        if bp.get("template_dynamic", 0):
            parts.append(f"{bp['template_dynamic']} template")
        if bp.get("generated_dynamic", 0):
            parts.append(f"{bp['generated_dynamic']} generated")
        if parts:
            st.caption(f"Datapoint breakdown: {' | '.join(parts)}")

    st.divider()

    # Overall outcome donut + Severity bar chart + Category defense status table
    col_donut, col_sev, col_cat = st.columns([1, 1, 1.2])

    with col_donut:
        st.subheader("Overall Outcome")
        resistant = summary.evaluated_attacks - summary.vulnerabilities_found
        vulnerable = summary.vulnerabilities_found
        errors = summary.total_errors
        donut_labels = []
        donut_values = []
        donut_colors = []
        if resistant > 0:
            donut_labels.append("Resistant")
            donut_values.append(resistant)
            donut_colors.append(COLORS['success_400'])
        if vulnerable > 0:
            donut_labels.append("Vulnerable")
            donut_values.append(vulnerable)
            donut_colors.append(COLORS['red_400'])
        if errors > 0:
            donut_labels.append("Error")
            donut_values.append(errors)
            donut_colors.append(COLORS['sand_400'])

        if donut_values:
            fig = go.Figure(go.Pie(
                labels=donut_labels, values=donut_values,
                marker_colors=donut_colors,
                textinfo="label+percent", textposition="outside",
                hole=0.5,
            ))
            fig.update_layout(
                height=400, showlegend=False,
                margin=dict(l=10, r=10, t=10, b=10),
            )
            st.plotly_chart(fig, width="stretch")
        else:
            st.info("No results to display.")

    with col_sev:
        st.subheader("Severity of Successful Attacks")
        if summary.by_severity:
            items = [(k, summary.by_severity[k]) for k in SEVERITY_ORDER if k in summary.by_severity]
            names = [k for k, _ in items]
            vuln_counts = [v.vulnerabilities_found for _, v in items]
            colors = [SEVERITY_COLORS.get(k, COLORS['sand_400']) for k in names]

            if any(c > 0 for c in vuln_counts):
                fig = go.Figure(go.Bar(
                    x=names, y=vuln_counts,
                    marker_color=colors,
                    text=vuln_counts, textposition="outside",
                ))
                fig.update_layout(
                    height=400, xaxis_title="Severity", yaxis_title="Vulnerabilities Found",
                    margin=dict(l=20, r=20, t=10, b=20), showlegend=False,
                )
                st.plotly_chart(fig, width="stretch")
            else:
                st.info("No successful attacks to analyze.")
        else:
            st.info("No severity breakdown available.")

    with col_cat:
        st.subheader("OWASP Category Defense Status")
        if summary.by_category:
            table_html = (
                '<table style="width:100%;border-collapse:collapse;font-size:0.85rem">'
                '<thead><tr>'
                '<th style="text-align:left;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.1)">Category</th>'
                '<th style="text-align:right;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.1);width:110px">Defense Rate</th>'
                '</tr></thead><tbody>'
            )
            for cat in sorted(summary.by_category.values(), key=lambda c: c.category):
                color = _defense_rate_color(cat.resistance_rate)
                table_html += (
                    f'<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">'
                    f'<td style="padding:6px 10px">{_fmt_category(cat.category)}</td>'
                    f'<td style="text-align:right;padding:6px 10px">'
                    f'<span style="background:{color}18;color:{color};border:1px solid {color}40;'
                    f'border-radius:12px;padding:2px 10px;font-weight:600;font-size:0.82rem">'
                    f'{cat.resistance_rate:.1%}</span></td>'
                    f'</tr>'
                )
            table_html += '</tbody></table>'
            st.markdown(table_html, unsafe_allow_html=True)

    # Focus Areas section — top-3 risk categories with remediation guidance
    st.divider()
    _render_focus_areas(report)


# ---------------------------------------------------------------------------
# Technical Analysis
# ---------------------------------------------------------------------------


def _render_technical_analysis(report: RedTeamReport, summary: ReportSummary) -> None:
    st.header("Breakdown")

    # KPIs
    weakest, weakest_count = _weakest_link(report.results)

    col1, col2, col3 = st.columns(3)
    col1.metric(
        "Attack Success Rate (ASR)", f"{summary.vulnerability_rate:.1%}",
        delta_color="inverse",
        help="Lower is better. Measures how often attacks succeed against defenses.",
    )
    col2.metric("Weakest Link", weakest, f"{weakest_count} breaches", delta_color="inverse")
    col3.metric("Total Samples Tested", f"{summary.total_attacks:,}")

    st.divider()

    # Interactive breakdown chart
    st.subheader("Interactive Breakdown")
    st.caption(
        "Use the dropdowns to explore ASR across different dimensions. "
        "**Group by** sets the Y-axis, **Stack by** adds a color breakdown."
    )

    _render_interactive_breakdown(report.results, summary)

    st.divider()

    # Technique and Delivery Method charts side by side
    col_left, col_right = st.columns(2)

    with col_left:
        st.subheader("ASR by Technique")
        if summary.by_technique:
            items = sorted(summary.by_technique.items(), key=lambda t: t[1].vulnerability_rate, reverse=True)
            names = [k for k, _ in items]
            vuln_rates = [v.vulnerability_rate * 100 for _, v in items]
            totals = [v.total_attacks for _, v in items]

            fig = px.bar(
                x=vuln_rates, y=names, orientation="h",
                labels={"x": "ASR (%)", "y": "Technique"},
                text=[f"n={n}" for n in totals],
            )
            fig.update_traces(
                textposition="inside", textfont=dict(color="white", size=10),
                marker_color=QUALITATIVE[:len(names)],
            )
            fig.update_layout(
                height=max(300, len(names) * 35), showlegend=False,
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")
        else:
            st.info("No technique breakdown available.")

    with col_right:
        st.subheader("ASR by Delivery Method")
        if summary.by_delivery_method:
            items = sorted(summary.by_delivery_method.items(), key=lambda t: t[1].vulnerability_rate, reverse=True)
            names = [k for k, _ in items]
            vuln_rates = [v.vulnerability_rate * 100 for _, v in items]
            totals = [v.total_attacks for _, v in items]

            fig = px.bar(
                x=vuln_rates, y=names, orientation="h",
                labels={"x": "ASR (%)", "y": "Delivery Method"},
                text=[f"n={n}" for n in totals],
            )
            fig.update_traces(
                textposition="inside", textfont=dict(color="white", size=10),
                marker_color=QUALITATIVE[:len(names)],
            )
            fig.update_layout(
                height=max(300, len(names) * 35), showlegend=False,
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")
        else:
            st.info("No delivery method breakdown available.")

    st.divider()

    # Severity + Turn Type + Scope
    col1, col2, col3 = st.columns(3)

    with col1:
        st.subheader("By Severity")
        if summary.by_severity:
            items = [(k, summary.by_severity[k]) for k in SEVERITY_ORDER if k in summary.by_severity]
            names = [k for k, _ in items]
            vuln_rates = [v.vulnerability_rate * 100 for _, v in items]
            totals = [v.total_attacks for _, v in items]
            colors = [SEVERITY_COLORS.get(k, COLORS['sand_400']) for k in names]

            fig = go.Figure(go.Bar(
                x=names, y=vuln_rates, marker_color=colors,
                text=[f"{r:.1f}%<br>n={n}" for r, n in zip(vuln_rates, totals)],
                textposition="outside",
            ))
            fig.update_layout(
                height=350, xaxis_title="Severity", yaxis_title="ASR (%)",
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")

    with col2:
        st.subheader("By Turn Type")
        if summary.by_turn_type:
            names = list(summary.by_turn_type.keys())
            totals = [v.total_attacks for v in summary.by_turn_type.values()]
            fig = go.Figure(go.Pie(
                labels=names, values=totals,
                marker_colors=QUALITATIVE[:len(names)],
                textinfo="label+value", hole=0.4,
            ))
            fig.update_layout(height=300, margin=dict(l=10, r=10, t=10, b=10), showlegend=False)
            st.plotly_chart(fig, width="stretch")
            for name, tt in summary.by_turn_type.items():
                st.caption(f"{name}: {tt.vulnerability_rate:.1%} vuln rate")

    with col3:
        st.subheader("By Scope")
        if summary.by_scope:
            names = list(summary.by_scope.keys())
            totals = [v.total_attacks for v in summary.by_scope.values()]
            fig = go.Figure(go.Pie(
                labels=names, values=totals,
                marker_colors=QUALITATIVE[:len(names)],
                textinfo="label+value", hole=0.4,
            ))
            fig.update_layout(height=300, margin=dict(l=10, r=10, t=10, b=10), showlegend=False)
            st.plotly_chart(fig, width="stretch")
            for name, sc in summary.by_scope.items():
                st.caption(f"{name}: {sc.vulnerability_rate:.1%} vuln rate")

    # Framework breakdown (for mixed reports)
    if summary.by_framework and len(summary.by_framework) > 1:
        st.divider()
        st.subheader("By Framework")
        items = sorted(summary.by_framework.items(), key=lambda t: t[1].vulnerability_rate, reverse=True)
        names = [k for k, _ in items]
        vuln_rates = [v.vulnerability_rate * 100 for _, v in items]
        totals = [v.total_attacks for _, v in items]

        fig = px.bar(
            x=names, y=vuln_rates,
            labels={"x": "Framework", "y": "ASR (%)"},
            text=[f"{r:.1f}% (n={n})" for r, n in zip(vuln_rates, totals)],
        )
        fig.update_traces(textposition="outside", marker_color=QUALITATIVE[:len(names)])
        fig.update_layout(
            height=350, showlegend=False,
            margin=dict(l=20, r=20, t=10, b=20),
        )
        st.plotly_chart(fig, width="stretch")

    # Turn depth analysis
    _render_turn_depth_analysis(report.results)

    # Attack failure treemap
    _render_attack_failure_treemap(report.results)


# ---------------------------------------------------------------------------
# Attack Failure Treemap
# ---------------------------------------------------------------------------


def _render_interactive_breakdown(results: list[RedTeamResult], summary: ReportSummary) -> None:
    """Interactive bar chart with Group-by and Stack-by dropdowns."""
    if not results:
        st.info("No results to display.")
        return

    # Available dimensions
    dim_labels: dict[str, str] = {
        "category": "OWASP Category",
        "severity": "Severity",
        "attack_technique": "Attack Technique",
        "delivery_method": "Delivery Method",
        "turn_type": "Turn Type",
        "source": "Source",
    }
    dimensions = list(dim_labels.keys())

    ctrl1, ctrl2 = st.columns(2)
    with ctrl1:
        group_by = st.selectbox(
            "Group by (Y-Axis)",
            options=dimensions,
            format_func=lambda x: dim_labels.get(x, x),
            key="breakdown_group_by",
        )
    with ctrl2:
        stack_options = ["None"] + [d for d in dimensions if d != group_by]
        stack_label = st.selectbox(
            "Stack / Color by",
            options=stack_options,
            format_func=lambda x: "None" if x == "None" else dim_labels.get(x, x),
            key="breakdown_stack_by",
        )
        stack_by: str | None = None if stack_label == "None" else stack_label

    # Extract per-result dimension values
    def _dim_value(r: RedTeamResult, dim: str) -> str:
        if dim == "category":
            return _fmt_category(r.attack.category)
        if dim == "severity":
            return r.attack.severity.value
        if dim == "attack_technique":
            return r.attack.attack_technique.value
        if dim == "delivery_method":
            return r.attack.delivery_methods[0].value if r.attack.delivery_methods else "unknown"
        if dim == "turn_type":
            return r.attack.turn_type.value if r.attack.turn_type else "unknown"
        if dim == "source":
            return r.attack.source
        return "unknown"

    # Build chart data
    from collections import defaultdict

    if stack_by is None:
        # Simple grouped bar: dimension -> {vuln, total}
        groups: dict[str, dict[str, int]] = defaultdict(lambda: {"vuln": 0, "total": 0})
        for r in results:
            key = _dim_value(r, group_by)
            groups[key]["total"] += 1
            if r.vulnerable:
                groups[key]["vuln"] += 1

        chart_rows = []
        for name, counts in groups.items():
            asr = (counts["vuln"] / counts["total"] * 100) if counts["total"] else 0
            chart_rows.append({"dimension": name, "asr": round(asr, 1), "n": counts["total"]})

        chart_rows.sort(key=lambda r: r["asr"], reverse=True)
        names = [r["dimension"] for r in chart_rows]

        fig = go.Figure(go.Bar(
            y=names, x=[r["asr"] for r in chart_rows],
            orientation="h",
            marker_color=QUALITATIVE[:len(names)],
            text=[f'{r["asr"]:.1f}% (n={r["n"]})' for r in chart_rows],
            textposition="inside",
            textfont=dict(color="white", size=10),
        ))
        fig.update_layout(
            height=max(350, len(names) * 40),
            margin=dict(l=20, r=20, t=10, b=20),
            xaxis_title="ASR (%)",
            yaxis_title=dim_labels.get(group_by, group_by),
            showlegend=False,
        )
    else:
        # Stacked bar: dimension x stack_dim
        groups_stacked: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"vuln": 0, "total": 0})
        for r in results:
            g = _dim_value(r, group_by)
            s = _dim_value(r, stack_by)
            groups_stacked[(g, s)]["total"] += 1
            if r.vulnerable:
                groups_stacked[(g, s)]["vuln"] += 1

        chart_rows_s = []
        for (g, s), counts in groups_stacked.items():
            asr = (counts["vuln"] / counts["total"] * 100) if counts["total"] else 0
            chart_rows_s.append({
                "dimension": g, "stack": s,
                "asr": round(asr, 1), "n": counts["total"],
            })

        # Sort dimensions by average ASR descending
        dim_asr: dict[str, list[float]] = defaultdict(list)
        for r in chart_rows_s:
            dim_asr[r["dimension"]].append(r["asr"])
        dim_order = sorted(dim_asr.keys(), key=lambda d: sum(dim_asr[d]) / len(dim_asr[d]), reverse=True)

        # Use severity colors if stacking by severity, otherwise qualitative
        stack_vals = sorted({r["stack"] for r in chart_rows_s})
        if stack_by == "severity":
            color_map = SEVERITY_COLORS
        else:
            color_map = {v: QUALITATIVE[i % len(QUALITATIVE)] for i, v in enumerate(stack_vals)}

        fig = go.Figure()
        for sv in stack_vals:
            sv_rows = {r["dimension"]: r for r in chart_rows_s if r["stack"] == sv}
            y_vals = dim_order
            x_vals = [sv_rows[d]["asr"] if d in sv_rows else 0 for d in dim_order]
            n_vals = [sv_rows[d]["n"] if d in sv_rows else 0 for d in dim_order]

            fig.add_trace(go.Bar(
                y=y_vals, x=x_vals, name=sv,
                orientation="h",
                marker_color=color_map.get(sv, COLORS['sand_400']),
                text=[f"n={n}" for n in n_vals],
                textposition="inside",
                textfont=dict(color="white", size=9),
            ))

        fig.update_layout(
            barmode="stack",
            height=max(400, len(dim_order) * 55),
            margin=dict(l=20, r=20, t=10, b=20),
            xaxis_title="ASR (%)",
            yaxis_title=dim_labels.get(group_by, group_by),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, title_text=dim_labels.get(stack_by, stack_by)),
        )

    st.plotly_chart(fig, width="stretch")

    # Category details expander (always available)
    if summary.by_category:
        with st.expander("Category Details"):
            rows = []
            for c in sorted(summary.by_category.values(), key=lambda c: c.resistance_rate):
                rows.append({
                    "Category": _fmt_category(c.category),
                    "Attacks": c.total_attacks,
                    "Evaluated": c.evaluated_attacks,
                    "Vulnerable": c.vulnerabilities_found,
                    "Resistance": f"{c.resistance_rate:.1%}",
                    "Errors": c.total_errors,
                    "Strategies": ", ".join(c.strategies_used) if c.strategies_used else "-",
                })
            st.dataframe(rows, use_container_width=True, hide_index=True)


# ---------------------------------------------------------------------------
# Turn Depth Analysis
# ---------------------------------------------------------------------------


def _render_turn_depth_analysis(results: list[RedTeamResult]) -> None:
    """Show when vulnerabilities are found across conversation turns."""
    multi_turn = [r for r in results if r.execution and r.execution.turns and r.execution.turns > 1]
    if not multi_turn:
        return

    st.divider()
    st.subheader("Conversation Depth Analysis")
    st.caption("How attack success varies with conversation length. Only includes multi-turn attacks.")

    # Group by turn count
    turn_data: dict[int, dict[str, int]] = {}
    for r in multi_turn:
        turns = r.execution.turns  # type: ignore[union-attr]
        if turns not in turn_data:
            turn_data[turns] = {"total": 0, "vulnerable": 0}
        turn_data[turns]["total"] += 1
        if r.vulnerable:
            turn_data[turns]["vulnerable"] += 1

    col_left, col_right = st.columns(2)

    with col_left:
        sorted_turns = sorted(turn_data.keys())
        totals = [turn_data[t]["total"] for t in sorted_turns]
        vulns = [turn_data[t]["vulnerable"] for t in sorted_turns]
        asrs = [(v / t * 100) if t else 0 for v, t in zip(vulns, totals)]

        fig = go.Figure()
        fig.add_trace(go.Bar(
            x=[str(t) for t in sorted_turns], y=asrs,
            marker_color=[_defense_rate_color(1 - a / 100) for a in asrs],
            text=[f"{a:.0f}%<br>n={n}" for a, n in zip(asrs, totals)],
            textposition="outside",
        ))
        fig.update_layout(
            height=350, xaxis_title="Conversation Turns", yaxis_title="ASR (%)",
            margin=dict(l=20, r=20, t=10, b=20),
        )
        st.plotly_chart(fig, width="stretch")

    with col_right:
        # Cumulative vulnerability discovery curve
        vuln_results = [r for r in multi_turn if r.vulnerable]
        if vuln_results:
            total_vulns = len(vuln_results)
            sorted_turns = sorted(turn_data.keys())
            cumulative = []
            running = 0
            for t in sorted_turns:
                running += turn_data[t]["vulnerable"]
                cumulative.append(running / total_vulns * 100)

            fig = go.Figure(go.Scatter(
                x=[str(t) for t in sorted_turns], y=cumulative,
                mode="lines+markers+text",
                marker=dict(size=8, color=COLORS['orange_300']),
                line=dict(color=COLORS['orange_300'], width=2),
                text=[f"{c:.0f}%" for c in cumulative],
                textposition="top center",
                textfont=dict(size=10),
            ))
            fig.update_layout(
                height=350,
                xaxis_title="Conversation Turns",
                yaxis_title="% of Vulnerabilities Found",
                yaxis_range=[0, 105],
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")
        else:
            st.info("No multi-turn vulnerabilities found.")


# ---------------------------------------------------------------------------
# Attack Failure Treemap
# ---------------------------------------------------------------------------


def _render_attack_failure_treemap(results: list[RedTeamResult]) -> None:
    """Treemap showing attack failures: Category -> Technique, size=failures, color=ASR%."""
    vulnerable_results = [r for r in results if r.vulnerable]
    if not vulnerable_results:
        return

    st.divider()
    st.subheader("Attack Failure Treemap")
    st.caption("Block size = number of successful attacks. Color intensity = attack success rate.")

    # Build grouped data: (category, technique) -> {failures, total}
    from collections import defaultdict

    groups: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"failures": 0, "total": 0})
    for r in results:
        key = (_fmt_category(r.attack.category), r.attack.attack_technique.value)
        groups[key]["total"] += 1
        if r.vulnerable:
            groups[key]["failures"] += 1

    rows = []
    for (cat, tech), counts in groups.items():
        if counts["failures"] > 0:
            rows.append({
                "category": cat,
                "technique": tech,
                "failures": counts["failures"],
                "total": counts["total"],
                "asr": round(counts["failures"] / counts["total"] * 100, 1),
            })

    if not rows:
        return

    fig = px.treemap(
        rows,
        path=["category", "technique"],
        values="failures",
        color="asr",
        color_continuous_scale=ORQ_SCALE_AGENT,
        range_color=[0, 100],
        custom_data=["total", "asr", "category"],
    )
    fig.update_traces(
        texttemplate="<b>%{label}</b><br>%{value} failures",
        hovertemplate=(
            "<b>%{label}</b><br>"
            "Category: %{customdata[2]}<br>"
            "Failures: %{value}<br>"
            "Total: %{customdata[0]}<br>"
            "ASR: %{customdata[1]:.1f}%"
            "<extra></extra>"
        ),
    )
    fig.update_layout(
        height=600,
        coloraxis_colorbar=dict(title="ASR (%)"),
        margin=dict(l=10, r=10, t=10, b=10),
    )
    st.plotly_chart(fig, width="stretch")


# ---------------------------------------------------------------------------
# Data Explorer
# ---------------------------------------------------------------------------


def _render_data_explorer(report: RedTeamReport, summary: ReportSummary) -> None:
    st.header("Dataset Overview")

    results = report.results
    if not results:
        st.info("No results to explore.")
        return

    # Overview metrics from summary breakdowns
    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Total Samples", f"{summary.total_attacks:,}")
    col2.metric("Categories", f"{len(summary.by_category)}")
    col3.metric("Attack Techniques", f"{len(summary.by_technique)}")
    col4.metric("Delivery Methods", f"{len(summary.by_delivery_method)}")
    sources = {r.attack.source for r in results}
    col5.metric("Sources", f"{len(sources)}")

    st.divider()

    # Distribution charts row 1
    col_left, col_right = st.columns(2)

    with col_left:
        st.subheader("Categories by Severity")
        if summary.by_category and summary.by_severity:
            # Build from results for cross-dimension
            cat_sev: Counter[tuple[str, str]] = Counter()
            for r in results:
                cat_sev[(r.attack.category, r.attack.severity.value)] += 1

            rows = [{"category": cat, "severity": sev, "count": cnt} for (cat, sev), cnt in cat_sev.items()]
            if rows:
                fig = px.bar(
                    rows, y="category", x="count", color="severity",
                    orientation="h", title="",
                    color_discrete_map=SEVERITY_COLORS,
                    category_orders={"severity": SEVERITY_ORDER},
                )
                fig.update_layout(
                    barmode="stack", height=max(350, len(summary.by_category) * 35),
                    margin=dict(l=20, r=20, t=10, b=20), legend_title_text="Severity",
                )
                st.plotly_chart(fig, width="stretch")

    with col_right:
        st.subheader("Attack Technique Distribution")
        if summary.by_technique:
            items = sorted(summary.by_technique.items(), key=lambda t: t[1].total_attacks)
            names = [k for k, _ in items]
            counts = [v.total_attacks for _, v in items]

            fig = px.bar(
                x=counts, y=names, orientation="h",
                labels={"x": "Sample Count", "y": "Technique"},
                text=counts,
            )
            fig.update_traces(textposition="outside", marker_color=COLORS['orange_300'])
            fig.update_layout(
                showlegend=False, height=max(350, len(names) * 30),
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")

    # Distribution charts row 2
    col_left2, col_right2 = st.columns(2)

    with col_left2:
        st.subheader("Delivery Method Distribution")
        if summary.by_delivery_method:
            items = sorted(summary.by_delivery_method.items(), key=lambda t: t[1].total_attacks, reverse=True)
            names = [k for k, _ in items]
            counts = [v.total_attacks for _, v in items]

            fig = px.bar(
                x=names, y=counts,
                labels={"x": "Delivery Method", "y": "Sample Count"},
                text=counts,
            )
            fig.update_traces(textposition="outside", marker_color=COLORS['blue_400'])
            fig.update_layout(
                showlegend=False, height=350,
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")

    with col_right2:
        st.subheader("Source Distribution")
        if sources:
            source_counts = Counter(r.attack.source for r in results)
            fig = go.Figure(go.Pie(
                labels=list(source_counts.keys()),
                values=list(source_counts.values()),
                marker_colors=QUALITATIVE[:len(source_counts)],
                hole=0.4, textinfo="label+value",
            ))
            fig.update_layout(height=350, margin=dict(l=20, r=20, t=10, b=20))
            st.plotly_chart(fig, width="stretch")

    # Dimension counts
    st.divider()
    st.subheader("Dimension Counts")

    dimensions: list[tuple[str, str, dict[str, int]]] = []
    if summary.by_category:
        dimensions.append(("Category", f"{len(summary.by_category)} unique", {_fmt_category(k): v.total_attacks for k, v in summary.by_category.items()}))
    if summary.by_technique:
        dimensions.append(("Technique", f"{len(summary.by_technique)} unique", {k: v.total_attacks for k, v in summary.by_technique.items()}))
    if summary.by_delivery_method:
        dimensions.append(("Delivery Method", f"{len(summary.by_delivery_method)} unique", {k: v.total_attacks for k, v in summary.by_delivery_method.items()}))
    if summary.by_severity:
        dimensions.append(("Severity", f"{len(summary.by_severity)} unique", {k: v.total_attacks for k, v in summary.by_severity.items()}))
    if summary.by_turn_type:
        dimensions.append(("Turn Type", f"{len(summary.by_turn_type)} unique", {k: v.total_attacks for k, v in summary.by_turn_type.items()}))
    if summary.by_scope:
        dimensions.append(("Scope", f"{len(summary.by_scope)} unique", {k: v.total_attacks for k, v in summary.by_scope.items()}))

    cols = st.columns(3)
    for i, (label, subtitle, counts) in enumerate(dimensions):
        with cols[i % 3]:
            with st.expander(f"{label} ({subtitle})", expanded=False):
                total = sum(counts.values())
                rows = [
                    {label: name, "Count": cnt, "%": round(cnt / total * 100, 1) if total else 0}
                    for name, cnt in sorted(counts.items(), key=lambda x: x[1], reverse=True)
                ]
                st.dataframe(rows, use_container_width=True, hide_index=True)

    # Sample Explorer
    st.divider()
    st.subheader("Sample Explorer")

    filtered = results
    st.caption(f"Showing {len(filtered)} results")

    if not filtered:
        st.info("No results match the current filters.")
        return

    # Results table — extended columns including delivery_method, turn_type, scope
    table_rows = []
    for r in filtered:
        # delivery_methods is a list in AttackInfo; join for display
        dms = getattr(r.attack, "delivery_methods", None)
        if dms:
            delivery_str = ", ".join(dm.value if hasattr(dm, "value") else str(dm) for dm in dms)
        else:
            delivery_str = "-"
        scope_val = r.attack.scope.value if r.attack.scope else "-"
        table_rows.append({
            "ID": r.attack.id,
            "Category": r.attack.category,
            "Technique": r.attack.attack_technique.value,
            "Delivery Method": delivery_str,
            "Turn Type": r.attack.turn_type.value if r.attack.turn_type else "-",
            "Scope": scope_val,
            "Severity": r.attack.severity.value,
            "Result": "VULNERABLE" if r.vulnerable else "RESISTANT",
            "Source": r.attack.source,
        })

    # Try row-click selection (Streamlit >= 1.35 supports on_select="rerun")
    st.caption("Click a row to view its conversation below.")
    selected_row_idx: int | None = None
    try:
        selection_state = st.dataframe(
            table_rows,
            use_container_width=True,
            height=300,
            hide_index=True,
            on_select="rerun",
            selection_mode="single-row",
            key="de_results_table",
        )
        rows_selected = (
            selection_state.selection.get("rows", [])
            if hasattr(selection_state, "selection") and selection_state.selection
            else []
        )
        if rows_selected:
            selected_row_idx = rows_selected[0]
    except TypeError:
        # Fallback for older Streamlit versions that do not support on_select
        st.dataframe(table_rows, use_container_width=True, height=300, hide_index=True)

    # Export buttons
    export_cols = st.columns([1, 1, 4])
    with export_cols[0]:
        import csv
        import io

        csv_buf = io.StringIO()
        writer = csv.DictWriter(csv_buf, fieldnames=table_rows[0].keys())
        writer.writeheader()
        writer.writerows(table_rows)
        st.download_button(
            "Download CSV",
            csv_buf.getvalue(),
            file_name="redteam_results.csv",
            mime="text/csv",
        )
    with export_cols[1]:
        json_data = json.dumps(
            [r.model_dump(mode="json") for r in filtered],
            indent=2, default=str,
        )
        st.download_button(
            "Download JSON",
            json_data,
            file_name="redteam_results.json",
            mime="application/json",
        )

    # Conversation viewer — driven by row click, with dropdown fallback
    st.subheader("Conversation Viewer")

    # Sync session state from row-click selection
    if selected_row_idx is not None:
        st.session_state["de_conv_select"] = selected_row_idx

    options = []
    for r in filtered:
        status = "VULN" if r.vulnerable else "SAFE"
        label = f"[{status}] {r.attack.id} / {r.attack.category} / {r.attack.attack_technique.value}"
        options.append(label)

    conv_idx = st.selectbox(
        "Select a sample",
        range(len(options)),
        format_func=lambda i: options[i],
        key="de_conv_select",
    )
    if conv_idx is not None:
        result = filtered[conv_idx]
        _render_result_detail(result)


def _render_result_detail(result: RedTeamResult) -> None:
    """Render detailed view for a single result."""
    atk = result.attack

    mc1, mc2, mc3, mc4 = st.columns(4)
    mc1.markdown(f"**Category:** {_fmt_category(atk.category)}")
    mc2.markdown(f"**Technique:** {atk.attack_technique.value}")
    mc3.markdown(f"**Severity:** {atk.severity.value}")
    mc4.markdown(f"**Turn Type:** {atk.turn_type.value}")

    if atk.delivery_methods:
        st.markdown(f"**Delivery Methods:** {', '.join(dm.value for dm in atk.delivery_methods)}")

    # Execution details
    if result.execution:
        ex = result.execution
        ec1, ec2, ec3 = st.columns(3)
        ec1.markdown(f"**Turns:** {ex.turns}" + (f" / {ex.max_turns}" if ex.max_turns else ""))
        if ex.duration_seconds is not None:
            ec2.markdown(f"**Duration:** {ex.duration_seconds:.1f}s")
        if ex.objective_achieved is not None:
            ec3.markdown(f"**Objective Achieved:** {ex.objective_achieved}")

    # Evaluation
    if result.evaluation:
        ev = result.evaluation
        if ev.passed is True:
            st.success(f"**RESISTANT** - {ev.explanation}")
        elif ev.passed is False:
            st.error(f"**VULNERABLE** - {ev.explanation}")
        else:
            st.warning(f"**Unevaluated** - {ev.explanation}")

    # Error
    if result.error:
        st.error(f"**Error ({result.error_type or 'unknown'}):** {result.error}")

    # Conversation
    if result.messages:
        st.markdown("---")
        st.markdown("**Conversation:**")
        for msg in result.messages:
            role = msg.role
            content = msg.content or ""

            if role == "system":
                with st.expander("System prompt", expanded=False):
                    st.code(content, language=None)
            elif role == "user":
                st.markdown("**User:**")
                st.code(content, language=None)
            elif role == "assistant":
                st.markdown("**Assistant:**")
                if content:
                    st.code(content, language=None)
                if msg.tool_calls:
                    for tc in msg.tool_calls:
                        st.code(
                            f"Tool call: {tc.function.name}({tc.function.arguments})",
                            language="json",
                        )
            elif role == "tool":
                name = msg.name or "tool"
                with st.expander(f"Tool response: {name}", expanded=False):
                    st.code(content, language=None)


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------


def _aggregate_token_usage(results: list[RedTeamResult]) -> dict[str, dict[str, float | int]]:
    """Aggregate token usage per agent from results."""
    agents: dict[str, dict[str, float | int]] = {}
    for r in results:
        key = r.agent.key or r.agent.display_name or "unknown"
        if key not in agents:
            agents[key] = {"total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "calls": 0, "attacks": 0}
        agents[key]["attacks"] += 1

        # Collect from execution-level token usage
        if r.execution and r.execution.token_usage:
            tu = r.execution.token_usage
            agents[key]["total_tokens"] += tu.total_tokens
            agents[key]["prompt_tokens"] += tu.prompt_tokens
            agents[key]["completion_tokens"] += tu.completion_tokens
            agents[key]["calls"] += tu.calls

        # Also add evaluation token usage
        if r.evaluation and r.evaluation.token_usage:
            eu = r.evaluation.token_usage
            agents[key]["total_tokens"] += eu.total_tokens
            agents[key]["prompt_tokens"] += eu.prompt_tokens
            agents[key]["completion_tokens"] += eu.completion_tokens
            agents[key]["calls"] += eu.calls
    return agents


def _render_usage_tab(report: RedTeamReport, summary: ReportSummary, agents: list[str]) -> None:
    st.header("Token Usage")

    # Overall totals
    tu = summary.token_usage_total
    if tu:
        col1, col2, col3, col4 = st.columns(4)
        col1.metric("Total Tokens", f"{tu.total_tokens:,}")
        col2.metric("Prompt Tokens", f"{tu.prompt_tokens:,}")
        col3.metric("Completion Tokens", f"{tu.completion_tokens:,}")
        col4.metric("API Calls", f"{tu.calls:,}")
    else:
        st.info("No aggregate token usage data available.")

    st.divider()

    # Per-agent breakdown
    agent_usage = _aggregate_token_usage(report.results)

    if agent_usage:
        st.subheader("Token Usage per Agent")

        if len(agent_usage) > 1:
            names = list(agent_usage.keys())
            tokens = [agent_usage[n]["total_tokens"] for n in names]

            fig = go.Figure(go.Bar(
                x=names, y=tokens,
                marker_color=QUALITATIVE[:len(names)],
                text=[f"{t:,}" for t in tokens], textposition="outside",
            ))
            fig.update_layout(
                height=350, yaxis_title="Total Tokens",
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")
        else:
            st.caption(f"Single agent: **{list(agent_usage.keys())[0]}**")

        # Detail table
        rows = []
        for name, usage in agent_usage.items():
            rows.append({
                "Agent": name,
                "Attacks": int(usage["attacks"]),
                "Total Tokens": f"{int(usage['total_tokens']):,}",
                "Prompt Tokens": f"{int(usage['prompt_tokens']):,}",
                "Completion Tokens": f"{int(usage['completion_tokens']):,}",
                "API Calls": int(usage["calls"]),
            })
        st.dataframe(rows, use_container_width=True, hide_index=True)

    # Token distribution histogram
    st.divider()
    st.subheader("Token Distribution per Attack")

    prompt_tokens: list[int] = []
    completion_tokens: list[int] = []
    for r in report.results:
        if r.execution and r.execution.token_usage:
            tu = r.execution.token_usage
            if tu.prompt_tokens > 0:
                prompt_tokens.append(tu.prompt_tokens)
            if tu.completion_tokens > 0:
                completion_tokens.append(tu.completion_tokens)

    if prompt_tokens or completion_tokens:
        col_left, col_right = st.columns(2)
        with col_left:
            if prompt_tokens:
                fig = go.Figure(go.Histogram(
                    x=prompt_tokens, nbinsx=30,
                    marker_color=COLORS['orange_300'],
                    name="Prompt Tokens",
                ))
                fig.update_layout(
                    height=300, xaxis_title="Tokens", yaxis_title="Frequency",
                    margin=dict(l=20, r=20, t=30, b=20),
                    title=dict(text="Prompt Tokens", font=dict(size=14)),
                )
                st.plotly_chart(fig, width="stretch")
            else:
                st.info("No prompt token data available.")

        with col_right:
            if completion_tokens:
                fig = go.Figure(go.Histogram(
                    x=completion_tokens, nbinsx=30,
                    marker_color=COLORS['blue_400'],
                    name="Completion Tokens",
                ))
                fig.update_layout(
                    height=300, xaxis_title="Tokens", yaxis_title="Frequency",
                    margin=dict(l=20, r=20, t=30, b=20),
                    title=dict(text="Completion Tokens", font=dict(size=14)),
                )
                st.plotly_chart(fig, width="stretch")
            else:
                st.info("No completion token data available.")
    else:
        st.info("No per-attack token data available.")


# ---------------------------------------------------------------------------
# Error Analysis
# ---------------------------------------------------------------------------


def _render_errors_tab(summary: ReportSummary, report: RedTeamReport) -> None:
    st.header("Error Analysis")

    error_rate = (summary.total_errors / summary.total_attacks * 100) if summary.total_attacks else 0

    col1, col2, col3 = st.columns(3)
    col1.metric("Total Errors", f"{summary.total_errors:,}")
    col2.metric("Error Rate", f"{error_rate:.1f}%")
    col3.metric("Error Types", f"{len(summary.errors_by_type):,}")

    st.divider()

    if summary.errors_by_type:
        st.subheader("Errors by Type")
        items = sorted(summary.errors_by_type.items(), key=lambda t: t[1], reverse=True)
        names = [k for k, _ in items]
        counts = [v for _, v in items]

        fig = px.bar(
            x=counts, y=names, orientation="h",
            labels={"x": "Count", "y": "Error Type"},
            text=counts,
        )
        fig.update_traces(textposition="outside", marker_color=QUALITATIVE[:len(names)])
        fig.update_layout(
            height=max(250, len(names) * 40), showlegend=False,
            margin=dict(l=20, r=20, t=10, b=20),
        )
        st.plotly_chart(fig, width="stretch")

    # Error detail table
    error_results = [r for r in report.results if r.error]
    if error_results:
        st.subheader("Error Details")
        rows = []
        for r in error_results:
            rows.append({
                "ID": r.attack.id,
                "Category": r.attack.category,
                "Technique": r.attack.attack_technique.value,
                "Error Type": r.error_type or "unknown",
                "Stage": r.error_stage or "-",
                "Error": r.error or "",
            })
        st.dataframe(rows, use_container_width=True, hide_index=True)

    # Error impact
    st.divider()
    st.subheader("Error Impact on Metrics")
    col1, col2 = st.columns(2)
    with col1:
        st.metric("Resistance Rate (including errors)", f"{summary.resistance_rate:.1%}")
    with col2:
        evaluated = summary.evaluated_attacks
        if evaluated > 0:
            vuln_of_evaluated = summary.vulnerabilities_found / evaluated
            clean_resistance = 1.0 - vuln_of_evaluated
            st.metric("Resistance Rate (errors excluded)", f"{clean_resistance:.1%}")


# ---------------------------------------------------------------------------
# Agent Comparison
# ---------------------------------------------------------------------------


def _render_agent_comparison(report: RedTeamReport, summary: ReportSummary, agents: list[str]) -> None:
    st.header("Multi-Agent Comparison")

    if len(agents) < 2:
        st.info("Agent comparison requires at least 2 agents in the report.")
        return

    # Group results by agent
    agent_results: dict[str, list[RedTeamResult]] = {a: [] for a in agents}
    for r in report.results:
        key = r.agent.key or r.agent.display_name or "unknown"
        if key in agent_results:
            agent_results[key].append(r)

    # Overall metrics per agent
    st.subheader("Overall Metrics")
    cols = st.columns(len(agents))
    for i, agent_name in enumerate(agents):
        ar = agent_results[agent_name]
        total = len(ar)
        vulns = sum(1 for r in ar if r.vulnerable)
        asr = (vulns / total * 100) if total else 0
        with cols[i]:
            st.markdown(f"### {agent_name}")
            st.metric("Attacks", f"{total:,}")
            st.metric("ASR", f"{asr:.1f}%")
            st.metric("Vulnerabilities", f"{vulns:,}")

    st.divider()

    # Agent comparison heatmap — ASR% by grouping dimension × agent
    st.subheader("Agent Heatmap")

    _dim_options: dict[str, str] = {
        "category": "Category",
        "technique": "Technique",
        "severity": "Severity",
    }
    heatmap_dim = st.selectbox(
        "Group by",
        options=list(_dim_options.keys()),
        format_func=lambda x: _dim_options.get(x, x),
        key="comp_heatmap_dim",
    )

    def _heatmap_dim_value(r: RedTeamResult, dim: str) -> str:
        if dim == "category":
            return _fmt_category(r.attack.category)
        if dim == "technique":
            return r.attack.attack_technique.value
        if dim == "severity":
            return r.attack.severity.value
        return "unknown"

    # Build pivot: rows=dim_values, cols=agents, values=ASR%
    from collections import defaultdict as _defaultdict

    pivot_data: dict[str, dict[str, dict[str, int]]] = _defaultdict(
        lambda: _defaultdict(lambda: {"total": 0, "vuln": 0})
    )
    for agent_name in agents:
        for r in agent_results[agent_name]:
            dv = _heatmap_dim_value(r, heatmap_dim)
            pivot_data[dv][agent_name]["total"] += 1
            if r.vulnerable:
                pivot_data[dv][agent_name]["vuln"] += 1

    # Sort rows
    if heatmap_dim == "severity":
        all_dim_vals = [s for s in SEVERITY_ORDER if s in pivot_data]
        other_vals = sorted(v for v in pivot_data if v not in SEVERITY_ORDER)
        all_dim_vals = all_dim_vals + other_vals
    else:
        all_dim_vals = sorted(pivot_data.keys())

    if all_dim_vals:
        # Build z-matrix (rows=dim_vals, cols=agents), text for annotations
        z_matrix = []
        text_matrix = []
        for dv in all_dim_vals:
            row_z = []
            row_text = []
            for agent_name in agents:
                counts = pivot_data[dv].get(agent_name, {"total": 0, "vuln": 0})
                asr = (counts["vuln"] / counts["total"] * 100) if counts["total"] else 0
                row_z.append(round(asr, 1))
                row_text.append(f"{asr:.0f}%<br>n={counts['total']}")
            z_matrix.append(row_z)
            text_matrix.append(row_text)

        heatmap_fig = go.Figure(go.Heatmap(
            z=z_matrix,
            x=agents,
            y=all_dim_vals,
            colorscale=ORQ_SCALE_HEAT,
            zmin=0,
            zmax=100,
            text=text_matrix,
            texttemplate="%{text}",
            textfont=dict(size=11),
            hoverongaps=False,
            colorbar=dict(title="ASR (%)"),
        ))
        heatmap_fig.update_layout(
            height=max(350, len(all_dim_vals) * 45 + 80),
            xaxis_title="Agent",
            yaxis_title=_dim_options.get(heatmap_dim, heatmap_dim),
            margin=dict(l=20, r=20, t=10, b=40),
        )
        st.plotly_chart(heatmap_fig, width="stretch")

    st.divider()

    # Per-category comparison (grouped bar chart)
    st.subheader("ASR by Category")

    cat_data: dict[str, dict[str, float]] = {}
    for agent_name in agents:
        for r in agent_results[agent_name]:
            cat = r.attack.category
            if cat not in cat_data:
                cat_data[cat] = {}
            cat_data[cat].setdefault(f"{agent_name}_total", 0)
            cat_data[cat].setdefault(f"{agent_name}_vuln", 0)
            cat_data[cat][f"{agent_name}_total"] += 1
            if r.vulnerable:
                cat_data[cat][f"{agent_name}_vuln"] += 1

    if cat_data:
        chart_rows = []
        for cat in sorted(cat_data.keys()):
            for agent_name in agents:
                total = cat_data[cat].get(f"{agent_name}_total", 0)
                vuln = cat_data[cat].get(f"{agent_name}_vuln", 0)
                asr = (vuln / total * 100) if total else 0
                chart_rows.append({
                    "category": _fmt_category(cat),
                    "agent": agent_name,
                    "asr": asr,
                    "n": total,
                })

        fig = px.bar(
            chart_rows, y="category", x="asr", color="agent",
            orientation="h", barmode="group",
            labels={"asr": "ASR (%)", "category": "Category"},
            color_discrete_sequence=QUALITATIVE,
        )
        fig.update_layout(
            height=max(350, len(cat_data) * 50),
            margin=dict(l=20, r=20, t=10, b=20),
            legend=dict(orientation="h", yanchor="bottom", y=1.02),
        )
        st.plotly_chart(fig, width="stretch")

    st.divider()

    # Agreement analysis
    st.subheader("Agent Agreement")

    # Build attack-id -> {agent: vulnerable} map
    attack_verdicts: dict[str, dict[str, bool]] = {}
    for r in report.results:
        aid = r.attack.id
        agent_key = r.agent.key or r.agent.display_name or "unknown"
        if aid not in attack_verdicts:
            attack_verdicts[aid] = {}
        attack_verdicts[aid][agent_key] = r.vulnerable

    # Count agreements/disagreements for pairs with both agents
    if len(agents) >= 2:
        a1, a2 = agents[0], agents[1]
        both_pass = 0
        both_fail = 0
        only_a1_fail = 0
        only_a2_fail = 0
        shared = 0

        for aid, verdicts in attack_verdicts.items():
            if a1 in verdicts and a2 in verdicts:
                shared += 1
                v1, v2 = verdicts[a1], verdicts[a2]
                if not v1 and not v2:
                    both_pass += 1
                elif v1 and v2:
                    both_fail += 1
                elif v1 and not v2:
                    only_a1_fail += 1
                else:
                    only_a2_fail += 1

        if shared > 0:
            agreement = (both_pass + both_fail) / shared * 100
            ac1, ac2, ac3 = st.columns(3)
            ac1.metric("Shared Samples", f"{shared:,}")
            ac2.metric("Agreement Rate", f"{agreement:.1f}%")
            ac3.metric("Disagreements", f"{only_a1_fail + only_a2_fail:,}")

            fig = go.Figure(go.Bar(
                x=["Both Resist", f"Only {a1} Fails", f"Only {a2} Fails", "Both Fail"],
                y=[both_pass, only_a1_fail, only_a2_fail, both_fail],
                marker_color=[COLORS['success_400'], COLORS['orange_300'], COLORS['orange_300'], COLORS['red_400']],
                text=[both_pass, only_a1_fail, only_a2_fail, both_fail],
                textposition="outside",
            ))
            fig.update_layout(
                height=350, yaxis_title="Count",
                margin=dict(l=20, r=20, t=10, b=20),
            )
            st.plotly_chart(fig, width="stretch")
        else:
            st.info("No shared attack samples between agents to compare.")

    # Agent delta treemap (configurable)
    if len(agents) >= 2:
        _render_agent_delta_treemap(report.results, agents)

    # Disagreement viewer
    if len(agents) >= 2:
        _render_disagreement_viewer(report.results, agents)


# ---------------------------------------------------------------------------
# Agent Delta Treemap
# ---------------------------------------------------------------------------


def _render_agent_delta_treemap(results: list[RedTeamResult], agents: list[str]) -> None:
    """Configurable treemap showing attack failures with agent and inner-dimension selectors."""
    from collections import defaultdict

    st.divider()
    st.subheader("Attack Failure Treemap (Comparison)")
    st.caption("Explore how attack failures distribute across agents and dimensions.")

    # Agent selector (filter to one agent's results)
    treemap_agent = st.selectbox(
        "Filter to agent",
        options=["All agents"] + agents,
        key="comp_treemap_agent",
    )

    # Inner dimension selector
    inner_dim_options: dict[str, str] = {
        "attack_technique": "Attack Technique",
        "delivery_method": "Delivery Method",
        "severity": "Severity",
    }
    inner_dim = st.selectbox(
        "Inner dimension",
        options=list(inner_dim_options.keys()),
        format_func=lambda x: inner_dim_options.get(x, x),
        key="comp_treemap_inner_dim",
    )

    def _inner_dim_val(r: RedTeamResult, dim: str) -> str:
        if dim == "attack_technique":
            return r.attack.attack_technique.value
        if dim == "delivery_method":
            dms = getattr(r.attack, "delivery_methods", None)
            if dms:
                return dms[0].value if hasattr(dms[0], "value") else str(dms[0])
            return "unknown"
        if dim == "severity":
            return r.attack.severity.value
        return "unknown"

    # Apply agent filter
    filtered_results = results
    if treemap_agent != "All agents":
        filtered_results = [
            r for r in results if (r.agent.key or r.agent.display_name or "unknown") == treemap_agent
        ]

    vulnerable_results = [r for r in filtered_results if r.vulnerable]
    if not vulnerable_results:
        st.info("No vulnerable results for the selected agent.")
        return

    # Build grouped data: (category, inner_dim_val) -> {failures, total}
    groups: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"failures": 0, "total": 0})
    for r in filtered_results:
        key = (_fmt_category(r.attack.category), _inner_dim_val(r, inner_dim))
        groups[key]["total"] += 1
        if r.vulnerable:
            groups[key]["failures"] += 1

    rows = []
    for (cat, dim_val), counts in groups.items():
        if counts["failures"] > 0:
            rows.append({
                "category": cat,
                "dimension": dim_val,
                "failures": counts["failures"],
                "total": counts["total"],
                "asr": round(counts["failures"] / counts["total"] * 100, 1),
            })

    if not rows:
        return

    agent_label = treemap_agent if treemap_agent != "All agents" else "all agents"
    dim_label = inner_dim_options.get(inner_dim, inner_dim)
    st.caption(
        f"Agent: **{agent_label}** | Inner dimension: **{dim_label}**. "
        "Block size = failures. Color intensity = attack success rate."
    )

    fig = px.treemap(
        rows,
        path=["category", "dimension"],
        values="failures",
        color="asr",
        color_continuous_scale=ORQ_SCALE_HEAT,
        range_color=[0, 100],
        custom_data=["total", "asr", "category"],
    )
    fig.update_traces(
        texttemplate="<b>%{label}</b><br>%{value} failures",
        hovertemplate=(
            "<b>%{label}</b><br>"
            "Category: %{customdata[2]}<br>"
            "Failures: %{value}<br>"
            "Total: %{customdata[0]}<br>"
            "ASR: %{customdata[1]:.1f}%"
            "<extra></extra>"
        ),
    )
    fig.update_layout(
        height=600,
        coloraxis_colorbar=dict(title="ASR (%)"),
        margin=dict(l=10, r=10, t=10, b=10),
    )
    st.plotly_chart(fig, width="stretch")


def _render_disagreement_viewer(results: list[RedTeamResult], agents: list[str]) -> None:
    """Side-by-side sample viewer for disagreements between two agents.

    Shows attacks where one agent is vulnerable and another is resistant.
    Paginated at 10 disagreements per page.
    """
    if len(agents) < 2:
        return

    st.divider()
    st.subheader("Disagreement Analysis")
    st.caption(
        "Attacks where agents disagree — one found vulnerable, the other resistant. "
        "Select agent pair to compare."
    )

    # Allow selecting any two agents
    if len(agents) == 2:
        a1, a2 = agents[0], agents[1]
    else:
        pair_col1, pair_col2 = st.columns(2)
        with pair_col1:
            a1 = st.selectbox("Agent A", options=agents, index=0, key="dis_agent_a")
        with pair_col2:
            remaining = [ag for ag in agents if ag != a1]
            a2 = st.selectbox("Agent B", options=remaining, index=0, key="dis_agent_b")

    # Build attack-id -> {agent: result} map
    from collections import defaultdict as _dd2

    attack_results_map: dict[str, dict[str, RedTeamResult]] = _dd2(dict)
    for r in results:
        agent_key = r.agent.key or r.agent.display_name or "unknown"
        if agent_key in (a1, a2):
            attack_results_map[r.attack.id][agent_key] = r

    # Find disagreements
    disagreements: list[tuple[RedTeamResult, RedTeamResult]] = []
    for aid, agent_map in attack_results_map.items():
        if a1 not in agent_map or a2 not in agent_map:
            continue
        r1, r2 = agent_map[a1], agent_map[a2]
        if r1.vulnerable != r2.vulnerable:
            disagreements.append((r1, r2))

    if not disagreements:
        st.info(f"No disagreements found between **{a1}** and **{a2}**.")
        return

    PAGE_SIZE = 10
    total_pages = max(1, (len(disagreements) + PAGE_SIZE - 1) // PAGE_SIZE)

    st.caption(f"Found {len(disagreements)} disagreements between **{a1}** and **{a2}**.")

    page = st.number_input(
        "Page",
        min_value=1,
        max_value=total_pages,
        value=1,
        step=1,
        key="dis_page",
        help=f"Page 1 of {total_pages} ({PAGE_SIZE} per page)",
    )

    start = (page - 1) * PAGE_SIZE
    end = start + PAGE_SIZE
    page_items = disagreements[start:end]

    for idx, (r1, r2) in enumerate(page_items, start=start + 1):
        with st.expander(
            f"#{idx} {r1.attack.id} — {_fmt_category(r1.attack.category)} / {r1.attack.attack_technique.value}",
            expanded=(idx == start + 1),  # expand first item by default
        ):
            col_a, col_b = st.columns(2)

            for col, r, agent_name in [(col_a, r1, a1), (col_b, r2, a2)]:
                with col:
                    verdict = "VULNERABLE" if r.vulnerable else "RESISTANT"
                    verdict_color = COLORS['red_400'] if r.vulnerable else COLORS['success_400']
                    st.markdown(
                        f"**{agent_name}** "
                        f"<span style='color:{verdict_color}; font-weight:bold;'>[{verdict}]</span>",
                        unsafe_allow_html=True,
                    )

                    # Show the last user message as the attack prompt
                    user_msgs = [m for m in r.messages if m.role == "user"]
                    if user_msgs:
                        st.markdown("**Attack prompt:**")
                        prompt_text = user_msgs[-1].content or ""
                        st.code(
                            prompt_text[:600] + ("…" if len(prompt_text) > 600 else ""),
                            language=None,
                        )

                    # Agent response
                    if r.response:
                        st.markdown("**Response:**")
                        resp = r.response
                        st.code(
                            resp[:600] + ("…" if len(resp) > 600 else ""),
                            language=None,
                        )

                    # Evaluator explanation
                    if r.evaluation and r.evaluation.explanation:
                        st.markdown("**Evaluator:**")
                        expl = r.evaluation.explanation
                        st.caption(expl[:400] + ("…" if len(expl) > 400 else ""))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

_render_dashboard()
