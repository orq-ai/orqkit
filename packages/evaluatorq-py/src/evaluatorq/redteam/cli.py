"""CLI for evaluatorq red teaming."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Optional

import typer
from dotenv import load_dotenv

load_dotenv(override=True)

app = typer.Typer(
    name="evaluatorq-redteam",
    help="Red teaming CLI for evaluatorq.",
    no_args_is_help=True,
)


def _configure_logging(verbosity: int) -> None:
    """Configure logging based on verbosity level."""
    if verbosity == 0:
        level = logging.WARNING
    elif verbosity == 1:
        level = logging.INFO
    else:
        level = logging.DEBUG

    logger = logging.getLogger("evaluatorq")
    logger.setLevel(level)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
        logger.addHandler(handler)

    try:
        from loguru import logger as loguru_logger

        loguru_logger.remove()
        loguru_logger.add(sys.stderr, level=level)
    except ImportError:
        pass


# ---------------------------------------------------------------------------
# Markdown export helpers (importable for tests)
# ---------------------------------------------------------------------------


def _generate_md_filename(target: str, timestamp: str) -> str:
    """Generate a safe markdown report filename.

    Sanitizes the target name by replacing characters that are unsafe in
    filenames (``/``, ``:``, whitespace) with hyphens and collapsing
    consecutive hyphens.

    Args:
        target:    Target identifier string (e.g. ``"agent:my/target"``).
        timestamp: Timestamp string (e.g. ``"20250615_103000"``).

    Returns:
        Filename string, e.g. ``"redteam-report-agent-my-target-20250615_103000.md"``.
    """
    safe_target = re.sub(r"[/:|\s]+", "-", target).strip("-")
    safe_target = re.sub(r"-{2,}", "-", safe_target)
    return f"redteam-report-{safe_target}-{timestamp}.md"


def write_markdown_report(
    report: Any,
    output_dir: Path,
    target: str,
) -> Path:
    """Export ``report`` to a Markdown file inside ``output_dir``.

    The filename is auto-generated from ``target`` and the current timestamp.
    The directory is created if it does not exist.

    Args:
        report:     The red team report to export.
        output_dir: Directory in which to write the file.
        target:     Target identifier used for filename generation.

    Returns:
        Path to the written Markdown file.
    """
    from evaluatorq.redteam.reports.export_md import export_markdown

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = _generate_md_filename(target=target, timestamp=timestamp)
    output_path = output_dir / filename

    md_content = export_markdown(report)
    output_path.write_text(md_content, encoding="utf-8")
    return output_path


@app.command()
def run(
    target: Annotated[
        list[str],
        typer.Option(
            "--target", "-t",
            help='Target identifier(s), e.g. "agent:<key>" or "openai:<model>". Repeatable.',
        ),
    ],
    mode: Annotated[
        str,
        typer.Option(help='Execution mode: "dynamic", "static", or "hybrid".'),
    ] = "dynamic",
    categories: Annotated[
        Optional[list[str]],
        typer.Option(
            "--category", "-c",
            help="OWASP categories to test (e.g. ASI01). Repeatable. Defaults to all.",
        ),
    ] = None,
    max_turns: Annotated[
        int,
        typer.Option(help="Maximum conversation turns for multi-turn attacks."),
    ] = 5,
    max_per_category: Annotated[
        Optional[int],
        typer.Option(help="Cap strategies per category."),
    ] = None,
    attack_model: Annotated[
        str,
        typer.Option(help="Model for adversarial prompt generation."),
    ] = "azure/gpt-5-mini",
    evaluator_model: Annotated[
        str,
        typer.Option(help="Model for OWASP evaluation scoring."),
    ] = "azure/gpt-5-mini",
    parallelism: Annotated[
        int,
        typer.Option(help="Maximum concurrent evaluatorq jobs."),
    ] = 5,
    generated_strategy_count: Annotated[
        int,
        typer.Option(help="Number of strategies to generate per category."),
    ] = 2,
    no_generate_strategies: Annotated[
        bool,
        typer.Option("--no-generate-strategies", help="Disable LLM-based strategy generation."),
    ] = False,
    max_dynamic_datapoints: Annotated[
        Optional[int],
        typer.Option(help="Cap dynamic (generated) datapoints."),
    ] = None,
    max_static_datapoints: Annotated[
        Optional[int],
        typer.Option(help="Cap static (dataset) datapoints."),
    ] = None,
    no_cleanup_memory: Annotated[
        bool,
        typer.Option("--no-cleanup-memory", help="Skip memory entity cleanup after dynamic runs."),
    ] = False,
    backend: Annotated[
        str,
        typer.Option(help='Backend name ("orq" or "openai").'),
    ] = "orq",
    dataset: Annotated[
        Optional[Path],
        typer.Option(help="Path to static dataset (required for static/hybrid modes)."),
    ] = None,
    output_dir: Annotated[
        Optional[Path],
        typer.Option(help="Directory to save intermediate stage artifacts."),
    ] = None,
    yes: Annotated[
        bool,
        typer.Option("--yes", "-y", help="Skip confirmation prompt."),
    ] = False,
    verbose: Annotated[
        int,
        typer.Option("--verbose", "-v", count=True, help="Increase verbosity (-v info, -vv debug)."),
    ] = 0,
    save_report: Annotated[
        Optional[Path],
        typer.Option(help="Path to write the report JSON."),
    ] = None,
    export_md: Annotated[
        Optional[Path],
        typer.Option(
            "--export-md",
            help="Directory path to write a Markdown report. Filename is auto-generated.",
        ),
    ] = None,
    system_prompt: Annotated[
        Optional[str],
        typer.Option("--system-prompt", help="System prompt for the target model/agent."),
    ] = None,
) -> None:
    """Run red teaming against one or more targets."""
    _configure_logging(verbose)

    from evaluatorq.redteam import red_team
    from evaluatorq.redteam.contracts import TargetConfig
    from evaluatorq.redteam.hooks import RichHooks

    target_config = TargetConfig(system_prompt=system_prompt) if system_prompt else None
    targets = target if len(target) > 1 else target[0]

    try:
        report = asyncio.run(
            red_team(
                target=targets,
                mode=mode,
                categories=categories,
                max_turns=max_turns,
                max_per_category=max_per_category,
                attack_model=attack_model,
                evaluator_model=evaluator_model,
                parallelism=parallelism,
                generate_strategies=not no_generate_strategies,
                generated_strategy_count=generated_strategy_count,
                max_dynamic_datapoints=max_dynamic_datapoints,
                max_static_datapoints=max_static_datapoints,
                cleanup_memory=not no_cleanup_memory,
                backend=backend,
                dataset_path=dataset,
                hooks=RichHooks(skip_confirm=yes),
                output_dir=output_dir,
                target_config=target_config,
            )
        )
    except RuntimeError as exc:
        if "cancelled" in str(exc).lower():
            typer.echo("Run cancelled.")
            raise SystemExit(0)
        raise
    except KeyboardInterrupt:
        typer.echo("\nInterrupted.")
        raise typer.Exit(code=130)

    if save_report:
        save_report.parent.mkdir(parents=True, exist_ok=True)
        save_report.write_text(json.dumps(report.model_dump(mode="json"), indent=2, default=str))
        typer.echo(f"Report saved to {save_report}")

    if export_md:
        target_label = targets if isinstance(targets, str) else ", ".join(targets)
        md_path = write_markdown_report(report, output_dir=export_md, target=target_label)
        typer.echo(f"Markdown report written to {md_path}")


@app.command()
def ui(
    report_path: Annotated[
        Path,
        typer.Argument(help="Path to report JSON file or directory containing report files."),
    ],
    port: Annotated[
        int,
        typer.Option(help="Port for the Streamlit server."),
    ] = 8501,
    host: Annotated[
        str,
        typer.Option(help="Host to bind the Streamlit server to."),
    ] = "localhost",
) -> None:
    """Launch the interactive Streamlit dashboard for a red team report."""
    import subprocess

    report_path = report_path.resolve()
    if not report_path.exists():
        typer.echo(f"Error: {report_path} does not exist.", err=True)
        raise typer.Exit(code=1)

    dashboard_script = Path(__file__).parent / "ui" / "dashboard.py"
    if not dashboard_script.exists():
        typer.echo("Error: Dashboard module not found.", err=True)
        raise typer.Exit(code=1)

    try:
        import streamlit  # noqa: F401
    except ImportError:
        typer.echo(
            'Streamlit is not installed. Install the ui extras:\n'
            '  pip install "evaluatorq[ui]"',
            err=True,
        )
        raise typer.Exit(code=1)

    subprocess.run(
        [
            sys.executable, "-m", "streamlit", "run",
            str(dashboard_script),
            "--server.port", str(port),
            "--server.address", host,
            "--browser.gatherUsageStats", "false",
            "--", str(report_path),
        ],
    )
