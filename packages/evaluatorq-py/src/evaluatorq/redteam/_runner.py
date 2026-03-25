"""Unified red teaming runner that dispatches to dynamic/static/hybrid pipelines."""

from __future__ import annotations

import asyncio
import warnings
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Union

from loguru import logger

from evaluatorq.redteam.adaptive.strategy_registry import list_available_categories
from evaluatorq.redteam.backends.base import (
    DefaultErrorMapper,
    DirectTargetFactory,
    NoopMemoryCleanup,
    is_agent_target,
)
from evaluatorq.redteam.contracts import AgentContext, RedTeamReport

if TYPE_CHECKING:
    from openai import AsyncOpenAI

    from evaluatorq.redteam.backends.base import (
        AgentTarget,
        AgentTargetFactory,
        ErrorMapper,
        MemoryCleanup,
    )

#: Accepted types for the ``target`` parameter.
TargetSpec = Union[str, 'AgentTarget', list[Union[str, 'AgentTarget']]]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def red_team(
    target: TargetSpec,
    *,
    mode: str = 'dynamic',
    categories: list[str] | None = None,
    max_turns: int = 5,
    max_per_category: int | None = None,
    attack_model: str = 'azure/gpt-5-mini',
    evaluator_model: str = 'azure/gpt-5-mini',
    parallelism: int = 5,
    generate_strategies: bool = True,
    generated_strategy_count: int = 2,
    max_datapoints: int | None = None,
    cleanup_memory: bool = True,
    backend: str = 'orq',
    target_factory: AgentTargetFactory | None = None,
    error_mapper: ErrorMapper | None = None,
    memory_cleanup: MemoryCleanup | None = None,
    llm_client: AsyncOpenAI | None = None,
    description: str | None = None,
    dataset_path: Any = None,
) -> RedTeamReport:
    """Unified entry point for red teaming.

    Args:
        target: What to attack. Accepts:

            * A string like ``"agent:<key>"`` or ``"openai:<model>"``.
            * An :class:`AgentTarget` object directly.
            * A list mixing strings and/or :class:`AgentTarget` objects for
              multi-target runs (each becomes a separate job in one run).

        mode: Execution mode — ``"dynamic"``, ``"static"``, or ``"hybrid"``.
        categories: OWASP categories to test (e.g., ``["ASI01", "ASI03"]``).
            Defaults to all available categories.
        max_turns: Maximum conversation turns for multi-turn attacks.
        max_per_category: Cap strategies per category (None = no cap).
        attack_model: Model for adversarial prompt generation.
        evaluator_model: Model for OWASP evaluation scoring.
        parallelism: Maximum concurrent evaluatorq jobs.
        generate_strategies: Whether to generate additional LLM-based strategies.
        generated_strategy_count: Number of strategies to generate per category.
        max_datapoints: Cap total datapoints (None = no cap).
        cleanup_memory: Whether to clean up memory entities after dynamic runs.
        backend: Backend name (``"orq"`` or ``"openai"``). Ignored when
            *target* is an :class:`AgentTarget` object.
        target_factory: Custom target factory (overrides backend default).

            .. deprecated::
                Pass an :class:`AgentTarget` instance as *target* instead.

        error_mapper: Custom error mapper (overrides backend default).
        memory_cleanup: Custom memory cleanup (overrides backend default).
        llm_client: Pre-configured AsyncOpenAI client for attack/strategy generation.
        description: Optional description for the report.
        dataset_path: Path to static dataset (required for static/hybrid modes).

    Returns:
        RedTeamReport with results and summary statistics.

    Raises:
        ValueError: If mode is invalid or required arguments are missing.
        NotImplementedError: For hybrid mode.
    """
    if target_factory is not None:
        warnings.warn(
            'target_factory is deprecated. Pass an AgentTarget instance as the target parameter instead.',
            DeprecationWarning,
            stacklevel=2,
        )

    if mode == 'dynamic':
        return await _run_dynamic(
            target=target,
            categories=categories,
            max_turns=max_turns,
            max_per_category=max_per_category,
            attack_model=attack_model,
            evaluator_model=evaluator_model,
            parallelism=parallelism,
            generate_strategies=generate_strategies,
            generated_strategy_count=generated_strategy_count,
            max_datapoints=max_datapoints,
            cleanup_memory=cleanup_memory,
            backend=backend,
            target_factory=target_factory,
            error_mapper=error_mapper,
            memory_cleanup=memory_cleanup,
            llm_client=llm_client,
            description=description,
        )
    if mode == 'static':
        # Static mode only supports string targets for now.
        if not isinstance(target, str):
            msg = 'Static mode currently only supports string targets (e.g., "agent:<key>").'
            raise ValueError(msg)
        return await _run_static(
            target=target,
            categories=categories,
            evaluator_model=evaluator_model,
            parallelism=parallelism,
            max_datapoints=max_datapoints,
            _backend=backend,
            dataset_path=dataset_path,
            description=description,
            llm_client=llm_client,
        )
    if mode == 'hybrid':
        raise NotImplementedError(
            'mode="hybrid" is not yet available. '
            + 'Hybrid mode will compose dynamic + static in a single evaluatorq run.'
        )
    msg = f'Invalid mode {mode!r}. Must be "dynamic", "static", or "hybrid".'
    raise ValueError(msg)


# ---------------------------------------------------------------------------
# Target resolution helpers
# ---------------------------------------------------------------------------


def _parse_target(target: str) -> tuple[str, str]:
    """Parse ``"kind:value"`` target string.

    Returns:
        Tuple of (kind, value), e.g. (``"agent"``, ``"my-agent-key"``).
    """
    if ':' not in target:
        # Default to agent kind
        return 'agent', target
    kind, _, value = target.partition(':')
    if not value:
        msg = f'Target {target!r} is missing a value after the colon.'
        raise ValueError(msg)
    return kind.lower(), value


def _resolve_string_target(target_str: str, backend: str, llm_client: AsyncOpenAI | None) -> AgentTarget:
    """Resolve a target string to a concrete :class:`AgentTarget` object."""
    kind, value = _parse_target(target_str)

    if kind == 'agent' and backend != 'openai':
        from evaluatorq.redteam.backends.orq import create_orq_agent_target

        return create_orq_agent_target(value)

    from evaluatorq.redteam.backends.openai import create_openai_target

    return create_openai_target(value, client=llm_client)


def _resolve_targets(
    target: TargetSpec,
    backend: str,
    llm_client: AsyncOpenAI | None,
) -> list[AgentTarget]:
    """Normalize *target* to a list of :class:`AgentTarget` objects."""
    raw_targets: list[str | AgentTarget] = [target] if not isinstance(target, list) else list(target)

    if not raw_targets:
        msg = 'target must not be empty.'
        raise ValueError(msg)

    resolved: list[AgentTarget] = []
    for t in raw_targets:
        if isinstance(t, str):
            resolved.append(_resolve_string_target(t, backend, llm_client))
        elif is_agent_target(t):
            resolved.append(t)
        else:
            msg = f'Invalid target type: {type(t).__name__}. Expected str or AgentTarget.'
            raise TypeError(msg)
    return resolved


def _get_target_label(target: AgentTarget) -> str:
    """Best-effort label for a target (used in jobs and reports)."""
    return getattr(target, 'name', None) or type(target).__name__


def _get_target_factory(target: AgentTarget) -> AgentTargetFactory:
    """Get the factory for per-job target creation."""
    if callable(getattr(target, 'create_target', None)):
        return target  # type: ignore[return-value]
    return DirectTargetFactory(target)


def _get_error_mapper(target: AgentTarget) -> ErrorMapper:
    """Get the error mapper from a target, or use the default."""
    if callable(getattr(target, 'map_error', None)):
        return target  # type: ignore[return-value]
    return DefaultErrorMapper()


def _get_memory_cleanup(target: AgentTarget) -> MemoryCleanup:
    """Get memory cleanup from a target, or use no-op."""
    if callable(getattr(target, 'cleanup_memory', None)):
        return target  # type: ignore[return-value]
    return NoopMemoryCleanup()


async def _get_agent_context(target: AgentTarget, label: str) -> AgentContext:
    """Get agent context from a target, or return a minimal default."""
    get_ctx = getattr(target, 'get_agent_context', None)
    if callable(get_ctx):
        return await get_ctx()
    logger.warning(
        f'Target {label!r} does not implement get_agent_context(); '
        f'using minimal context (no tools/memory/knowledge). '
        f'Strategy generation will not be tailored to agent capabilities.'
    )
    return AgentContext(key=label)


# ---------------------------------------------------------------------------
# Dynamic pipeline
# ---------------------------------------------------------------------------


async def _run_dynamic(
    *,
    target: TargetSpec,
    categories: list[str] | None,
    max_turns: int,
    max_per_category: int | None,
    attack_model: str,
    evaluator_model: str,
    parallelism: int,
    generate_strategies: bool,
    generated_strategy_count: int,
    max_datapoints: int | None,
    cleanup_memory: bool,
    backend: str,
    target_factory: AgentTargetFactory | None,
    error_mapper: ErrorMapper | None,
    memory_cleanup: MemoryCleanup | None,
    llm_client: AsyncOpenAI | None,
    description: str | None,
) -> RedTeamReport:
    """Run dynamic red teaming via evaluatorq."""
    from evaluatorq import evaluatorq

    from evaluatorq.redteam.backends.registry import create_async_llm_client
    from evaluatorq.redteam.adaptive.pipeline import (
        cleanup_memory_entities,
        create_dynamic_evaluator,
        create_dynamic_redteam_job,
        generate_dynamic_datapoints,
    )
    from evaluatorq.redteam.reports.converters import dynamic_evaluatorq_results_to_report

    pipeline_start = datetime.now(tz=timezone.utc).astimezone()

    # ----- Resolve all targets -----
    targets = _resolve_targets(target, backend, llm_client)

    # Resolve contexts for all targets (primary used for datapoint generation).
    # Disambiguate duplicate labels to prevent silent overwrites.
    target_contexts: dict[str, AgentContext] = {}
    target_labels: list[str] = []
    for i, t in enumerate(targets):
        label = _get_target_label(t)
        if label in target_contexts:
            label = f'{label}-{i}'
            logger.warning(f'Duplicate target label detected, disambiguating as {label!r}')
        ctx = await _get_agent_context(t, label)
        target_contexts[label] = ctx
        target_labels.append(label)

    primary_label = target_labels[0]
    primary_context = target_contexts[primary_label]
    resolved_categories = categories or list_available_categories()

    # ----- LLM client for strategy generation -----
    resolved_llm_client = llm_client
    if resolved_llm_client is None and generate_strategies:
        resolved_llm_client = create_async_llm_client()

    # ----- Stage 1: Generate datapoints (shared across all targets) -----
    labels_display = ', '.join(target_labels)
    logger.info(
        f'Generating attack datapoints for [{labels_display}] '
        f'({len(resolved_categories)} categories, max_turns={max_turns})'
    )
    datapoints, _filtering_metadata = await generate_dynamic_datapoints(
        agent_context=primary_context,
        categories=resolved_categories,
        max_per_category=max_per_category,
        max_turns=max_turns,
        generate_additional_strategies=generate_strategies,
        generated_strategy_count=generated_strategy_count,
        llm_client=resolved_llm_client,
        attack_model=attack_model,
        parallelism=parallelism,
    )
    if max_datapoints is not None and max_datapoints > 0:
        datapoints = datapoints[:max_datapoints]
    if not datapoints:
        msg = 'No datapoints generated. Check categories and agent capabilities.'
        raise ValueError(msg)

    # ----- Stage 2: Create one job per target -----
    jobs = []
    for t, label in zip(targets, target_labels):
        ctx = target_contexts[label]
        # Explicit overrides (backward compat for deprecated target_factory)
        factory = target_factory or _get_target_factory(t)
        mapper = error_mapper or _get_error_mapper(t)
        job = create_dynamic_redteam_job(
            agent_key=label,
            agent_context=ctx,
            red_team_model=attack_model,
            max_turns=max_turns,
            target_factory=factory,
            error_mapper=mapper,
            attack_llm_client=resolved_llm_client,
        )
        jobs.append(job)

    evaluator = create_dynamic_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)

    # ----- Stage 3: Run evaluatorq (all jobs in one run) -----
    logger.info(f'Running {len(datapoints)} attacks against [{labels_display}] (parallelism={parallelism})')
    try:
        results = await evaluatorq(
            'dynamic-red-team',
            data=datapoints,
            jobs=jobs,
            evaluators=[evaluator],
            parallelism=parallelism,
            print_results=False,
            description=description or f'Dynamic red teaming for [{labels_display}]',
        )
    except (asyncio.CancelledError, KeyboardInterrupt):
        logger.warning('Run cancelled — attempting memory cleanup')
        if cleanup_memory:
            await _cleanup_all_targets(targets, target_labels, target_contexts, datapoints, memory_cleanup)
        raise
    except Exception as exc:
        logger.error(f'Evaluatorq run failed: {type(exc).__name__}: {exc} — attempting memory cleanup before re-raising')
        if cleanup_memory:
            await _cleanup_all_targets(targets, target_labels, target_contexts, datapoints, memory_cleanup)
        raise

    pipeline_duration = (datetime.now(tz=timezone.utc).astimezone() - pipeline_start).total_seconds()

    # ----- Stage 4: Normalize results -----
    logger.info(f'Normalizing results ({pipeline_duration:.1f}s elapsed)')
    report = dynamic_evaluatorq_results_to_report(
        target_contexts=target_contexts,
        categories_tested=resolved_categories,
        results=results,
        duration_seconds=pipeline_duration,
        description=description or f'Dynamic red teaming for [{labels_display}]',
    )

    # ----- Stage 5: Cleanup memory entities for all targets -----
    if cleanup_memory:
        await _cleanup_all_targets(targets, target_labels, target_contexts, datapoints, memory_cleanup)

    return report


async def _cleanup_all_targets(
    targets: list[AgentTarget],
    target_labels: list[str],
    target_contexts: dict[str, AgentContext],
    datapoints: list[Any],
    memory_cleanup_override: MemoryCleanup | None,
) -> None:
    """Clean up memory entities for all targets that support it."""
    from evaluatorq.redteam.adaptive.pipeline import cleanup_memory_entities

    entity_ids = [
        dp.inputs['memory_entity_id']
        for dp in datapoints
        if 'memory_entity_id' in dp.inputs
    ]
    if not entity_ids:
        return

    for t, label in zip(targets, target_labels):
        ctx = target_contexts.get(label)
        if ctx is None or not ctx.has_memory:
            continue
        cleanup = memory_cleanup_override or _get_memory_cleanup(t)
        logger.info(f'Cleaning up {len(entity_ids)} memory entities for {label}')
        try:
            await cleanup_memory_entities(ctx, entity_ids, memory_cleanup=cleanup)
        except Exception as e:
            logger.warning(f'Memory cleanup failed for {label}: {type(e).__name__}: {e}')


# ---------------------------------------------------------------------------
# Static pipeline
# ---------------------------------------------------------------------------


async def _run_static(
    *,
    target: str,
    categories: list[str] | None,
    evaluator_model: str,
    parallelism: int,
    max_datapoints: int | None,
    _backend: str,
    dataset_path: Any,
    description: str | None,
    llm_client: AsyncOpenAI | None = None,
) -> RedTeamReport:
    """Run static red teaming via evaluatorq."""
    from pathlib import Path

    from evaluatorq import evaluatorq

    from evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge import (
        create_owasp_evaluator,
        load_owasp_agentic_dataset,
    )
    from evaluatorq.redteam.reports.converters import static_evaluatorq_results_to_reports
    from evaluatorq.redteam.runtime.jobs import create_model_job

    target_kind, target_value = _parse_target(target)
    pipeline_start = datetime.now(tz=timezone.utc).astimezone()

    # Load dataset (may use synchronous ORQ SDK internally, so run in thread)
    path = Path(dataset_path) if dataset_path is not None else None
    data = await asyncio.to_thread(
        load_owasp_agentic_dataset,
        num_samples=max_datapoints,
        categories=categories,
        path=path,
    )

    # Create job based on target kind
    if target_kind == 'agent':
        model_job = create_model_job(agent_key=target_value)
    elif target_kind == 'openai':
        model_job = create_model_job(model=target_value, llm_client=llm_client)
    elif target_kind == 'deployment':
        model_job = create_model_job(deployment_key=target_value, llm_client=llm_client)
    else:
        model_job = create_model_job(model=target_value, llm_client=llm_client)

    evaluator = create_owasp_evaluator(evaluator_model=evaluator_model, llm_client=llm_client)

    # Run evaluatorq
    logger.info(f'Running static red teaming against {target} (parallelism={parallelism})')
    try:
        results = await evaluatorq(
            'static-red-team',
            data=data,
            jobs=[model_job],
            evaluators=[evaluator],
            parallelism=parallelism,
            print_results=False,
            description=description or f'Static red teaming for {target}',
        )
    except (asyncio.CancelledError, KeyboardInterrupt):
        logger.warning('Static red teaming run cancelled')
        raise

    pipeline_duration = (datetime.now(tz=timezone.utc).astimezone() - pipeline_start).total_seconds()

    # Normalize results — static runs may produce multiple job reports
    reports = static_evaluatorq_results_to_reports(
        results=results,
        agent_model=target_value if target_kind != 'agent' else None,
        agent_key=target_value if target_kind == 'agent' else None,
        description=description or f'Static red teaming for {target}',
    )

    # Return the first (primary) report, or merge if needed
    if not reports:
        from evaluatorq.redteam.reports.converters import static_results_to_report

        return static_results_to_report(
            [],
            agent_model=target_value if target_kind != 'agent' else None,
            agent_key=target_value if target_kind == 'agent' else None,
            description=description,
        )

    primary_report = next(iter(reports.values()))
    primary_report.duration_seconds = pipeline_duration
    return primary_report
