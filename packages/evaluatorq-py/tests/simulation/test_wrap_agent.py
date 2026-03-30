"""Tests for wrap_simulation_agent."""

import pytest

from evaluatorq.simulation.wrap_agent import _validate_shape


class TestValidateShape:
    def test_valid_shape(self):
        _validate_shape({"name": "test", "goal": "help"}, "scenario", ["name", "goal"])

    def test_missing_key(self):
        with pytest.raises(ValueError, match="missing required field 'goal'"):
            _validate_shape({"name": "test"}, "scenario", ["name", "goal"])

    def test_not_an_object(self):
        with pytest.raises(ValueError, match="Expected 'scenario' to be an object"):
            _validate_shape("not a dict", "scenario", ["name"])

    def test_none_value(self):
        with pytest.raises(ValueError, match="Expected 'scenario' to be an object"):
            _validate_shape(None, "scenario", ["name"])
