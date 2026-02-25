"""Pipeline hook system for the evaluatorq red teaming runner.

Provides a ``PipelineHooks`` protocol that separates rendering concerns from
pipeline logic.  Hook implementations are injected via ``red_team(hooks=...)``.

Public API:
    PipelineHooks  — runtime-checkable Protocol
    ConfirmPayload — TypedDict for on_confirm payload
    DefaultHooks   — loguru-based implementation (library callers)
    RichHooks      — Rich terminal implementation (CLI)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from loguru import logger

from evaluatorq.redteam.reports.display import print_report_summary

if TYPE_CHECKING:
    from rich.console import Console as RichConsole

    from evaluatorq.redteam.contracts import RedTeamReport

# ---------------------------------------------------------------------------
# Stage label mapping
# ---------------------------------------------------------------------------

_STAGE_LABELS: dict[str, str] = {
    "context_retrieval": "Retrieving Agent Context",
    "datapoint_generation": "Generating Attack Datapoints",
    "attack_execution": "Executing Attacks",
    "report_generation": "Generating Report",
    "cleanup": "Cleaning Up",
    "target_start": "Starting Target",
    "target_complete": "Target Complete",
}

# ---------------------------------------------------------------------------
# ConfirmPayload TypedDict
# ---------------------------------------------------------------------------

try:
    from typing import TypedDict
except ImportError:
    from typing_extensions import TypedDict  # type: ignore[assignment]


class ConfirmPayload(TypedDict, total=False):
    """Payload passed to ``on_confirm`` before pipeline execution begins."""

    agent_context: dict[str, Any] | None
    """Serialized agent context (None for static mode)."""

    num_datapoints: int
    """Total number of attack datapoints to be executed."""

    num_dynamic: int | None
    """Number of dynamic datapoints (hybrid mode only)."""

    num_static: int | None
    """Number of static datapoints (hybrid mode only)."""

    categories: list[str]
    """OWASP categories being tested."""

    attack_model: str
    """Model used for adversarial prompt generation."""

    evaluator_model: str
    """Model used for OWASP evaluation scoring."""

    max_turns: int
    """Maximum conversation turns per attack."""

    parallelism: int
    """Maximum concurrent evaluatorq jobs."""

    filtering_metadata: dict[str, Any] | None
    """Strategy filtering metadata from datapoint generation."""

    mode: str
    """Execution mode: 'dynamic', 'static', or 'hybrid'."""

    target: str
    """Target identifier string."""

    dataset_path: str | None
    """Path to static dataset (static/hybrid modes)."""

    vulnerabilities: list[str] | None
    """Vulnerability labels loaded from dataset (static mode)."""


# ---------------------------------------------------------------------------
# PipelineHooks Protocol
# ---------------------------------------------------------------------------

try:
    from typing import Protocol, runtime_checkable
except ImportError:
    from typing_extensions import Protocol, runtime_checkable  # type: ignore[assignment]


@runtime_checkable
class PipelineHooks(Protocol):
    """Protocol for pipeline lifecycle hooks.

    Implementations are injected into ``red_team()`` via ``hooks=...``.
    All methods are synchronous.  If a hook raises, the pipeline breaks.
    """

    def on_stage_start(self, stage: str, meta: dict[str, Any]) -> None:
        """Called when a pipeline stage begins.

        Args:
            stage: Stage identifier (e.g. ``"context_retrieval"``).
            meta:  Stage-specific metadata dict.
        """
        ...

    def on_stage_end(self, stage: str, meta: dict[str, Any]) -> None:
        """Called when a pipeline stage completes.

        Args:
            stage: Stage identifier matching the corresponding ``on_stage_start``.
            meta:  Stage-specific result metadata.
        """
        ...

    def on_confirm(self, payload: ConfirmPayload) -> bool:
        """Called before execution begins to confirm the run plan.

        Args:
            payload: Summary of the planned run.

        Returns:
            ``True`` to proceed, ``False`` to cancel (raises ``RuntimeError``).
        """
        ...

    def on_complete(self, report: RedTeamReport) -> None:
        """Called once with the final merged report after all targets complete.

        Args:
            report: The final ``RedTeamReport``.
        """
        ...


# ---------------------------------------------------------------------------
# DefaultHooks — loguru output
# ---------------------------------------------------------------------------


class DefaultHooks:
    """Default hook implementation that logs via loguru.

    Used by library callers who do not supply a ``hooks`` argument to
    ``red_team()``.  ``on_confirm`` always returns ``True`` (no interactive
    prompt).
    """

    def on_stage_start(self, stage: str, meta: dict[str, Any]) -> None:
        label = _STAGE_LABELS.get(stage, stage)
        logger.info(f"[redteam] Stage started: {stage} — {label} | meta={meta}")

    def on_stage_end(self, stage: str, meta: dict[str, Any]) -> None:
        label = _STAGE_LABELS.get(stage, stage)
        logger.info(f"[redteam] Stage complete: {stage} — {label} | meta={meta}")

    def on_confirm(self, payload: ConfirmPayload) -> bool:
        """Log plan details and always approve."""
        num_dp = payload.get("num_datapoints", "?")
        categories = payload.get("categories") or []
        attack_model = payload.get("attack_model", "?")
        evaluator_model = payload.get("evaluator_model", "?")
        target = payload.get("target", "?")
        mode = payload.get("mode", "?")
        logger.info(
            f"[redteam] Run plan: target={target!r} mode={mode!r} "
            f"datapoints={num_dp} categories={len(categories)} "
            f"attack_model={attack_model!r} evaluator_model={evaluator_model!r}"
        )
        return True

    def on_complete(self, report: RedTeamReport) -> None:
        """Log a brief summary and UI hint."""
        summary = report.summary
        logger.info(
            f"[redteam] Run complete — resistance_rate={summary.resistance_rate:.0%} "
            f"vulnerabilities={summary.vulnerabilities_found} "
            f"attacks={summary.total_attacks}"
        )
        logger.info(
            "[redteam] Tip: visualise results with  evaluatorq redteam ui <report.json>"
        )


# ---------------------------------------------------------------------------
# RichHooks — Rich terminal output
# ---------------------------------------------------------------------------


class RichHooks:
    """Rich terminal hook implementation for the evaluatorq CLI.

    Renders stage banners, a detailed confirmation table, and delegates the
    final report summary to :func:`~evaluatorq.redteam.reports.display.print_report_summary`.

    Args:
        console:      A :class:`rich.console.Console` instance.  A new one is
                      created when ``None`` is passed (default).
        skip_confirm: When ``True``, renders the plan but skips the interactive
                      ``typer.confirm`` prompt and returns ``True`` automatically.
    """

    def __init__(self, *, console: RichConsole | None = None, skip_confirm: bool = False) -> None:
        if console is None:
            from rich.console import Console

            console = Console()
        self._console = console
        self._skip_confirm = skip_confirm

    # ------------------------------------------------------------------
    # on_stage_start
    # ------------------------------------------------------------------

    def on_stage_start(self, stage: str, meta: dict[str, Any]) -> None:
        label = _STAGE_LABELS.get(stage, stage.replace("_", " ").title())
        self._console.rule(f"[bold cyan]{label}[/bold cyan]")

    # ------------------------------------------------------------------
    # on_stage_end
    # ------------------------------------------------------------------

    def on_stage_end(self, stage: str, meta: dict[str, Any]) -> None:
        # Intentionally quiet — the next on_stage_start banner signals progress.
        pass

    # ------------------------------------------------------------------
    # on_confirm
    # ------------------------------------------------------------------

    def on_confirm(self, payload: ConfirmPayload) -> bool:
        """Render a detailed run plan and prompt for confirmation."""
        from rich import box
        from rich.panel import Panel
        from rich.table import Table

        # ── Run parameters table ────────────────────────────────────────
        table = Table(title="Run Plan", show_header=True, header_style="bold", box=box.ROUNDED)
        table.add_column("Parameter", style="white", min_width=20)
        table.add_column("Value", style="cyan")

        target = payload.get("target", "?")
        mode = payload.get("mode", "?")
        num_dp = payload.get("num_datapoints", "?")
        categories = payload.get("categories") or []
        attack_model = payload.get("attack_model", "?")
        evaluator_model = payload.get("evaluator_model", "?")
        max_turns = payload.get("max_turns", "?")
        parallelism = payload.get("parallelism", "?")
        dataset_path = payload.get("dataset_path")
        num_dynamic = payload.get("num_dynamic")
        num_static = payload.get("num_static")

        table.add_row("Target", str(target))
        table.add_row("Mode", str(mode))
        table.add_row("Datapoints", str(num_dp))

        if num_dynamic is not None and num_static is not None:
            table.add_row("  → Dynamic", str(num_dynamic))
            table.add_row("  → Static", str(num_static))

        table.add_row("Categories", str(len(categories)))
        table.add_row("Attack Model", str(attack_model))
        table.add_row("Evaluator Model", str(evaluator_model))
        table.add_row("Max Turns", str(max_turns))
        table.add_row("Parallelism", str(parallelism))

        if dataset_path:
            table.add_row("Dataset Path", str(dataset_path))

        self._console.print(table)

        # ── Agent capabilities panel ────────────────────────────────────
        agent_context = payload.get("agent_context")
        if agent_context is not None:
            self._render_agent_capabilities(agent_context)

        # ── Filtering metadata ──────────────────────────────────────────
        filtering_metadata = payload.get("filtering_metadata")
        if filtering_metadata:
            self._render_filtering_metadata(filtering_metadata)

        # ── Prompt or auto-approve ──────────────────────────────────────
        if self._skip_confirm:
            return True

        import typer

        return typer.confirm("Proceed with this run?")

    def _render_agent_capabilities(self, agent_context: dict[str, Any]) -> None:
        """Render an agent capabilities panel."""
        from rich.panel import Panel

        tools = agent_context.get("tools") or []
        memory_stores = agent_context.get("memory_stores") or []
        knowledge_bases = agent_context.get("knowledge_bases") or []

        lines: list[str] = []

        if tools:
            tool_names = ", ".join(
                t.get("name", str(t)) if isinstance(t, dict) else str(t) for t in tools[:10]
            )
            suffix = f" (+{len(tools) - 10} more)" if len(tools) > 10 else ""
            lines.append(f"Tools ({len(tools)}): {tool_names}{suffix}")
        else:
            lines.append("Tools: none")

        if memory_stores:
            store_ids = ", ".join(
                m.get("store_id", str(m)) if isinstance(m, dict) else str(m)
                for m in memory_stores[:5]
            )
            lines.append(f"Memory Stores ({len(memory_stores)}): {store_ids}")
        else:
            lines.append("Memory: none")

        if knowledge_bases:
            kb_ids = ", ".join(
                kb.get("kb_id", str(kb)) if isinstance(kb, dict) else str(kb)
                for kb in knowledge_bases[:5]
            )
            lines.append(f"Knowledge Bases ({len(knowledge_bases)}): {kb_ids}")
        else:
            lines.append("Knowledge Bases: none")

        self._console.print(
            self._make_panel("\n".join(lines), title="Agent Capabilities")
        )

    def _render_filtering_metadata(self, filtering_metadata: dict[str, Any]) -> None:
        """Render strategy filtering metadata."""
        from rich import box
        from rich.table import Table

        table = Table(
            title="Strategy Filtering",
            show_header=True,
            header_style="bold",
            box=box.SIMPLE,
        )
        table.add_column("Metric", style="white")
        table.add_column("Value", style="cyan", justify="right")

        for key, value in filtering_metadata.items():
            table.add_row(key.replace("_", " ").title(), str(value))

        self._console.print(table)

    @staticmethod
    def _make_panel(content: str, title: str) -> Any:
        from rich.panel import Panel

        return Panel(content, title=title, expand=False)

    # ------------------------------------------------------------------
    # on_complete
    # ------------------------------------------------------------------

    def on_complete(self, report: RedTeamReport) -> None:
        """Render the full report summary and a UI hint."""
        print_report_summary(report)
        self._console.print()
        self._console.rule("[bold green]Run Complete[/bold green]")
        self._console.print(
            "[dim]Tip:[/dim] Visualise results interactively with "
            "[bold cyan]evaluatorq redteam ui <report.json>[/bold cyan]"
        )
