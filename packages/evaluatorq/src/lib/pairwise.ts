import type { Span } from "@opentelemetry/api";
import { z } from "zod";

import {
  agreementRate,
  compensatedSum,
  type Prediction,
  pluralityVote,
  resolvePanel,
  runJuryCore,
  sumUsage,
  unswap,
  type VerdictValue,
} from "./common/jury.js";
import { setSpanAttrs, withSpan } from "./common/tracing.js";
import { type JuryVote, type Usage, UsageSchema } from "./contracts.js";
import {
  comparisonsPerJudge,
  fitBt,
  type JudgedComparison,
  reliability,
} from "./ranking.js";
import { captureParentContext } from "./tracing/context.js";

export type PairwiseVerdict = "A" | "B" | "tie";

export type PairwiseJudgeFn<S = unknown> = (
  first: S,
  second: S,
  model: string,
) => Promise<Prediction>;

const pairwiseVerdict = z.enum(["A", "B", "tie"]);
const rate = z.number().nullable();

export function reconcilePair(
  first: VerdictValue | null,
  second: VerdictValue | null,
): { vote: VerdictValue | null; flipped: boolean } {
  if (first === null || second === null) {
    return { vote: null, flipped: false };
  }
  return first === second
    ? { vote: first, flipped: false }
    : { vote: null, flipped: true };
}

export function pairwiseConsensus(
  votes: readonly (VerdictValue | null)[],
): string {
  const { verdict } = pluralityVote(votes.filter((v) => v !== null));
  return verdict === null ? "inconclusive" : String(verdict);
}

export const RepetitionObservationSchema = z.object({
  ordering: z.enum(["ab", "ba"]),
  repetition: z.number().int().nonnegative(),
  verdict: pairwiseVerdict.nullable().default(null),
  explanation: z.string().nullable().default(null),
  rawOutput: z.record(z.unknown()).nullable().default(null),
});

export type RepetitionObservation = z.infer<typeof RepetitionObservationSchema>;

export const PairwiseVoteSchema = z.object({
  model: z.string(),
  vote: pairwiseVerdict.nullable(),
  flipped: z.boolean().default(false),
  completed: z.boolean().default(true),
  replacement: z.boolean().default(false),
  explanation: z.string().default(""),
  observations: z.array(RepetitionObservationSchema).default(() => []),
  repetitionFailures: z.number().int().nonnegative().default(0),
});

export type PairwiseVote = z.infer<typeof PairwiseVoteSchema>;
export type PairwiseVoteInput = z.input<typeof PairwiseVoteSchema>;

export const PairwiseComparisonSchema = z.object({
  winner: z.string(),
  votes: z.array(PairwiseVoteSchema).default(() => []),
  tokenUsage: UsageSchema.nullable().default(null),
  judgeLatencyMs: z.number().finite().nonnegative().nullable().default(null),
  traceId: z.string().nullable().default(null),
});

export type PairwiseComparison = z.infer<typeof PairwiseComparisonSchema>;
export type PairwiseComparisonInput = z.input<typeof PairwiseComparisonSchema>;

export const JudgeStatsSchema = z.object({
  model: z.string(),
  aRate: rate,
  bRate: rate,
  positionBias: z.number(),
  tieRate: z.number(),
  sigma: rate.default(null),
  consistency: rate.default(null),
  consistencyRaw: rate.default(null),
});

export type JudgeStats = z.infer<typeof JudgeStatsSchema>;

export const BTSigmaAggregationSchema = z.object({
  pABeatsB: z.number(),
  skillGap: z.number(),
  judgeSigmas: z.record(z.number()).default(() => ({})),
  repetitionConsistency: z.record(z.number()).default(() => ({})),
  repetitionConsistencyRaw: z.record(z.number()).default(() => ({})),
  winners: z.array(z.string()).default(() => []),
  aWinRate: rate,
  bWinRate: rate,
  tieRate: z.number(),
  inconclusiveRate: z.number(),
  converged: z.boolean().default(true),
  fitWarnings: z.array(z.string()).default(() => []),
});

export type BTSigmaAggregation = z.infer<typeof BTSigmaAggregationSchema>;

export const PairwiseReportSchema = z.object({
  comparisons: z.number().int(),
  aWinRate: rate,
  bWinRate: rate,
  tieRate: z.number(),
  inconclusiveRate: z.number(),
  meanAgreement: rate,
  perJudge: z.array(JudgeStatsSchema).default(() => []),
  btSigma: BTSigmaAggregationSchema.nullable().default(null),
});

export type PairwiseReport = z.infer<typeof PairwiseReportSchema>;

function ratio(count: number, total: number): number | null {
  return total ? count / total : null;
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function mean(values: readonly number[]): number {
  return compensatedSum(values) / values.length;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? (ordered[mid] as number)
    : ((ordered[mid - 1] as number) + (ordered[mid] as number)) / 2;
}

function isClose(a: number, b: number, relTol = 1e-9): boolean {
  return Math.abs(a - b) <= relTol * Math.max(Math.abs(a), Math.abs(b));
}

const VOTE_TO_P: Record<PairwiseVerdict, number> = { A: 1, B: 0, tie: 0.5 };
// Below this many decisive votes a judge's sigma is mostly prior, not evidence.
const MIN_VOTES_FOR_SIGMA = 5;
// A judge that never agreed with itself still casts a heavily discounted vote.
const MIN_CONSISTENCY_WEIGHT = 0.05;
// One datapoint of evidence at the panel mean, so a judge measured once is
// pulled halfway there and the prior fades as datapoints accumulate.
const SHRINKAGE_PSEUDO_OBS = 1;
// Below this the borrowed fallback is one judge's own value deciding the panel.
const MIN_MEASURED_JUDGES = 2;

function winnerRates(winners: readonly string[], total: number) {
  const counts = tally(winners);
  const a = counts.get("A") ?? 0;
  const b = counts.get("B") ?? 0;
  return {
    aWinRate: ratio(a, a + b),
    bWinRate: ratio(b, a + b),
    tieRate: total ? (counts.get("tie") ?? 0) / total : 0,
    inconclusiveRate: total ? (counts.get("inconclusive") ?? 0) / total : 0,
  };
}

function uniformPluralityAggregation(
  comparisons: readonly PairwiseComparison[],
  warnings: string[],
  converged = true,
): BTSigmaAggregation {
  const winners = comparisons.map((c) => c.winner);
  return {
    pABeatsB: 0.5,
    skillGap: 0,
    judgeSigmas: {},
    repetitionConsistency: {},
    repetitionConsistencyRaw: repetitionConsistencyRaw(comparisons),
    winners,
    ...winnerRates(winners, comparisons.length),
    converged,
    fitWarnings: warnings,
  };
}

interface RepetitionStat {
  raw: number;
  discounted: number;
  n: number;
}

function repetitionStats(
  comparisons: readonly PairwiseComparison[],
): Map<string, RepetitionStat> {
  const raw = new Map<string, number[]>();
  const discounted = new Map<string, number[]>();
  for (const comparison of comparisons) {
    for (const vote of comparison.votes) {
      const groups = new Map<string, string[]>();
      for (const o of vote.observations) {
        if (o.verdict !== null) {
          groups.set(o.ordering, [
            ...(groups.get(o.ordering) ?? []),
            o.verdict,
          ]);
        }
      }
      const groupScores: number[] = [];
      for (const values of groups.values()) {
        if (values.length >= 2) {
          const pairs = values.flatMap((a, i) =>
            values.slice(i + 1).map((b) => (a === b ? 1 : 0)),
          );
          groupScores.push(mean(pairs));
        }
      }
      if (groupScores.length === 0) {
        continue;
      }
      const agreement = mean(groupScores);
      const nObs = vote.observations.length;
      const completion = nObs
        ? Math.max(0, (nObs - vote.repetitionFailures) / nObs)
        : 1;
      raw.set(vote.model, [...(raw.get(vote.model) ?? []), agreement]);
      discounted.set(vote.model, [
        ...(discounted.get(vote.model) ?? []),
        agreement * completion,
      ]);
    }
  }
  return new Map(
    [...raw.keys()].sort().map((judge) => {
      const scores = raw.get(judge) as number[];
      return [
        judge,
        {
          raw: mean(scores),
          discounted: mean(discounted.get(judge) as number[]),
          n: scores.length,
        },
      ];
    }),
  );
}

export function repetitionConsistency(
  comparisons: readonly PairwiseComparison[],
): Record<string, number> {
  const stats = [...repetitionStats(comparisons)];
  if (stats.length === 0) {
    return {};
  }
  const totalN = stats.reduce((acc, [, s]) => acc + s.n, 0);
  // Evidence-weighted, so a thin judge does not set the anchor it is shrunk to.
  const panelMean =
    compensatedSum(stats.map(([, s]) => s.discounted * s.n)) / totalN;
  const k = SHRINKAGE_PSEUDO_OBS;
  return Object.fromEntries(
    stats.map(([judge, s]) => [
      judge,
      (s.n * s.discounted + k * panelMean) / (s.n + k),
    ]),
  );
}

export function repetitionConsistencyRaw(
  comparisons: readonly PairwiseComparison[],
): Record<string, number> {
  return Object.fromEntries(
    [...repetitionStats(comparisons)].map(([judge, s]) => [judge, s.raw]),
  );
}

function hasRepeat(orderings: readonly string[]): boolean {
  return [...tally(orderings).values()].some((n) => n >= 2);
}

export function hasRepeatedOrdering(
  comparisons: readonly PairwiseComparison[],
): boolean {
  return comparisons.some((c) =>
    c.votes.some((v) => hasRepeat(v.observations.map((o) => o.ordering))),
  );
}

function tallyPairwiseOutcomes(
  comparisons: readonly PairwiseComparison[],
): Map<string, Map<PairwiseVerdict, number>> {
  const voteCounts = new Map<string, Map<PairwiseVerdict, number>>();
  for (const comparison of comparisons) {
    for (const { model, vote } of comparison.votes) {
      if (vote !== null) {
        const counts = voteCounts.get(model) ?? new Map();
        counts.set(vote, (counts.get(vote) ?? 0) + 1);
        voteCounts.set(model, counts);
      }
    }
  }
  return voteCounts;
}

function weightedPairwiseWinners(
  comparisons: readonly PairwiseComparison[],
  weights: Readonly<Record<string, number>>,
): string[] {
  return comparisons.map((comparison) => {
    const totals: Record<PairwiseVerdict, number> = { A: 0, B: 0, tie: 0 };
    for (const { model, vote } of comparison.votes) {
      if (vote !== null) {
        totals[vote] += weights[model] ?? 1;
      }
    }
    const entries = Object.entries(totals);
    if (entries.every(([, value]) => value === 0)) {
      return "inconclusive";
    }
    const top = Math.max(...Object.values(totals));
    // A genuine tie must stay a tie rather than crown whichever side rounded up.
    const leaders = entries.filter(([, value]) => isClose(value, top));
    return leaders.length === 1 ? (leaders[0]?.[0] as string) : "inconclusive";
  });
}

export function btSigmaAggregation(
  comparisons: readonly PairwiseComparison[],
): BTSigmaAggregation {
  if (
    comparisons.some((c) =>
      c.votes.some((v) => v.vote !== null && !v.completed),
    )
  ) {
    return uniformPluralityAggregation(comparisons, [
      "single-ordering data: position-bias symmetrisation unavailable; used uniform plurality instead",
    ]);
  }

  const voteCounts = tallyPairwiseOutcomes(comparisons);
  const records: JudgedComparison[] = [...voteCounts.keys()]
    .sort()
    .flatMap((judge) => {
      const counts = voteCounts.get(judge) as Map<PairwiseVerdict, number>;
      return [...counts.keys()].sort().map((vote) => ({
        judge,
        itemA: "A",
        itemB: "B",
        pA: VOTE_TO_P[vote],
        weight: counts.get(vote) as number,
      }));
    });
  if (records.length === 0) {
    return {
      pABeatsB: 0.5,
      skillGap: 0,
      judgeSigmas: {},
      repetitionConsistency: {},
      repetitionConsistencyRaw: repetitionConsistencyRaw(comparisons),
      winners: comparisons.map(() => "inconclusive"),
      aWinRate: null,
      bWinRate: null,
      tieRate: 0,
      inconclusiveRate: comparisons.length ? 1 : 0,
      converged: true,
      fitWarnings: ["no decisive votes to fit on"],
    };
  }

  const fit = fitBt(records, { judgeSigma: true, hard: true });
  const fitWarnings = [...fit.warnings];
  const repConsistency = repetitionConsistency(comparisons);
  const repRaw = repetitionConsistencyRaw(comparisons);
  const measured = Object.keys(repConsistency).length;
  if (measured === 0 && hasRepeatedOrdering(comparisons)) {
    fitWarnings.push(
      "repetition weighting skipped: repeated passes exist but no single ordering held >= 2 decisive passes to measure consistency; using the pooled two-item fit",
    );
  }
  const repActive = measured >= MIN_MEASURED_JUDGES;
  if (measured > 0 && !repActive) {
    fitWarnings.push(
      `repetition weighting skipped: only ${measured} judge(s) had repeated decisive observations, need >= ${MIN_MEASURED_JUDGES}; using the pooled two-item fit`,
    );
  }
  if (!fit.converged) {
    if (!repActive) {
      fitWarnings.push(
        "non-converged fit: used uniform plurality winners instead",
      );
      return uniformPluralityAggregation(comparisons, fitWarnings, false);
    }
    fitWarnings.push(
      "non-converged fit: p_a_beats_b/skill_gap unavailable (reported neutral); winners still weighted by repetition consistency",
    );
  }

  // With two items a unanimous judge's sigma is a function of its own
  // one-sidedness, so 1/sigma would hand it an unbounded weight.
  const oneSided = new Set(
    [...voteCounts].filter(([, c]) => c.size === 1).map(([judge]) => judge),
  );
  const hasSigmas = Object.keys(fit.sigmas).length > 0;
  const sigmas = Object.fromEntries(
    Object.entries(fit.sigmas).filter(
      ([judge]) => fit.converged && !oneSided.has(judge),
    ),
  );
  let weights: Record<string, number> = Object.fromEntries(
    Object.keys(sigmas).map((judge) => [judge, reliability(fit, judge)]),
  );
  if (hasSigmas && oneSided.size > 0) {
    const values = Object.values(weights);
    const neutral = values.length > 0 ? median(values) : 1;
    for (const judge of [...oneSided].sort()) {
      weights[judge] = neutral;
      const [direction] = (
        voteCounts.get(judge) as Map<PairwiseVerdict, number>
      ).keys();
      const tail = repActive
        ? "excluded from judge_sigmas; its weight comes from repetition consistency"
        : "weighted neutrally and excluded from judge_sigmas";
      fitWarnings.push(
        `judge '${judge}' voted '${direction}' on every decisive comparison; with two items its sigma measures one-sidedness, not reliability - ${tail}`,
      );
    }
  }
  if (hasSigmas) {
    const perJudge = comparisonsPerJudge(records);
    for (const judge of Object.keys(perJudge).sort()) {
      const n = perJudge[judge] as number;
      if (n < MIN_VOTES_FOR_SIGMA && !oneSided.has(judge)) {
        fitWarnings.push(
          `judge '${judge}' has only ${Math.trunc(n)} decisive vote(s); its sigma is mostly prior, not evidence`,
        );
      }
    }
  }

  // Within-datapoint consistency cannot mistake datapoint heterogeneity for
  // judge noise; the pooled fit still supplies the run-level headline.
  if (repActive) {
    weights = Object.fromEntries(
      Object.entries(repConsistency).map(([judge, c]) => [
        judge,
        Math.max(c, MIN_CONSISTENCY_WEIGHT),
      ]),
    );
    const voted = new Set(
      comparisons.flatMap((c) =>
        c.votes.filter((v) => v.vote !== null).map((v) => v.model),
      ),
    );
    const fallback = median(Object.values(weights));
    for (const judge of [...voted].sort()) {
      if (!Object.hasOwn(weights, judge)) {
        weights[judge] = fallback;
        fitWarnings.push(
          `judge '${judge}' has no repeated decisive observations; weighted at the median measured consistency (${fallback.toFixed(2)})`,
        );
      }
    }
    const datapoints = comparisons.filter((c) =>
      c.votes.some((v) =>
        hasRepeat(
          v.observations
            .filter((o) => o.verdict !== null)
            .map((o) => o.ordering),
        ),
      ),
    ).length;
    fitWarnings.push(
      `reliability weights from within-datapoint repetition consistency (${measured} judge(s), ${datapoints} datapoint(s) with repeats)`,
    );
  }

  const winners = weightedPairwiseWinners(comparisons, weights);
  const gap = fit.converged
    ? (fit.skills.A as number) - (fit.skills.B as number)
    : 0;
  return {
    pABeatsB: fit.converged ? 1 / (1 + Math.exp(-gap)) : 0.5,
    skillGap: gap,
    judgeSigmas: sigmas,
    repetitionConsistency: repConsistency,
    repetitionConsistencyRaw: repRaw,
    winners,
    ...winnerRates(winners, comparisons.length),
    converged: fit.converged,
    fitWarnings,
  };
}

export type PairwiseAggregation = "plurality" | "bt-sigma";

export function buildReport(
  comparisons: readonly PairwiseComparison[],
  aggregation: PairwiseAggregation = "plurality",
): PairwiseReport {
  if (aggregation !== "plurality" && aggregation !== "bt-sigma") {
    throw new Error(
      `unknown aggregation '${String(aggregation)}'; expected 'plurality' or 'bt-sigma'`,
    );
  }
  const total = comparisons.length;
  const perJudge = new Map<string, PairwiseVote[]>();
  for (const comparison of comparisons) {
    for (const vote of comparison.votes) {
      perJudge.set(vote.model, [...(perJudge.get(vote.model) ?? []), vote]);
    }
  }
  const consistency = repetitionConsistency(comparisons);
  const consistencyRaw = repetitionConsistencyRaw(comparisons);
  const btSigma =
    aggregation === "bt-sigma" ? btSigmaAggregation(comparisons) : null;

  const judgeStats: JudgeStats[] = [...perJudge].map(([model, votes]) => {
    const count = (predicate: (v: PairwiseVote) => boolean) =>
      votes.filter(predicate).length;
    const sided = count((v) => v.vote === "A" || v.vote === "B");
    return {
      model,
      aRate: ratio(
        count((v) => v.vote === "A"),
        sided,
      ),
      bRate: ratio(
        count((v) => v.vote === "B"),
        sided,
      ),
      // Only over pairs where a flip was possible.
      positionBias:
        ratio(
          count((v) => v.flipped),
          count((v) => v.completed),
        ) ?? 0,
      tieRate: count((v) => v.vote === "tie") / votes.length,
      sigma: btSigma?.judgeSigmas[model] ?? null,
      consistency: consistency[model] ?? null,
      consistencyRaw: consistencyRaw[model] ?? null,
    };
  });

  // A lone decisive vote scores 1.0 exactly when the panel is most degraded.
  const agreements = comparisons.flatMap((c) => {
    const decisive = c.votes.flatMap((v) => v.vote ?? []);
    const value = decisive.length >= 2 ? agreementRate(decisive) : null;
    return value === null ? [] : [value];
  });

  return {
    comparisons: total,
    ...winnerRates(
      comparisons.map((c) => c.winner),
      total,
    ),
    meanAgreement: agreements.length > 0 ? mean(agreements) : null,
    perJudge: judgeStats,
    btSigma,
  };
}

function decisiveValue(vote: JuryVote | undefined): VerdictValue | null {
  if (!vote || !vote.success || vote.abstained) {
    return null;
  }
  if (!isPairwiseValue(vote.value)) {
    throw new Error(
      `pairwise judge returned '${String(vote.value)}'; expected 'A', 'B', or 'tie'`,
    );
  }
  return vote.value;
}

function isPairwiseValue(value: unknown): value is PairwiseVerdict {
  return value === "A" || value === "B" || value === "tie";
}

function reconciledExplanation(
  value: VerdictValue | null,
  first: JuryVote | undefined,
  second: JuryVote | undefined,
): string {
  if (value === null) {
    return "";
  }
  if (first?.explanation && decisiveValue(first) === value) {
    return first.explanation;
  }
  if (second?.explanation && unswap(decisiveValue(second)) === value) {
    return second.explanation;
  }
  return first?.explanation || second?.explanation || "";
}

interface PairwiseCall<S> {
  judgeFn: PairwiseJudgeFn<S>;
  responseA: S;
  responseB: S;
  repetitions: number;
  propagateErrors: boolean;
  juryContext: unknown;
}

type VotesByModel = Map<string, JuryVote>;

async function runPairwiseOrdering<S>(
  models: readonly string[],
  call: PairwiseCall<S>,
  swapped: boolean,
  replacement: boolean,
): Promise<{ votes: VotesByModel; usage: Usage | null }> {
  // The core, not runJury: one comparison owns one span across both orderings.
  // Stand-ins are promoted at the pair level so they get both orderings.
  const deliberation = await runJuryCore({
    judgeFn: (model) =>
      swapped
        ? call.judgeFn(call.responseB, call.responseA, model)
        : call.judgeFn(call.responseA, call.responseB, model),
    panel: models,
    repetitions: call.repetitions,
    minSuccessfulJudges: 1,
    propagateErrors: call.propagateErrors,
    labelSwapped: swapped,
    parentContext: call.juryContext,
    replacement,
  });
  return {
    votes: new Map(deliberation.jury.votes.map((v) => [v.model, v])),
    usage: deliberation.tokenUsage,
  };
}

async function runPairwiseBoth<S>(
  models: readonly string[],
  call: PairwiseCall<S>,
  swap: boolean,
  replacement = false,
): Promise<{ first: VotesByModel; second: VotesByModel; usages: Usage[] }> {
  if (!swap) {
    const { votes, usage } = await runPairwiseOrdering(
      models,
      call,
      false,
      replacement,
    );
    return { first: votes, second: new Map(), usages: usage ? [usage] : [] };
  }
  const [first, second] = await Promise.all([
    runPairwiseOrdering(models, call, false, replacement),
    runPairwiseOrdering(models, call, true, replacement),
  ]);
  return {
    first: first.votes,
    second: second.votes,
    usages: [first.usage, second.usage].filter((u) => u !== null),
  };
}

function pairwiseFailed(
  model: string,
  first: VotesByModel,
  second: VotesByModel,
  swap: boolean,
): boolean {
  if (!first.get(model)?.success) {
    return true;
  }
  return swap && !second.get(model)?.success;
}

function pairwiseObservations(
  model: string,
  first: VotesByModel,
  second: VotesByModel,
): { observations: RepetitionObservation[]; failures: number } {
  const observations: RepetitionObservation[] = [];
  let failures = 0;
  const orderings = [
    ["ab", first.get(model)],
    ["ba", second.get(model)],
  ] as const;
  for (const [ordering, juryVote] of orderings) {
    if (!juryVote) {
      continue;
    }
    failures += juryVote.repetitionsFailed;
    juryVote.repetitions.forEach((rep, repetition) => {
      const value = ordering === "ba" ? unswap(rep.value) : rep.value;
      let verdict: PairwiseVerdict | null = null;
      if (isPairwiseValue(value)) {
        verdict = value;
      } else if (value !== null) {
        // Off-contract must lower reliability, not pass as a free abstention.
        console.warn(
          `pairwise judge ${model} returned an off-contract repetition value '${String(value)}' on the ${ordering} ordering (repetition ${repetition}); counting it as a failure, not an abstention`,
        );
        failures += 1;
      }
      observations.push({
        ordering,
        repetition,
        verdict,
        explanation: rep.explanation,
        rawOutput: rep.rawOutput,
      });
    });
  }
  return { observations, failures };
}

function asVote(value: VerdictValue | null): PairwiseVerdict | null {
  if (value === null) {
    return null;
  }
  if (!isPairwiseValue(value)) {
    throw new Error(
      `pairwise vote '${String(value)}' outside the contract; expected 'A', 'B', or 'tie'`,
    );
  }
  return value;
}

export interface RunPairwiseOptions<S> {
  judgeFn: PairwiseJudgeFn<S>;
  panel: readonly string[];
  responseA: S;
  responseB: S;
  swap?: boolean;
  repetitions?: number;
  replacementJudges?: readonly string[] | null;
  minSuccessfulJudges?: number;
  propagateErrors?: boolean;
}

const INVALID_TRACE_ID = "0".repeat(32);

export async function runPairwise<S>(
  options: RunPairwiseOptions<S>,
): Promise<PairwiseComparison> {
  const {
    judgeFn,
    responseA,
    responseB,
    swap = true,
    repetitions = 1,
    replacementJudges,
    minSuccessfulJudges = 1,
    propagateErrors = false,
  } = options;
  const panel = resolvePanel(options.panel);

  return withSpan("orq.pairwise_jury", {}, async (span) => {
    const spanTraceId = span?.spanContext().traceId;
    const traceId =
      spanTraceId && spanTraceId !== INVALID_TRACE_ID ? spanTraceId : null;
    const call: PairwiseCall<S> = {
      judgeFn,
      responseA,
      responseB,
      repetitions,
      propagateErrors,
      juryContext: await captureParentContext(),
    };

    const started = performance.now();
    let first: VotesByModel;
    let second: VotesByModel;
    let usages: Usage[];
    let standIns: string[] = [];
    let judgeLatencyMs: number;
    try {
      ({ first, second, usages } = await runPairwiseBoth(panel, call, swap));
      const failed = panel.filter((m) =>
        pairwiseFailed(m, first, second, swap),
      ).length;
      const seen = new Set(panel);
      for (const candidate of replacementJudges ?? []) {
        if (candidate && !seen.has(candidate)) {
          standIns.push(candidate);
          seen.add(candidate);
        }
      }
      standIns = standIns.slice(0, failed);
      if (standIns.length > 0) {
        const stood = await runPairwiseBoth(standIns, call, swap, true);
        for (const [model, vote] of stood.first) {
          first.set(model, vote);
        }
        for (const [model, vote] of stood.second) {
          second.set(model, vote);
        }
        usages.push(...stood.usages);
      }
    } finally {
      judgeLatencyMs = performance.now() - started;
    }

    const standInSet = new Set(standIns);
    const votes: PairwiseVote[] = [...panel, ...standIns].map((model) => {
      const firstVote = first.get(model);
      const secondVote = second.get(model);
      const firstValue = decisiveValue(firstVote);
      let vote: VerdictValue | null = firstValue;
      let flipped = false;
      let completed = false;
      if (swap) {
        const secondValue = unswap(decisiveValue(secondVote));
        ({ vote, flipped } = reconcilePair(firstValue, secondValue));
        completed = firstValue !== null && secondValue !== null;
      }
      const { observations, failures } = pairwiseObservations(
        model,
        first,
        second,
      );
      return {
        model,
        vote: asVote(vote),
        flipped,
        completed,
        replacement: standInSet.has(model),
        explanation: reconciledExplanation(vote, firstVote, secondVote),
        observations,
        repetitionFailures: failures,
      };
    });

    const decisive = votes.flatMap((v) => v.vote ?? []);
    const comparison = PairwiseComparisonSchema.parse({
      winner:
        decisive.length < Math.max(1, minSuccessfulJudges)
          ? "inconclusive"
          : pairwiseConsensus(decisive),
      votes,
      tokenUsage: sumUsage(usages),
      judgeLatencyMs,
      traceId,
    });
    recordPairwiseSpan(span, comparison, {
      panelSize: panel.length,
      minSuccessfulJudges,
      swap,
    });
    return comparison;
  });
}

function recordPairwiseSpan(
  span: Span | undefined,
  comparison: PairwiseComparison,
  options: { panelSize: number; minSuccessfulJudges: number; swap: boolean },
): void {
  const flipped = comparison.votes.filter((v) => v.flipped).map((v) => v.model);
  const decisive = comparison.votes.flatMap((v) => v.vote ?? []);
  setSpanAttrs(span, {
    "jury.verdict": comparison.winner,
    "jury.aggregator": "pairwise_plurality",
    "jury.min_successful_judges": options.minSuccessfulJudges,
    "jury.raw_agreement": agreementRate(decisive),
    "jury.judges_configured": options.panelSize,
    "jury.judges_succeeded": decisive.length,
    // A flipped judge answered both times: position bias, not a failure.
    "jury.judges_failed": comparison.votes.filter(
      (v) => !v.replacement && v.vote === null && !v.flipped,
    ).length,
    "jury.replacements_used": comparison.votes.filter((v) => v.replacement)
      .length,
    "jury.inconclusive": comparison.winner === "inconclusive",
    "jury.flipped": flipped.length,
    "jury.flipped_judges": [...flipped].sort().join(",") || null,
    "jury.swap": options.swap,
  });
}
