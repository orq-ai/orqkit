"""Tests for the unified red_team() entry point and category helpers."""

from __future__ import annotations

import pytest

from evaluatorq.redteam import get_category_info, list_categories, red_team
from evaluatorq.redteam.runner import _parse_target


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
        kind, value = _parse_target('Agent:my-key')
        assert kind == 'agent'

    def test_empty_value_raises(self):
        with pytest.raises(ValueError, match='missing a value'):
            _parse_target('agent:')

    def test_multiple_colons(self):
        kind, value = _parse_target('openai:org/gpt-4o:latest')
        assert kind == 'openai'
        assert value == 'org/gpt-4o:latest'


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
        for cat, details in info.items():
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
            'evaluatorq.redteam.runner._run_static',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_static:
            result = await red_team('agent:test', mode='static')
            assert result is sentinel
            mock_static.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_hybrid_mode_dispatches(self):
        """Hybrid mode dispatches to _run_hybrid."""
        from unittest.mock import AsyncMock, patch

        sentinel = object()
        with patch(
            'evaluatorq.redteam.runner._run_hybrid',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_hybrid:
            result = await red_team('agent:test', mode='hybrid')
            assert result is sentinel
            mock_hybrid.assert_awaited_once()


class TestStaticCoverageGuard:
    """Tests for static mode evaluator coverage guard."""

    @pytest.mark.asyncio
    async def test_run_static_filters_uncovered_categories(self):
        """Static mode skips datapoints whose category has no evaluator."""
        from unittest.mock import MagicMock, patch

        from evaluatorq import DataPoint

        # Create datapoints with a mix of covered and uncovered categories
        datapoints = [
            DataPoint(inputs={'id': '1', 'category': 'ASI01', 'messages': []}),
            DataPoint(inputs={'id': '2', 'category': 'UNKNOWN_CAT', 'messages': []}),
            DataPoint(inputs={'id': '3', 'category': 'ASI02', 'messages': []}),
        ]

        def mock_get_evaluator(cat, model_id=None):
            if cat in ('ASI01', 'ASI02'):
                return MagicMock()
            return None

        with (
            patch(
                'evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge.load_owasp_agentic_dataset',
                return_value=datapoints,
            ),
            patch(
                'evaluatorq.redteam.frameworks.owasp.evaluators.get_evaluator_for_category',
                side_effect=mock_get_evaluator,
            ),
            patch('evaluatorq.evaluatorq', return_value=[]) as mock_evaluatorq,
            patch('evaluatorq.redteam.runtime.jobs.create_model_job', return_value=MagicMock()),
            patch('evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge.create_owasp_evaluator', return_value=MagicMock()),
            patch('evaluatorq.redteam.reports.converters.static_evaluatorq_results_to_reports', return_value={}),
        ):
            from evaluatorq.redteam.runner import _run_static

            await _run_static(
                target='agent:test',
                categories=None,
                evaluator_model='azure/gpt-5-mini',
                parallelism=5,
                max_static_datapoints=None,
                backend='orq',
                dataset_path=None,
                description='test',
            )

            # Verify evaluatorq was called with only 2 datapoints (not 3)
            call_args = mock_evaluatorq.call_args
            submitted_data = call_args.kwargs.get('data')
            assert len(submitted_data) == 2

    @pytest.mark.asyncio
    async def test_run_static_raises_when_all_filtered(self):
        """Static mode raises ValueError when all datapoints are filtered."""
        from unittest.mock import patch

        from evaluatorq import DataPoint

        datapoints = [
            DataPoint(inputs={'id': '1', 'category': 'UNKNOWN', 'messages': []}),
        ]

        with (
            patch(
                'evaluatorq.redteam.frameworks.owasp.evaluatorq_bridge.load_owasp_agentic_dataset',
                return_value=datapoints,
            ),
            patch(
                'evaluatorq.redteam.frameworks.owasp.evaluators.get_evaluator_for_category',
                return_value=None,
            ),
        ):
            from evaluatorq.redteam.runner import _run_static

            with pytest.raises(ValueError, match='All datapoints were filtered out'):
                await _run_static(
                    target='agent:test',
                    categories=None,
                    evaluator_model='azure/gpt-5-mini',
                    parallelism=5,
                    max_static_datapoints=None,
                    backend='orq',
                    dataset_path=None,
                    description='test',
                )


class TestConfirmCallback:
    """Tests for confirm_callback support."""

    @pytest.mark.asyncio
    async def test_confirm_callback_aborts_on_false(self):
        """Confirm callback returning False should abort execution."""
        from unittest.mock import AsyncMock, MagicMock, patch

        callback = MagicMock(return_value=False)

        with (
            patch('evaluatorq.redteam.runner._run_dynamic') as mock_dynamic,
        ):
            # Make _run_dynamic propagate the confirm callback behavior
            async def _fake_dynamic(**kwargs):
                cb = kwargs.get('confirm_callback')
                if cb is not None and not cb({'test': True}):
                    raise RuntimeError('Execution cancelled by confirmation callback')
                return MagicMock()

            mock_dynamic.side_effect = _fake_dynamic

            with pytest.raises(RuntimeError, match='cancelled by confirmation callback'):
                await red_team(
                    'agent:test',
                    mode='dynamic',
                    confirm_callback=callback,
                )

    @pytest.mark.asyncio
    async def test_confirm_callback_proceeds_on_true(self):
        """Confirm callback returning True should allow execution."""
        from unittest.mock import AsyncMock, MagicMock, patch

        callback = MagicMock(return_value=True)
        sentinel = object()

        with patch(
            'evaluatorq.redteam.runner._run_dynamic',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_dynamic:
            result = await red_team(
                'agent:test',
                mode='dynamic',
                confirm_callback=callback,
            )
            assert result is sentinel
            # confirm_callback is passed through to _run_dynamic
            call_kwargs = mock_dynamic.call_args.kwargs
            assert call_kwargs['confirm_callback'] is callback


class TestRedTeamMultiTarget:
    """Tests for red_team() with multiple targets."""

    @pytest.mark.asyncio
    async def test_empty_targets_raises(self):
        with pytest.raises(ValueError, match='at least one target'):
            await red_team([])

    @pytest.mark.asyncio
    async def test_multi_target_runs_each_and_merges(self):
        """Multi-target calls _red_team_single per target and merges."""
        from datetime import datetime, timezone
        from unittest.mock import AsyncMock, patch

        from evaluatorq.redteam.contracts import (
            Pipeline,
            RedTeamReport,
            ReportSummary,
        )

        def make_mock_report(target: str, **kwargs) -> RedTeamReport:
            return RedTeamReport(
                created_at=datetime.now(tz=timezone.utc),
                description=f'Report for {target}',
                pipeline=Pipeline.DYNAMIC,
                framework=None,
                categories_tested=['ASI01'],
                tested_agents=[target],
                total_results=0,
                results=[],
                summary=ReportSummary(),
            )

        with patch(
            'evaluatorq.redteam.runner._red_team_single',
            new_callable=AsyncMock,
        ) as mock_single:
            mock_single.side_effect = make_mock_report

            result = await red_team(['agent:a', 'agent:b'])

            assert mock_single.call_count == 2
            # Merged report should have both agents
            assert set(result.tested_agents) == {'agent:a', 'agent:b'}

    @pytest.mark.asyncio
    async def test_single_string_target_works(self):
        """A single string target dispatches directly (no merge)."""
        from unittest.mock import AsyncMock, patch

        sentinel = object()
        with patch(
            'evaluatorq.redteam.runner._red_team_single',
            new_callable=AsyncMock,
            return_value=sentinel,
        ) as mock_single:
            result = await red_team('agent:test')
            assert result is sentinel
            mock_single.assert_awaited_once()
