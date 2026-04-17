"""Unit tests for OpenAI Agents SDK red teaming target."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

pytest.importorskip("agents")

from evaluatorq.integrations.openai_agents_integration import OpenAIAgentTarget  # noqa: E402


def _mock_runner_and_result(output: str = "response") -> tuple[MagicMock, MagicMock]:
    result = MagicMock()
    result.final_output = output
    result.to_input_list.return_value = [
        {"role": "user", "content": "prompt"},
        {"role": "assistant", "content": output},
    ]
    runner = MagicMock()
    runner.run = AsyncMock(return_value=result)
    return runner, result


class TestOpenAIAgentTarget:
    @pytest.mark.asyncio
    async def test_send_prompt_returns_response(self, monkeypatch: pytest.MonkeyPatch) -> None:
        runner, _ = _mock_runner_and_result("hello back")
        monkeypatch.setattr("evaluatorq.integrations.openai_agents_integration.target.Runner", runner)

        target = OpenAIAgentTarget(MagicMock())
        response = await target.send_prompt("hello")
        assert response == "hello back"

    @pytest.mark.asyncio
    async def test_first_prompt_sends_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        runner, _ = _mock_runner_and_result()
        monkeypatch.setattr("evaluatorq.integrations.openai_agents_integration.target.Runner", runner)

        target = OpenAIAgentTarget(MagicMock())
        await target.send_prompt("first")

        call_args = runner.run.call_args
        assert call_args[0][1] == "first"

    @pytest.mark.asyncio
    async def test_second_prompt_sends_history(self, monkeypatch: pytest.MonkeyPatch) -> None:
        runner, _ = _mock_runner_and_result()
        monkeypatch.setattr("evaluatorq.integrations.openai_agents_integration.target.Runner", runner)

        target = OpenAIAgentTarget(MagicMock())
        await target.send_prompt("first")
        await target.send_prompt("second")

        input_data = runner.run.call_args[0][1]
        assert isinstance(input_data, list)
        assert input_data[-1] == {"role": "user", "content": "second"}

    @pytest.mark.asyncio
    async def test_reset_clears_history(self, monkeypatch: pytest.MonkeyPatch) -> None:
        runner, _ = _mock_runner_and_result()
        monkeypatch.setattr("evaluatorq.integrations.openai_agents_integration.target.Runner", runner)

        target = OpenAIAgentTarget(MagicMock())
        await target.send_prompt("first")
        target.reset_conversation()
        await target.send_prompt("after reset")

        call_args = runner.run.call_args
        assert call_args[0][1] == "after reset"

    def test_clone_returns_independent_instance(self) -> None:
        agent = MagicMock()
        target = OpenAIAgentTarget(agent, run_kwargs={"max_turns": 5})
        target._history = [{"role": "user", "content": "old"}]
        cloned = target.clone()
        assert cloned is not target
        assert cloned._history == []
        assert cloned._agent is agent
        assert cloned._run_kwargs is not target._run_kwargs
        assert cloned._run_kwargs == {"max_turns": 5}
