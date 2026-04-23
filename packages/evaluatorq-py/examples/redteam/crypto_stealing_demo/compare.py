"""Render two red_team reports side-by-side with rich."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.table import Table


def _load(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def _rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    results = report.get("results") or report.get("datapoints") or []
    out: list[dict[str, Any]] = []
    for r in results:
        vuln = r.get("attack", {}).get("vulnerability") or r.get("vulnerability") or "unknown"
        messages = r.get("messages", [])
        last_user = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
            "",
        )
        preview = (last_user or "")[:60]
        ev = r.get("evaluation") or {}
        vulnerable = r.get("vulnerable")
        verdict = (
            "VULNERABLE"
            if vulnerable is True
            else "RESISTANT"
            if vulnerable is False
            else (ev.get("explanation", "?")[:20] if ev else "?")
        )
        out.append({"vulnerability": vuln, "preview": preview, "verdict": verdict})
    return out


def render_side_by_side(hal_path: str, jarvis_path: str) -> None:
    console = Console()
    v = _load(hal_path)
    s = _load(jarvis_path)
    v_rows = _rows(v)
    s_rows = _rows(s)

    v_summary = v.get("summary", {})
    s_summary = s.get("summary", {})

    console.print(
        f"\n[bold]HAL[/bold]:    "
        f"{v_summary.get('vulnerabilities_found', '?')}/{v_summary.get('total_attacks', '?')} attacks succeeded · "
        f"resistance {v_summary.get('resistance_rate', 0.0):.0%}"
    )
    console.print(
        f"[bold]JARVIS[/bold]: "
        f"{s_summary.get('vulnerabilities_found', '?')}/{s_summary.get('total_attacks', '?')} attacks succeeded · "
        f"resistance {s_summary.get('resistance_rate', 0.0):.0%}\n"
    )

    table = Table(title="Attack-by-attack comparison", show_lines=True)
    table.add_column("Vulnerability", style="bold")
    table.add_column("Attack preview")
    table.add_column("HAL", justify="center")
    table.add_column("JARVIS", justify="center")

    for v_row, s_row in zip(v_rows, s_rows):
        v_verdict = (
            f"[red]{v_row['verdict']}[/red]"
            if "VULN" in v_row["verdict"].upper()
            else f"[green]{v_row['verdict']}[/green]"
        )
        s_verdict = (
            f"[red]{s_row['verdict']}[/red]"
            if "VULN" in s_row["verdict"].upper()
            else f"[green]{s_row['verdict']}[/green]"
        )
        table.add_row(v_row["vulnerability"], v_row["preview"], v_verdict, s_verdict)

    console.print(table)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <hal.json> <jarvis.json>", file=sys.stderr)
        sys.exit(2)
    render_side_by_side(sys.argv[1], sys.argv[2])
