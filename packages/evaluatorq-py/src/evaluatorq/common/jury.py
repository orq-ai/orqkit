"""Generic judge-panel orchestration and verdict aggregation."""

from __future__ import annotations

import asyncio
import re
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from typing import Literal

from loguru import logger
from pydantic import BaseModel

from evaluatorq.contracts import JuryResult, JuryStats, JuryVote, StrEnum, TokenUsage

VerdictValue = bool | float | str
TieBreak = Callable[[list[VerdictValue]], VerdictValue | None]


class VerdictKind(StrEnum):
    CATEGORICAL = 'categorical'
    NUMERIC = 'numeric'


class Prediction(BaseModel):
    """One judge pass returned by a caller-provided judge function."""

    value: VerdictValue | None = None
    explanation: str = ''
    token_usage: TokenUsage | None = None
    error: str | None = None
    abstained: bool = False

    @property
    def decisive(self) -> bool:
        return self.error is None and not self.abstained and self.value is not None


class JuryDeliberation(BaseModel):
    """Final verdict plus the serializable jury result."""

    verdict: VerdictValue | None = None
    explanation: str = ''
    jury: JuryResult
    token_usage: TokenUsage | None = None


def _sum_usage(usages: list[TokenUsage]) -> TokenUsage | None:
    if not usages:
        return None
    total = usages[0]
    for usage in usages[1:]:
        total = total + usage
    return total


def _plurality_vote(values: Sequence[VerdictValue]) -> tuple[VerdictValue | None, bool]:
    if not values:
        return None, False
    counts = Counter(values)
    top_count = max(counts.values())
    winners = [value for value, count in counts.items() if count == top_count]
    if len(winners) > 1:
        return None, True
    return winners[0], False


def _numeric_vote(values: Sequence[VerdictValue], aggregation: Literal['mean', 'median']) -> float | None:
    nums = [float(v) for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not nums:
        return None
    if aggregation == 'median':
        ordered = sorted(nums)
        mid = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[mid]
        return (ordered[mid - 1] + ordered[mid]) / 2
    return sum(nums) / len(nums)


def _jury_stats(values: Sequence[VerdictValue]) -> JuryStats | None:
    if not values:
        return None
    if all(isinstance(v, bool) for v in values):
        nums = [1.0 if v else 0.0 for v in values]
    elif all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
        nums = [float(v) for v in values]
    else:
        return None
    mean = sum(nums) / len(nums)
    variance = sum((n - mean) ** 2 for n in nums) / len(nums)
    return JuryStats(mean=mean, std=variance**0.5)


def _agreement_rate(values: Sequence[VerdictValue]) -> float | None:
    if not values:
        return None
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
        return None
    counts = Counter(values)
    return max(counts.values()) / len(values)


def _jury_explanation(votes: Sequence[JuryVote]) -> str:
    for vote in reversed(votes):
        if vote.error:
            return f'No judge produced a usable verdict; last error: {vote.error}'
    if any(v.abstained for v in votes):
        return 'No judge produced a usable verdict; all decisive judges abstained.'
    return 'No judge produced a usable verdict.'


def append_jury_summary(explanation: str | None, jury: JuryResult | None) -> str:
    """Append a compact jury summary to a scorer explanation."""
    base = explanation or ''
    if jury is None:
        return base
    rate = f'{jury.raw_agreement:.0%}' if jury.raw_agreement is not None else 'n/a'
    flags: list[str] = []
    if jury.tie:
        flags.append('TIE (tie-break applied)')
    if jury.inconclusive:
        flags.append('INCONCLUSIVE')
    suffix = f', {", ".join(flags)}' if flags else ''
    summary = f'[jury: {jury.judges_succeeded}/{jury.judges_configured} judges, raw agreement {rate}{suffix}]'
    return f'{base} {summary}' if base else summary


async def _call_prediction(judge_fn: Callable[[str], Awaitable[Prediction]], model: str) -> Prediction:
    try:
        return await judge_fn(model)
    except Exception as exc:
        logger.warning('jury judge_fn raised: {}', exc)
        return Prediction(error=str(exc))


async def _judge_vote(
    *,
    model: str,
    judge_fn: Callable[[str], Awaitable[Prediction]],
    repetitions: int,
    verdict_kind: VerdictKind,
    tie_break: TieBreak | None,
    replacement: bool,
    numeric_aggregation: Literal['mean', 'median'],
) -> tuple[JuryVote, list[TokenUsage]]:
    predictions = await asyncio.gather(*[_call_prediction(judge_fn, model) for _ in range(max(1, repetitions))])
    usages = [p.token_usage for p in predictions if p.token_usage is not None]
    decisive = [p for p in predictions if p.decisive]
    abstained = bool(predictions) and not decisive and any(p.abstained for p in predictions)
    repetitions_raw = [p.value if p.decisive else None for p in predictions]
    failed_count = sum(1 for p in predictions if p.error is not None)

    if failed_count > 0 and failed_count < len(predictions):
        logger.warning('judge {} had {}/{} repetitions fail', model, failed_count, len(predictions))

    if not decisive:
        if abstained:
            explanation = next((p.explanation for p in predictions if p.abstained and p.explanation), '')
            return (
                JuryVote(
                    model=model,
                    replacement=replacement,
                    success=True,
                    abstained=True,
                    explanation=explanation,
                    repetitions=repetitions_raw,
                    repetitions_failed=failed_count,
                ),
                usages,
            )
        error = next((p.error for p in predictions if p.error), 'no successful prediction')
        return (
            JuryVote(
                model=model,
                replacement=replacement,
                success=False,
                error=error,
                repetitions=repetitions_raw,
                repetitions_failed=failed_count,
            ),
            usages,
        )

    values = [p.value for p in decisive if p.value is not None]
    tie = False
    if verdict_kind is VerdictKind.NUMERIC:
        value = _numeric_vote(values, numeric_aggregation)
    else:
        value, tie = _plurality_vote(values)
        if tie and tie_break is not None:
            value = tie_break(values)
    if value is None:
        return (
            JuryVote(
                model=model,
                replacement=replacement,
                success=True,
                abstained=True,
                explanation='Judge repetitions tied without a decisive tie-break.',
                repetitions=repetitions_raw,
                repetitions_failed=failed_count,
            ),
            usages,
        )
    representative = next(
        (p.explanation for p in decisive if p.value == value and p.explanation), decisive[0].explanation
    )
    return (
        JuryVote(
            model=model,
            replacement=replacement,
            success=True,
            value=value,
            explanation=representative,
            repetitions=repetitions_raw,
            repetitions_failed=failed_count,
        ),
        usages,
    )


async def run_jury(
    *,
    judge_fn: Callable[[str], Awaitable[Prediction]],
    panel: Sequence[str],
    repetitions: int = 1,
    replacement_judges: Sequence[str] | None = None,
    min_successful_judges: int = 1,
    verdict_kind: VerdictKind = VerdictKind.CATEGORICAL,
    tie_break: TieBreak | None = None,
    numeric_aggregation: Literal['mean', 'median'] = 'mean',
    tie_break_label: str | None = None,
) -> JuryDeliberation:
    """Run a generic panel of judges and aggregate their verdicts."""
    resolved_panel = resolve_panel(panel)
    replacement_pool = [r for r in (replacement_judges or []) if r and r not in resolved_panel]

    judge_results = await asyncio.gather(*[
        _judge_vote(
            model=model,
            judge_fn=judge_fn,
            repetitions=repetitions,
            verdict_kind=verdict_kind,
            tie_break=tie_break,
            replacement=False,
            numeric_aggregation=numeric_aggregation,
        )
        for model in resolved_panel
    ])

    votes: list[JuryVote] = []
    usages: list[TokenUsage] = []
    for vote, vote_usages in judge_results:
        votes.append(vote)
        usages.extend(vote_usages)

    failures = sum(1 for vote in votes if not vote.success)
    stand_ins = replacement_pool[:failures]
    if stand_ins:
        replacement_results = await asyncio.gather(*[
            _judge_vote(
                model=model,
                judge_fn=judge_fn,
                repetitions=repetitions,
                verdict_kind=verdict_kind,
                tie_break=tie_break,
                replacement=True,
                numeric_aggregation=numeric_aggregation,
            )
            for model in stand_ins
        ])
        for vote, vote_usages in replacement_results:
            votes.append(vote)
            usages.extend(vote_usages)

    decisive_votes = [v for v in votes if v.success and not v.abstained and v.value is not None]
    decisive_values = [v.value for v in decisive_votes if v.value is not None]
    inconclusive = len(decisive_votes) < max(1, min_successful_judges)
    tie = False
    verdict: VerdictValue | None = None

    if not inconclusive:
        if verdict_kind is VerdictKind.NUMERIC:
            verdict = _numeric_vote(decisive_values, numeric_aggregation)
        else:
            verdict, tie = _plurality_vote(decisive_values)
            if tie and tie_break is not None:
                verdict = tie_break(decisive_values)
            if verdict is None:
                inconclusive = True
                tie = False

    # Log degraded / collapsed jury states loudly (A4).
    if not decisive_votes:
        logger.error(
            'jury collapsed: 0/{} judges produced a usable verdict ({} failed)',
            len(resolved_panel),
            failures,
        )
    elif inconclusive:
        logger.warning(
            'jury inconclusive: {}/{} decisive, need {}',
            len(decisive_votes),
            len(resolved_panel),
            max(1, min_successful_judges),
        )

    if inconclusive:
        if decisive_votes:
            explanation = (
                f'Inconclusive: only {len(decisive_votes)} of {max(1, min_successful_judges)} '
                'required judges returned a usable verdict.'
            )
        else:
            explanation = _jury_explanation(votes)
    else:
        representative = next((v for v in decisive_votes if v.value == verdict), None)
        explanation = representative.explanation if representative else ''
        if tie:
            tie_label = tie_break_label if tie_break_label is not None else 'tie-break applied'
            explanation = f'[TIE — {tie_label}] {explanation}'

    jury = JuryResult(
        judges_configured=len(resolved_panel),
        judges_succeeded=len(decisive_votes),
        judges_failed=failures,
        replacements_used=len(stand_ins),
        tie=tie,
        inconclusive=inconclusive,
        votes=votes,
        stats=None if inconclusive else _jury_stats(decisive_values),
        raw_agreement=None if inconclusive else _agreement_rate(decisive_values),
    )
    return JuryDeliberation(verdict=verdict, explanation=explanation, jury=jury, token_usage=_sum_usage(usages))


_FAMILY_MARKERS: tuple[tuple[str, str], ...] = (
    ('claude', 'anthropic'),
    ('chatgpt', 'openai'),
    ('gpt', 'openai'),
    ('o1', 'openai'),
    ('o3', 'openai'),
    ('o4', 'openai'),
    ('gemini', 'google'),
    ('palm', 'google'),
    ('llama', 'meta'),
    ('mixtral', 'mistral'),
    ('mistral', 'mistral'),
    ('command', 'cohere'),
    ('grok', 'xai'),
    ('deepseek', 'deepseek'),
    ('qwen', 'alibaba'),
    ('glm', 'zhipu'),
    ('minimax', 'minimax'),
)
_KNOWN_FAMILIES: frozenset[str] = frozenset(fam for _, fam in _FAMILY_MARKERS)


def provider_family(model_id: str) -> str:
    ident = (model_id or '').strip().lower()
    if not ident:
        return 'unknown'
    tokens = [t for t in re.split(r'[/\-_.: ]+', ident) if t]
    if not tokens:
        return 'unknown'
    if tokens[0] in _KNOWN_FAMILIES:
        return tokens[0]
    for marker, family in _FAMILY_MARKERS:
        if any(tok == marker or tok.startswith(marker) for tok in tokens):
            return family
    return 'unknown'


def _panel_composition_messages(panel: list[str], target_models: list[str]) -> list[str]:
    messages: list[str] = []
    families = {provider_family(m) for m in panel}
    known = families - {'unknown'}
    if len(panel) > 1 and 'unknown' not in families and len(known) == 1:
        messages.append(
            f'Panel judges are all from a single provider family ({next(iter(known))}): {panel}. '
            'Correlated judges do not add the diversity a jury is meant to provide; '
            'prefer an odd, mixed-provider panel.'
        )
    target_families = {provider_family(m) for m in target_models} - {'unknown'}
    shared = known & target_families
    if shared:
        offenders = [m for m in panel if provider_family(m) in shared]
        shared_label = ', '.join(sorted(shared))
        messages.append(
            f'Judge(s) {offenders} share the target provider family ({shared_label}). '
            'Same-family self-judging may bias verdicts toward the target\'s own provider; '
            'prefer judges from a different provider than the target.'
        )
    return messages


def resolve_panel(panel: Sequence[str]) -> list[str]:
    """Dedup panel preserving insertion order, then validate non-empty."""
    resolved: list[str] = []
    for model in panel:
        if model and model not in resolved:
            resolved.append(model)
    if not resolved:
        raise ValueError('judge panel must contain at least one model')
    return resolved
