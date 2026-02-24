"""Unified red teaming runner that dispatches to dynamic/static/hybrid pipelines."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger


def _save_stage(output_dir: Path | None, filename: str, content: str) -> None:
    """Write a stage artifact to *output_dir* when saving is enabled.

    Wraps the raw payload in an envelope with a ``saved_at`` ISO-8601
    timestamp so every artifact is self-describing.
    """
    if output_dir is None:
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = json.loads(content)
    envelope = {
        "saved_at": datetime.now(tz=timezone.utc).isoformat(),
        "data": payload,
    }
    (output_dir / filename).write_text(json.dumps(envelope, indent=2, default=str), encoding="utf-8")
    logger.info(f"Saved {filename} to {output_dir}")


def _save_report(output_dir: Path | None, filename: str, report: RedTeamReport) -> None:
    """Write a summary report to *output_dir* as flat JSON with ``saved_at``.

    Unlike :func:`_save_stage`, the report is written without an extra
    envelope layer — ``saved_at`` is injected directly into the top-level
    dict alongside the existing report fields.
    """
    if output_dir is None:
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    data = report.model_dump(mode="json")
    data["saved_at"] = datetime.now(tz=timezone.utc).isoformat()
    (output_dir / filename).write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    logger.info(f"Saved {filename} to {output_dir}")

from evaluatorq.redteam.adaptive.strategy_registry import (
    get_category_info,
    list_available_categories,
)
from evaluatorq.redteam.contracts import AgentContext, RedTeamReport, TargetConfig


def _datapoint_breakdown(datapoints: list[Any]) -> dict[str, int]:
    """Classify datapoints into static, template_dynamic, and generated_dynamic."""
    static = 0
    template_dynamic = 0
    generated_dynamic = 0
    for dp in datapoints:
        inputs = dp.inputs if hasattr(dp, "inputs") else dp
        source = inputs.get("hybrid_source", "")
        if source == "static":
            static += 1
        elif inputs.get("strategy", {}).get("is_generated", False):
            generated_dynamic += 1
        else:
            template_dynamic += 1
    return {
        "static": static,
        "template_dynamic": template_dynamic,
        "generated_dynamic": generated_dynamic,
    }

if TYPE_CHECKING:
    from openai import AsyncOpenAI

    from evaluatorq.redteam.backends.base import AgentTargetFactory, ErrorMapper, MemoryCleanup


async def red_team(
    target: str | list[str],
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
    max_dynamic_datapoints: int | None = None,
    max_static_datapoints: int | None = None,
    cleanup_memory: bool = True,
    backend: str = 'orq',
    target_factory: AgentTargetFactory | None = None,
    error_mapper: ErrorMapper | None = None,
    memory_cleanup: MemoryCleanup | None = None,
    llm_client: AsyncOpenAI | None = None,
    description: str | None = None,
    dataset_path: Any = None,
    confirm_callback: Callable[[dict[str, Any]], bool] | None = None,
    output_dir: Path | str | None = None,
    print_results: bool = False,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Unified entry point for red teaming.

    Accepts a single target or a list of targets. When multiple targets are
    provided, each is run independently and the results are merged into a
    single report.

    Args:
        target: Target identifier(s). A single string like ``"agent:<key>"``
            or ``"openai:<model>"``, or a list of such strings for multi-target runs.
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
        max_dynamic_datapoints: Cap dynamic (generated) datapoints (None = no cap).
        max_static_datapoints: Cap static (dataset) datapoints (None = no cap).
        cleanup_memory: Whether to clean up memory entities after dynamic runs.
        backend: Backend name (``"orq"`` or ``"openai"``).
        target_factory: Custom target factory (overrides backend default).
        error_mapper: Custom error mapper (overrides backend default).
        memory_cleanup: Custom memory cleanup (overrides backend default).
        llm_client: Pre-configured AsyncOpenAI client for attack/strategy generation.
        description: Optional description for the report.
        dataset_path: Path to static dataset (required for static/hybrid modes).
        confirm_callback: Optional callback that receives a summary dict before
            execution. Return ``False`` to cancel the run.
        output_dir: Optional directory to save intermediate stage artifacts as
            numbered JSON files. When ``None`` (default), no files are written.
        print_results: Whether to print a Rich summary table after each run
            completes. Defaults to ``False``.
        target_config: Optional backend-agnostic target configuration (e.g.
            system prompt for OpenAI targets).

    Returns:
        RedTeamReport with results and summary statistics.

    Raises:
        ValueError: If mode is invalid or required arguments are missing.
        RuntimeError: If confirm_callback returns False.
    """
    resolved_output_dir = Path(output_dir) if output_dir is not None else None

    kwargs: dict[str, Any] = dict(
        mode=mode,
        categories=categories,
        max_turns=max_turns,
        max_per_category=max_per_category,
        attack_model=attack_model,
        evaluator_model=evaluator_model,
        parallelism=parallelism,
        generate_strategies=generate_strategies,
        generated_strategy_count=generated_strategy_count,
        max_dynamic_datapoints=max_dynamic_datapoints,
        max_static_datapoints=max_static_datapoints,
        cleanup_memory=cleanup_memory,
        backend=backend,
        target_factory=target_factory,
        error_mapper=error_mapper,
        memory_cleanup=memory_cleanup,
        llm_client=llm_client,
        description=description,
        dataset_path=dataset_path,
        confirm_callback=confirm_callback,
        output_dir=resolved_output_dir,
        print_results=print_results,
        target_config=target_config,
    )

    targets = [target] if isinstance(target, str) else list(target)
    if not targets:
        msg = 'red_team() requires at least one target'
        raise ValueError(msg)

    if len(targets) == 1:
        return await _red_team_single(targets[0], **kwargs)  # type: ignore[arg-type]

    from evaluatorq.redteam.reports.converters import merge_reports

    reports: list[RedTeamReport] = []
    for t in targets:
        t_kwargs: dict[str, Any] = {**kwargs, 'description': f'{description or "Multi-target"} ({t})'}
        report = await _red_team_single(t, **t_kwargs)  # type: ignore[arg-type]
        reports.append(report)

    merged = merge_reports(
        *reports,
        description=description or f'Multi-target red teaming ({len(targets)} targets)',
    )

    if print_results:
        from evaluatorq.redteam.reports.display import print_report_summary
        print_report_summary(merged)

    return merged


async def _red_team_single(
    target: str,
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
    max_dynamic_datapoints: int | None = None,
    max_static_datapoints: int | None = None,
    cleanup_memory: bool = True,
    backend: str = 'orq',
    target_factory: AgentTargetFactory | None = None,
    error_mapper: ErrorMapper | None = None,
    memory_cleanup: MemoryCleanup | None = None,
    llm_client: AsyncOpenAI | None = None,
    description: str | None = None,
    dataset_path: Any = None,
    confirm_callback: Callable[[dict[str, Any]], bool] | None = None,
    output_dir: Path | None = None,
    print_results: bool = False,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Run red teaming against a single target, dispatching by mode."""
    report: RedTeamReport
    if mode == 'dynamic':
        report = await _run_dynamic(
            target=target,
            categories=categories,
            max_turns=max_turns,
            max_per_category=max_per_category,
            attack_model=attack_model,
            evaluator_model=evaluator_model,
            parallelism=parallelism,
            generate_strategies=generate_strategies,
            generated_strategy_count=generated_strategy_count,
            max_dynamic_datapoints=max_dynamic_datapoints,
            cleanup_memory=cleanup_memory,
            backend=backend,
            target_factory=target_factory,
            error_mapper=error_mapper,
            memory_cleanup=memory_cleanup,
            llm_client=llm_client,
            description=description,
            confirm_callback=confirm_callback,
            output_dir=output_dir,
            target_config=target_config,
        )
    elif mode == 'static':
        report = await _run_static(
            target=target,
            categories=categories,
            evaluator_model=evaluator_model,
            parallelism=parallelism,
            max_static_datapoints=max_static_datapoints,
            backend=backend,
            dataset_path=dataset_path,
            description=description,
            llm_client=llm_client,
            output_dir=output_dir,
            target_config=target_config,
        )
    elif mode == 'hybrid':
        report = await _run_hybrid(
            target=target,
            categories=categories,
            max_turns=max_turns,
            max_per_category=max_per_category,
            attack_model=attack_model,
            evaluator_model=evaluator_model,
            parallelism=parallelism,
            generate_strategies=generate_strategies,
            generated_strategy_count=generated_strategy_count,
            max_dynamic_datapoints=max_dynamic_datapoints,
            max_static_datapoints=max_static_datapoints,
            cleanup_memory=cleanup_memory,
            backend=backend,
            target_factory=target_factory,
            error_mapper=error_mapper,
            memory_cleanup=memory_cleanup,
            llm_client=llm_client,
            description=description,
            dataset_path=dataset_path,
            confirm_callback=confirm_callback,
            output_dir=output_dir,
            target_config=target_config,
        )
    else:
        msg = f'Invalid mode {mode!r}. Must be "dynamic", "static", or "hybrid".'
        raise ValueError(msg)

    if print_results:
        from evaluatorq.redteam.reports.display import print_report_summary
        print_report_summary(report)

    return report


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


async def _run_dynamic(
    *,
    target: str,
    categories: list[str] | None,
    max_turns: int,
    max_per_category: int | None,
    attack_model: str,
    evaluator_model: str,
    parallelism: int,
    generate_strategies: bool,
    generated_strategy_count: int,
    max_dynamic_datapoints: int | None,
    cleanup_memory: bool,
    backend: str,
    target_factory: AgentTargetFactory | None,
    error_mapper: ErrorMapper | None,
    memory_cleanup: MemoryCleanup | None,
    llm_client: AsyncOpenAI | None,
    description: str | None,
    confirm_callback: Callable[[dict[str, Any]], bool] | None = None,
    output_dir: Path | None = None,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Run dynamic red teaming via evaluatorq."""
    from evaluatorq import evaluatorq
    from evaluatorq.tracing import capture_parent_context, init_tracing_if_needed

    from evaluatorq.redteam.backends.base import DefaultErrorMapper
    from evaluatorq.redteam.backends.registry import create_async_llm_client, resolve_backend
    from evaluatorq.redteam.adaptive.pipeline import (
        cleanup_memory_entities,
        create_dynamic_evaluator,
        create_dynamic_redteam_job,
        generate_dynamic_datapoints,
    )
    from evaluatorq.redteam.reports.converters import dynamic_evaluatorq_results_to_report
    from evaluatorq.redteam.tracing import set_span_attrs, with_redteam_span

    await init_tracing_if_needed()
    parent_context = await capture_parent_context()

    target_kind, target_value = _parse_target(target)

    async with with_redteam_span(
        "orq.redteam.pipeline",
        attributes={
            "orq.redteam.target": target,
            "orq.redteam.mode": "dynamic",
            "orq.redteam.backend": backend,
            "orq.redteam.max_turns": max_turns,
            "orq.redteam.parallelism": parallelism,
        },
        parent_context=parent_context,
    ) as pipeline_span:
        pipeline_start = datetime.now(tz=timezone.utc).astimezone()

        # Resolve backend
        backend_bundle = resolve_backend(backend, llm_client=llm_client, target_config=target_config)
        resolved_factory = target_factory or backend_bundle.target_factory
        resolved_error_mapper = error_mapper or DefaultErrorMapper()
        resolved_memory_cleanup = memory_cleanup or backend_bundle.memory_cleanup

        # Get agent context
        async with with_redteam_span(
            "orq.redteam.context_retrieval",
            {"orq.redteam.target": target_value},
        ) as ctx_span:
            agent_context: AgentContext = await backend_bundle.context_provider.get_agent_context(target_value)
            set_span_attrs(ctx_span, {
                "orq.redteam.num_tools": len(agent_context.tools) if agent_context.tools else 0,
                "orq.redteam.num_memory_stores": len(agent_context.memory_stores) if agent_context.memory_stores else 0,
                "orq.redteam.num_knowledge_bases": len(agent_context.knowledge_bases) if agent_context.knowledge_bases else 0,
            })

        _save_stage(output_dir, "01_agent_context.json", agent_context.model_dump_json(indent=2))

        resolved_categories = categories or list_available_categories()

        # Create LLM client for strategy generation
        resolved_llm_client = llm_client
        if resolved_llm_client is None and generate_strategies:
            resolved_llm_client = create_async_llm_client()

        # Stage 1: Generate datapoints
        logger.info(
            f'Generating attack datapoints for {target} '
            f'({len(resolved_categories)} categories, max_turns={max_turns})'
        )
        async with with_redteam_span(
            "orq.redteam.datapoint_generation",
            {
                "orq.redteam.num_categories": len(resolved_categories),
                "orq.redteam.generate_strategies": generate_strategies,
            },
        ) as dp_span:
            datapoints, _filtering_metadata = await generate_dynamic_datapoints(
                agent_context=agent_context,
                categories=resolved_categories,
                max_per_category=max_per_category,
                max_turns=max_turns,
                generate_additional_strategies=generate_strategies,
                generated_strategy_count=generated_strategy_count,
                llm_client=resolved_llm_client,
                attack_model=attack_model,
                parallelism=parallelism,
            )
            set_span_attrs(dp_span, {"orq.redteam.num_datapoints": len(datapoints)})

        # Warn if generated strategies will be unused due to cap
        if generate_strategies and generated_strategy_count > 0 and max_dynamic_datapoints is not None:
            template_count = sum(
                1 for dp in datapoints
                if not dp.inputs.get('strategy', {}).get('is_generated', False)
            )
            if template_count >= max_dynamic_datapoints:
                logger.warning(
                    f'max_dynamic_datapoints={max_dynamic_datapoints} is already covered by '
                    f'{template_count} template strategies — {generated_strategy_count} generated '
                    f'strategies per category will be unused. Consider increasing '
                    f'max_dynamic_datapoints or setting --no-generate-strategies.'
                )

        if max_dynamic_datapoints is not None and max_dynamic_datapoints > 0:
            datapoints = datapoints[:max_dynamic_datapoints]
        if not datapoints:
            msg = 'No datapoints generated. Check categories and agent capabilities.'
            raise ValueError(msg)

        _save_stage(output_dir, "02_datapoints.json", json.dumps([dp.inputs for dp in datapoints], indent=2, default=str))

        # Confirm callback
        if confirm_callback is not None:
            summary = {
                'agent_context': agent_context.model_dump(mode='json'),
                'num_datapoints': len(datapoints),
                'categories': resolved_categories,
                'attack_model': attack_model,
                'evaluator_model': evaluator_model,
                'max_turns': max_turns,
                'parallelism': parallelism,
            }
            if not confirm_callback(summary):
                msg = 'Execution cancelled by confirmation callback'
                raise RuntimeError(msg)

        # Stage 2: Create job and evaluator
        dynamic_job = create_dynamic_redteam_job(
            agent_key=target_value,
            agent_context=agent_context,
            red_team_model=attack_model,
            max_turns=max_turns,
            target_factory=resolved_factory,
            error_mapper=resolved_error_mapper,
            attack_llm_client=resolved_llm_client,
        )
        evaluator = create_dynamic_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)

        # Stage 3: Run evaluatorq
        logger.info(f'Running {len(datapoints)} attacks against {target} (parallelism={parallelism})')
        try:
            results = await evaluatorq(
                'dynamic-red-team',
                data=datapoints,
                jobs=[dynamic_job],
                evaluators=[evaluator],
                parallelism=parallelism,
                print_results=False,
                _exit_on_failure=False,
                description=description or f'Dynamic red teaming for {target}',
            )
        except (asyncio.CancelledError, KeyboardInterrupt):
            logger.warning('Run cancelled — attempting memory cleanup')
            if cleanup_memory and agent_context.has_memory:
                await cleanup_memory_entities(agent_context, [
                    dp.inputs['memory_entity_id']
                    for dp in datapoints
                    if 'memory_entity_id' in dp.inputs
                ], memory_cleanup=resolved_memory_cleanup)
            raise

        _save_stage(output_dir, "03_attack_results.json", json.dumps([r.model_dump(mode='json') for r in results], indent=2, default=str))

        pipeline_duration = (datetime.now(tz=timezone.utc).astimezone() - pipeline_start).total_seconds()

        # Stage 4: Normalize results
        logger.info(f'Normalizing results ({pipeline_duration:.1f}s elapsed)')
        report = dynamic_evaluatorq_results_to_report(
            agent_context=agent_context,
            categories_tested=resolved_categories,
            results=results,
            duration_seconds=pipeline_duration,
            description=description or f'Dynamic red teaming for {target}',
        )

        _save_report(output_dir, "04_summary_report.json", report)

        set_span_attrs(pipeline_span, {
            "orq.redteam.num_datapoints": len(datapoints),
            "orq.redteam.num_categories": len(resolved_categories),
            "orq.redteam.duration_seconds": pipeline_duration,
        })

        # Stage 5: Cleanup memory entities
        if cleanup_memory and agent_context.has_memory:
            entity_ids = [
                dp.inputs['memory_entity_id']
                for dp in datapoints
                if 'memory_entity_id' in dp.inputs
            ]
            if entity_ids:
                logger.info(f'Cleaning up {len(entity_ids)} memory entities')
                async with with_redteam_span(
                    "orq.redteam.memory_cleanup",
                    {"orq.redteam.num_entities": len(entity_ids)},
                ) as cleanup_span:
                    await cleanup_memory_entities(agent_context, entity_ids, memory_cleanup=resolved_memory_cleanup)
                    set_span_attrs(cleanup_span, {
                        "orq.redteam.num_stores": len(agent_context.memory_stores) if agent_context.memory_stores else 0,
                    })

        return report


async def _run_static(
    *,
    target: str,
    categories: list[str] | None,
    evaluator_model: str,
    parallelism: int,
    max_static_datapoints: int | None,
    backend: str,
    dataset_path: Any,
    description: str | None,
    llm_client: AsyncOpenAI | None = None,
    output_dir: Path | None = None,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Run static red teaming via evaluatorq."""
    from evaluatorq import evaluatorq

    from evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge import (
        create_owasp_evaluator,
        load_owasp_agentic_dataset,
    )
    from evaluatorq.redteam.frameworks.owasp.evaluators import get_evaluator_for_category
    from evaluatorq.redteam.reports.converters import static_evaluatorq_results_to_reports
    from evaluatorq.redteam.runtime.jobs import create_model_job

    target_kind, target_value = _parse_target(target)
    pipeline_start = datetime.now(tz=timezone.utc).astimezone()

    # Load dataset
    path = Path(dataset_path) if dataset_path is not None else None
    data = load_owasp_agentic_dataset(
        num_samples=max_static_datapoints,
        categories=categories,
        path=path,
    )

    # Filter out datapoints whose category has no registered evaluator
    if isinstance(data, list):
        from collections import Counter

        from evaluatorq.redteam.contracts import normalize_category

        skipped: Counter[str] = Counter()
        filtered: list[Any] = []
        for dp in data:
            cat = dp.inputs.get('category', '')
            norm_cat = normalize_category(cat)
            if get_evaluator_for_category(norm_cat) is None:
                skipped[norm_cat] += 1
            else:
                filtered.append(dp)
        for cat, count in sorted(skipped.items()):
            logger.warning(f'Skipped {count} datapoints for {cat}: no evaluator registered')
        if not filtered and data:
            msg = 'All datapoints were filtered out — no evaluator registered for any category.'
            raise ValueError(msg)
        data = filtered  # type: ignore[assignment]

    _save_stage(output_dir, "01_datapoints.json", json.dumps([dp.inputs for dp in data], indent=2, default=str))  # pyright: ignore[reportAttributeAccessIssue]

    # Create job based on target kind
    _sys_prompt = target_config.system_prompt if target_config else None
    if target_kind == 'agent':
        model_job = create_model_job(agent_key=target_value, llm_client=llm_client, system_prompt=_sys_prompt)
    elif target_kind == 'openai':
        model_job = create_model_job(model=target_value, llm_client=llm_client, system_prompt=_sys_prompt)
    elif target_kind == 'deployment':
        model_job = create_model_job(deployment_key=target_value, llm_client=llm_client, system_prompt=_sys_prompt)
    else:
        model_job = create_model_job(model=target_value, llm_client=llm_client, system_prompt=_sys_prompt)

    evaluator = create_owasp_evaluator(evaluator_model=evaluator_model, llm_client=llm_client)

    # Run evaluatorq with _exit_on_failure=False because in red teaming
    # "failures" are expected (they represent successfully breached defenses).
    logger.info(f'Running static red teaming against {target} (parallelism={parallelism})')
    results = await evaluatorq(
        'static-red-team',
        data=data,
        jobs=[model_job],
        evaluators=[evaluator],
        parallelism=parallelism,
        print_results=False,
        _exit_on_failure=False,
        description=description or f'Static red teaming for {target}',
    )

    _save_stage(output_dir, "02_attack_results.json", json.dumps([r.model_dump(mode='json') for r in results], indent=2, default=str))

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
    _save_report(output_dir, "03_summary_report.json", primary_report)
    return primary_report


async def _run_hybrid(
    *,
    target: str,
    categories: list[str] | None,
    max_turns: int,
    max_per_category: int | None,
    attack_model: str,
    evaluator_model: str,
    parallelism: int,
    generate_strategies: bool,
    generated_strategy_count: int,
    max_dynamic_datapoints: int | None,
    max_static_datapoints: int | None,
    cleanup_memory: bool,
    backend: str,
    target_factory: AgentTargetFactory | None,
    error_mapper: ErrorMapper | None,
    memory_cleanup: MemoryCleanup | None,
    llm_client: AsyncOpenAI | None,
    description: str | None,
    dataset_path: Any,
    confirm_callback: Callable[[dict[str, Any]], bool] | None = None,
    output_dir: Path | None = None,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Run hybrid red teaming — dynamic + static in a single evaluatorq call.

    Generates dynamic datapoints and loads static datapoints, tags each with
    routing metadata, then dispatches through a hybrid job and scorer.
    """
    from evaluatorq import DataPoint, EvaluationResult, evaluatorq, job

    from evaluatorq.redteam.backends.base import DefaultErrorMapper
    from evaluatorq.redteam.backends.registry import create_async_llm_client, resolve_backend
    from evaluatorq.redteam.adaptive.pipeline import (
        cleanup_memory_entities,
        create_dynamic_evaluator,
        create_dynamic_redteam_job,
        generate_dynamic_datapoints,
    )
    from evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge import (
        create_owasp_evaluator,
        load_owasp_agentic_dataset,
    )
    from evaluatorq.redteam.reports.converters import (
        dynamic_evaluatorq_results_to_report,
        merge_reports,
        static_evaluatorq_results_to_reports,
    )
    from evaluatorq.redteam.runtime.jobs import create_model_job

    target_kind, target_value = _parse_target(target)
    pipeline_start = datetime.now(tz=timezone.utc).astimezone()

    # Resolve backend
    backend_bundle = resolve_backend(backend, llm_client=llm_client, target_config=target_config)
    resolved_factory = target_factory or backend_bundle.target_factory
    resolved_error_mapper = error_mapper or DefaultErrorMapper()
    resolved_memory_cleanup = memory_cleanup or backend_bundle.memory_cleanup

    # Get agent context
    agent_context: AgentContext = await backend_bundle.context_provider.get_agent_context(target_value)
    _save_stage(output_dir, "01_agent_context.json", agent_context.model_dump_json(indent=2))

    resolved_categories = categories or list_available_categories()

    # Create LLM client
    resolved_llm_client = llm_client
    if resolved_llm_client is None and generate_strategies:
        resolved_llm_client = create_async_llm_client()

    # Generate dynamic datapoints
    dynamic_datapoints, _ = await generate_dynamic_datapoints(
        agent_context=agent_context,
        categories=resolved_categories,
        max_per_category=max_per_category,
        max_turns=max_turns,
        generate_additional_strategies=generate_strategies,
        generated_strategy_count=generated_strategy_count,
        llm_client=resolved_llm_client,
        attack_model=attack_model,
        parallelism=parallelism,
    )

    # Warn if generated strategies will be unused due to cap
    if generate_strategies and generated_strategy_count > 0 and max_dynamic_datapoints is not None:
        template_count = sum(
            1 for dp in dynamic_datapoints
            if not dp.inputs.get('strategy', {}).get('is_generated', False)
        )
        if template_count >= max_dynamic_datapoints:
            logger.warning(
                f'max_dynamic_datapoints={max_dynamic_datapoints} is already covered by '
                f'{template_count} template strategies — {generated_strategy_count} generated '
                f'strategies per category will be unused. Consider increasing '
                f'max_dynamic_datapoints or setting --no-generate-strategies.'
            )

    # Cap dynamic datapoints independently
    if max_dynamic_datapoints is not None and max_dynamic_datapoints > 0:
        dynamic_datapoints = dynamic_datapoints[:max_dynamic_datapoints]

    _save_stage(output_dir, "02_dynamic_datapoints.json", json.dumps([dp.inputs for dp in dynamic_datapoints], indent=2, default=str))

    # Load static datapoints (capped independently)
    path = Path(dataset_path) if dataset_path is not None else None
    static_data = load_owasp_agentic_dataset(
        num_samples=max_static_datapoints,
        categories=categories,
        path=path,
    )
    static_datapoints: list[DataPoint] = static_data if isinstance(static_data, list) else []
    _save_stage(output_dir, "03_static_datapoints.json", json.dumps([dp.inputs for dp in static_datapoints], indent=2, default=str))

    # Tag datapoints with hybrid routing metadata
    for dp in dynamic_datapoints:
        dp.inputs['hybrid_source'] = 'dynamic'
    for dp in static_datapoints:
        dp.inputs['hybrid_source'] = 'static'

    all_datapoints = dynamic_datapoints + static_datapoints
    if not all_datapoints:
        msg = 'No datapoints generated for hybrid mode.'
        raise ValueError(msg)

    # Confirm callback
    if confirm_callback is not None:
        summary = {
            'agent_context': agent_context.model_dump(mode='json'),
            'num_datapoints': len(all_datapoints),
            'num_dynamic': len(dynamic_datapoints),
            'num_static': len(static_datapoints),
            'categories': resolved_categories,
            'attack_model': attack_model,
            'evaluator_model': evaluator_model,
            'max_turns': max_turns,
            'parallelism': parallelism,
        }
        if not confirm_callback(summary):
            msg = 'Execution cancelled by confirmation callback'
            raise RuntimeError(msg)

    # Create the underlying jobs
    dynamic_job = create_dynamic_redteam_job(
        agent_key=target_value,
        agent_context=agent_context,
        red_team_model=attack_model,
        max_turns=max_turns,
        target_factory=resolved_factory,
        error_mapper=resolved_error_mapper,
        attack_llm_client=resolved_llm_client,
    )
    _sys_prompt = target_config.system_prompt if target_config else None
    if target_kind == 'agent':
        static_job = create_model_job(agent_key=target_value, llm_client=resolved_llm_client, system_prompt=_sys_prompt)
    elif target_kind == 'openai':
        static_job = create_model_job(model=target_value, llm_client=resolved_llm_client, system_prompt=_sys_prompt)
    elif target_kind == 'deployment':
        static_job = create_model_job(deployment_key=target_value, llm_client=resolved_llm_client, system_prompt=_sys_prompt)
    else:
        static_job = create_model_job(model=target_value, llm_client=resolved_llm_client, system_prompt=_sys_prompt)

    # Build hybrid dispatcher job — inner jobs are @job-decorated so they
    # return {"name": ..., "output": ...}. Unwrap to get the raw output.
    safe_target = ''.join(ch if ch.isalnum() or ch in {'-', '_'} else '-' for ch in target_value).strip('-') or 'unknown'

    @job(f'redteam:hybrid:{safe_target}')
    async def hybrid_job(data: DataPoint, row: int) -> Any:
        route = data.inputs.get('hybrid_source', 'static')
        inner = dynamic_job if route == 'dynamic' else static_job
        result = await inner(data, row)
        output = result.get('output', result) if isinstance(result, dict) else result
        # Serialize dynamic dict output to JSON string for evaluatorq persistence
        # safety (matches research repo pattern).
        if route == 'dynamic' and isinstance(output, dict):
            return json.dumps(output, default=str)
        return output

    # Build hybrid scorer
    dynamic_evaluator = create_dynamic_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)
    static_evaluator = create_owasp_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)

    async def hybrid_scorer(params: Any) -> EvaluationResult:
        data = params['data']
        route = data.inputs.get('hybrid_source', 'static')
        if route == 'dynamic':
            # Dynamic output was JSON-serialized; deserialize for the scorer.
            raw_output = params.get('output')
            if isinstance(raw_output, str):
                try:
                    raw_output = json.loads(raw_output)
                except (json.JSONDecodeError, TypeError) as e:
                    logger.warning(f'Failed to deserialize dynamic output as JSON: {e}')
            dynamic_params = dict(params, output=raw_output)
            return await dynamic_evaluator['scorer'](dynamic_params)
        return await static_evaluator['scorer'](params)

    # Run evaluatorq
    logger.info(
        f'Running hybrid red teaming against {target} '
        f'({len(dynamic_datapoints)} dynamic + {len(static_datapoints)} static, parallelism={parallelism})'
    )
    try:
        results = await evaluatorq(
            'hybrid-red-team',
            data=all_datapoints,
            jobs=[hybrid_job],
            evaluators=[{'name': 'hybrid-owasp-security', 'scorer': hybrid_scorer}],
            parallelism=parallelism,
            print_results=False,
            _exit_on_failure=False,
            description=description or f'Hybrid red teaming for {target}',
        )
    except (asyncio.CancelledError, KeyboardInterrupt):
        logger.warning('Hybrid run cancelled — attempting memory cleanup')
        if cleanup_memory and agent_context.has_memory:
            entity_ids = [
                dp.inputs['memory_entity_id']
                for dp in dynamic_datapoints
                if 'memory_entity_id' in dp.inputs
            ]
            if entity_ids:
                await cleanup_memory_entities(agent_context, entity_ids, memory_cleanup=resolved_memory_cleanup)
        raise

    _save_stage(output_dir, "04_attack_results.json", json.dumps([r.model_dump(mode='json') for r in results], indent=2, default=str))

    pipeline_duration = (datetime.now(tz=timezone.utc).astimezone() - pipeline_start).total_seconds()

    # Split results by source and convert
    dynamic_results = [r for r in results if getattr(r, 'data_point', None) and r.data_point.inputs.get('hybrid_source') == 'dynamic']
    static_results = [r for r in results if getattr(r, 'data_point', None) and r.data_point.inputs.get('hybrid_source') != 'dynamic']

    reports_to_merge: list[RedTeamReport] = []
    if dynamic_results:
        from evaluatorq.redteam.reports.converters import dynamic_evaluatorq_results_to_report
        dyn_report = dynamic_evaluatorq_results_to_report(
            agent_context=agent_context,
            categories_tested=resolved_categories,
            results=dynamic_results,
            duration_seconds=pipeline_duration,
            description=f'{description or "Hybrid"} (dynamic)',
        )
        reports_to_merge.append(dyn_report)
    if static_results:
        static_reports = static_evaluatorq_results_to_reports(
            results=static_results,
            agent_model=target_value if target_kind != 'agent' else None,
            agent_key=target_value if target_kind == 'agent' else None,
            description=f'{description or "Hybrid"} (static)',
        )
        reports_to_merge.extend(static_reports.values())

    if not reports_to_merge:
        from evaluatorq.redteam.reports.converters import static_results_to_report
        return static_results_to_report([], description=description)

    report = merge_reports(*reports_to_merge, description=description or f'Hybrid red teaming for {target}')
    report.duration_seconds = pipeline_duration
    report.summary.datapoint_breakdown = _datapoint_breakdown(all_datapoints)
    _save_report(output_dir, "05_summary_report.json", report)

    # Memory cleanup
    if cleanup_memory and agent_context.has_memory:
        entity_ids = [
            dp.inputs['memory_entity_id']
            for dp in dynamic_datapoints
            if 'memory_entity_id' in dp.inputs
        ]
        if entity_ids:
            logger.info(f'Cleaning up {len(entity_ids)} memory entities')
            await cleanup_memory_entities(agent_context, entity_ids, memory_cleanup=resolved_memory_cleanup)

    return report


