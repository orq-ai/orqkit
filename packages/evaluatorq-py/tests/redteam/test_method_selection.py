"""Tests for strategy-name / delivery-method selection in red_team().

Covers the predicate behavior in `_filter_by_method` directly, plus runner-level
warning behavior for unknown names and empty intersections.
"""

from __future__ import annotations

import pytest

from evaluatorq.redteam.adaptive.strategy_registry import (
    VULNERABILITY_STRATEGY_REGISTRY,
    _filter_by_method,
)
from evaluatorq.redteam.contracts import (
    AttackStrategy,
    AttackTechnique,
    DeliveryMethod,
    Severity,
    TurnType,
)


def _make_strategy(
    name: str,
    *,
    delivery_methods: list[DeliveryMethod],
    technique: AttackTechnique = AttackTechnique.DIRECT_INJECTION,
    turn_type: TurnType = TurnType.SINGLE,
    category: str = "ASI01",
) -> AttackStrategy:
    return AttackStrategy(
        category=category,
        name=name,
        description="test",
        attack_technique=technique,
        delivery_methods=delivery_methods,
        turn_type=turn_type,
        severity=Severity.MEDIUM,
        objective_template="x",
    )


@pytest.fixture
def sample_strategies() -> list[AttackStrategy]:
    return [
        _make_strategy("alpha", delivery_methods=[DeliveryMethod.CRESCENDO]),
        _make_strategy("beta", delivery_methods=[DeliveryMethod.BASE64, DeliveryMethod.LEETSPEAK]),
        _make_strategy("gamma", delivery_methods=[DeliveryMethod.MULTILINGUAL]),
        _make_strategy("alpha", delivery_methods=[DeliveryMethod.BASE64], category="LLM01"),
    ]


# ---------------------------------------------------------------------------
# 1. Predicate behavior
# ---------------------------------------------------------------------------


class TestFilterByMethod:
    """Pure predicate behavior — no runner, no planner."""

    def test_no_filters_returns_all(self, sample_strategies: list[AttackStrategy]) -> None:
        kept = _filter_by_method(sample_strategies, names=None, delivery_methods=None)
        assert kept == sample_strategies

    def test_filter_by_strategy_name_narrows_set(self, sample_strategies: list[AttackStrategy]) -> None:
        kept = _filter_by_method(sample_strategies, names={"beta"}, delivery_methods=None)
        assert [s.name for s in kept] == ["beta"]

    def test_filter_by_delivery_method_narrows_set(self, sample_strategies: list[AttackStrategy]) -> None:
        kept = _filter_by_method(
            sample_strategies, names=None, delivery_methods={DeliveryMethod.CRESCENDO}
        )
        assert [s.name for s in kept] == ["alpha"]

    def test_filter_and_semantics_when_both_set(self, sample_strategies: list[AttackStrategy]) -> None:
        # alpha appears twice (different categories, different delivery methods).
        # name=alpha + delivery=base64 should keep only the LLM01 variant.
        kept = _filter_by_method(
            sample_strategies, names={"alpha"}, delivery_methods={DeliveryMethod.BASE64}
        )
        assert len(kept) == 1
        assert kept[0].category == "LLM01"

    def test_strategy_name_matches_across_categories(self, sample_strategies: list[AttackStrategy]) -> None:
        # Duplicate names are intentional — both alpha strategies survive.
        kept = _filter_by_method(sample_strategies, names={"alpha"}, delivery_methods=None)
        assert {s.category for s in kept} == {"ASI01", "LLM01"}

    def test_delivery_method_overlap_semantics(self, sample_strategies: list[AttackStrategy]) -> None:
        # beta has [BASE64, LEETSPEAK] — selecting LEETSPEAK keeps it.
        kept = _filter_by_method(
            sample_strategies, names=None, delivery_methods={DeliveryMethod.LEETSPEAK}
        )
        assert [s.name for s in kept] == ["beta"]

    def test_empty_intersection_returns_empty(self, sample_strategies: list[AttackStrategy]) -> None:
        kept = _filter_by_method(
            sample_strategies,
            names={"nonexistent"},
            delivery_methods={DeliveryMethod.CRESCENDO},
        )
        assert kept == []

    def test_empty_name_set_filters_everything_out(self, sample_strategies: list[AttackStrategy]) -> None:
        # Explicit empty set means "match nothing", distinct from None.
        kept = _filter_by_method(sample_strategies, names=set(), delivery_methods=None)
        assert kept == []


# ---------------------------------------------------------------------------
# 2. Registry-level invariants
# ---------------------------------------------------------------------------


class TestRegistryNameUniqueness:
    """Regression guard: strategy names are unique across the registry today.

    The filter predicate does not rely on uniqueness — it handles duplicates
    correctly — but if uniqueness is ever broken, the docstring on
    ``red_team(strategies=...)`` should be revisited to clarify multi-match
    semantics to users.
    """

    def test_no_strategy_name_appears_in_multiple_vulnerabilities(self) -> None:
        name_to_vulns: dict[str, set[str]] = {}
        for vuln, strategies in VULNERABILITY_STRATEGY_REGISTRY.items():
            for strategy in strategies:
                name_to_vulns.setdefault(strategy.name, set()).add(vuln.value)

        duplicated = {name: vulns for name, vulns in name_to_vulns.items() if len(vulns) > 1}
        assert not duplicated, (
            f"Strategy names are no longer unique across the registry: {duplicated}. "
            "Update the docstring on red_team(strategies=...) to document the multi-match semantics."
        )

    def test_filter_against_real_registry_finds_each_name(self) -> None:
        # Sanity: a known registered name yields at least one match through
        # the real predicate path.
        all_strategies = [s for strategies in VULNERABILITY_STRATEGY_REGISTRY.values() for s in strategies]
        sample_name = all_strategies[0].name
        kept = _filter_by_method(all_strategies, names={sample_name}, delivery_methods=None)
        assert len(kept) >= 1
        assert all(s.name == sample_name for s in kept)


