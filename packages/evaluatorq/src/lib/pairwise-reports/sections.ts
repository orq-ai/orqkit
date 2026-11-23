import type { ReportSection } from "../contracts.js";
import { hasRepeatedOrdering, type PairwiseVote } from "../pairwise.js";
import type { PairwiseEntry, PairwiseRun } from "../pairwise-run.js";

export const POSITION_BIAS_WARN = 0.15;
// Compared with ">" where POSITION_BIAS_WARN uses ">=": exactly 10% inconclusive
// is not yet worth a warning, a bias of exactly 0.15 is.
export const INCONCLUSIVE_WARN = 0.1;

export interface ConsensusData extends Record<string, unknown> {
  labelA: string;
  labelB: string;
  aWinRate: number | null;
  bWinRate: number | null;
  tieRate: number | null;
  inconclusiveRate: number | null;
  meanAgreement: number | null;
  comparisons: number;
  decided: number;
  btSigma: {
    aWinRate: number | null;
    bWinRate: number | null;
    inconclusiveRate: number;
    fitWarnings: string[];
  } | null;
}

export interface JudgeRow {
  model: string;
  aRate: number | null;
  bRate: number | null;
  tieRate: number;
  positionBias: number | null;
  sigma: number | null;
  consistency: number | null;
  consistencyRaw: number | null;
  biased: boolean;
  measured: boolean;
  replacement: boolean;
}

export interface JudgesData extends Record<string, unknown> {
  labelA: string;
  labelB: string;
  swap: boolean;
  observedSwap: boolean;
  btSigma: boolean;
  observedConsistency: boolean;
  repeated: boolean;
  rows: JudgeRow[];
}

export interface ClassifyObservationView {
  ordering: string;
  repetition: number;
  choice: unknown;
  confidence: unknown;
  probabilities: Record<string, unknown> | null;
}

export interface VoteCell {
  model: string;
  vote: string | null;
  label: string;
  flipped: boolean;
  explanation: string;
  present: boolean;
  classifyObservations: ClassifyObservationView[];
}

export interface ComparisonRow {
  index: number;
  question: string;
  responseA: string;
  responseB: string;
  winner: string;
  winnerLabel: string;
  split: boolean;
  votes: VoteCell[];
}

export interface ComparisonsData extends Record<string, unknown> {
  labelA: string;
  labelB: string;
  judges: string[];
  rows: ComparisonRow[];
}

export function voteLabel(vote: unknown, run: PairwiseRun): string {
  if (vote === "A") {
    return run.labelA;
  }
  if (vote === "B") {
    return run.labelB;
  }
  return vote === "tie" ? "tie" : "abstained";
}

export function winnerLabel(winner: string, run: PairwiseRun): string {
  return winner === "inconclusive" ? "inconclusive" : voteLabel(winner, run);
}

export function isSplit(entry: PairwiseEntry): boolean {
  if (entry.comparison.winner === "inconclusive") {
    return true;
  }
  const decisive = new Set(
    entry.comparison.votes.flatMap((v) => (v.vote === null ? [] : [v.vote])),
  );
  return decisive.size > 1;
}

function buildConsensusSection(run: PairwiseRun): ReportSection {
  const report = run.rollup();
  const weighted = report.btSigma;
  const data: ConsensusData = {
    labelA: run.labelA,
    labelB: run.labelB,
    aWinRate: report.aWinRate,
    bWinRate: report.bWinRate,
    tieRate: report.tieRate,
    inconclusiveRate: report.inconclusiveRate,
    meanAgreement: report.meanAgreement,
    comparisons: report.comparisons,
    // Counted from entries: inverting the rates would depend on float round trips.
    decided: run.entries.filter(
      (e) => e.comparison.winner === "A" || e.comparison.winner === "B",
    ).length,
    btSigma: weighted
      ? {
          aWinRate: weighted.aWinRate,
          bWinRate: weighted.bWinRate,
          inconclusiveRate: weighted.inconclusiveRate,
          fitWarnings: [...weighted.fitWarnings],
        }
      : null,
  };
  return { kind: "pairwise_consensus", title: "Consensus", data };
}

/** `run.swap` is recorded intent; a completed vote proves both orderings really landed. */
export function observedSwap(run: PairwiseRun): boolean {
  return run.entries.some((e) => e.comparison.votes.some((v) => v.completed));
}

function buildJudgesSection(run: PairwiseRun): ReportSection {
  const report = run.rollup();
  const allVotes = run.entries.flatMap((e) => e.comparison.votes);
  const replacements = new Set(
    allVotes.filter((v) => v.replacement).map((v) => v.model),
  );
  // positionBias falls back to 0 with no completed pair, which would read as a steady judge.
  const measured = new Map(
    report.perJudge.map((stat) => [
      stat.model,
      allVotes.some((v) => v.completed && v.model === stat.model),
    ]),
  );
  const rows: JudgeRow[] = report.perJudge.map((stat) => {
    const isMeasured = measured.get(stat.model) === true;
    return {
      model: stat.model,
      aRate: stat.aRate,
      bRate: stat.bRate,
      tieRate: stat.tieRate,
      positionBias: isMeasured ? stat.positionBias : null,
      sigma: stat.sigma,
      consistency: stat.consistency,
      consistencyRaw: stat.consistencyRaw,
      biased: isMeasured && stat.positionBias >= POSITION_BIAS_WARN,
      measured: isMeasured,
      replacement: replacements.has(stat.model),
    };
  });
  const data: JudgesData = {
    labelA: run.labelA,
    labelB: run.labelB,
    swap: run.swap,
    observedSwap: [...measured.values()].some(Boolean),
    btSigma: report.btSigma !== null,
    observedConsistency: report.perJudge.some(
      (stat) => stat.consistency !== null,
    ),
    repeated: hasRepeatedOrdering(run.comparisons()),
    rows,
  };
  return { kind: "pairwise_judges", title: "Judges", data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyObservations(
  vote: PairwiseVote,
  run: PairwiseRun,
): ClassifyObservationView[] {
  const displayLabel = (
    label: unknown,
    ordering: string,
    disambiguate = false,
  ): unknown => {
    let shown = label;
    if (ordering === "ba") {
      if (shown === "A") {
        shown = "B";
      } else if (shown === "B") {
        shown = "A";
      }
    }
    if (shown === "A" || shown === "B") {
      return voteLabel(shown, run) + (disambiguate ? ` (${shown})` : "");
    }
    return shown;
  };

  const rendered: ClassifyObservationView[] = [];
  for (const observation of vote.observations) {
    const raw = observation.rawOutput;
    if (!raw || raw.type !== "choice") {
      continue;
    }
    const { probabilities } = raw;
    let choice = displayLabel(raw.choice, observation.ordering);
    let displayed: Record<string, unknown> | null = null;
    if (isRecord(probabilities)) {
      const labels: Record<string, string> = {};
      for (const key of Object.keys(probabilities)) {
        labels[key] = String(displayLabel(key, observation.ordering));
      }
      const originals = Object.values(labels);
      const occupied = new Set(originals);
      // Side names can collide with each other, "tie", or provider-added keys.
      for (const key of ["A", "B"]) {
        const current = labels[key];
        if (
          current === undefined ||
          originals.filter((label) => label === current).length < 2
        ) {
          continue;
        }
        const base = String(displayLabel(key, observation.ordering, true));
        let unique = base;
        let suffix = 2;
        while (occupied.has(unique)) {
          unique = `${base} ${suffix}`;
          suffix += 1;
        }
        labels[key] = unique;
        occupied.add(unique);
      }
      if (typeof raw.choice === "string") {
        choice = labels[raw.choice] ?? choice;
      }
      displayed = {};
      for (const [key, value] of Object.entries(probabilities)) {
        displayed[labels[key] as string] = value;
      }
    }
    rendered.push({
      ordering: observation.ordering,
      repetition: observation.repetition,
      choice,
      confidence: raw.confidence,
      probabilities: displayed,
    });
  }
  return rendered;
}

function voteCell(
  vote: PairwiseVote | undefined,
  model: string,
  run: PairwiseRun,
): VoteCell {
  if (!vote) {
    return {
      model,
      vote: null,
      label: "abstained",
      flipped: false,
      explanation: "",
      present: false,
      classifyObservations: [],
    };
  }
  return {
    model,
    vote: vote.vote,
    label: voteLabel(vote.vote, run),
    flipped: vote.flipped,
    explanation: vote.explanation,
    present: true,
    classifyObservations: classifyObservations(vote, run),
  };
}

/** The union, not the first row's votes: a replacement can appear partway through a run. */
export function judgeOrder(run: PairwiseRun): string[] {
  const order = [...run.judges];
  for (const entry of run.entries) {
    for (const vote of entry.comparison.votes) {
      if (!order.includes(vote.model)) {
        order.push(vote.model);
      }
    }
  }
  return order;
}

function buildComparisonsSection(run: PairwiseRun): ReportSection {
  const order = judgeOrder(run);
  const rows: ComparisonRow[] = run.entries.map((entry, index) => {
    const votes = new Map(entry.comparison.votes.map((v) => [v.model, v]));
    return {
      index: index + 1,
      question: entry.question,
      responseA: entry.responseA,
      responseB: entry.responseB,
      winner: entry.comparison.winner,
      winnerLabel: winnerLabel(entry.comparison.winner, run),
      split: isSplit(entry),
      votes: order.map((model) => voteCell(votes.get(model), model, run)),
    };
  });
  const data: ComparisonsData = {
    labelA: run.labelA,
    labelB: run.labelB,
    judges: order,
    rows,
  };
  return { kind: "pairwise_comparisons", title: "Comparisons", data };
}

export function buildReportSections(run: PairwiseRun): ReportSection[] {
  return [
    buildConsensusSection(run),
    buildJudgesSection(run),
    buildComparisonsSection(run),
  ];
}
