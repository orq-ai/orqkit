"""Agent simulation integration for evaluatorq.

Provides tools to run multi-turn agent simulations with user simulator
and judge agents, convert results to OpenResponses format, and integrate
with the evaluatorq evaluation pipeline.

Example::

    from evaluatorq.simulation import simulate, generate_and_simulate
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)


def _check_simulation_deps() -> None:
    missing = []
    for mod in ("openai",):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        raise ImportError(
            f"Simulation requires optional dependencies: {', '.join(missing)}. "
            f"Install with: pip install 'evaluatorq[simulation]'"
        )


_check_simulation_deps()

# ---------------------------------------------------------------------------
# Public imports (after dep check)
# ---------------------------------------------------------------------------

from evaluatorq.simulation.adapters import from_chat_completions, from_orq_deployment  # noqa: E402
from evaluatorq.simulation.agents.base import AgentConfig, BaseAgent  # noqa: E402
from evaluatorq.simulation.agents.judge import JudgeAgent  # noqa: E402
from evaluatorq.simulation.agents.user_simulator import UserSimulatorAgent  # noqa: E402
from evaluatorq.simulation.convert import to_open_responses  # noqa: E402
from evaluatorq.simulation.evaluators import (  # noqa: E402
    SIMULATION_EVALUATORS,
    SimulationScorer,
    get_all_evaluators,
    get_evaluator,
)
from evaluatorq.simulation.generators import (  # noqa: E402
    DatapointGenerator,
    FirstMessageGenerator,
    PersonaGenerator,
    ScenarioGenerator,
)
from evaluatorq.simulation.quality.message_perturbation import (  # noqa: E402
    PerturbationType,
    apply_perturbation,
    apply_perturbations_batch,
    apply_random_perturbation,
)
from evaluatorq.simulation.runner.simulation import SimulationRunner, TargetAgent  # noqa: E402
from evaluatorq.simulation.types import (  # noqa: E402
    ChatMessage,
    CommunicationStyle,
    ConversationStrategy,
    Criterion,
    CulturalContext,
    Datapoint,
    EmotionalArc,
    InputFormat,
    Judgment,
    Message,
    Persona,
    Scenario,
    SimulationResult,
    StartingEmotion,
    TerminatedBy,
    TokenUsage,
    TurnMetrics,
)
from evaluatorq.simulation.utils.dataset_export import (  # noqa: E402
    export_datapoints_to_jsonl,
    export_results_to_jsonl,
    load_datapoints_from_jsonl,
    parse_jsonl,
    results_to_jsonl,
)
from evaluatorq.simulation.utils.prompt_builders import (  # noqa: E402
    build_datapoint_system_prompt,
    build_persona_system_prompt,
    build_scenario_user_context,
    generate_datapoint,
)
from evaluatorq.simulation.wrap_agent import wrap_simulation_agent  # noqa: E402


# ---------------------------------------------------------------------------
# High-level API: simulate()
# ---------------------------------------------------------------------------


async def simulate(
    *,
    evaluation_name: str = "",
    agent_key: str | None = None,
    target_callback: Callable[[list[ChatMessage]], str | Awaitable[str]] | None = None,
    personas: list[Persona] | None = None,
    scenarios: list[Scenario] | None = None,
    datapoints: list[Datapoint] | None = None,
    max_turns: int = 10,
    model: str = "azure/gpt-4o-mini",
    evaluator_names: list[str] | None = None,
    parallelism: int = 5,
) -> list[SimulationResult]:
    """High-level function to run agent simulations.

    Handles:
    - Creating persona x scenario combinations
    - Generating first messages for each combination
    - Running simulations in parallel
    - Applying evaluators to results
    """
    from openai import AsyncOpenAI

    # Validate evaluator names early
    resolved_evaluator_names = evaluator_names or ["goal_achieved", "criteria_met"]
    scorers = [(name, get_evaluator(name)) for name in resolved_evaluator_names]

    # Build datapoints from personas x scenarios if not provided
    if datapoints is None:
        if not personas or not scenarios:
            raise ValueError(
                "Either provide 'datapoints' or both 'personas' and 'scenarios'"
            )

        api_key = os.environ.get("ORQ_API_KEY")
        if not api_key:
            raise ValueError(
                "ORQ_API_KEY environment variable is not set. Set it before calling simulate()."
            )

        shared_client = AsyncOpenAI(
            api_key=api_key,
            base_url=os.environ.get("ROUTER_BASE_URL", "https://api.orq.ai/v2/router"),
        )

        first_msg_gen = FirstMessageGenerator(model=model, client=shared_client)

        try:
            pairs = [
                (persona, scenario) for persona in personas for scenario in scenarios
            ]

            generated_datapoints: list[Datapoint] = []
            batch_size = 5
            for i in range(0, len(pairs), batch_size):
                batch = pairs[i : i + batch_size]
                batch_results = await asyncio.gather(
                    *[
                        _generate_single_datapoint(first_msg_gen, persona, scenario)
                        for persona, scenario in batch
                    ]
                )
                generated_datapoints.extend(batch_results)
            datapoints = generated_datapoints
        finally:
            await shared_client.close()

    if not datapoints:
        raise ValueError(
            "No datapoints to simulate — persona or scenario generation may have failed"
        )

    # Bridge agentKey to invoke() if no callback is provided
    resolved_callback = target_callback
    if not resolved_callback and agent_key:
        resolved_callback = from_orq_deployment(agent_key)

    if not resolved_callback:
        raise ValueError("Either target_callback or agent_key is required")

    # Create simulation runner
    runner = SimulationRunner(
        target_callback=resolved_callback,
        model=model,
        max_turns=max_turns,
    )

    try:
        # Run simulations
        results = await runner.run_batch(
            datapoints,
            max_turns=max_turns,
            max_concurrency=parallelism,
        )

        # Apply evaluators to results
        for result in results:
            scores: dict[str, float] = {}
            for scorer_name, fn in scorers:
                scores[scorer_name] = fn(result)
            result.metadata["evaluator_scores"] = scores
            if evaluation_name:
                result.metadata["evaluation_name"] = evaluation_name

        return results
    finally:
        await runner.close()


async def _generate_single_datapoint(
    gen: FirstMessageGenerator, persona: Persona, scenario: Scenario
) -> Datapoint:
    first_message = await gen.generate(persona, scenario)
    return generate_datapoint(persona, scenario, first_message)


# ---------------------------------------------------------------------------
# High-level API: generate_and_simulate()
# ---------------------------------------------------------------------------


async def generate_and_simulate(
    *,
    evaluation_name: str = "",
    agent_description: str,
    agent_key: str | None = None,
    target_callback: Callable[[list[ChatMessage]], str | Awaitable[str]] | None = None,
    num_personas: int = 5,
    num_scenarios: int = 5,
    max_turns: int = 10,
    model: str = "azure/gpt-4o-mini",
    evaluator_names: list[str] | None = None,
    parallelism: int = 5,
) -> list[SimulationResult]:
    """Generate personas/scenarios and run simulations.

    Convenience function that combines generation and simulation.
    """
    # Bridge agentKey to invoke() if no callback is provided
    resolved_callback = target_callback
    if not resolved_callback and agent_key:
        resolved_callback = from_orq_deployment(agent_key)

    if not resolved_callback:
        raise ValueError(
            "Either target_callback or agent_key is required for generate_and_simulate"
        )

    # Generate personas and scenarios in parallel
    persona_gen = PersonaGenerator(model=model)
    scenario_gen = ScenarioGenerator(model=model)

    personas, scenarios = await asyncio.gather(
        persona_gen.generate(
            agent_description=agent_description, num_personas=num_personas
        ),
        scenario_gen.generate(
            agent_description=agent_description, num_scenarios=num_scenarios
        ),
    )

    # Run simulations
    return await simulate(
        evaluation_name=evaluation_name,
        target_callback=resolved_callback,
        personas=personas,
        scenarios=scenarios,
        max_turns=max_turns,
        model=model,
        evaluator_names=evaluator_names,
        parallelism=parallelism,
    )


__all__ = [
    # High-level API
    "simulate",
    "generate_and_simulate",
    # Adapters
    "from_chat_completions",
    "from_orq_deployment",
    # Agents
    "AgentConfig",
    "BaseAgent",
    "JudgeAgent",
    "UserSimulatorAgent",
    # Conversion
    "to_open_responses",
    # Evaluators
    "SIMULATION_EVALUATORS",
    "SimulationScorer",
    "get_all_evaluators",
    "get_evaluator",
    # Generators
    "DatapointGenerator",
    "FirstMessageGenerator",
    "PersonaGenerator",
    "ScenarioGenerator",
    # Quality
    "PerturbationType",
    "apply_perturbation",
    "apply_perturbations_batch",
    "apply_random_perturbation",
    # Runner
    "SimulationRunner",
    "TargetAgent",
    # Types
    "ChatMessage",
    "CommunicationStyle",
    "ConversationStrategy",
    "Criterion",
    "CulturalContext",
    "Datapoint",
    "EmotionalArc",
    "InputFormat",
    "Judgment",
    "Message",
    "Persona",
    "Scenario",
    "SimulationResult",
    "StartingEmotion",
    "TerminatedBy",
    "TokenUsage",
    "TurnMetrics",
    # Utils
    "build_datapoint_system_prompt",
    "build_persona_system_prompt",
    "build_scenario_user_context",
    "export_datapoints_to_jsonl",
    "export_results_to_jsonl",
    "generate_datapoint",
    "load_datapoints_from_jsonl",
    "parse_jsonl",
    "results_to_jsonl",
    # Job wrapper
    "wrap_simulation_agent",
]
