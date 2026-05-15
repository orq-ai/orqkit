"""Wraps the simulation framework as an evaluatorq Job.

Follows the same pattern as wrap_langchain_agent().
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from evaluatorq.simulation.adapters import from_orq_deployment
from evaluatorq.simulation.convert import to_open_responses
from evaluatorq.simulation.types import (
    DEFAULT_MODEL,
    ChatMessage,
    Datapoint,
    Persona,
    Scenario,
    SimulationResult,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from evaluatorq.simulation.agents.base import BaseAgent
    from evaluatorq.simulation.runner.simulation import SimulationRunner
    from evaluatorq.types import DataPoint

logger = logging.getLogger(__name__)


def _validate_shape(value: Any, label: str, required_keys: list[str]) -> None:
    """Lightweight runtime check that an object has the expected keys."""
    if not isinstance(value, dict):
        raise ValueError(  # noqa: TRY004
            f"Expected '{label}' to be an object, got {type(value).__name__}"
        )
    for key in required_keys:
        if key not in value:
            raise ValueError(f"Invalid '{label}': missing required field '{key}'")


def _extract_single_datapoint(data: DataPoint) -> Datapoint:
    """Extract exactly one simulation Datapoint from an evaluatorq DataPoint.

    Accepts the four legacy input shapes (``datapoint``, ``datapoints`` of length
    one, ``persona`` + ``scenario``, ``personas`` + ``scenarios`` each of length
    one) and normalizes to a single ``Datapoint``.
    """
    inputs = data.inputs
    if "datapoint" in inputs:
        dp = inputs["datapoint"]
        _validate_shape(dp, "datapoint", ["persona", "scenario", "first_message"])
        return Datapoint.model_validate(dp)
    if "datapoints" in inputs:
        dps = inputs["datapoints"]
        if not isinstance(dps, list):
            raise ValueError("Expected 'datapoints' to be an array")
        if len(dps) != 1:
            raise ValueError(
                "wrap_simulation_agent DataPoint must encode exactly one datapoint. "
                "For batch simulations use simulate() directly."
            )
        _validate_shape(
            dps[0], "datapoints[]", ["persona", "scenario", "first_message"]
        )
        return Datapoint.model_validate(dps[0])
    if "persona" in inputs and "scenario" in inputs:
        _validate_shape(inputs["persona"], "persona", ["name"])
        _validate_shape(inputs["scenario"], "scenario", ["name", "goal"])
        persona = Persona.model_validate(inputs["persona"])
        scenario = Scenario.model_validate(inputs["scenario"])
        # No first_message available — runner will produce a generic open
        return Datapoint(
            id=f"{persona.name}-{scenario.name}",
            persona=persona,
            scenario=scenario,
            user_system_prompt="",
            first_message=inputs.get("first_message", ""),
        )
    if "personas" in inputs and "scenarios" in inputs:
        if not isinstance(inputs["personas"], list) or not isinstance(
            inputs["scenarios"], list
        ):
            raise ValueError("Expected 'personas' and 'scenarios' to be arrays")
        if len(inputs["personas"]) != 1 or len(inputs["scenarios"]) != 1:
            raise ValueError(
                "wrap_simulation_agent DataPoint must encode exactly one "
                "persona-scenario pair. For batch simulations use simulate() directly."
            )
        _validate_shape(inputs["personas"][0], "personas[]", ["name"])
        _validate_shape(inputs["scenarios"][0], "scenarios[]", ["name", "goal"])
        persona = Persona.model_validate(inputs["personas"][0])
        scenario = Scenario.model_validate(inputs["scenarios"][0])
        return Datapoint(
            id=f"{persona.name}-{scenario.name}",
            persona=persona,
            scenario=scenario,
            user_system_prompt="",
            first_message="",
        )
    raise ValueError(
        "Expected data.inputs to contain 'persona' + 'scenario', 'datapoint', "
        "'datapoints', or 'personas' + 'scenarios'"
    )


async def _run_one_simulation(
    runner: SimulationRunner,
    sim_dp: Datapoint,
    *,
    max_turns: int | None = None,
) -> SimulationResult:
    """Run a single simulation on a shared runner.

    Thin wrapper around ``SimulationRunner.run`` that hands the runner one
    canonical ``Datapoint``. Lives here so both the public
    ``wrap_simulation_agent`` job and ``simulate()``'s internal job_fn share
    one execution path.
    """
    return await runner.run(datapoint=sim_dp, max_turns=max_turns)


def wrap_simulation_agent(
    *,
    name: str = "simulation",
    target_callback: Callable[[list[ChatMessage]], str | Awaitable[str]] | None = None,
    agent_key: str | None = None,
    max_turns: int = 10,
    model: str | None = None,
    user_simulator: BaseAgent | None = None,
    judge: BaseAgent | None = None,
) -> Callable[[DataPoint, int], Awaitable[dict[str, Any]]]:
    """Create an evaluatorq Job that runs agent simulations.

    Each DataPoint should have inputs containing simulation data:
    - ``persona`` and ``scenario``, or
    - ``datapoint`` (full Datapoint object), or
    - ``datapoints`` / ``personas`` + ``scenarios`` each of length one
    """
    # Lazy import to avoid simulation -> evaluatorq -> simulation cycles
    from evaluatorq.simulation.runner.simulation import SimulationRunner

    resolved_callback = target_callback
    if not resolved_callback and agent_key:
        resolved_callback = from_orq_deployment(agent_key)
    if not resolved_callback:
        raise ValueError(
            "wrap_simulation_agent requires either target_callback or agent_key"
        )

    effective_model = model or DEFAULT_MODEL

    # Per-job instance: caller manages lifecycle via close on the returned
    # job's __closure_runner__ attribute (set below) if they need to release
    # the HTTP client early; otherwise it's closed when the process exits.
    runner = SimulationRunner(
        target_callback=resolved_callback,
        model=effective_model,
        max_turns=max_turns,
        user_simulator=user_simulator,
        judge=judge,
    )

    async def job_fn(data: DataPoint, _row: int) -> dict[str, Any]:
        sim_dp = _extract_single_datapoint(data)
        result = await _run_one_simulation(runner, sim_dp, max_turns=max_turns)
        return {
            "name": name,
            "output": to_open_responses(result, effective_model),
        }

    # Expose the runner so callers (e.g. simulate()) can close it after the
    # evaluatorq run completes. Public users of wrap_simulation_agent() can
    # also call this if they care about HTTP-client cleanup.
    setattr(job_fn, "__closure_runner__", runner)  # noqa: B010
    return job_fn
