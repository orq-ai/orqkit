"""Unified red teaming runner that dispatches to dynamic/static/hybrid pipelines."""

from __future__ import annotations

import asyncio
import copy
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from evaluatorq.redteam.adaptive.strategy_registry import (
    get_category_info,
    list_available_categories,
)
from evaluatorq.redteam.contracts import AgentContext, DEFAULT_PIPELINE_MODEL, Pipeline, RedTeamReport, TargetConfig
from evaluatorq.redteam.exceptions import CancelledError, CredentialError
from evaluatorq.redteam.hooks import ConfirmPayload, DefaultHooks, PipelineHooks


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
    logger.debug(f"Saved {filename} to {output_dir}")


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
    logger.debug(f"Saved {filename} to {output_dir}")


async def _send_cleaned_results(
    results: list[Any],
    name: str,
    description: str,
    start_time: datetime,
) -> None:
    """Strip skipped job results and upload to the Orq platform.

    In multi-target mode each ``DataPointResult`` may contain job results
    from *all* target jobs, but only the matching target produces a real
    output — the rest return ``None``.  Before uploading we remove those
    empty job results so the experiment shows one clean row per datapoint
    without duplication.
    """
    from evaluatorq.send_results import send_results_to_orq
    from evaluatorq.types import DataPointResult

    api_key = os.environ.get("ORQ_API_KEY")
    if not api_key:
        logger.debug("Skipping result upload to Orq platform: ORQ_API_KEY not set")
        return

    cleaned: list[DataPointResult] = []
    for result in results:
        if not result.job_results:
            continue
        # Keep only job results with a non-None output
        real_jobs = [jr for jr in result.job_results if jr.output is not None]
        if not real_jobs:
            continue
        # Shallow-copy the result and replace job_results
        clean = copy.copy(result)
        clean.job_results = real_jobs
        cleaned.append(clean)

    if not cleaned:
        logger.debug("No cleaned results to send to Orq platform")
        return

    logger.debug(f"Sending {len(cleaned)} cleaned results to Orq platform (stripped from {len(results)} raw)")
    try:
        await send_results_to_orq(
            api_key=api_key,
            evaluation_name=name,
            evaluation_description=description,
            dataset_id=None,
            results=cleaned,
            start_time=start_time,
            end_time=datetime.now(tz=timezone.utc),
        )
    except Exception as e:
        logger.error(
            f'Failed to upload {len(cleaned)} results to Orq platform: {e}. '
            'Results have been saved locally.'
        )


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
    from collections.abc import Callable

    from openai import AsyncOpenAI

    from evaluatorq import DataPoint
    from evaluatorq.redteam.backends.base import AgentTargetFactory, ErrorMapper, MemoryCleanup


# ---------------------------------------------------------------------------
# PreparedTarget dataclass
# ---------------------------------------------------------------------------

@dataclass
class PreparedTarget:
    """Typed container for all per-target state prepared before a run.

    Returned by :func:`_prepare_target` and consumed by
    :func:`_run_dynamic_or_hybrid`.
    """

    target: str
    target_kind: str
    target_value: str
    safe_target: str
    agent_context: AgentContext
    dynamic_datapoints: list[DataPoint]
    static_datapoints: list[DataPoint]  # empty list for dynamic mode
    all_datapoints: list[DataPoint]
    job: Callable[..., Any]  # the @job-decorated callable for this target
    dynamic_job: Callable[..., Any]  # raw inner dynamic job
    resolved_memory_cleanup: MemoryCleanup
    resolved_llm_client: AsyncOpenAI
    filtering_metadata: dict[str, Any]
    memory_entity_ids: list[str]  # runtime-accumulated entity IDs for cleanup


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def red_team(
    target: str | list[str],
    *,
    mode: Pipeline | str = Pipeline.DYNAMIC,
    categories: list[str] | None = None,
    vulnerabilities: list[str] | None = None,
    max_turns: int = 5,
    max_per_category: int | None = None,
    attack_model: str = DEFAULT_PIPELINE_MODEL,
    evaluator_model: str = DEFAULT_PIPELINE_MODEL,
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
    dataset_path: Path | str | None = None,
    hooks: PipelineHooks | None = None,
    output_dir: Path | str | None = None,
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
            Defaults to all available categories. Ignored if ``vulnerabilities`` is set.
        vulnerabilities: Vulnerability IDs to test (e.g., ``["goal_hijacking", "prompt_injection"]``).
            Takes precedence over ``categories``.
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
        hooks: Optional ``PipelineHooks`` implementation. Defaults to
            ``DefaultHooks()`` (loguru output, auto-confirm).
        output_dir: Optional directory to save intermediate stage artifacts as
            numbered JSON files. When ``None`` (default), no files are written.
        target_config: Optional backend-agnostic target configuration (e.g.
            system prompt for OpenAI targets).

    Returns:
        RedTeamReport with results and summary statistics.

    Raises:
        ValueError: If mode is invalid or required arguments are missing.
        CancelledError: If hooks.on_confirm returns False.
    """
    resolved_hooks: PipelineHooks = hooks or DefaultHooks()
    resolved_output_dir = Path(output_dir) if output_dir is not None else None

    targets = [target] if isinstance(target, str) else list(target)
    if not targets:
        msg = 'red_team() requires at least one target'
        raise ValueError(msg)

    resolved_mode = Pipeline(mode)

    # Early credential validation — fail fast with a clear message
    if llm_client is None and not os.getenv('OPENAI_API_KEY') and not os.getenv('ORQ_API_KEY'):
        raise CredentialError(
            'Missing LLM credentials. Set either OPENAI_API_KEY (optionally OPENAI_BASE_URL) '
            'or ORQ_API_KEY (optionally ORQ_BASE_URL).'
        )

    if vulnerabilities:
        from evaluatorq.redteam.vulnerability_registry import (
            get_primary_category,
            resolve_vulnerabilities as _resolve_vulns,
        )
        resolved_vulns = _resolve_vulns(vulnerabilities)
        resolved_categories = [get_primary_category(v) for v in resolved_vulns]
    elif categories:
        resolved_categories = categories
    else:
        resolved_categories = list_available_categories()

    if resolved_mode in (Pipeline.DYNAMIC, Pipeline.HYBRID):
        report = await _run_dynamic_or_hybrid(
            targets=targets,
            mode=resolved_mode,
            categories=resolved_categories,
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
            hooks=resolved_hooks,
            output_dir=resolved_output_dir,
            target_config=target_config,
        )
    elif resolved_mode == Pipeline.STATIC:
        report = await _run_static(
            targets=targets,
            categories=resolved_categories,
            evaluator_model=evaluator_model,
            parallelism=parallelism,
            max_static_datapoints=max_static_datapoints,
            backend=backend,
            dataset_path=dataset_path,
            description=description,
            llm_client=llm_client,
            hooks=resolved_hooks,
            output_dir=resolved_output_dir,
            target_config=target_config,
        )
    else:
        msg = f'Invalid mode {mode!r}. Must be "dynamic", "static", or "hybrid".'
        raise ValueError(msg)

    resolved_hooks.on_complete(report, output_dir=str(resolved_output_dir) if resolved_output_dir else None)
    return report


# ---------------------------------------------------------------------------
# Shared helpers
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


def _make_safe_target(value: str) -> str:
    """Return a job-name-safe slug from a target value."""
    return ''.join(ch if ch.isalnum() or ch in {'-', '_'} else '-' for ch in value).strip('-') or 'unknown'


def _create_job_for_target(
    target: str,
    llm_client: Any,
    system_prompt: str | None,
) -> Any:
    """Create a model job for the given target string.

    Dispatches on the target kind (``agent``, ``openai``, ``deployment``, or
    fallback to model) and returns the appropriate
    :func:`~evaluatorq.redteam.runtime.jobs.create_model_job` result.

    Args:
        target:        Full target string, e.g. ``"agent:my-key"`` or
                       ``"openai:gpt-4o"``.
        llm_client:    Optional pre-configured :class:`openai.AsyncOpenAI`
                       client.
        system_prompt: Optional system prompt to pass to the job.

    Returns:
        A job callable as returned by ``create_model_job``.
    """
    from evaluatorq.redteam.runtime.jobs import create_model_job

    kind, value = _parse_target(target)
    if kind == 'agent':
        return create_model_job(agent_key=value, llm_client=llm_client, system_prompt=system_prompt)
    elif kind == 'openai':
        return create_model_job(model=value, llm_client=llm_client, system_prompt=system_prompt)
    elif kind == 'deployment':
        return create_model_job(deployment_key=value, llm_client=llm_client, system_prompt=system_prompt)
    else:
        return create_model_job(model=value, llm_client=llm_client, system_prompt=system_prompt)


# ---------------------------------------------------------------------------
# Per-target preparation (dynamic and hybrid)
# ---------------------------------------------------------------------------

async def _prepare_target(
    *,
    target: str,
    mode: Pipeline,
    categories: list[str] | None,
    max_turns: int,
    max_per_category: int | None,
    attack_model: str,
    parallelism: int,
    generate_strategies: bool,
    generated_strategy_count: int,
    max_dynamic_datapoints: int | None,
    max_static_datapoints: int | None,
    backend: str,
    target_factory: AgentTargetFactory | None,
    error_mapper: ErrorMapper | None,
    memory_cleanup: MemoryCleanup | None,
    llm_client: AsyncOpenAI | None,
    dataset_path: Any,
    hooks: PipelineHooks,
    output_dir: Path | None,
    target_config: TargetConfig | None,
    resolved_categories: list[str],
    shared_datapoints: list[Any] | None = None,
) -> PreparedTarget:
    """Prepare all per-target state for a dynamic or hybrid run.

    Always: parse target, resolve backend, retrieve agent context, and
    build a job closure for this target.

    When ``shared_datapoints`` is None (default): generate dynamic datapoints
    from this target's agent context (first-target behaviour).

    When ``shared_datapoints`` is provided: skip datapoint generation and
    reuse those datapoints directly (subsequent-target behaviour in
    multi-target runs).

    When ``mode == Pipeline.HYBRID`` and ``dataset_path`` is provided: also load the
    static dataset, create a static job, and build a hybrid dispatcher job
    that routes on ``hybrid_source``.

    When ``mode == 'dynamic'``: skip the static dataset and build a simpler
    dynamic job wrapper.

    Returns:
        A :class:`PreparedTarget` instance with all per-target state.
    """
    from evaluatorq import DataPoint, job

    from evaluatorq.redteam.backends.base import DefaultErrorMapper
    from evaluatorq.redteam.backends.registry import create_async_llm_client, resolve_backend
    from evaluatorq.redteam.adaptive.pipeline import (
        create_dynamic_redteam_job,
        generate_dynamic_datapoints,
    )

    target_kind, target_value = _parse_target(target)
    safe_target = _make_safe_target(target_value)

    backend_bundle = resolve_backend(backend, llm_client=llm_client, target_config=target_config)
    resolved_factory = target_factory or backend_bundle.target_factory
    resolved_error_mapper = error_mapper or DefaultErrorMapper()
    resolved_memory_cleanup_t = memory_cleanup or backend_bundle.memory_cleanup

    # Context retrieval
    hooks.on_stage_start("context_retrieval", {"target": target_value})
    agent_context: AgentContext = await backend_bundle.context_provider.get_agent_context(target_value)
    hooks.on_stage_end("context_retrieval", {
        "num_tools": len(agent_context.tools) if agent_context.tools else 0,
        "num_memory_stores": len(agent_context.memory_stores) if agent_context.memory_stores else 0,
        "num_knowledge_bases": len(agent_context.knowledge_bases) if agent_context.knowledge_bases else 0,
    })

    # LLM client
    resolved_llm_client = llm_client
    if resolved_llm_client is None and generate_strategies:
        resolved_llm_client = create_async_llm_client()

    if shared_datapoints is not None:
        # Reuse datapoints generated by the first target — skip generation
        dynamic_datapoints = list(shared_datapoints)
        filtering_metadata: dict[str, Any] = {}
        hooks.on_stage_start("datapoint_generation", {"target": target})
        hooks.on_stage_end("datapoint_generation", {
            "num_datapoints": len(dynamic_datapoints),
            "shared": True,
        })
    else:
        # Datapoint generation
        hooks.on_stage_start("datapoint_generation", {
            "num_categories": len(resolved_categories),
            "target": target,
        })

        dynamic_datapoints, filtering_metadata = await generate_dynamic_datapoints(
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

        if generate_strategies and generated_strategy_count > 0 and max_dynamic_datapoints is not None:
            template_count = sum(
                1 for dp in dynamic_datapoints
                if not dp.inputs.get('strategy', {}).get('is_generated', False)
            )
            if template_count >= max_dynamic_datapoints:
                logger.warning(
                    f'[{target}] max_dynamic_datapoints={max_dynamic_datapoints} is already covered by '
                    f'{template_count} template strategies — {generated_strategy_count} generated '
                    f'strategies per category will be unused.'
                )

        if max_dynamic_datapoints is not None and max_dynamic_datapoints > 0:
            dynamic_datapoints = dynamic_datapoints[:max_dynamic_datapoints]

    # Build the raw dynamic job for this target
    _memory_entity_ids: list[str] = []
    dynamic_job = create_dynamic_redteam_job(
        agent_key=target_value,
        agent_context=agent_context,
        red_team_model=attack_model,
        max_turns=max_turns,
        target_factory=resolved_factory,
        error_mapper=resolved_error_mapper,
        attack_llm_client=resolved_llm_client,
        memory_entity_ids=_memory_entity_ids,
    )

    # --- Mode-specific path ---------------------------------------------------

    if mode == Pipeline.HYBRID and dataset_path is not None:
        if shared_datapoints is not None:
            # Shared datapoints already contain both dynamic and static (tagged).
            # Split them back out so PreparedTarget fields stay semantically correct.
            static_datapoints: list[Any] = [
                dp for dp in dynamic_datapoints
                if dp.inputs.get('hybrid_source') == 'static'
            ]
            dynamic_datapoints = [
                dp for dp in dynamic_datapoints
                if dp.inputs.get('hybrid_source') != 'static'
            ]
            all_datapoints = dynamic_datapoints + static_datapoints
        else:
            from evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge import load_owasp_agentic_dataset

            # Load static datapoints
            path = Path(dataset_path)
            static_data = load_owasp_agentic_dataset(
                num_samples=max_static_datapoints,
                categories=categories,
                path=path,
            )
            static_datapoints = static_data if isinstance(static_data, list) else []

            # Tag with hybrid_source only (no target_tag — datapoints are shared)
            for dp in dynamic_datapoints:
                dp.inputs['hybrid_source'] = 'dynamic'
            for dp in static_datapoints:
                dp.inputs['hybrid_source'] = 'static'

            all_datapoints = dynamic_datapoints + static_datapoints

        hooks.on_stage_end("datapoint_generation", {
            "num_datapoints": len(all_datapoints),
            "num_dynamic": len(dynamic_datapoints),
            "num_static": len(static_datapoints),
        })

        # Build the static job via shared helper
        _sys_prompt = target_config.system_prompt if target_config else None
        static_job = _create_job_for_target(target, resolved_llm_client, _sys_prompt)

        # Build the hybrid dispatcher job
        _safe_target = safe_target  # explicit cell binding for the closure

        @job(f'redteam:hybrid:{_safe_target}')
        async def _target_job(
            data: DataPoint,
            row: int,
            _dyn: Any = dynamic_job,
            _sta: Any = static_job,
        ) -> Any:
            route = data.inputs.get('hybrid_source', 'static')
            inner = _dyn if route == 'dynamic' else _sta
            result = await inner(data, row)
            # Inner job is @job-decorated, so it returns {"name": ..., "output": ...}.
            # Unwrap to avoid double-wrapping since _target_job is also @job-decorated.
            return result.get('output', result) if isinstance(result, dict) else result

    else:
        # Dynamic mode — no target_tag tagging needed, datapoints are shared
        static_datapoints = []
        all_datapoints = dynamic_datapoints

        if shared_datapoints is None:
            hooks.on_stage_end("datapoint_generation", {"num_datapoints": len(all_datapoints)})

        # Build the dynamic dispatcher job
        _safe_target = safe_target

        @job(f'redteam:dynamic:{_safe_target}')
        async def _target_job(
            data: DataPoint,
            row: int,
            _inner: Any = dynamic_job,
        ) -> Any:
            result = await _inner(data, row)
            # Inner job is @job-decorated, so it returns {"name": ..., "output": ...}.
            # Unwrap to avoid double-wrapping since _target_job is also @job-decorated.
            return result.get('output', result) if isinstance(result, dict) else result

    return PreparedTarget(
        target=target,
        target_kind=target_kind,
        target_value=target_value,
        safe_target=safe_target,
        agent_context=agent_context,
        dynamic_datapoints=dynamic_datapoints,
        static_datapoints=static_datapoints,
        all_datapoints=all_datapoints,
        job=_target_job,
        dynamic_job=dynamic_job,
        resolved_memory_cleanup=resolved_memory_cleanup_t,
        resolved_llm_client=resolved_llm_client,
        filtering_metadata=filtering_metadata,
        memory_entity_ids=_memory_entity_ids,
    )


# ---------------------------------------------------------------------------
# Merged dynamic + hybrid runner
# ---------------------------------------------------------------------------

async def _run_dynamic_or_hybrid(
    *,
    targets: list[str],
    mode: Pipeline,
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
    hooks: PipelineHooks | None = None,
    output_dir: Path | None = None,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Run dynamic or hybrid red teaming for multiple targets in a single evaluatorq call.

    For each target, :func:`_prepare_target` retrieves agent context, generates
    agent-specific dynamic datapoints, and produces a job closure.  The first
    target generates shared datapoints; subsequent targets reuse them to avoid
    redundant LLM calls.  For hybrid mode an additional static dataset is loaded
    and a routing job is built.  All jobs are submitted in a single
    ``evaluatorq()`` call.

    After execution, results are split by ``job_name`` (matching each target's
    ``safe_target`` slug) and converted to per-target :class:`RedTeamReport`
    instances, which are merged into one unified report.

    Args:
        mode: ``"dynamic"`` or ``"hybrid"``.
    """
    from evaluatorq import EvaluationResult, evaluatorq

    from evaluatorq.redteam.adaptive.pipeline import (
        cleanup_memory_entities,
        create_dynamic_evaluator,
    )
    from evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge import create_owasp_evaluator
    from evaluatorq.redteam.reports.converters import (
        dynamic_evaluatorq_results_to_report,
        merge_reports,
        static_evaluatorq_results_to_reports,
        static_results_to_report,
    )
    from evaluatorq.redteam.tracing import set_span_attrs, with_redteam_span
    from evaluatorq.tracing import capture_parent_context, init_tracing_if_needed

    resolved_hooks: PipelineHooks = hooks or DefaultHooks()
    pipeline_start = datetime.now(tz=timezone.utc).astimezone()

    resolved_categories = categories or list_available_categories()

    await init_tracing_if_needed()
    parent_context = await capture_parent_context()

    async with with_redteam_span(
        "orq.redteam.pipeline",
        attributes={
            "orq.redteam.targets": ", ".join(targets),
            "orq.redteam.mode": mode,
            "orq.redteam.backend": backend,
            "orq.redteam.max_turns": max_turns,
            "orq.redteam.parallelism": parallelism,
        },
        parent_context=parent_context,
    ) as pipeline_span:

        # Step 1: Prepare the first target fully — this generates the shared datapoints.
        _common_prepare_kwargs: dict[str, Any] = dict(
            mode=mode,
            categories=categories,
            max_turns=max_turns,
            max_per_category=max_per_category,
            attack_model=attack_model,
            parallelism=parallelism,
            generate_strategies=generate_strategies,
            generated_strategy_count=generated_strategy_count,
            max_dynamic_datapoints=max_dynamic_datapoints,
            max_static_datapoints=max_static_datapoints,
            backend=backend,
            target_factory=target_factory,
            error_mapper=error_mapper,
            memory_cleanup=memory_cleanup,
            llm_client=llm_client,
            dataset_path=dataset_path,
            hooks=resolved_hooks,
            output_dir=output_dir,
            target_config=target_config,
            resolved_categories=resolved_categories,
        )
        first_target = await _prepare_target(target=targets[0], **_common_prepare_kwargs)

        # Step 2: Prepare remaining targets with shared datapoints — skip generation.
        if len(targets) > 1:
            other_targets: list[PreparedTarget] = list(await asyncio.gather(
                *[
                    _prepare_target(
                        target=t,
                        shared_datapoints=first_target.all_datapoints,
                        **_common_prepare_kwargs,
                    )
                    for t in targets[1:]
                ]
            ))
            prepared_targets: list[PreparedTarget] = [first_target] + other_targets
        else:
            prepared_targets = [first_target]

        # Step 3: Use the first target's datapoints as THE shared datapoints.
        # All jobs run on the same set of datapoints for side-by-side comparison.
        all_datapoints: list[Any] = first_target.all_datapoints
        all_jobs: list[Any] = [pt.job for pt in prepared_targets]

        if not all_datapoints:
            msg = f'No datapoints generated for any target in {mode} multi-target mode.'
            raise ValueError(msg)

        _save_stage(
            output_dir,
            "01_all_datapoints.json",
            json.dumps([dp.inputs for dp in all_datapoints], indent=2, default=str),
        )

        # Confirm hook — aggregate across all targets (fires once)
        first_ctx = prepared_targets[0].agent_context if prepared_targets else None
        all_filtering_metadata = next(
            (pt.filtering_metadata for pt in prepared_targets if isinstance(pt.filtering_metadata, dict)),
            None,
        )

        if mode == Pipeline.HYBRID:
            # Datapoints are shared — use the first target's counts (they're the same for all)
            total_dynamic = len(first_target.dynamic_datapoints)
            total_static = len(first_target.static_datapoints)
            confirm_payload: ConfirmPayload = {
                "agent_context": first_ctx.model_dump(mode="json") if first_ctx is not None else None,
                "num_datapoints": len(all_datapoints),
                "num_dynamic": total_dynamic,
                "num_static": total_static,
                "categories": resolved_categories,
                "attack_model": attack_model,
                "evaluator_model": evaluator_model,
                "max_turns": max_turns,
                "parallelism": parallelism,
                "filtering_metadata": all_filtering_metadata,
                "mode": "hybrid",
                "target": ", ".join(targets),
                "dataset_path": str(dataset_path) if dataset_path else None,
                "vulnerabilities": None,
            }
        else:
            confirm_payload = {
                "agent_context": first_ctx.model_dump(mode="json") if first_ctx is not None else None,
                "num_datapoints": len(all_datapoints),
                "num_dynamic": len(all_datapoints),
                "num_static": None,
                "categories": resolved_categories,
                "attack_model": attack_model,
                "evaluator_model": evaluator_model,
                "max_turns": max_turns,
                "parallelism": parallelism,
                "filtering_metadata": all_filtering_metadata,
                "mode": "dynamic",
                "target": ", ".join(targets),
                "dataset_path": None,
                "vulnerabilities": None,
            }

        if not resolved_hooks.on_confirm(confirm_payload):
            msg = 'Execution cancelled by confirmation callback'
            raise CancelledError(msg)

        # Stage: attack_execution
        resolved_hooks.on_stage_start("attack_execution", {
            "num_datapoints": len(all_datapoints),
            "targets": targets,
        })

        resolved_llm_client = llm_client

        # Build evaluator — hybrid routes on hybrid_source; dynamic uses the
        # dynamic evaluator directly.
        has_static = any(pt.static_datapoints for pt in prepared_targets)
        if mode == Pipeline.HYBRID and has_static:
            dynamic_evaluator = create_dynamic_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)
            static_evaluator = create_owasp_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)

            async def hybrid_scorer(params: Any) -> EvaluationResult:
                data = params['data']
                route = data.inputs.get('hybrid_source', 'static')
                if route == 'dynamic':
                    raw_output = params.get('output')
                    if isinstance(raw_output, str):
                        try:
                            raw_output = json.loads(raw_output)
                        except (json.JSONDecodeError, TypeError) as e:
                            logger.warning(f'Failed to deserialize dynamic output as JSON: {e}')
                    dynamic_params = dict(params, output=raw_output)
                    return await dynamic_evaluator['scorer'](dynamic_params)
                return await static_evaluator['scorer'](params)

            evaluators: list[Any] = [{'name': 'hybrid-owasp-security', 'scorer': hybrid_scorer}]
            log_label = (
                f'{len(first_target.dynamic_datapoints)} dynamic + '
                f'{len(first_target.static_datapoints)} static datapoints'
            )
        else:
            evaluator = create_dynamic_evaluator(evaluator_model=evaluator_model, llm_client=resolved_llm_client)
            evaluators = [evaluator]
            log_label = f'{len(all_datapoints)} datapoints'

        try:
            results = await evaluatorq(
                'red-team',
                data=all_datapoints,
                jobs=all_jobs,
                evaluators=evaluators,
                parallelism=parallelism,
                print_results=False,
                _exit_on_failure=False,
                _send_results=False,
                description=description or f'{mode.capitalize()} red teaming ({len(targets)} targets)',
            )
        except (asyncio.CancelledError, KeyboardInterrupt):
            logger.warning(f'Multi-target {mode} run cancelled — attempting memory cleanup')
            for pt in prepared_targets:
                if cleanup_memory and pt.agent_context.has_memory:
                    entity_ids = pt.memory_entity_ids
                    if entity_ids:
                        await cleanup_memory_entities(
                            pt.agent_context, entity_ids, memory_cleanup=pt.resolved_memory_cleanup
                        )
            raise

        resolved_hooks.on_stage_end("attack_execution", {"num_results": len(results)})

        _save_stage(
            output_dir,
            "02_attack_results.json",
            json.dumps([r.model_dump(mode='json') for r in results], indent=2, default=str),
        )

        pipeline_duration = (datetime.now(tz=timezone.utc).astimezone() - pipeline_start).total_seconds()

        # Stage: report_generation — split by job_name, convert, merge
        resolved_hooks.on_stage_start("report_generation", {"num_results": len(results)})

        # Group raw evaluatorq results by target safe_target slug, matching
        # job_name from each job result (job names are like "redteam:dynamic:<safe_target>").
        # With shared datapoints each DataPointResult has job_results from ALL targets,
        # so we create synthetic per-target copies containing only that target's job result.
        results_by_target: dict[str, list[Any]] = {}
        for result in results:
            if not result.job_results:
                # No job results — assign to all targets so reports can show the gap
                for pt in prepared_targets:
                    results_by_target.setdefault(pt.safe_target, []).append(result)
                continue
            for jr in result.job_results:
                for pt in prepared_targets:
                    if pt.safe_target in (jr.job_name or ''):
                        target_result = copy.copy(result)
                        target_result.job_results = [jr]
                        results_by_target.setdefault(pt.safe_target, []).append(target_result)
                        break
                else:
                    logger.warning(f'Job result with name {jr.job_name!r} did not match any target — excluded from reports')

        per_target_reports: list[RedTeamReport] = []
        for pt in prepared_targets:
            safe = pt.safe_target
            target_results = results_by_target.get(safe, [])

            if mode == Pipeline.HYBRID and has_static:
                # Split by hybrid_source and convert separately, then merge
                dynamic_results = [
                    r for r in target_results
                    if getattr(r, 'data_point', None) is not None
                    and r.data_point.inputs.get('hybrid_source') == 'dynamic'
                ]
                static_results_for_target = [
                    r for r in target_results
                    if getattr(r, 'data_point', None) is not None
                    and r.data_point.inputs.get('hybrid_source') != 'dynamic'
                ]

                target_sub_reports: list[RedTeamReport] = []

                if dynamic_results:
                    dyn_report = dynamic_evaluatorq_results_to_report(
                        agent_context=pt.agent_context,
                        categories_tested=resolved_categories,
                        results=dynamic_results,
                        duration_seconds=pipeline_duration,
                        description=f'{description or "Hybrid"} ({pt.target}) (dynamic)',
                    )
                    target_sub_reports.append(dyn_report)

                if static_results_for_target:
                    static_reports = static_evaluatorq_results_to_reports(
                        results=static_results_for_target,
                        agent_model=pt.target_value if pt.target_kind != 'agent' else None,
                        agent_key=pt.target_value if pt.target_kind == 'agent' else None,
                        description=f'{description or "Hybrid"} ({pt.target}) (static)',
                    )
                    target_sub_reports.extend(static_reports.values())

                if target_sub_reports:
                    t_report = merge_reports(
                        *target_sub_reports,
                        description=f'{description or "Hybrid red teaming"} ({pt.target})',
                    )
                else:
                    t_report = static_results_to_report(
                        [],
                        description=f'{description or "Hybrid red teaming"} ({pt.target})',
                    )

                t_report.summary.datapoint_breakdown = _datapoint_breakdown(pt.all_datapoints)

            else:
                # Dynamic mode: convert all target results as dynamic
                if target_results:
                    t_report = dynamic_evaluatorq_results_to_report(
                        agent_context=pt.agent_context,
                        categories_tested=resolved_categories,
                        results=target_results,
                        duration_seconds=pipeline_duration,
                        description=f'{description or "Dynamic red teaming"} ({pt.target})',
                    )
                else:
                    t_report = static_results_to_report(
                        [],
                        description=f'{description or "Dynamic red teaming"} ({pt.target})',
                    )

            per_target_reports.append(t_report)

        if not per_target_reports:
            merged = static_results_to_report(
                [],
                description=description or f'{mode.capitalize()} red teaming ({len(targets)} targets)',
            )
        else:
            merged = merge_reports(
                *per_target_reports,
                description=description or f'{mode.capitalize()} red teaming ({len(targets)} targets)',
            )

        merged.duration_seconds = pipeline_duration

        if mode == Pipeline.HYBRID:
            merged.summary.datapoint_breakdown = _datapoint_breakdown(all_datapoints)

        resolved_hooks.on_stage_end("report_generation", {
            "resistance_rate": merged.summary.resistance_rate,
            "elapsed_s": pipeline_duration,
        })

        _save_report(output_dir, "03_summary_report.json", merged)

        # Upload cleaned results to Orq platform — strip skipped job results
        # (jobs return None for datapoints belonging to a different target).
        await _send_cleaned_results(
            results=results,
            name='red-team',
            description=description or f'{mode.capitalize()} red teaming ({len(targets)} targets)',
            start_time=pipeline_start,
        )

        set_span_attrs(pipeline_span, {
            "orq.redteam.num_datapoints": len(all_datapoints),
            "orq.redteam.num_categories": len(resolved_categories),
            "orq.redteam.duration_seconds": pipeline_duration,
        })

        # Memory cleanup for all targets — use runtime-accumulated entity IDs
        for pt in prepared_targets:
            if cleanup_memory and pt.agent_context.has_memory:
                entity_ids = pt.memory_entity_ids
                if entity_ids:
                    resolved_hooks.on_stage_start("cleanup", {"num_entities": len(entity_ids), "target": pt.target})
                    from evaluatorq.redteam.tracing import with_redteam_span as _wrs
                    async with _wrs(
                        "orq.redteam.memory_cleanup",
                        {"orq.redteam.num_entities": len(entity_ids)},
                    ) as cleanup_span:
                        await cleanup_memory_entities(pt.agent_context, entity_ids, memory_cleanup=pt.resolved_memory_cleanup)
                        set_span_attrs(cleanup_span, {
                            "orq.redteam.num_stores": len(pt.agent_context.memory_stores) if pt.agent_context.memory_stores else 0,
                        })
                    resolved_hooks.on_stage_end("cleanup", {"num_entities_cleaned": len(entity_ids)})

        return merged


# ---------------------------------------------------------------------------
# Static runner
# ---------------------------------------------------------------------------

async def _run_static(
    *,
    targets: list[str],
    categories: list[str] | None,
    evaluator_model: str,
    parallelism: int,
    max_static_datapoints: int | None,
    backend: str,
    dataset_path: Any,
    description: str | None,
    llm_client: AsyncOpenAI | None = None,
    hooks: PipelineHooks | None = None,
    output_dir: Path | None = None,
    target_config: TargetConfig | None = None,
) -> RedTeamReport:
    """Run static red teaming for multiple targets in a single ``evaluatorq()`` call.

    Each target becomes its own ``job`` within the single evaluatorq run.
    The shared dataset is used as-is; each job processes every datapoint.
    Results are split by ``job_name`` into per-target reports, which are
    then merged into one unified ``RedTeamReport``.
    """
    from evaluatorq import evaluatorq

    from evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge import (
        create_owasp_evaluator,
        load_owasp_agentic_dataset,
    )
    from evaluatorq.redteam.frameworks.owasp.evaluators import get_evaluator_for_category
    from evaluatorq.redteam.reports.converters import (
        merge_reports,
        static_evaluatorq_results_to_reports,
        static_results_to_report,
    )
    from evaluatorq.redteam.contracts import normalize_category

    resolved_hooks: PipelineHooks = hooks or DefaultHooks()
    pipeline_start = datetime.now(tz=timezone.utc).astimezone()

    # Load the shared dataset once for all targets
    path = Path(dataset_path) if dataset_path is not None else None
    data = load_owasp_agentic_dataset(
        num_samples=max_static_datapoints,
        categories=categories,
        path=path,
    )

    # Filter out datapoints whose category has no registered evaluator
    if isinstance(data, list):
        from collections import Counter

        skipped: Counter[str] = Counter()
        filtered_data: list[Any] = []
        for dp in data:
            cat = dp.inputs.get('category', '')
            norm_cat = normalize_category(cat)
            if get_evaluator_for_category(norm_cat) is None:
                skipped[norm_cat] += 1
            else:
                filtered_data.append(dp)
        for cat, count in sorted(skipped.items()):
            logger.warning(f'Skipped {count} datapoints for {cat}: no evaluator registered')
        if not filtered_data and data:
            msg = 'All datapoints were filtered out — no evaluator registered for any category.'
            raise ValueError(msg)
        data = filtered_data  # type: ignore[assignment]

    _save_stage(output_dir, "01_datapoints.json", json.dumps([dp.inputs for dp in data], indent=2, default=str))  # pyright: ignore[reportAttributeAccessIssue]

    # Build one job per target using the shared helper
    _sys_prompt = target_config.system_prompt if target_config else None
    jobs: list[Any] = [
        _create_job_for_target(t, llm_client, _sys_prompt)
        for t in targets
    ]

    evaluator = create_owasp_evaluator(evaluator_model=evaluator_model, llm_client=llm_client)

    # Confirm hook — report aggregate counts
    vulnerabilities: list[str] = list({
        dp.inputs.get("category", "") for dp in data  # pyright: ignore[reportAttributeAccessIssue]
        if dp.inputs.get("category")
    })
    confirm_payload: ConfirmPayload = {
        "agent_context": None,
        "num_datapoints": len(data) if isinstance(data, list) else 0,  # type: ignore[arg-type]
        "num_dynamic": None,
        "num_static": len(data) if isinstance(data, list) else 0,  # type: ignore[arg-type]
        "categories": categories or vulnerabilities,
        "attack_model": "",
        "evaluator_model": evaluator_model,
        "max_turns": 1,
        "parallelism": parallelism,
        "filtering_metadata": None,
        "mode": "static",
        "target": ", ".join(targets),
        "dataset_path": str(path) if path else None,
        "vulnerabilities": vulnerabilities,
    }
    if not resolved_hooks.on_confirm(confirm_payload):
        msg = 'Execution cancelled by confirmation callback'
        raise CancelledError(msg)

    resolved_hooks.on_stage_start("attack_execution", {
        "num_datapoints": len(data) if isinstance(data, list) else 0,  # type: ignore[arg-type]
        "targets": targets,
    })

    results = await evaluatorq(
        'red-team',
        data=data,
        jobs=jobs,
        evaluators=[evaluator],
        parallelism=parallelism,
        print_results=False,
        _exit_on_failure=False,
        _send_results=False,
        description=description or f'Static red teaming ({len(targets)} targets)',
    )

    resolved_hooks.on_stage_end("attack_execution", {"num_results": len(results)})

    _save_stage(output_dir, "02_attack_results.json", json.dumps([r.model_dump(mode='json') for r in results], indent=2, default=str))

    pipeline_duration = (datetime.now(tz=timezone.utc).astimezone() - pipeline_start).total_seconds()

    resolved_hooks.on_stage_start("report_generation", {"num_results": len(results)})

    # Build a job_name → (target_kind, target_value) lookup from the actual
    # job objects so that we can populate agent_key / agent_model correctly.
    job_name_to_target: dict[str, tuple[str, str]] = {}
    for t in targets:
        t_kind, t_value = _parse_target(t)
        safe = _make_safe_target(t_value)
        # create_model_job names follow "redteam:static:<safe_target>" convention;
        # use the safe slug for the lookup key to handle collisions gracefully.
        job_name_to_target[safe] = (t_kind, t_value)

    # static_evaluatorq_results_to_reports groups by job_name already.
    # We call it once with all results; it returns a dict keyed by job_name.
    per_job_reports: dict[str, RedTeamReport] = static_evaluatorq_results_to_reports(
        results=results,
        description=description or 'Static red teaming',
    )

    # Patch each per-job report with the correct agent identity, since
    # static_evaluatorq_results_to_reports does not know about target mapping.
    for job_name, job_report in per_job_reports.items():
        # Match by looking for the target slug inside the job_name string.
        for slug, (t_kind, t_value) in job_name_to_target.items():
            if slug in job_name:
                for result in job_report.results:
                    result.agent.key = t_value if t_kind == 'agent' else result.agent.key
                    result.agent.model = t_value if t_kind != 'agent' else result.agent.model
                job_report.tested_agents = [t_value]
                break

    all_job_reports = list(per_job_reports.values())
    if not all_job_reports:
        merged = static_results_to_report(
            [],
            description=description or f'Static red teaming ({len(targets)} targets)',
        )
    else:
        merged = merge_reports(
            *all_job_reports,
            description=description or f'Static red teaming ({len(targets)} targets)',
        )

    merged.duration_seconds = pipeline_duration
    resolved_hooks.on_stage_end("report_generation", {
        "resistance_rate": merged.summary.resistance_rate,
        "elapsed_s": pipeline_duration,
    })

    _save_report(output_dir, "03_summary_report.json", merged)

    # Upload results to Orq platform — in static mode all jobs produce real
    # output for every datapoint, so we send results as-is (no stripping).
    await _send_cleaned_results(
        results=results,
        name='red-team',
        description=description or f'Static red teaming ({len(targets)} targets)',
        start_time=pipeline_start,
    )

    return merged
