"""
Built-in evaluators for evaluatorq.

This module provides commonly used evaluators that can be used with the evaluatorq framework.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .types import Evaluator, ScorerParameter


@dataclass
class StringContainsConfig:
    """Configuration options for the string contains evaluator."""

    case_insensitive: bool = True
    """Whether the comparison should be case-insensitive. Defaults to True."""

    name: str = "string-contains"
    """Optional name for the evaluator. Defaults to 'string-contains'."""


def string_contains_evaluator(
    config: StringContainsConfig | None = None,
    *,
    case_insensitive: bool = True,
    name: str = "string-contains",
) -> Evaluator:
    """
    Creates an evaluator that checks if the output contains the expected output.
    Uses the data.expected_output from the dataset to compare against.

    Args:
        config: Optional StringContainsConfig object with all settings
        case_insensitive: Whether the comparison should be case-insensitive
        name: Optional name for the evaluator

    Returns:
        An Evaluator that checks if output contains expected output

    Example:
        # Basic usage
        evaluator = string_contains_evaluator()

        # With case-sensitive matching
        strict_evaluator = string_contains_evaluator(case_insensitive=False)

        # With custom name
        my_evaluator = string_contains_evaluator(name="my-contains-check")
    """
    # Use config if provided, otherwise use kwargs
    final_case_insensitive = case_insensitive
    final_name = name

    if config is not None:
        final_case_insensitive = config.case_insensitive
        final_name = config.name

    async def scorer(params: ScorerParameter) -> dict[str, Any]:
        data = params["data"]
        output = params["output"]

        expected = str(data.expected_output) if data.expected_output is not None else ""
        actual = str(output) if output is not None else ""

        if not expected:
            return {
                "value": 0,
                "pass_": False,
                "explanation": "No expected output defined",
            }

        expected_normalized = expected.lower() if final_case_insensitive else expected
        actual_normalized = actual.lower() if final_case_insensitive else actual

        contains = expected_normalized in actual_normalized

        if contains:
            return {
                "value": 1.0,
                "pass_": True,
                "explanation": f'Output contains "{expected}"',
            }
        else:
            truncated_actual = actual[:100] + "..." if len(actual) > 100 else actual
            return {
                "value": 0.0,
                "pass_": False,
                "explanation": f'Expected "{expected}" not found in: "{truncated_actual}"',
            }

    return {
        "name": final_name,
        "scorer": scorer,
    }


def exact_match_evaluator(
    *,
    case_insensitive: bool = False,
    name: str = "exact-match",
) -> Evaluator:
    """
    Creates an evaluator that checks if the output exactly matches the expected output.
    Uses the data.expected_output from the dataset to compare against.

    Args:
        case_insensitive: Whether the comparison should be case-insensitive
        name: Optional name for the evaluator

    Returns:
        An Evaluator that checks if output exactly matches expected output

    Example:
        # Basic usage (case-sensitive)
        evaluator = exact_match_evaluator()

        # With case-insensitive matching
        loose_evaluator = exact_match_evaluator(case_insensitive=True)
    """

    async def scorer(params: ScorerParameter) -> dict[str, Any]:
        data = params["data"]
        output = params["output"]

        expected = str(data.expected_output) if data.expected_output is not None else ""
        actual = str(output) if output is not None else ""

        if not expected:
            return {
                "value": 0,
                "pass_": False,
                "explanation": "No expected output defined",
            }

        expected_normalized = expected.lower() if case_insensitive else expected
        actual_normalized = actual.lower() if case_insensitive else actual

        matches = expected_normalized == actual_normalized

        if matches:
            return {
                "value": 1.0,
                "pass_": True,
                "explanation": "Output exactly matches expected output",
            }
        else:
            return {
                "value": 0.0,
                "pass_": False,
                "explanation": f'Expected "{expected}" but got "{actual[:50]}{"..." if len(actual) > 50 else ""}"',
            }

    return {
        "name": name,
        "scorer": scorer,
    }
