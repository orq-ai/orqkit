"""Tests for JudgeAgent."""

import json
from unittest.mock import MagicMock

import pytest

from evaluatorq.simulation.agents.judge import JudgeAgent, JudgeAgentConfig
from evaluatorq.simulation.agents.base import LLMResult
from evaluatorq.simulation.types import Criterion


@pytest.fixture
def judge():
    config = JudgeAgentConfig(
        goal="Get a refund",
        criteria=[
            Criterion(description="Agent offers refund", type="must_happen"),
            Criterion(description="Agent is rude", type="must_not_happen"),
        ],
        ground_truth="Refund approved",
        api_key="test-key",
    )
    return JudgeAgent(config)


class TestJudgeAgent:
    def test_name(self, judge):
        assert judge.name == "JudgeAgent"

    def test_system_prompt_contains_goal(self, judge):
        assert "Get a refund" in judge.system_prompt

    def test_system_prompt_contains_criteria(self, judge):
        prompt = judge.system_prompt
        assert "MUST HAPPEN" in prompt
        assert "Agent offers refund" in prompt
        assert "MUST NOT HAPPEN" in prompt
        assert "Agent is rude" in prompt

    def test_system_prompt_contains_ground_truth(self, judge):
        assert "GROUND TRUTH" in judge.system_prompt
        assert "Refund approved" in judge.system_prompt

    def test_parse_continue_judgment(self, judge):
        tool_call = MagicMock()
        tool_call.function.name = "continue_conversation"
        tool_call.function.arguments = json.dumps(
            {
                "reason": "Goal not yet achieved",
                "response_quality": 0.8,
            }
        )

        result = LLMResult(content="", tool_calls=[tool_call])
        judgment = judge._parse_judgment(result)

        assert judgment.should_terminate is False
        assert judgment.reason == "Goal not yet achieved"
        assert judgment.goal_achieved is False
        assert judgment.response_quality == 0.8

    def test_parse_finish_judgment(self, judge):
        tool_call = MagicMock()
        tool_call.function.name = "finish_conversation"
        tool_call.function.arguments = json.dumps(
            {
                "reason": "Goal achieved",
                "goal_achieved": True,
                "rules_broken": [],
                "goal_completion_score": 1.0,
                "tone_appropriateness": 0.9,
            }
        )

        result = LLMResult(content="", tool_calls=[tool_call])
        judgment = judge._parse_judgment(result)

        assert judgment.should_terminate is True
        assert judgment.goal_achieved is True
        assert judgment.goal_completion_score == 1.0
        assert judgment.tone_appropriateness == 0.9

    def test_parse_judgment_no_tool_calls(self, judge):
        result = LLMResult(content="Some text", tool_calls=None)
        judgment = judge._parse_judgment(result)

        assert judgment.should_terminate is True
        assert "failed to make explicit decision" in judgment.reason

    def test_parse_judgment_invalid_json(self, judge):
        tool_call = MagicMock()
        tool_call.function.name = "finish_conversation"
        tool_call.function.arguments = "not json"

        result = LLMResult(content="", tool_calls=[tool_call])
        judgment = judge._parse_judgment(result)

        assert judgment.should_terminate is True
        assert "Failed to parse" in judgment.reason

    def test_parse_judgment_clamps_score(self, judge):
        tool_call = MagicMock()
        tool_call.function.name = "finish_conversation"
        tool_call.function.arguments = json.dumps(
            {
                "reason": "Done",
                "goal_achieved": True,
                "rules_broken": [],
                "goal_completion_score": 1.5,
                "response_quality": -0.5,
            }
        )

        result = LLMResult(content="", tool_calls=[tool_call])
        judgment = judge._parse_judgment(result)

        assert judgment.goal_completion_score == 1.0
        assert judgment.response_quality == 0.0
