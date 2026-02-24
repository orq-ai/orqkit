"""CLI for evaluatorq red teaming."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
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
    print_results: Annotated[
        bool,
        typer.Option("--print-results", help="Print a Rich summary table after the run."),
    ] = False,
    save_report: Annotated[
        Optional[Path],
        typer.Option(help="Path to write the report JSON."),
    ] = None,
    system_prompt: Annotated[
        Optional[str],
        typer.Option("--system-prompt", help="System prompt for the target model/agent."),
    ] = None,
) -> None:
    """Run red teaming against one or more targets."""
    _configure_logging(verbose)

    from evaluatorq.redteam import print_report_summary, red_team
    from evaluatorq.redteam.contracts import TargetConfig

    target_config = TargetConfig(system_prompt=system_prompt) if system_prompt else None

    confirm_callback = None
    if not yes:

        def _confirm(summary: dict[str, Any]) -> bool:
            from rich.console import Console
            from rich.table import Table

            console = Console()
            table = Table(title="Run Summary", show_header=True, header_style="bold")
            table.add_column("Parameter", style="white")
            table.add_column("Value", style="cyan")
            table.add_row("Targets", ", ".join(target))
            table.add_row("Mode", mode)
            table.add_row("Datapoints", str(summary.get("num_datapoints", "?")))
            table.add_row("Categories", str(len(summary.get("categories", []))))
            table.add_row("Attack Model", summary.get("attack_model", attack_model))
            table.add_row("Evaluator Model", summary.get("evaluator_model", evaluator_model))
            table.add_row("Max Turns", str(summary.get("max_turns", max_turns)))
            table.add_row("Parallelism", str(summary.get("parallelism", parallelism)))
            console.print(table)
            return typer.confirm("Proceed with this run?")

        confirm_callback = _confirm

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
                confirm_callback=confirm_callback,
                output_dir=output_dir,
                print_results=False,
                target_config=target_config,
            )
        )
    except RuntimeError as exc:
        if "cancelled" in str(exc).lower():
            typer.echo("Run cancelled.")
            raise typer.Exit(code=1) from exc
        raise
    except KeyboardInterrupt:
        typer.echo("\nInterrupted.")
        raise typer.Exit(code=130)

    if print_results:
        print_report_summary(report)

    if save_report:
        save_report.parent.mkdir(parents=True, exist_ok=True)
        save_report.write_text(json.dumps(report.model_dump(mode="json"), indent=2, default=str))
        typer.echo(f"Report saved to {save_report}")


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
