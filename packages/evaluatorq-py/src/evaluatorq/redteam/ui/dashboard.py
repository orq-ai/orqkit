"""Interactive Streamlit dashboard for exploring red team reports.

Launch via CLI:  evaluatorq-redteam ui /path/to/report.json
Or directly:     streamlit run dashboard.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from evaluatorq.redteam.contracts import (
    OWASP_CATEGORY_NAMES,
    RedTeamReport,
    RedTeamResult,
    ReportSummary,
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

# ---------------------------------------------------------------------------
# Color palette
# ---------------------------------------------------------------------------

SEVERITY_COLORS: dict[str, str] = {
    "critical": "#991B1B",
    "high": "#EF4444",
    "medium": "#FB923C",
    "low": "#FCD34D",
}

SEVERITY_ORDER = ["critical", "high", "medium", "low"]


def _fmt_category(code: str) -> str:
    name = OWASP_CATEGORY_NAMES.get(code)
    return f"{code} - {name}" if name else code


def _status_icon(rate: float) -> str:
    if rate >= 0.9:
        return "\u2705"
    if rate >= 0.8:
        return "\U0001f7e0"
    return "\u274c"


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
def _load_report(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _parse_report(data: dict) -> RedTeamReport:
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
    return f"{cat} + {tech}", count


def _critical_exposure(results: list[RedTeamResult]) -> int:
    return sum(1 for r in results if r.vulnerable and r.attack.severity.value == "critical")


def _compliant_categories(summary: ReportSummary) -> tuple[int, int]:
    """Return (fully_compliant, total) category counts."""
    total = len(summary.by_category)
    compliant = sum(1 for c in summary.by_category.values() if c.vulnerabilities_found == 0)
    return compliant, total


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
                "```\nevaluatorq-redteam ui /path/to/report.json\n```"
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
    if report.tested_agents:
        st.sidebar.markdown(f"**Agents:** {', '.join(report.tested_agents)}")
    if report.duration_seconds is not None:
        mins, secs = divmod(int(report.duration_seconds), 60)
        st.sidebar.markdown(f"**Duration:** {mins}m {secs}s")

    # Agent context
    if report.agent_context:
        ctx = report.agent_context
        st.sidebar.divider()
        st.sidebar.markdown(f"### {ctx.display_name or ctx.key or 'Agent'}")
        if ctx.description:
            st.sidebar.caption(ctx.description)
        if ctx.model:
            st.sidebar.markdown(f":brain: **Model:** `{ctx.model}`")
        if ctx.tools:
            st.sidebar.markdown(":wrench: **Tools**")
            tool_colors = ["blue", "green", "orange", "red", "violet", "rainbow"]
            for i, t in enumerate(ctx.tools):
                color = tool_colors[i % len(tool_colors)]
                st.sidebar.markdown(f"&nbsp;&nbsp;&nbsp;&nbsp;:{color}[`{t.name or 'unknown'}`]")
        if ctx.memory_stores:
            st.sidebar.markdown(f":file_cabinet: **Memory:** {len(ctx.memory_stores)} store(s)")
            for m in ctx.memory_stores:
                st.sidebar.markdown(f"&nbsp;&nbsp;&nbsp;&nbsp;`{m.key or m.id or 'unknown'}`")
        if ctx.knowledge_bases:
            st.sidebar.markdown(f":books: **Knowledge:** {len(ctx.knowledge_bases)} base(s)")
            for kb in ctx.knowledge_bases:
                st.sidebar.markdown(f"&nbsp;&nbsp;&nbsp;&nbsp;`{kb.name or kb.key or kb.id or 'unknown'}`")

    # Title
    framework_name = report.framework.value if report.framework else "OWASP"
    st.title("Red Team Security Report")

    # Detect multi-agent
    unique_agents = sorted({r.agent.key or r.agent.display_name or "unknown" for r in report.results})
    has_multi_agent = len(unique_agents) >= 2

    # Build tabs
    tab_names = ["\U0001f4ca Summary", "\U0001f50d Breakdown", "\U0001f4c2 Explorer"]
    has_usage = summary.token_usage_total is not None or any(
        r.attack.token_usage is not None or (r.execution and r.execution.token_usage) for r in report.results
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
        _render_executive_summary(report, summary, framework_name)
    tab_idx += 1

    with tabs[tab_idx]:
        _render_technical_analysis(report, summary)
    tab_idx += 1

    with tabs[tab_idx]:
        _render_data_explorer(report, summary)
    tab_idx += 1

    if has_usage:
        with tabs[tab_idx]:
            _render_usage_tab(report, summary, unique_agents if has_multi_agent else [])
        tab_idx += 1

    if summary.total_errors > 0:
        with tabs[tab_idx]:
            _render_errors_tab(summary, report)
        tab_idx += 1

    if has_multi_agent:
        with tabs[tab_idx]:
            _render_agent_comparison(report, summary, unique_agents)


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
        "Critical Risk Exposure", f"{critical_count}",
        delta="Release Blocked" if critical_count > 0 else "Clear",
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

    # Severity bar chart + Category defense status table
    col_left, col_right = st.columns(2)

    with col_left:
        st.subheader("Severity of Successful Attacks")
        if summary.by_severity:
            items = [(k, summary.by_severity[k]) for k in SEVERITY_ORDER if k in summary.by_severity]
            names = [k for k, _ in items]
            vuln_counts = [v.vulnerabilities_found for _, v in items]
            colors = [SEVERITY_COLORS.get(k, "#94A3B8") for k in names]

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

    with col_right:
        st.subheader("OWASP Category Defense Status")
        if summary.by_category:
            rows = []
            for cat in sorted(summary.by_category.values(), key=lambda c: c.category):
                rows.append({
                    "Category": _fmt_category(cat.category),
                    "Status": _status_icon(cat.resistance_rate),
                    "Defense Rate": f"{cat.resistance_rate:.1%}",
                })
            st.dataframe(rows, use_container_width=True, hide_index=True, height=360)
            st.caption("\u2705 \u226590% | \U0001f7e0 80-90% | \u274c <80%")


# ---------------------------------------------------------------------------
# Technical Analysis
# ---------------------------------------------------------------------------


def _render_technical_analysis(report: RedTeamReport, summary: ReportSummary) -> None:
    st.header("Deep Dive Analysis")

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

    # Category breakdown chart
    st.subheader("Per-Category Breakdown")
    if summary.by_category:
        cats = sorted(summary.by_category.values(), key=lambda c: c.resistance_rate)
        labels = [_fmt_category(c.category) for c in cats]
        vulnerability = [c.vulnerability_rate * 100 for c in cats]
        resistance = [c.resistance_rate * 100 for c in cats]

        fig = go.Figure()
        fig.add_trace(go.Bar(
            y=labels, x=vulnerability, name="Vulnerability Rate",
            orientation="h", marker_color="#EF4444",
            text=[f"{v:.1f}%" for v in vulnerability], textposition="inside",
        ))
        fig.add_trace(go.Bar(
            y=labels, x=resistance, name="Resistance Rate",
            orientation="h", marker_color="#22C55E",
            text=[f"{r:.1f}%" for r in resistance], textposition="inside",
        ))
        fig.update_layout(
            barmode="group", height=max(300, len(cats) * 50),
            margin=dict(l=20, r=20, t=20, b=20),
            legend=dict(orientation="h", yanchor="bottom", y=1.02),
            xaxis_title="Rate (%)",
        )
        st.plotly_chart(fig, width="stretch")

        with st.expander("Category Details"):
            rows = []
            for c in cats:
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
                color=vuln_rates, color_continuous_scale="Reds",
            )
            fig.update_traces(textposition="inside", textfont=dict(color="white", size=10))
            fig.update_layout(
                height=max(300, len(names) * 35), showlegend=False,
                margin=dict(l=20, r=20, t=10, b=20), coloraxis_showscale=False,
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
                color=vuln_rates, color_continuous_scale="Reds",
            )
            fig.update_traces(textposition="inside", textfont=dict(color="white", size=10))
            fig.update_layout(
                height=max(300, len(names) * 35), showlegend=False,
                margin=dict(l=20, r=20, t=10, b=20), coloraxis_showscale=False,
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
            colors = [SEVERITY_COLORS.get(k, "#94A3B8") for k in names]

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
                marker_colors=["#3B82F6", "#8B5CF6"],
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
                marker_colors=["#F59E0B", "#06B6D4"],
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
            color=vuln_rates, color_continuous_scale="Reds",
        )
        fig.update_traces(textposition="outside")
        fig.update_layout(
            height=350, showlegend=False,
            margin=dict(l=20, r=20, t=10, b=20), coloraxis_showscale=False,
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
            fig.update_traces(textposition="outside")
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
            fig.update_traces(textposition="outside")
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

    # Filters
    fc1, fc2, fc3, fc4 = st.columns(4)

    categories = sorted({r.attack.category for r in results})
    with fc1:
        sel_cats = st.multiselect("Category", categories, default=[], key="de_cats")

    techniques = sorted({r.attack.attack_technique.value for r in results})
    with fc2:
        sel_techs = st.multiselect("Technique", techniques, default=[], key="de_techs")

    with fc3:
        sel_vuln = st.selectbox("Result", ["All", "Vulnerable", "Resistant"], key="de_vuln")

    with fc4:
        sel_sevs = st.multiselect("Severity", SEVERITY_ORDER, default=[], key="de_sevs")

    # Apply filters
    filtered = results
    if sel_cats:
        filtered = [r for r in filtered if r.attack.category in sel_cats]
    if sel_techs:
        filtered = [r for r in filtered if r.attack.attack_technique.value in sel_techs]
    if sel_vuln == "Vulnerable":
        filtered = [r for r in filtered if r.vulnerable]
    elif sel_vuln == "Resistant":
        filtered = [r for r in filtered if not r.vulnerable]
    if sel_sevs:
        filtered = [r for r in filtered if r.attack.severity.value in sel_sevs]

    st.caption(f"Showing {len(filtered)} of {len(results)} results")

    if not filtered:
        st.info("No results match the current filters.")
        return

    # Results table
    table_rows = []
    for r in filtered:
        table_rows.append({
            "ID": r.attack.id,
            "Category": r.attack.category,
            "Technique": r.attack.attack_technique.value,
            "Severity": r.attack.severity.value,
            "Result": "VULNERABLE" if r.vulnerable else "RESISTANT",
            "Source": r.attack.source,
        })
    st.dataframe(table_rows, use_container_width=True, height=300, hide_index=True)

    # Conversation viewer
    st.subheader("Conversation Viewer")
    options = []
    for r in filtered:
        status = "VULN" if r.vulnerable else "SAFE"
        label = f"[{status}] {r.attack.id} / {r.attack.category} / {r.attack.attack_technique.value}"
        options.append(label)

    selected_idx = st.selectbox("Select a sample", range(len(options)), format_func=lambda i: options[i], key="de_conv_select")
    if selected_idx is not None:
        result = filtered[selected_idx]
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

        # Collect from attack-level token usage
        tu = r.attack.token_usage
        if tu:
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
                marker_color=["#3B82F6", "#8B5CF6", "#06B6D4", "#F59E0B", "#EF4444"][:len(names)],
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

    # Token usage breakdown by role (adversarial vs target)
    has_breakdown = any(r.attack.token_usage_adversarial or r.attack.token_usage_target for r in report.results)
    if has_breakdown:
        st.divider()
        st.subheader("Adversarial vs Target Usage")

        adv_tokens = 0
        tgt_tokens = 0
        for r in report.results:
            if r.attack.token_usage_adversarial:
                adv_tokens += r.attack.token_usage_adversarial.total_tokens
            if r.attack.token_usage_target:
                tgt_tokens += r.attack.token_usage_target.total_tokens

        fig = go.Figure(go.Pie(
            labels=["Adversarial", "Target"],
            values=[adv_tokens, tgt_tokens],
            marker_colors=["#EF4444", "#3B82F6"],
            textinfo="label+value+percent", hole=0.4,
        ))
        fig.update_layout(title="Tokens by Role", height=350, margin=dict(l=20, r=20, t=40, b=20))
        st.plotly_chart(fig, width="stretch")

        st.dataframe([
            {"Role": "Adversarial (attacker LLM)", "Tokens": f"{adv_tokens:,}"},
            {"Role": "Target (agent under test)", "Tokens": f"{tgt_tokens:,}"},
        ], use_container_width=True, hide_index=True)


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
            text=counts, color=counts, color_continuous_scale="Reds",
        )
        fig.update_traces(textposition="outside")
        fig.update_layout(
            height=max(250, len(names) * 40), showlegend=False,
            margin=dict(l=20, r=20, t=10, b=20), coloraxis_showscale=False,
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

    # Per-category comparison
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
                marker_color=["#22C55E", "#FB923C", "#FB923C", "#EF4444"],
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


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

_render_dashboard()
