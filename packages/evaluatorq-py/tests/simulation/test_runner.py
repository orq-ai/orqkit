"""Tests for SimulationRunner."""

import pytest

from evaluatorq.simulation.runner.simulation import SimulationRunner
from evaluatorq.simulation.types import (
    CommunicationStyle,
    Persona,
    Scenario,
    TerminatedBy,
)


def _make_persona():
    return Persona(
        name="Test User",
        patience=0.5,
        assertiveness=0.5,
        politeness=0.5,
        technical_level=0.5,
        communication_style=CommunicationStyle.casual,
        background="A test user",
    )


def _make_scenario():
    return Scenario(name="Test Scenario", goal="Get help")


class TestSimulationRunnerValidation:
    def test_requires_target(self):
        with pytest.raises(ValueError, match="Must provide either"):
            SimulationRunner(model="test")

    def test_max_turns_validation(self):
        with pytest.raises(ValueError, match="max_turns must be >= 1"):
            SimulationRunner(
                target_callback=lambda msgs: "ok",
                max_turns=0,
            )

    def test_model_validation(self):
        with pytest.raises(ValueError, match="model must be a non-empty"):
            SimulationRunner(
                target_callback=lambda msgs: "ok",
                model="   ",
            )


class TestSimulationRunnerRun:
    @pytest.mark.asyncio
    async def test_run_requires_persona_or_datapoint(self):
        runner = SimulationRunner(target_callback=lambda msgs: "ok")
        result = await runner.run(persona=_make_persona())
        assert result.terminated_by == TerminatedBy.error
        assert "Must provide either datapoint" in result.reason

    @pytest.mark.asyncio
    async def test_run_error_handling(self):
        """Runner should never throw, always return error result."""

        async def failing_callback(msgs):
            raise RuntimeError("API down")

        runner = SimulationRunner(target_callback=failing_callback, model="test-model")
        result = await runner.run(
            persona=_make_persona(),
            scenario=_make_scenario(),
            first_message="Hello",
        )
        # Should get an error result (either from missing API key or actual error)
        assert result.terminated_by == TerminatedBy.error
