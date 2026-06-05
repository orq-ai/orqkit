"""Unit tests for the panel-of-judges / jury feature (RES-739).

Mirrors the orq platform jury contract and the LLM-jury best practices
(orq.ai/blog/llm-juries-in-practice): fail-closed ties with an explicit tie
flag, per-judge votes, mean/std stats, judge replacement on failure.

Covers:
1. _majority_vote / _agreement_rate / _jury_stats aggregation helpers
2. Single judge + single repetition stays byte-identical (jury is None)
3. Jury: unanimous and split verdicts, per-judge votes recorded
4. Per-judge repetition majority voting
5. Fail-closed tie handling with explicit tie flag
6. Judge replacement on total failure (replacements_used)
7. min_successful_judges floor → inconclusive
8. Token usage summed across all jury calls
"""

from __future__ import annotations

import contextlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evaluatorq.redteam.adaptive.evaluator import (
    OWASPEvaluator,
    _agreement_rate,
    _jury_stats,
    _majority_vote,
)
from evaluatorq.redteam.contracts import AttackEvaluationResult, Vulnerability

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _response(content: str, usage_tokens: int | None = None) -> MagicMock:
    """Build a mock chat-completion response with the given content."""
    mock_message = MagicMock()
    mock_message.content = content

    mock_choice = MagicMock()
    mock_choice.message = mock_message

    mock_response = MagicMock()
    mock_response.choices = [mock_choice]
    if usage_tokens is None:
        mock_response.usage = None
    else:
        usage = MagicMock()
        usage.prompt_tokens = usage_tokens
        usage.completion_tokens = usage_tokens
        usage.total_tokens = usage_tokens * 2
        mock_response.usage = usage
    return mock_response


def _verdict_json(value: bool) -> str:
    return f'{{"value": {str(value).lower()}, "explanation": "judge says {value}"}}'


def _model_client(per_model: dict[str, list[str]], usage_tokens: int | None = None) -> AsyncMock:
    """Mock AsyncOpenAI client returning queued contents per model.

    ``per_model`` maps a model id to an ordered list of response contents; each
    call for that model pops the next content (cycling if exhausted), which lets
    a single judge return different verdicts across repetitions. A content value
    of the sentinel ``"__raise__"`` makes that call raise, simulating a failure.
    """
    cursors = {model: 0 for model in per_model}

    async def _create(*_args: Any, **kwargs: Any) -> MagicMock:
        model = kwargs['model']
        queue = per_model[model]
        idx = cursors[model] % len(queue)
        cursors[model] += 1
        content = queue[idx]
        if content == '__raise__':
            raise RuntimeError('judge exploded')
        return _response(content, usage_tokens=usage_tokens)

    client = AsyncMock()
    client.chat.completions.create = AsyncMock(side_effect=_create)
    return client


def _patch_tracing():
    @contextlib.asynccontextmanager
    async def _noop_span(*args: Any, **kwargs: Any):
        yield MagicMock()

    return (
        patch('evaluatorq.redteam.adaptive.evaluator.with_llm_span', side_effect=_noop_span),
        patch('evaluatorq.redteam.adaptive.evaluator.record_llm_response'),
    )


async def _evaluate(evaluator: OWASPEvaluator) -> AttackEvaluationResult:
    span_patch, record_patch = _patch_tracing()
    with span_patch, record_patch:
        return await evaluator.evaluate_vulnerability(
            vuln=Vulnerability.GOAL_HIJACKING,
            messages=[{'role': 'user', 'content': 'attack prompt'}],
            response='agent response',
        )


# ---------------------------------------------------------------------------
# Aggregation helpers
# ---------------------------------------------------------------------------


class TestAggregationHelpers:
    def test_majority_vote_clear_majority(self):
        assert _majority_vote([True, True, False]) == (True, False)
        assert _majority_vote([False, False, True]) == (False, False)

    def test_majority_vote_ignores_none(self):
        assert _majority_vote([True, None, True]) == (True, False)
        assert _majority_vote([None, None, False]) == (False, False)

    def test_majority_vote_all_none(self):
        assert _majority_vote([None, None]) == (None, False)

    def test_majority_vote_tie_flags_tie(self):
        assert _majority_vote([True, False]) == (None, True)
        assert _majority_vote([True, True, False, False]) == (None, True)

    def test_agreement_rate(self):
        assert _agreement_rate([True, True, True]) == 1.0
        assert _agreement_rate([True, True, False]) == pytest.approx(2 / 3)
        assert _agreement_rate([True, False]) == 0.5
        assert _agreement_rate([]) is None

    def test_jury_stats(self):
        stats = _jury_stats([True, True, False])
        assert stats is not None
        assert stats.mean == pytest.approx(2 / 3)
        assert stats.std == pytest.approx((2 / 9) ** 0.5)
        assert _jury_stats([]) is None


# ---------------------------------------------------------------------------
# Jury behaviour
# ---------------------------------------------------------------------------


class TestJury:
    @pytest.mark.asyncio
    async def test_single_judge_single_rep_is_backward_compatible(self):
        """Default config must not populate the jury field."""
        client = _model_client({'judge-a': [_verdict_json(True)]})
        evaluator = OWASPEvaluator(evaluator_model='judge-a', llm_client=client)

        result = await _evaluate(evaluator)

        assert result.passed is True
        assert result.jury is None
        assert client.chat.completions.create.await_count == 1

    @pytest.mark.asyncio
    async def test_unanimous_jury(self):
        client = _model_client({
            'judge-a': [_verdict_json(True)],
            'judge-b': [_verdict_json(True)],
            'judge-c': [_verdict_json(True)],
        })
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b', 'judge-c'],
        )

        result = await _evaluate(evaluator)

        assert result.passed is True
        assert result.jury is not None
        jury = result.jury
        assert jury.tie is False
        assert jury.agreement_rate == 1.0
        assert jury.judges_configured == 3
        assert jury.judges_succeeded == 3
        assert jury.judges_failed == 0
        assert [v.model for v in jury.votes] == ['judge-a', 'judge-b', 'judge-c']
        assert all(v.value is True and v.success for v in jury.votes)
        assert jury.stats is not None
        assert jury.stats.mean == 1.0
        assert jury.stats.std == 0.0

    @pytest.mark.asyncio
    async def test_split_jury_takes_majority(self):
        client = _model_client({
            'judge-a': [_verdict_json(True)],
            'judge-b': [_verdict_json(True)],
            'judge-c': [_verdict_json(False)],
        })
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b', 'judge-c'],
        )

        result = await _evaluate(evaluator)

        assert result.passed is True  # 2 RESISTANT vs 1 VULNERABLE
        assert result.jury is not None
        assert result.jury.tie is False
        assert result.jury.agreement_rate == pytest.approx(2 / 3)
        verdicts = {v.model: v.value for v in result.jury.votes}
        assert verdicts == {'judge-a': True, 'judge-b': True, 'judge-c': False}

    @pytest.mark.asyncio
    async def test_per_judge_repetition_majority(self):
        """A single judge run 3x with votes [True, True, False] → True."""
        client = _model_client({'judge-a': [_verdict_json(True), _verdict_json(True), _verdict_json(False)]})
        evaluator = OWASPEvaluator(evaluator_model='judge-a', llm_client=client, repetitions=3)

        result = await _evaluate(evaluator)

        assert result.passed is True
        assert client.chat.completions.create.await_count == 3
        assert result.jury is not None
        assert len(result.jury.votes) == 1
        assert result.jury.votes[0].repetitions == [True, True, False]

    @pytest.mark.asyncio
    async def test_even_jury_tie_fails_closed(self):
        """A tied panel resolves to VULNERABLE (fail-closed) and flags the tie."""
        client = _model_client({
            'judge-a': [_verdict_json(True)],
            'judge-b': [_verdict_json(False)],
        })
        evaluator = OWASPEvaluator(evaluator_model='judge-a', llm_client=client, judges=['judge-b'])

        result = await _evaluate(evaluator)

        assert result.passed is False  # fail-closed
        assert result.jury is not None
        assert result.jury.tie is True
        assert result.jury.agreement_rate == 0.5
        assert result.explanation.startswith('[TIE — fail-closed to VULNERABLE]')

    @pytest.mark.asyncio
    async def test_replacement_judge_on_failure(self):
        """A judge that fails every repetition is replaced, keeping panel strength."""
        client = _model_client({
            'judge-a': [_verdict_json(True)],
            'judge-b': ['__raise__'],
            'judge-r': [_verdict_json(True)],
        })
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b'],
            replacement_judges=['judge-r'],
        )

        result = await _evaluate(evaluator)

        assert result.passed is True
        assert result.jury is not None
        jury = result.jury
        assert jury.replacements_used == 1
        assert jury.judges_failed == 1
        assert jury.judges_succeeded == 2
        votes = {v.model: (v.success, v.replacement) for v in jury.votes}
        assert votes['judge-b'] == (False, False)
        assert votes['judge-r'] == (True, True)

    @pytest.mark.asyncio
    async def test_api_error_judge_is_replaced_not_fatal(self):
        """An APIStatusError from one judge degrades to a failed vote + replacement,
        rather than aborting the whole jury (regression from live run)."""
        import httpx
        from openai import APIStatusError

        async def _create(*_args: Any, **kwargs: Any):
            model = kwargs['model']
            if model == 'judge-b':
                raise APIStatusError(
                    message='model not found',
                    response=httpx.Response(404, request=httpx.Request('POST', 'https://x')),
                    body=None,
                )
            return _response(_verdict_json(True))

        client = AsyncMock()
        client.chat.completions.create = AsyncMock(side_effect=_create)
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b'],
            replacement_judges=['judge-r'],
        )

        # judge-r must also return a verdict
        original = client.chat.completions.create.side_effect

        async def _create2(*args: Any, **kwargs: Any):
            if kwargs['model'] == 'judge-r':
                return _response(_verdict_json(True))
            return await original(*args, **kwargs)

        client.chat.completions.create.side_effect = _create2

        result = await _evaluate(evaluator)

        assert result.passed is True  # judge-a + judge-r both RESISTANT
        assert result.jury is not None
        assert result.jury.replacements_used == 1
        votes = {v.model: (v.success, v.replacement) for v in result.jury.votes}
        assert votes['judge-b'] == (False, False)
        assert votes['judge-r'] == (True, True)

    @pytest.mark.asyncio
    async def test_single_judge_api_error_still_propagates(self):
        """The single-judge fast path keeps the original fail-loud behaviour."""
        import httpx
        from openai import APIStatusError

        client = AsyncMock()
        client.chat.completions.create = AsyncMock(
            side_effect=APIStatusError(
                message='boom',
                response=httpx.Response(500, request=httpx.Request('POST', 'https://x')),
                body=None,
            )
        )
        evaluator = OWASPEvaluator(evaluator_model='judge-a', llm_client=client)

        with pytest.raises(APIStatusError):
            await _evaluate(evaluator)

    @pytest.mark.asyncio
    async def test_min_successful_judges_floor_inconclusive(self):
        """Below min_successful_judges the verdict is inconclusive (None)."""
        client = _model_client({
            'judge-a': [_verdict_json(True)],
            'judge-b': ['__raise__'],
        })
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b'],
            min_successful_judges=2,
        )

        result = await _evaluate(evaluator)

        assert result.passed is None
        assert result.jury is not None
        assert result.jury.judges_succeeded == 1
        assert result.jury.tie is False
        assert 'Inconclusive' in result.explanation

    @pytest.mark.asyncio
    async def test_all_judges_and_replacements_fail(self):
        """When every judge (incl. replacements) fails, the verdict is inconclusive
        with a non-empty error explanation and zero successes."""
        client = _model_client({
            'judge-a': ['__raise__'],
            'judge-b': ['__raise__'],
            'judge-r': ['__raise__'],
        })
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b'],
            replacement_judges=['judge-r'],
        )

        result = await _evaluate(evaluator)

        assert result.passed is None
        assert result.jury is not None
        assert result.jury.judges_succeeded == 0
        assert result.jury.stats is None
        assert result.jury.agreement_rate is None
        assert result.explanation  # non-empty error string
        assert all(not v.success for v in result.jury.votes)

    @pytest.mark.asyncio
    async def test_token_usage_summed_across_jury(self):
        client = _model_client(
            {
                'judge-a': [_verdict_json(True)],
                'judge-b': [_verdict_json(True)],
            },
            usage_tokens=10,
        )
        evaluator = OWASPEvaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b'],
            repetitions=2,
        )

        result = await _evaluate(evaluator)

        # 2 judges x 2 reps = 4 calls, each 10 prompt + 10 completion tokens.
        assert result.token_usage is not None
        assert result.token_usage.calls == 4
        assert result.token_usage.prompt_tokens == 40
        assert result.token_usage.completion_tokens == 40

    @pytest.mark.asyncio
    async def test_duplicate_judge_is_deduplicated(self):
        """Passing the primary model again as a judge must not double-count it."""
        client = _model_client({'judge-a': [_verdict_json(True)]})
        evaluator = OWASPEvaluator(evaluator_model='judge-a', llm_client=client, judges=['judge-a'])

        assert evaluator.panel == ['judge-a']


class TestEndToEndScorer:
    """Drive the real create_dynamic_evaluator scorer (no mocking of the evaluator)
    to prove config -> panel -> jury -> EvaluationResult actually wires together."""

    @pytest.mark.asyncio
    async def test_scorer_produces_jury_and_summary(self):
        from types import SimpleNamespace

        from evaluatorq.redteam.adaptive.pipeline import create_dynamic_evaluator
        from evaluatorq.redteam.contracts import AgentResponse, AttackerResponse, AttackOutput, Turn

        client = _model_client({
            'judge-a': [_verdict_json(True)],
            'judge-b': [_verdict_json(True)],
            'judge-c': [_verdict_json(False)],
        })
        scorer = create_dynamic_evaluator(
            evaluator_model='judge-a',
            llm_client=client,
            judges=['judge-b', 'judge-c'],
            judge_repetitions=1,
        )['scorer']

        attack_output = AttackOutput(
            turns=[Turn(attacker=AttackerResponse(generated_prompt='do bad'), target=AgentResponse(text='no'))],
            category='ASI01',
            vulnerability='goal_hijacking',
        )

        span_patch, record_patch = _patch_tracing()
        with span_patch, record_patch:
            result = await scorer({
                'data': SimpleNamespace(inputs={'category': 'ASI01', 'vulnerability': 'goal_hijacking'}),
                'output': attack_output,
            })

        # 2 RESISTANT vs 1 VULNERABLE → pass, and the jury summary surfaces in the explanation.
        assert result.pass_ is True
        assert '[jury: 3/3 judges, agreement 67%]' in (result.explanation or '')
        # 3 judges actually got called.
        assert client.chat.completions.create.await_count == 3


class TestJurySummary:
    def test_summary_appended_when_jury_present(self):
        from evaluatorq.redteam.adaptive.pipeline import _append_jury_summary
        from evaluatorq.redteam.contracts import JuryResult

        jury = JuryResult(
            judges_configured=3,
            judges_succeeded=3,
            judges_failed=0,
            agreement_rate=2 / 3,
        )
        out = _append_jury_summary('Agent resisted.', jury)
        assert out == 'Agent resisted. [jury: 3/3 judges, agreement 67%]'

    def test_summary_flags_tie(self):
        from evaluatorq.redteam.adaptive.pipeline import _append_jury_summary
        from evaluatorq.redteam.contracts import JuryResult

        jury = JuryResult(judges_configured=2, judges_succeeded=2, judges_failed=0, tie=True, agreement_rate=0.5)
        out = _append_jury_summary('Split.', jury)
        assert 'TIE (fail-closed)' in out

    def test_no_summary_for_single_judge(self):
        from evaluatorq.redteam.adaptive.pipeline import _append_jury_summary

        assert _append_jury_summary('Agent resisted.', None) == 'Agent resisted.'
