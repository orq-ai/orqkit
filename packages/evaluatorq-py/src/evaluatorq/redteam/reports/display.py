"""Rich terminal display for red team report summaries."""

from __future__ import annotations

from rich import box
from rich.console import Console
from rich.table import Table
from rich.text import Text

from evaluatorq.redteam.contracts import OWASP_CATEGORY_NAMES, RedTeamReport


def _format_category_label(category: str) -> str:
    """Format ``'ASI01'`` → ``'ASI01 - Prompt Injection'``."""
    name = OWASP_CATEGORY_NAMES.get(category)
    if name:
        return f"{category} - {name}"
    return category


def _rate_style(rate: float) -> str:
    """Return a Rich color style for a resistance/coverage rate."""
    if rate >= 0.8:
        return "green"
    if rate >= 0.5:
        return "yellow"
    return "red"


def print_report_summary(report: RedTeamReport) -> None:
    """Print a Rich summary of a :class:`RedTeamReport` to the terminal.

    Displays:
    * High-level stats (total attacks, vulnerabilities, resistance rate, …)
    * Per-category breakdown sorted by vulnerability rate (worst first)
    * Top vulnerable techniques (if any)
    * Top error causes (if any)
    """
    console = Console()
    summary = report.summary

    # ── Title ──────────────────────────────────────────────────────────
    console.print()
    console.print("[bold underline white]RED TEAM REPORT SUMMARY[/bold underline white]")
    console.print()

    # ── Summary stats table ────────────────────────────────────────────
    stats = Table(show_header=True, header_style="bold", box=box.ROUNDED)
    stats.add_column("Metric", style="white", width=22)
    stats.add_column("Value", width=15)

    stats.add_row("Total Attacks", Text(str(summary.total_attacks), style="cyan"))
    stats.add_row("Evaluated", Text(str(summary.evaluated_attacks), style="cyan"))
    stats.add_row(
        "Vulnerabilities",
        Text(str(summary.vulnerabilities_found), style="red" if summary.vulnerabilities_found else "green"),
    )
    stats.add_row(
        "Resistance Rate",
        Text(f"{summary.resistance_rate:.0%}", style=_rate_style(summary.resistance_rate)),
    )
    stats.add_row(
        "Eval Coverage",
        Text(f"{summary.evaluation_coverage:.0%}", style=_rate_style(summary.evaluation_coverage)),
    )
    if report.duration_seconds is not None:
        mins, secs = divmod(int(report.duration_seconds), 60)
        stats.add_row("Duration", Text(f"{mins}m {secs}s", style="cyan"))
    if summary.total_errors:
        stats.add_row("Errors", Text(str(summary.total_errors), style="red"))

    # Datapoint breakdown from metadata
    meta = report.metadata or {}
    if "num_datapoints" in meta:
        stats.add_row("Datapoints", Text(str(meta["num_datapoints"]), style="cyan"))
    breakdown = meta.get("breakdown")
    if breakdown:
        parts = []
        if breakdown.get("static", 0):
            parts.append(f"{breakdown['static']} static")
        if breakdown.get("template_dynamic", 0):
            parts.append(f"{breakdown['template_dynamic']} template")
        if breakdown.get("generated_dynamic", 0):
            parts.append(f"{breakdown['generated_dynamic']} generated")
        if parts:
            stats.add_row("  Breakdown", Text(", ".join(parts), style="cyan"))

    console.print(stats)
    console.print()

    # ── Per-category breakdown ─────────────────────────────────────────
    if summary.by_category:
        sorted_cats = sorted(
            summary.by_category.values(),
            key=lambda c: (1.0 - c.resistance_rate, -c.total_attacks),
            reverse=False,
        )
        # Show worst-first (lowest resistance first)
        sorted_cats = sorted(
            summary.by_category.values(),
            key=lambda c: c.resistance_rate,
        )

        cat_table = Table(show_header=True, header_style="bold", box=box.ROUNDED)
        cat_table.add_column("Category", style="white", min_width=30)
        cat_table.add_column("Attacks", justify="right", width=9)
        cat_table.add_column("Vulnerable", justify="right", width=11)
        cat_table.add_column("Resistance", justify="right", width=11)

        for cat_summary in sorted_cats:
            cat_table.add_row(
                _format_category_label(cat_summary.category),
                Text(str(cat_summary.total_attacks), style="cyan"),
                Text(
                    str(cat_summary.vulnerabilities_found),
                    style="red" if cat_summary.vulnerabilities_found else "green",
                ),
                Text(
                    f"{cat_summary.resistance_rate:.0%}",
                    style=_rate_style(cat_summary.resistance_rate),
                ),
            )

        console.print("[bold white]Per-Category Breakdown:[/bold white]")
        console.print(cat_table)
        console.print()

    # ── Top vulnerable techniques ──────────────────────────────────────
    if summary.by_technique:
        top_techniques = sorted(summary.by_technique.items(), key=lambda t: t[1], reverse=True)[:5]
        tech_table = Table(show_header=True, header_style="bold", box=box.ROUNDED)
        tech_table.add_column("Technique", style="white", min_width=25)
        tech_table.add_column("Vulnerabilities", justify="right", width=16)

        for technique, count in top_techniques:
            tech_table.add_row(technique, Text(str(count), style="red"))

        console.print("[bold white]Top Vulnerable Techniques:[/bold white]")
        console.print(tech_table)
        console.print()

    # ── Top error causes ───────────────────────────────────────────────
    if summary.errors_by_type:
        top_errors = sorted(summary.errors_by_type.items(), key=lambda t: t[1], reverse=True)[:5]
        err_table = Table(show_header=True, header_style="bold", box=box.ROUNDED)
        err_table.add_column("Error Type", style="white", min_width=25)
        err_table.add_column("Count", justify="right", width=8)

        for error_type, count in top_errors:
            err_table.add_row(error_type, Text(str(count), style="red"))

        console.print("[bold white]Top Error Causes:[/bold white]")
        console.print(err_table)
        console.print()
