import { SEVERITY_ORDER } from "../common/reports/palette.js";
import { TURN_METRICS } from "../integrations/simulation/metrics.js";
import type { SimulationResult } from "../integrations/simulation/types.js";
import { judgeOrder } from "../pairwise-reports/sections.js";
import { comparisonFlags } from "../pairwise-reports/stats.js";
import type { PairwiseEntry, PairwiseRun } from "../pairwise-run.js";
import { deliveryMethodStr } from "../redteam/delivery-method-registry.js";
import type {
  RedTeamReport,
  RedTeamResult,
} from "../redteam/reports/models.js";

export type Selections = Record<string, string[]>;

export interface FilterDef {
  dimensions: readonly string[];
  // biome-ignore lint/suspicious/noExplicitAny: each surface passes its own run type
  options: (obj: any) => Record<string, string[]>;
  // biome-ignore lint/suspicious/noExplicitAny: each surface passes its own run type
  apply: (obj: any, sel: Selections) => unknown[];
  // biome-ignore lint/suspicious/noExplicitAny: each surface passes its own run type
  results: (obj: any) => unknown[];
}

const sel = (s: Selections, key: string, fallback: string[]): string[] => {
  const v = s[key];
  return v && v.length > 0 ? v : fallback;
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

const sortedUnique = (xs: Iterable<string>): string[] =>
  [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const pyInt = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^\s*[+-]?\d+\s*$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
};

const pyFloat = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  if (
    t === "" ||
    !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^[+-]?(inf|infinity|nan)$/.test(t)
  )
    return null;
  if (t.endsWith("nan")) return Number.NaN;
  if (t.endsWith("inf") || t.endsWith("infinity"))
    return t.startsWith("-") ? -Infinity : Infinity;
  return Number(t);
};

const REDTEAM_DIMS = [
  "result",
  "severity",
  "min_turns",
  "category",
  "agent",
  "technique",
  "delivery_method",
  "vulnerability",
] as const;

const RESULT_CLASSES = ["Vulnerable", "Resistant", "Not evaluated", "Error"];

const rtAgent = (r: RedTeamResult): string =>
  r.agent.key || r.agent.displayName || "unknown";
const rtTurns = (r: RedTeamResult): number =>
  r.execution ? r.execution.turns : 1;

function rtOptions(report: RedTeamReport): Record<string, string[]> {
  const results = report.results;
  const maxTurns = results.length ? Math.max(...results.map(rtTurns)) : 1;
  return {
    result: [...RESULT_CLASSES],
    agent: sortedUnique(results.map(rtAgent)),
    category: sortedUnique(results.map((r) => r.attack.category)),
    severity: SEVERITY_ORDER.filter((s) =>
      results.some((r) => r.attack.severity === s),
    ),
    technique: sortedUnique(results.map((r) => r.attack.attackTechnique)),
    delivery_method: sortedUnique(
      results.flatMap((r) =>
        (r.attack.deliveryMethods ?? []).map(deliveryMethodStr),
      ),
    ),
    vulnerability: sortedUnique(
      results.map((r) => r.attack.vulnerability).filter(Boolean),
    ),
    max_turns: [String(maxTurns)],
  };
}

export function rtResultClass(r: RedTeamResult): string {
  if (r.error) return "Error";
  if (r.vulnerable === null || r.vulnerable === undefined)
    return "Not evaluated";
  return r.vulnerable ? "Vulnerable" : "Resistant";
}

function rtApply(report: RedTeamReport, s: Selections): RedTeamResult[] {
  let results = [...report.results];
  const full = rtOptions(report);
  const resultSel = s.result ?? [];
  const chosen = new Set(resultSel);
  const mt = s.min_turns ?? ["1"];
  const minTurns = mt.length ? (pyInt(mt[0]) ?? 1) : 1;
  const allCat = full.category ?? [];
  const selCat = sel(s, "category", allCat);
  const allSev = full.severity ?? [];
  const selSev = sel(s, "severity", allSev);
  const allTech = full.technique ?? [];
  const selTech = sel(s, "technique", allTech);
  const allDel = full.delivery_method ?? [];
  const selDel = allDel.length ? sel(s, "delivery_method", allDel) : [];
  const allVul = full.vulnerability ?? [];
  const selVul = allVul.length ? sel(s, "vulnerability", allVul) : [];
  const allAgents = full.agent ?? [];
  const selAgents = allAgents.length > 1 ? sel(s, "agent", allAgents) : [];

  const filters: [boolean, (r: RedTeamResult) => boolean][] = [
    [
      resultSel.length > 0 && !sameSet([...chosen], RESULT_CLASSES),
      (r) => chosen.has(rtResultClass(r)),
    ],
    [minTurns > 1, (r) => rtTurns(r) >= minTurns],
    [!sameSet(selCat, allCat), (r) => selCat.includes(r.attack.category)],
    [!sameSet(selSev, allSev), (r) => selSev.includes(r.attack.severity)],
    [
      !sameSet(selTech, allTech),
      (r) => selTech.includes(r.attack.attackTechnique),
    ],
    [
      allDel.length > 0 && !sameSet(selDel, allDel),
      (r) =>
        (r.attack.deliveryMethods ?? []).some((dm) =>
          selDel.includes(deliveryMethodStr(dm)),
        ),
    ],
    [
      allVul.length > 0 && !sameSet(selVul, allVul),
      (r) => selVul.includes(r.attack.vulnerability),
    ],
    [
      allAgents.length > 1 && !sameSet(selAgents, allAgents),
      (r) => selAgents.includes(rtAgent(r)),
    ],
  ];
  for (const [on, pred] of filters) if (on) results = results.filter(pred);
  return results;
}

export function simMetricDimKey(key: string, highIsRisky: boolean): string {
  return highIsRisky ? `min_${key}` : `max_${key}`;
}

const SIM_DIMS = [
  "persona",
  "scenario",
  "terminated_by",
  "goal_outcome",
  "rule_broken",
  "max_goal_score",
  "min_turns",
  "min_total_tokens",
  ...TURN_METRICS.map((m) => simMetricDimKey(m.key, m.highIsRisky)),
];

interface SimRun {
  results: SimulationResult[];
}

const pyStr = (v: unknown): string =>
  v === undefined
    ? "unknown"
    : v === null
      ? "None"
      : v === true
        ? "True"
        : v === false
          ? "False"
          : String(v);
const meta = (r: SimulationResult, key: string): string =>
  pyStr(Object.hasOwn(r.metadata, key) ? r.metadata[key] : undefined);

const clampScore = (raw: string | undefined): number | null => {
  const v = pyFloat(raw);
  return v === null ? null : Math.max(0, Math.min(1, v));
};

const positiveInt = (raw: string | undefined): number | null => {
  const v = pyInt(raw);
  return v !== null && v > 0 ? v : null;
};

function simMultiselect(results: SimulationResult[]): Record<string, string[]> {
  return {
    persona: sortedUnique(results.map((r) => meta(r, "persona"))),
    scenario: sortedUnique(results.map((r) => meta(r, "scenario"))),
    terminated_by: sortedUnique(results.map((r) => r.terminated_by)),
    goal_outcome: ["Achieved", "Not achieved"],
  };
}

function simOptions(run: SimRun): Record<string, string[]> {
  const rs = run.results;
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  return {
    ...simMultiselect(rs),
    max_turns: [String(max(rs.map((r) => r.turn_count)))],
    max_total_tokens: [String(max(rs.map((r) => r.token_usage.total_tokens)))],
    metrics: TURN_METRICS.filter((m) =>
      rs.some((r) => r.turn_metrics.some((tm) => tm[m.key] != null)),
    ).map((m) => m.key),
  };
}

function simMetricKeeps(
  r: SimulationResult,
  m: (typeof TURN_METRICS)[number],
  threshold: number,
): boolean {
  const values = r.turn_metrics
    .map((tm) => tm[m.key])
    .filter((v): v is number => v != null);
  if (!values.length) return true;
  return m.highIsRisky
    ? Math.max(...values) >= threshold
    : Math.min(...values) <= threshold;
}

function simApply(run: SimRun, s: Selections): SimulationResult[] {
  let results = [...run.results];
  const full = simMultiselect(run.results);
  const allP = full.persona ?? [];
  const selP = sel(s, "persona", allP);
  const allS = full.scenario ?? [];
  const selS = sel(s, "scenario", allS);
  const allT = full.terminated_by ?? [];
  const selT = sel(s, "terminated_by", allT);
  const goalSel = (s.goal_outcome ?? []).filter(
    (v) => v === "Achieved" || v === "Not achieved",
  );
  const want = goalSel.length === 1 ? goalSel[0] === "Achieved" : false;
  const gs = s.max_goal_score ?? [];
  const goalMax = gs.length ? clampScore(gs[0]) : null;
  const ts = s.min_turns ?? [];
  const minTurns = ts.length ? positiveInt(ts[0]) : null;
  const tk = s.min_total_tokens ?? [];
  const minTokens = tk.length ? positiveInt(tk[0]) : null;

  const filters: [boolean, (r: SimulationResult) => boolean][] = [
    [!sameSet(selP, allP), (r) => selP.includes(meta(r, "persona"))],
    [!sameSet(selS, allS), (r) => selS.includes(meta(r, "scenario"))],
    [!sameSet(selT, allT), (r) => selT.includes(r.terminated_by)],
    [goalSel.length === 1, (r) => Boolean(r.goal_achieved) === want],
    [(s.rule_broken ?? []).includes("yes"), (r) => r.rules_broken.length > 0],
    [goalMax !== null, (r) => r.goal_completion_score <= (goalMax as number)],
    [minTurns !== null, (r) => r.turn_count >= (minTurns as number)],
    [
      minTokens !== null,
      (r) => r.token_usage.total_tokens >= (minTokens as number),
    ],
  ];
  for (const m of TURN_METRICS) {
    const ms = s[simMetricDimKey(m.key, m.highIsRisky)] ?? [];
    if (!ms.length) continue;
    const threshold = clampScore(ms[0]);
    if (threshold === null) continue;
    filters.push([true, (r) => simMetricKeeps(r, m, threshold)]);
  }
  for (const [on, pred] of filters) if (on) results = results.filter(pred);
  return results;
}

const PAIRWISE_DIMS = [
  "winner",
  "split",
  "thrown_out",
  "judge_failed",
  "judge",
];

function pairwiseWinnerLabels(run: PairwiseRun): [string, string][] {
  let a = run.labelA;
  let b = run.labelB;
  if (new Set([a, b, "tie", "inconclusive"]).size < 4) {
    a = "A";
    b = "B";
  }
  return [
    [a, "A"],
    [b, "B"],
    ["tie", "tie"],
    ["inconclusive", "inconclusive"],
  ];
}

function pairwiseOptions(run: PairwiseRun): Record<string, string[]> {
  return {
    winner: pairwiseWinnerLabels(run).map(([label]) => label),
    judge: judgeOrder(run),
  };
}

function pairwiseApply(run: PairwiseRun, s: Selections): PairwiseEntry[] {
  const winners = pairwiseWinnerLabels(run);
  const picked = sel(s, "winner", []);
  const winnerKeys = new Set(
    winners.filter(([label]) => picked.includes(label)).map(([, key]) => key),
  );
  const narrowWinner = winnerKeys.size > 0 && winnerKeys.size < winners.length;
  const order = judgeOrder(run);
  const judges = new Set((s.judge ?? []).filter((j) => order.includes(j)));
  const narrowJudge = judges.size > 0 && judges.size < order.length;
  const wantSplit = (s.split ?? []).includes("yes");
  const wantThrown = (s.thrown_out ?? []).includes("yes");
  const wantFailed = (s.judge_failed ?? []).includes("yes");

  return run.entries.filter((entry) => {
    const c = entry.comparison;
    if (narrowWinner && !winnerKeys.has(c.winner)) return false;
    if (
      narrowJudge &&
      !c.votes.some((v) => judges.has(v.model) && v.vote != null)
    )
      return false;
    if (wantSplit || wantThrown || wantFailed) {
      const f = comparisonFlags(entry, run.judges);
      if (
        (wantSplit && !f.split) ||
        (wantThrown && !f.thrownOut) ||
        (wantFailed && !f.judgeFailed)
      )
        return false;
    }
    return true;
  });
}

export const FILTERS: Readonly<Record<string, FilterDef>> = {
  redteam: {
    dimensions: REDTEAM_DIMS,
    options: rtOptions,
    apply: rtApply,
    results: (r: RedTeamReport) => [...r.results],
  },
  sim: {
    dimensions: SIM_DIMS,
    options: simOptions,
    apply: simApply,
    results: (r: SimRun) => [...r.results],
  },
  pairwise: {
    dimensions: PAIRWISE_DIMS,
    options: pairwiseOptions,
    apply: pairwiseApply,
    results: (r: PairwiseRun) => [...r.entries],
  },
};

export function applyOrAll(
  // biome-ignore lint/suspicious/noExplicitAny: any surface's run object
  reportObj: any,
  surface: string,
  selections: Selections,
): unknown[] {
  const def = FILTERS[surface];
  if (!def) return [...reportObj.results];
  if (Object.keys(selections).length === 0) return def.results(reportObj);
  return def.apply(reportObj, selections);
}

export function parseSelections(
  query: URLSearchParams,
  surface: string,
): Selections {
  const def = FILTERS[surface];
  if (!def) return {};
  const out: Selections = {};
  for (const dim of def.dimensions) {
    const vals = query.getAll(dim);
    if (vals.length) out[dim] = vals;
  }
  return out;
}
