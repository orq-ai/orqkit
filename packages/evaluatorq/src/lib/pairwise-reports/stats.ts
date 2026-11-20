import { compensatedSum, exactSum, pythonFixed } from "../common/jury.js";
import type { Usage } from "../contracts.js";
import type { PairwiseEntry, PairwiseRun } from "../pairwise-run.js";
import { isSplit, observedSwap, POSITION_BIAS_WARN } from "./sections.js";

export type Tone = "good" | "warn" | "";

const CATEGORIES = ["A", "B", "tie"];
export const DECIDED_GOOD = 0.7;
export const THROWN_OUT_WARN = 0.1;

const percent = (value: number): string => `${pythonFixed(value * 100, 0)}%`;

export function wilsonInterval(
  k: number,
  n: number,
  z = 1.96,
): { low: number; high: number } {
  if (n === 0) {
    return { low: 0, high: 1 };
  }
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function outcomeCounts(
  run: PairwiseRun,
): Record<"A" | "B" | "tie" | "inconclusive", number> {
  const counts = { A: 0, B: 0, tie: 0, inconclusive: 0 };
  for (const entry of run.entries) {
    const winner = entry.comparison.winner;
    if (winner in counts) {
      counts[winner as keyof typeof counts] += 1;
    }
  }
  return counts;
}

export interface Verdict {
  state: "clear" | "too_close" | "no_decided";
  leader: "A" | "B" | null;
  leaderLabel: string | null;
  winsA: number;
  winsB: number;
  ties: number;
  inconclusive: number;
  decided: number;
  total: number;
  winRate: number | null;
  low: number | null;
  high: number | null;
}

export function verdict(run: PairwiseRun): Verdict {
  const counts = outcomeCounts(run);
  const decided = counts.A + counts.B;
  const base = {
    winsA: counts.A,
    winsB: counts.B,
    ties: counts.tie,
    inconclusive: counts.inconclusive,
    decided,
    total: run.entries.length,
  };
  if (decided === 0) {
    return {
      ...base,
      state: "no_decided",
      leader: null,
      leaderLabel: null,
      winRate: null,
      low: null,
      high: null,
    };
  }
  const leader = counts.A > counts.B ? "A" : counts.B > counts.A ? "B" : null;
  const k = Math.max(counts.A, counts.B);
  const { low, high } = wilsonInterval(k, decided);
  let leaderLabel: string | null = null;
  if (leader !== null) {
    leaderLabel = leader === "A" ? run.labelA : run.labelB;
  }
  return {
    ...base,
    state: leader !== null && low > 0.5 ? "clear" : "too_close",
    leader,
    leaderLabel,
    winRate: k / decided,
    low,
    high,
  };
}

export function fleissKappa(run: PairwiseRun): {
  kappa: number | null;
  rows: number;
} {
  const judges = [...run.judges];
  const n = judges.length;
  if (n < 2) {
    return { kappa: null, rows: 0 };
  }
  const rows: Map<string, number>[] = [];
  for (const entry of run.entries) {
    const votes = new Map<string, string | null>();
    const duplicates = new Set<string>();
    for (const vote of entry.comparison.votes) {
      if (vote.replacement || !judges.includes(vote.model)) {
        continue;
      }
      if (votes.has(vote.model)) {
        duplicates.add(vote.model);
      } else {
        votes.set(vote.model, vote.vote);
      }
    }
    if (
      judges.every((j) => (votes.get(j) ?? null) !== null && !duplicates.has(j))
    ) {
      const counter = new Map<string, number>();
      for (const j of judges) {
        const value = votes.get(j) as string;
        counter.set(value, (counter.get(value) ?? 0) + 1);
      }
      rows.push(counter);
    }
  }
  if (rows.length === 0) {
    return { kappa: null, rows: 0 };
  }
  const count = (row: Map<string, number>, key: string): number =>
    row.get(key) ?? 0;
  const perRow = rows.map((row) => {
    let squares = 0;
    for (const key of CATEGORIES) {
      squares += count(row, key) ** 2;
    }
    return (squares - n) / (n * (n - 1));
  });
  const pBar = compensatedSum(perRow) / rows.length;
  const pE = compensatedSum(
    CATEGORIES.map((key) => {
      let total = 0;
      for (const row of rows) {
        total += count(row, key);
      }
      return (total / (rows.length * n)) ** 2;
    }),
  );
  if (pE >= 1) {
    return { kappa: null, rows: rows.length };
  }
  return { kappa: (pBar - pE) / (1 - pE), rows: rows.length };
}

export function kappaLabel(k: number): string {
  if (k < 0) {
    return "poor";
  }
  const bands: [number, string][] = [
    [0.2, "slight"],
    [0.4, "fair"],
    [0.6, "moderate"],
    [0.8, "substantial"],
  ];
  for (const [cut, name] of bands) {
    if (k < cut) {
      return name;
    }
  }
  return "almost perfect";
}

export interface LengthLean {
  longerWins: number;
  compared: number;
}

const characters = (text: string): number => Array.from(text).length;

export function lengthLean(run: PairwiseRun): LengthLean | null {
  let compared = 0;
  let longerWins = 0;
  for (const entry of run.entries) {
    const winner = entry.comparison.winner;
    const lengthA = characters(entry.responseA);
    const lengthB = characters(entry.responseB);
    if ((winner !== "A" && winner !== "B") || lengthA === lengthB) {
      continue;
    }
    compared += 1;
    if ((winner === "A") === lengthA > lengthB) {
      longerWins += 1;
    }
  }
  return compared ? { longerWins, compared } : null;
}

export interface ComparisonFlags {
  split: boolean;
  thrownOut: boolean;
  judgeFailed: boolean;
}

export function comparisonFlags(
  entry: PairwiseEntry,
  judges: readonly string[],
): ComparisonFlags {
  const { votes } = entry.comparison;
  const present = new Set(votes.map((v) => v.model));
  return {
    split: isSplit(entry),
    thrownOut: votes.some((v) => v.flipped),
    judgeFailed:
      votes.some((v) => v.repetitionFailures > 0) ||
      judges.some((j) => !present.has(j)),
  };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number | null;
  costRecorded: number;
  costPartial: boolean;
  costComplete: boolean;
  withUsage: number;
}

function pricingIsIncomplete(usage: Usage): boolean {
  return usage.calls <= 0 || usage.pricedCalls !== usage.calls;
}

export function judgeUsage(run: PairwiseRun): UsageTotals {
  const usages = run.entries.flatMap((e) =>
    e.comparison.tokenUsage ? [e.comparison.tokenUsage] : [],
  );
  const costs = usages.flatMap((u) =>
    u.totalCost === null || u.totalCost === undefined ? [] : [u.totalCost],
  );
  const costRecorded = costs.length;
  const costPartial =
    usages.some(pricingIsIncomplete) || costRecorded < run.entries.length;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const usage of usages) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens || usage.inputTokens + usage.outputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cost: costs.length ? exactSum(costs) : null,
    costRecorded,
    costPartial,
    costComplete:
      run.entries.length > 0 &&
      costRecorded === run.entries.length &&
      !costPartial,
    withUsage: usages.length,
  };
}

export interface GenerationMetrics {
  aCost: number | null;
  bCost: number | null;
  aCostRecorded: number;
  bCostRecorded: number;
  aCostPartial: boolean;
  bCostPartial: boolean;
  aLatencyMs: number | null;
  bLatencyMs: number | null;
  aLatencyRecorded: number;
  bLatencyRecorded: number;
  pairedCostEntries: number;
  pairedLatencyEntries: number;
}

export function generationMetrics(run: PairwiseRun): GenerationMetrics {
  const costs: [number[], number[]] = [[], []];
  const partial = [false, false];
  const latencies: [number[], number[]] = [[], []];
  let pairedCost = 0;
  let pairedLatency = 0;
  for (const entry of run.entries) {
    const pair = [entry.metricsA, entry.metricsB];
    pair.forEach((metrics, side) => {
      if (!metrics) {
        return;
      }
      const cost = metrics.usage?.totalCost;
      if (metrics.usage && cost !== null && cost !== undefined) {
        costs[side as 0 | 1].push(cost);
        partial[side] = partial[side] || pricingIsIncomplete(metrics.usage);
      }
      if (metrics.latencyMs !== null) {
        latencies[side as 0 | 1].push(metrics.latencyMs);
      }
    });
    if (
      pair.every(
        (metrics) =>
          metrics?.usage &&
          metrics.usage.totalCost !== null &&
          metrics.usage.totalCost !== undefined &&
          !pricingIsIncomplete(metrics.usage),
      )
    ) {
      pairedCost += 1;
    }
    if (pair.every((metrics) => metrics && metrics.latencyMs !== null)) {
      pairedLatency += 1;
    }
  }
  const total = run.entries.length;
  return {
    aCost: costs[0].length ? exactSum(costs[0]) : null,
    bCost: costs[1].length ? exactSum(costs[1]) : null,
    aCostRecorded: costs[0].length,
    bCostRecorded: costs[1].length,
    aCostPartial: partial[0] === true || costs[0].length < total,
    bCostPartial: partial[1] === true || costs[1].length < total,
    aLatencyMs: latencies[0].length ? exactSum(latencies[0]) : null,
    bLatencyMs: latencies[1].length ? exactSum(latencies[1]) : null,
    aLatencyRecorded: latencies[0].length,
    bLatencyRecorded: latencies[1].length,
    pairedCostEntries: pairedCost,
    pairedLatencyEntries: pairedLatency,
  };
}

export interface TrustSignal {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}

function agreementSignal(run: PairwiseRun): TrustSignal {
  const { kappa, rows } = fleissKappa(run);
  const label = "Judge agreement";
  if (kappa === null && rows) {
    return {
      label,
      value: "undefined",
      detail: `every judge chose the same outcome on all ${rows} included comparisons, so agreement is undefined`,
      tone: "",
    };
  }
  if (kappa === null) {
    return {
      label,
      value: "not measurable",
      detail: "needs two or more judges voting on the same comparison",
      tone: "",
    };
  }
  return {
    label,
    value: `κ ${pythonFixed(kappa, 2)}`,
    detail: `${kappaLabel(kappa)}, 1 = every judge agreed, over ${rows} full-panel comparisons`,
    tone: "",
  };
}

function lengthSignal(run: PairwiseRun): TrustSignal {
  const lean = lengthLean(run);
  if (!lean) {
    return {
      label: "Length",
      value: "not measurable",
      detail: "no decided comparison had answers of different length",
      tone: "",
    };
  }
  const longer = lean.longerWins * 2 >= lean.compared;
  const wins = longer ? lean.longerWins : lean.compared - lean.longerWins;
  const word = longer ? "longer" : "shorter";
  const { low, high } = wilsonInterval(wins, lean.compared);
  const base = `${wins} of ${lean.compared} decided comparisons with answers of different length`;
  const range = `95% range ${percent(low)} to ${percent(high)}`;
  const clear = low > 0.5;
  return {
    label: "Length",
    value: `${word} won ${percent(wins / lean.compared)}`,
    detail: clear
      ? `${base}; ${range}; judges may favour ${word} answers`
      : `${base}; ${range} includes 50%, so it could be chance`,
    tone: clear ? "warn" : "",
  };
}

export function trustSignals(run: PairwiseRun): TrustSignal[] {
  const total = run.entries.length;
  const summary = verdict(run);
  const share = total ? summary.decided / total : 0;
  const out: TrustSignal[] = [
    {
      label: "Decided",
      value: `${summary.decided} of ${total} (${percent(share)})`,
      detail: "comparisons had a winner",
      tone: share >= DECIDED_GOOD ? "good" : "warn",
    },
  ];
  const votes = run.entries.flatMap((e) => e.comparison.votes);
  const flipped = votes.filter((vote) => vote.flipped).length;
  const thrown = votes.length ? flipped / votes.length : 0;
  out.push({
    label: "Votes thrown out",
    value: `${percent(thrown)} (${flipped}/${votes.length})`,
    detail: "flipped when the sides were swapped",
    tone: thrown > THROWN_OUT_WARN ? "warn" : "",
  });
  out.push(agreementSignal(run));
  if (observedSwap(run)) {
    const report = run.rollup();
    const measured = new Set(
      votes.filter((vote) => vote.completed).map((vote) => vote.model),
    );
    const stats = report.perJudge.filter((s) => measured.has(s.model));
    const flagged = stats.filter((s) => s.positionBias >= POSITION_BIAS_WARN);
    out.push({
      label: "Position bias",
      value: `${flagged.length} of ${stats.length} judges`,
      detail: `flagged at a flip rate of ${POSITION_BIAS_WARN} or more`,
      tone: flagged.length ? "warn" : "good",
    });
  }
  out.push(lengthSignal(run));
  let failures = 0;
  for (const vote of votes) {
    failures += vote.repetitionFailures;
  }
  out.push({
    label: "Judge failures",
    value: String(failures),
    detail: "judge passes failed or returned an unusable answer",
    tone: failures ? "warn" : "good",
  });
  return out;
}
