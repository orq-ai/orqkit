"""Tests for the unified red_team() entry point and category helpers."""

from __future__ import annotations

import warnings

import pytest

from evaluatorq.redteam import get_category_info, list_categories, red_team
from evaluatorq.redteam._runner import (  # pyright: ignore[reportPrivateUsage]
    _get_agent_context,
    _get_error_mapper,
    _get_memory_cleanup,
    _get_target_factory,
    _get_target_label,
    _parse_target,
)
from evaluatorq.redteam.backends.base import (
    DefaultErrorMapper,
    DirectTargetFactory,
    NoopMemoryCleanup,
    is_agent_target,
)
from evaluatorq.redteam.contracts import AgentContext


# ---------------------------------------------------------------------------
# Minimal mock targets for testing
# ---------------------------------------------------------------------------


class MinimalTarget:
    """Bare-minimum AgentTarget — only required methods."""

    async def send_prompt(self, prompt: str) -> str:
        return f'echo: {prompt}'

    def reset_conversation(self) -> None:
        pass


class NamedTarget(MinimalTarget):
    """Target with a .name attribute."""

    name = 'my-custom-agent'


class FullTarget(MinimalTarget):
    """Target implementing all optional protocols."""

    name = 'full-agent'

    async def get_agent_context(self) -> AgentContext:
        return AgentContext(key='full-agent', display_name='Full Agent')

    def create_target(self, agent_key: str, memory_entity_id: str | None = None) -> FullTarget:
        return FullTarget()

    async def cleanup_memory(self, agent_context: AgentContext, entity_ids: list[str]) -> None:
        pass

    def map_error(self, exc: Exception) -> tuple[str, str]:
        return 'custom_error', str(exc)

    def clone(self) -> FullTarget:
        return FullTarget()


class NotATarget:
    """Object that does NOT satisfy AgentTarget."""

    def some_method(self) -> None:
        pass


# ---------------------------------------------------------------------------
# is_agent_target()
# ---------------------------------------------------------------------------


class TestIsAgentTarget:
    def test_minimal_target(self):
        assert is_agent_target(MinimalTarget()) is True

    def test_full_target(self):
        assert is_agent_target(FullTarget()) is True

    def test_not_a_target(self):
        assert is_agent_target(NotATarget()) is False

    def test_string_is_not_target(self):
        assert is_agent_target('agent:key') is False

    def test_none_is_not_target(self):
        assert is_agent_target(None) is False


# ---------------------------------------------------------------------------
# Target label resolution
# ---------------------------------------------------------------------------


class TestGetTargetLabel:
    def test_class_name_fallback(self):
        assert _get_target_label(MinimalTarget()) == 'MinimalTarget'

    def test_name_attribute_preferred(self):
        assert _get_target_label(NamedTarget()) == 'my-custom-agent'


# ---------------------------------------------------------------------------
# Capability extraction
# ---------------------------------------------------------------------------


class TestCapabilityExtraction:
    def test_factory_from_full_target(self):
        t = FullTarget()
        factory = _get_target_factory(t)
        # Should use the target itself as factory
        assert factory is t

    def test_factory_fallback_for_minimal(self):
        t = MinimalTarget()
        factory = _get_target_factory(t)
        assert isinstance(factory, DirectTargetFactory)

    def test_error_mapper_from_full_target(self):
        t = FullTarget()
        mapper = _get_error_mapper(t)
        assert mapper is t

    def test_error_mapper_fallback_for_minimal(self):
        t = MinimalTarget()
        mapper = _get_error_mapper(t)
        assert isinstance(mapper, DefaultErrorMapper)

    def test_memory_cleanup_from_full_target(self):
        t = FullTarget()
        cleanup = _get_memory_cleanup(t)
        assert cleanup is t

    def test_memory_cleanup_fallback_for_minimal(self):
        t = MinimalTarget()
        cleanup = _get_memory_cleanup(t)
        assert isinstance(cleanup, NoopMemoryCleanup)

    @pytest.mark.asyncio
    async def test_agent_context_from_full_target(self):
        t = FullTarget()
        ctx = await _get_agent_context(t, 'fallback')
        assert ctx.key == 'full-agent'
        assert ctx.display_name == 'Full Agent'

    @pytest.mark.asyncio
    async def test_agent_context_fallback_for_minimal(self):
        t = MinimalTarget()
        ctx = await _get_agent_context(t, 'my-label')
        assert ctx.key == 'my-label'


# ---------------------------------------------------------------------------
# _parse_target (string parsing — unchanged behavior)
# ---------------------------------------------------------------------------


class TestParseTarget:
    """Tests for target string parsing."""

    def test_agent_target(self):
        kind, value = _parse_target('agent:my-agent-key')
        assert kind == 'agent'
        assert value == 'my-agent-key'

    def test_openai_target(self):
        kind, value = _parse_target('openai:gpt-4o')
        assert kind == 'openai'
        assert value == 'gpt-4o'

    def test_bare_key_defaults_to_agent(self):
        kind, value = _parse_target('my-agent-key')
        assert kind == 'agent'
        assert value == 'my-agent-key'

    def test_case_insensitive_kind(self):
        kind, _value = _parse_target('Agent:my-key')
        assert kind == 'agent'

    def test_empty_value_raises(self):
        with pytest.raises(ValueError, match='missing a value'):
            _parse_target('agent:')

    def test_multiple_colons(self):
        kind, value = _parse_target('openai:org/gpt-4o:latest')
        assert kind == 'openai'
        assert value == 'org/gpt-4o:latest'


# ---------------------------------------------------------------------------
# Category helpers
# ---------------------------------------------------------------------------


class TestListCategories:
    """Tests for list_categories()."""

    def test_returns_list(self):
        cats = list_categories()
        assert isinstance(cats, list)
        assert len(cats) > 0

    def test_no_owasp_prefix(self):
        cats = list_categories()
        for cat in cats:
            assert not cat.startswith('OWASP-'), f'{cat} should not have OWASP- prefix'

    def test_contains_known_categories(self):
        cats = list_categories()
        assert 'ASI01' in cats


class TestGetCategoryInfo:
    """Tests for get_category_info()."""

    def test_returns_dict(self):
        info = get_category_info()
        assert isinstance(info, dict)
        assert len(info) > 0

    def test_info_structure(self):
        info = get_category_info()
        for _cat, details in info.items():
            assert 'name' in details
            assert 'strategy_count' in details
            assert 'single_turn_count' in details
            assert 'multi_turn_count' in details
            assert isinstance(details['strategy_count'], int)
            assert details['strategy_count'] > 0

    def test_asi01_has_strategies(self):
        info = get_category_info()
        assert 'ASI01' in info
        assert info['ASI01']['strategy_count'] > 0


# ---------------------------------------------------------------------------
# red_team() validation
# ---------------------------------------------------------------------------


class TestRedTeamValidation:
    """Tests for red_team() argument validation (no actual LLM calls)."""

    @pytest.mark.asyncio
    async def test_invalid_mode_raises(self):
        with pytest.raises(ValueError, match='Invalid mode'):
            await red_team('agent:test', mode='invalid')

    @pytest.mark.asyncio
    async def test_static_mode_dispatches(self):
        """Static mode dispatches to _run_static (no longer raises NotImplementedError)."""
        from unittest.mock import AsyncMock, patch

        sentinel = object()
        with patch(
            'evaluatorq.redteam._runner._run_static',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_static:
            result = await red_team('agent:test', mode='static')
            assert result is sentinel
            mock_static.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_hybrid_mode_not_implemented(self):
        with pytest.raises(NotImplementedError, match='not yet available'):
            await red_team('agent:test', mode='hybrid')


# ---------------------------------------------------------------------------
# red_team() with AgentTarget objects
# ---------------------------------------------------------------------------


class TestRedTeamWithAgentTarget:
    """Tests for passing AgentTarget objects directly to red_team()."""

    @pytest.mark.asyncio
    async def test_agent_target_dispatches_to_dynamic(self):
        """red_team(MyAgent()) dispatches to _run_dynamic."""
        from unittest.mock import AsyncMock, patch

        sentinel = object()
        with patch(
            'evaluatorq.redteam._runner._run_dynamic',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_dynamic:
            result = await red_team(MinimalTarget())
            assert result is sentinel
            mock_dynamic.assert_awaited_once()
            # Verify target was passed through
            call_kwargs = mock_dynamic.call_args.kwargs
            assert call_kwargs['target'] is not None

    @pytest.mark.asyncio
    async def test_agent_target_list_dispatches(self):
        """red_team([target1, target2]) dispatches to _run_dynamic with list."""
        from unittest.mock import AsyncMock, patch

        sentinel = object()
        t1, t2 = MinimalTarget(), NamedTarget()
        with patch(
            'evaluatorq.redteam._runner._run_dynamic',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_dynamic:
            result = await red_team([t1, t2])
            assert result is sentinel
            call_kwargs = mock_dynamic.call_args.kwargs
            assert call_kwargs['target'] == [t1, t2]

    @pytest.mark.asyncio
    async def test_static_mode_rejects_agent_target(self):
        """Static mode only supports string targets."""
        with pytest.raises(ValueError, match='Static mode currently only supports string targets'):
            await red_team(MinimalTarget(), mode='static')

    @pytest.mark.asyncio
    async def test_invalid_target_type_raises(self):
        """Non-string, non-AgentTarget raises TypeError inside _resolve_targets."""
        from evaluatorq.redteam._runner import _resolve_targets  # pyright: ignore[reportPrivateUsage]

        with pytest.raises(TypeError, match='Invalid target type'):
            _resolve_targets(12345, backend='orq', llm_client=None)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Deprecation warnings
# ---------------------------------------------------------------------------


class TestDeprecation:
    @pytest.mark.asyncio
    async def test_target_factory_deprecation_warning(self):
        """Passing target_factory emits a DeprecationWarning."""
        from unittest.mock import AsyncMock, patch

        mock_factory = type('MockFactory', (), {'create_target': lambda *a, **kw: MinimalTarget()})()

        with (
            patch(
                'evaluatorq.redteam._runner._run_dynamic',
                new_callable=AsyncMock,
                return_value=object(),
            ),
            warnings.catch_warnings(record=True) as w,
        ):
            warnings.simplefilter('always')
            await red_team('agent:test', target_factory=mock_factory)
            deprecation_warnings = [x for x in w if issubclass(x.category, DeprecationWarning)]
            assert len(deprecation_warnings) >= 1
            assert 'target_factory is deprecated' in str(deprecation_warnings[0].message)
