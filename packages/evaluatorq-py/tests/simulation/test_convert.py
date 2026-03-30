"""Tests for SimulationResult → OpenResponses conversion."""

from evaluatorq.simulation.convert import to_open_responses
from evaluatorq.simulation.types import (
    Message,
    SimulationResult,
    TerminatedBy,
    TokenUsage,
)


def _make_result(**overrides):
    defaults = dict(
        messages=[
            Message(role="user", content="Hello"),
            Message(role="assistant", content="Hi there!"),
            Message(role="user", content="Help me"),
            Message(role="assistant", content="Sure!"),
        ],
        terminated_by=TerminatedBy.judge,
        reason="Goal achieved",
        goal_achieved=True,
        goal_completion_score=1.0,
        rules_broken=[],
        turn_count=2,
        token_usage=TokenUsage(
            prompt_tokens=100, completion_tokens=50, total_tokens=150
        ),
        turn_metrics=[],
    )
    defaults.update(overrides)
    return SimulationResult(**defaults)


class TestToOpenResponses:
    def test_basic_conversion(self):
        result = _make_result()
        response = to_open_responses(result)

        assert response["object"] == "response"
        assert response["status"] == "completed"
        assert len(response["input"]) == 2  # 2 user messages
        assert len(response["output"]) == 2  # 2 assistant messages

    def test_input_messages(self):
        result = _make_result()
        response = to_open_responses(result)

        input_msgs = response["input"]
        assert input_msgs[0]["role"] == "user"
        assert input_msgs[0]["content"][0]["type"] == "input_text"
        assert input_msgs[0]["content"][0]["text"] == "Hello"

    def test_output_messages(self):
        result = _make_result()
        response = to_open_responses(result)

        output_msgs = response["output"]
        assert output_msgs[0]["role"] == "assistant"
        assert output_msgs[0]["content"][0]["type"] == "output_text"
        assert output_msgs[0]["content"][0]["text"] == "Hi there!"

    def test_status_mapping_judge(self):
        result = _make_result(terminated_by=TerminatedBy.judge)
        response = to_open_responses(result)
        assert response["status"] == "completed"

    def test_status_mapping_error(self):
        result = _make_result(
            terminated_by=TerminatedBy.error, reason="Something failed"
        )
        response = to_open_responses(result)
        assert response["status"] == "failed"
        assert response["error"]["message"] == "Something failed"

    def test_status_mapping_max_turns(self):
        result = _make_result(terminated_by=TerminatedBy.max_turns)
        response = to_open_responses(result)
        assert response["status"] == "incomplete"
        assert response["incomplete_details"] is not None

    def test_usage(self):
        result = _make_result()
        response = to_open_responses(result)

        assert response["usage"]["input_tokens"] == 100
        assert response["usage"]["output_tokens"] == 50
        assert response["usage"]["total_tokens"] == 150

    def test_metadata(self):
        result = _make_result(criteria_results={"a": True})
        response = to_open_responses(result)

        meta = response["metadata"]
        assert meta["framework"] == "simulation"
        assert meta["goal_achieved"] is True
        assert meta["goal_completion_score"] == 1.0
        assert meta["criteria_results"] == {"a": True}

    def test_model_parameter(self):
        result = _make_result()
        response = to_open_responses(result, model="gpt-4o")
        assert response["model"] == "gpt-4o"

    def test_empty_messages(self):
        result = _make_result(messages=[])
        response = to_open_responses(result)
        assert response["input"] == []
        assert response["output"] == []

    def test_no_usage_when_zero(self):
        result = _make_result(token_usage=TokenUsage())
        response = to_open_responses(result)
        assert response["usage"] is None
