import { loadTypedReport } from "../common/dashboard/library.js";
import { compensatedSum } from "../common/jury.js";
import { pairIndicesByKey } from "../common/matching.js";
import { esc, kpiCards, pct } from "../common/reports/html-helpers.js";
import { pyFixed, pyPercent } from "../common/reports/number-format.js";
import { COLORS } from "../common/reports/palette.js";
import {
  renderTranscriptFragment,
  type SimulationEntryView,
} from "../common/reports/sim-detail.js";
import {
  renderSvg,
  type VegaSpec,
  vlBarH,
  vlGroupedBar,
} from "../common/reports/vega.js";
import { codepointCompare } from "../common/sanitize.js";
import type { ReportResult } from "../integrations/simulation/reports/helpers.js";
import { simulationIndividualEntries } from "../integrations/simulation/reports/sections.js";
import type { SimulationRun } from "../integrations/simulation/run-store.js";
import { cliSlugRenderScope } from "./orq-workspace.js";
import { page } from "./shell.js";
import { panel, reportBackLink } from "./view.js";

export type SimCompareEntry = SimulationEntryView & {
  goal_completion_score: number;
};

export const simCompareRuntime = {
  renderSvg: (spec: VegaSpec): Promise<string> => renderSvg(spec),
  renderTranscriptFragment: (
    entry: SimCompareEntry,
  ): string | Promise<string> => renderTranscriptFragment(entry),
};

const UP = COLORS.success_400;
const DOWN = COLORS.red_400;

export type KpiKind = "rate" | "score" | "turns" | "count";

export interface KpiRow {
  label: string;
  a: number | null;
  b: number | null;
  kind: KpiKind;
}

export function kpiDelta(row: KpiRow): number | null {
  return row.a === null || row.b === null ? null : row.b - row.a;
}

const mean = (values: readonly number[]): number | null =>
  values.length ? compensatedSum(values) / values.length : null;

const signed = (text: string): string =>
  text.startsWith("-") ? text : `+${text}`;

function counter(entries: readonly SimCompareEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries)
    counts.set(e.terminated_by, (counts.get(e.terminated_by) ?? 0) + 1);
  return counts;
}

const sortedUnion = (...keys: Iterable<string>[]): string[] =>
  [...new Set(keys.flatMap((k) => [...k]))].sort(codepointCompare);

export function compareKpis(
  entriesA: readonly SimCompareEntry[],
  entriesB: readonly SimCompareEntry[],
  runA: Pick<SimulationRun, "scorerAverages">,
  runB: Pick<SimulationRun, "scorerAverages">,
): KpiRow[] {
  const goal = (es: readonly SimCompareEntry[]) =>
    mean(es.map((e) => (e.goal_achieved ? 1 : 0)));
  const rows: KpiRow[] = [
    {
      label: "Conversations",
      a: entriesA.length,
      b: entriesB.length,
      kind: "count",
    },
    {
      label: "Goal-achieved rate",
      a: goal(entriesA),
      b: goal(entriesB),
      kind: "rate",
    },
    {
      label: "Mean goal score",
      a: mean(entriesA.map((e) => e.goal_completion_score)),
      b: mean(entriesB.map((e) => e.goal_completion_score)),
      kind: "score",
    },
    {
      label: "Mean turns",
      a: mean(entriesA.map((e) => e.turn_count)),
      b: mean(entriesB.map((e) => e.turn_count)),
      kind: "turns",
    },
  ];
  const saA = runA.scorerAverages ?? {};
  const saB = runB.scorerAverages ?? {};
  for (const key of sortedUnion(Object.keys(saA), Object.keys(saB)))
    rows.push({
      label: `Scorer: ${key}`,
      a: saA[key] ?? null,
      b: saB[key] ?? null,
      kind: "score",
    });
  const tbA = counter(entriesA);
  const tbB = counter(entriesB);
  for (const label of sortedUnion(tbA.keys(), tbB.keys()))
    rows.push({
      label: `Terminated: ${label}`,
      a: tbA.get(label) ?? 0,
      b: tbB.get(label) ?? 0,
      kind: "count",
    });
  return rows;
}

function fmt(value: number | null, kind: KpiKind): string {
  if (value === null) return "n/a";
  if (kind === "rate") return `${pyFixed(value * 100, 0)}%`;
  if (kind === "score") return pyFixed(value, 2);
  if (kind === "turns") return pyFixed(value, 1);
  return pyFixed(value, 0);
}

function fmtDelta(row: KpiRow): string {
  const d = kpiDelta(row);
  if (d === null) return '<span class="cmp-delta cmp-flat">\u2014</span>';
  if (Math.abs(d) < 1e-9) return '<span class="cmp-delta cmp-flat">0</span>';
  const arrow = d > 0 ? "&#x25B2;" : "&#x25BC;";
  const cls = d > 0 ? "cmp-up" : "cmp-down";
  let body: string;
  if (row.kind === "rate") body = `${signed(pyFixed(d * 100, 0))}%`;
  else if (row.kind === "score") body = signed(pyFixed(d, 2));
  else if (row.kind === "turns") body = signed(pyFixed(d, 1));
  else body = signed(pyFixed(d, 0));
  return `<span class="cmp-delta ${cls}">${arrow} ${body}</span>`;
}

export interface Matching {
  matched: { a: SimCompareEntry; b: SimCompareEntry }[];
  aOnly: SimCompareEntry[];
  bOnly: SimCompareEntry[];
}

export function matchRate(m: Matching): number {
  const total = 2 * m.matched.length + m.aOnly.length + m.bOnly.length;
  return total ? (2 * m.matched.length) / total : 0;
}

export function matchEntries(
  entriesA: readonly SimCompareEntry[],
  entriesB: readonly SimCompareEntry[],
): Matching {
  const { matched, aOnly, bOnly } = pairIndicesByKey(entriesA, entriesB, (e) =>
    JSON.stringify([e.persona, e.scenario]),
  );
  return {
    matched: matched.map(([i, j]) => ({
      a: entriesA[i] as SimCompareEntry,
      b: entriesB[j] as SimCompareEntry,
    })),
    aOnly: aOnly.map((i) => entriesA[i] as SimCompareEntry),
    bOnly: bOnly.map((i) => entriesB[i] as SimCompareEntry),
  };
}

export function simCompareEntries(
  run: Pick<SimulationRun, "results">,
): SimCompareEntry[] {
  return simulationIndividualEntries(
    run.results as unknown as ReportResult[],
  ) as unknown as SimCompareEntry[];
}

function agg(
  entries: readonly SimCompareEntry[],
): [number | null, number | null, number | null] {
  return [
    mean(entries.map((e) => (e.goal_achieved ? 1 : 0))),
    mean(entries.map((e) => e.goal_completion_score)),
    mean(entries.map((e) => e.turn_count)),
  ];
}

function dirStatus(delta: number, higherBetter: boolean): string {
  if (Math.abs(delta) < 1e-9) return "neutral";
  const good = higherBetter ? delta > 0 : delta < 0;
  return good ? "pass" : "fail";
}

function kpiBand(
  entriesA: readonly SimCompareEntry[],
  entriesB: readonly SimCompareEntry[],
): string {
  const [rateA, scoreA, turnsA] = agg(entriesA);
  const [rateB, scoreB, turnsB] = agg(entriesB);
  const rateDelta = rateA !== null && rateB !== null ? rateB - rateA : null;
  const scoreDelta =
    scoreA !== null && scoreB !== null ? scoreB - scoreA : null;
  const turnsDelta =
    turnsA !== null && turnsB !== null ? turnsB - turnsA : null;
  const rateText = rateDelta === null ? "n/a" : signed(pyPercent(rateDelta));
  const scoreText =
    scoreDelta === null ? "n/a" : signed(pyFixed(scoreDelta, 2));
  const turnsText =
    turnsDelta === null ? "n/a" : signed(pyFixed(turnsDelta, 1));
  return kpiCards([
    {
      label: `Goal-achieved · ${rateText} vs A`,
      value: pct(rateB),
      status: rateDelta === null ? "neutral" : dirStatus(rateDelta, true),
    },
    {
      label: `Mean score · ${scoreText} vs A`,
      value: scoreB === null ? "n/a" : pyFixed(scoreB, 2),
      status: scoreDelta === null ? "neutral" : dirStatus(scoreDelta, true),
    },
    {
      label: `Mean turns · ${turnsText} vs A`,
      value: turnsB === null ? "n/a" : pyFixed(turnsB, 1),
      status: "neutral",
    },
    {
      label: `Conversations · ${entriesA.length} → ${entriesB.length}`,
      value: String(entriesB.length),
      status: "neutral",
    },
  ]);
}

async function chartPanel(
  title: string,
  sub: string,
  spec: VegaSpec,
): Promise<string> {
  const svg = await simCompareRuntime.renderSvg(spec);
  return svg ? panel(title, sub, svg) : "";
}

const OUTCOMES_SUB = "Goal rate and mean score · A vs B";

async function outcomesChart(
  entriesA: readonly SimCompareEntry[],
  entriesB: readonly SimCompareEntry[],
  nameA: string,
  nameB: string,
): Promise<string> {
  const empty = (message: string) =>
    panel("Outcomes", OUTCOMES_SUB, `<p class="sim-empty">${message}</p>`);
  if (!entriesA.length && !entriesB.length)
    return empty("No outcome data is available in either run.");
  if (!entriesA.length || !entriesB.length)
    return empty("Outcome data requires entries from both runs.");
  const [rateA, scoreA] = agg(entriesA);
  const [rateB, scoreB] = agg(entriesB);
  if (rateA === null || scoreA === null || rateB === null || scoreB === null)
    return empty("Outcome data is incomplete for one or both runs.");
  return chartPanel(
    "Outcomes",
    OUTCOMES_SUB,
    vlGroupedBar({
      categories: ["Goal-achieved rate", "Mean goal score"],
      series: [
        [nameA, [rateA, scoreA]],
        [nameB, [rateB, scoreB]],
      ],
      xTitle: "0 to 1",
    }),
  );
}

const SCORER_TITLE = "Scorer averages";
const SCORER_SUB = "Per-scorer mean · shared scorers only";

async function scorerChart(
  runA: Pick<SimulationRun, "scorerAverages">,
  runB: Pick<SimulationRun, "scorerAverages">,
  nameA: string,
  nameB: string,
): Promise<string> {
  const saA = runA.scorerAverages ?? {};
  const saB = runB.scorerAverages ?? {};
  const shared = Object.keys(saA)
    .filter((k) => k in saB)
    .sort(codepointCompare);
  const only = sortedUnion(Object.keys(saA), Object.keys(saB)).filter(
    (k) => !shared.includes(k),
  );
  const onlyNote = only.length
    ? `<p class="cmp-note">Not compared (measured by one run only): ${esc(only.join(", "))}</p>`
    : "";
  if (!shared.length)
    return panel(
      SCORER_TITLE,
      SCORER_SUB,
      onlyNote ||
        '<p class="cmp-note">No scorer data was measured by both runs.</p>',
    );
  const svg = await simCompareRuntime.renderSvg(
    vlGroupedBar({
      categories: shared,
      series: [
        [nameA, shared.map((k) => saA[k] as number)],
        [nameB, shared.map((k) => saB[k] as number)],
      ],
      xTitle: "Average score",
    }),
  );
  if (!svg) return "";
  return panel(SCORER_TITLE, SCORER_SUB, svg + onlyNote);
}

async function terminatedChart(
  entriesA: readonly SimCompareEntry[],
  entriesB: readonly SimCompareEntry[],
  nameA: string,
  nameB: string,
): Promise<string> {
  const tbA = counter(entriesA);
  const tbB = counter(entriesB);
  const labels = sortedUnion(tbA.keys(), tbB.keys());
  if (!labels.length) return "";
  return chartPanel(
    "How conversations ended",
    "Terminated-by counts · A vs B",
    vlGroupedBar({
      categories: labels,
      series: [
        [nameA, labels.map((x) => tbA.get(x) ?? 0)],
        [nameB, labels.map((x) => tbB.get(x) ?? 0)],
      ],
      xTitle: "Conversations",
    }),
  );
}

async function deltaChart(matching: Matching): Promise<string> {
  if (!matching.matched.length) return "";
  const rows = matching.matched
    .map(
      ({ a, b }) =>
        [
          `${a.persona}/${a.scenario}`,
          b.goal_completion_score - a.goal_completion_score,
        ] as const,
    )
    .sort((x, y) => x[1] - y[1]);
  const values = rows.map((r) => r[1]);
  return chartPanel(
    "Per-conversation score change",
    "B minus A on matched conversations · green improved, red regressed",
    vlBarH({
      labels: rows.map((r) => r[0]),
      values,
      color: UP,
      colors: values.map((v) => (v >= 0 ? UP : DOWN)),
      xTitle: "B minus A (goal score)",
      valueLabels: values.map((v) => signed(pyFixed(v, 2))),
    }),
  );
}

function allMetricsTable(
  rows: readonly KpiRow[],
  nameA: string,
  nameB: string,
): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td>${fmt(r.a, r.kind)}</td><td>${fmt(r.b, r.kind)}</td><td>${fmtDelta(r)}</td></tr>`,
    )
    .join("");
  const table =
    '<table class="cmp-table"><thead><tr>' +
    `<th>Metric</th><th>${esc(nameA)}</th><th>${esc(nameB)}</th><th>&Delta; (B - A)</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`;
  return panel("All metrics", "Full A / B / delta breakdown", table);
}

function diffTable(ridA: string, ridB: string, matching: Matching): string {
  const safeA = esc(ridA);
  const safeB = esc(ridB);
  const rows = matching.matched.map(({ a, b }) => {
    const ga = a.goal_achieved ? "yes" : "no";
    const gb = b.goal_achieved ? "yes" : "no";
    const flip =
      a.goal_achieved !== b.goal_achieved
        ? '<span class="cmp-flip">flip</span>'
        : "";
    const dScore = b.goal_completion_score - a.goal_completion_score;
    const dTurns = b.turn_count - a.turn_count;
    return (
      '<tr class="cmp-diff-row" style="cursor:pointer"' +
      ` hx-get="/compare/sim/transcript?a=${safeA}&b=${safeB}&ia=${a.index}&ib=${b.index}"` +
      ' hx-target="#cmp-transcript-panel" hx-swap="innerHTML">' +
      `<td>${esc(a.persona)}</td><td>${esc(a.scenario)}</td>` +
      `<td>${ga} &rarr; ${gb} ${flip}</td>` +
      `<td>${pyFixed(a.goal_completion_score, 2)} &rarr; ${pyFixed(b.goal_completion_score, 2)} (${signed(pyFixed(dScore, 2))})</td>` +
      `<td>${a.turn_count} &rarr; ${b.turn_count} (${dTurns >= 0 ? "+" : ""}${dTurns})</td>` +
      "</tr>"
    );
  });
  const matchedHtml = rows.length
    ? '<table class="cmp-table"><thead><tr>' +
      "<th>Persona</th><th>Scenario</th><th>Goal (A&rarr;B)</th>" +
      "<th>Score (A&rarr;B)</th><th>Turns (A&rarr;B)</th>" +
      `</tr></thead><tbody>${rows.join("")}</tbody></table>`
    : '<p class="sim-empty">No conversations matched on (persona, scenario).</p>';
  const unmatched = (title: string, entries: readonly SimCompareEntry[]) =>
    entries.length
      ? `<div class="cmp-unmatched"><strong>${esc(title)}</strong><ul>${entries
          .map((e) => `<li>${esc(e.persona)} &middot; ${esc(e.scenario)}</li>`)
          .join("")}</ul></div>`
      : "";
  const slot =
    '<div id="cmp-transcript-panel" class="cmp-transcript-panel">' +
    '<p class="sim-select-prompt">Select a matched conversation above to compare transcripts.</p></div>';
  return panel(
    "Outcome diffs",
    "Matched by persona and scenario · click a row to compare transcripts",
    matchedHtml +
      unmatched("Only in A", matching.aOnly) +
      unmatched("Only in B", matching.bOnly) +
      slot,
  );
}

export async function renderCompareTranscript(
  entryA: SimCompareEntry,
  entryB: SimCompareEntry,
  nameA: string,
  nameB: string,
): Promise<string> {
  const left = await simCompareRuntime.renderTranscriptFragment(entryA);
  const right = await simCompareRuntime.renderTranscriptFragment(entryB);
  return (
    '<div class="cmp-transcript-grid">' +
    `<div class="cmp-side"><h3 class="cmp-side-title">${esc(nameA)}</h3>${left}</div>` +
    `<div class="cmp-side"><h3 class="cmp-side-title">${esc(nameB)}</h3>${right}</div>` +
    "</div>"
  );
}

export const minuteStamp = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

function hero(
  runA: SimulationRun,
  runB: SimulationRun,
  matching: Matching,
): string {
  const summary = `${matching.matched.length} matched · ${matching.aOnly.length} only in A · ${matching.bOnly.length} only in B`;
  const rate = matchRate(matching);
  const warn =
    rate < 0.5
      ? ` <span class="cmp-warn">low overlap (${pyPercent(rate)}) \u2014 the two runs share few ` +
        "(persona, scenario) pairs, so most conversations can't be compared directly.</span>"
      : "";
  return (
    '<header class="report-hero">' +
    '<p class="report-hero-kicker">Agent Simulation · Run comparison</p>' +
    `<h2 class="report-hero-title">${esc(runA.runName)} <span class="cmp-vs">vs</span> ${esc(runB.runName)}</h2>` +
    `<p class="report-hero-sub">A: ${esc(runA.runName)} · ${minuteStamp(runA.createdAt)} &nbsp;&nbsp; B: ${esc(runB.runName)} · ${minuteStamp(runB.createdAt)}</p>` +
    `</header><p class="cmp-note">${summary}.${warn}</p>`
  );
}

export async function renderComparePage(
  ridA: string,
  ridB: string,
  runA: SimulationRun,
  runB: SimulationRun,
): Promise<string> {
  const entriesA = simCompareEntries(runA);
  const entriesB = simCompareEntries(runB);
  const kpis = compareKpis(entriesA, entriesB, runA, runB);
  const matching = matchEntries(entriesA, entriesB);
  const nameA = runA.runName;
  const nameB = runB.runName;
  const kpiSection = panel(
    "KPI deltas",
    "Headline metrics, B relative to A",
    kpiBand(entriesA, entriesB),
  );
  const charts =
    '<div class="cmp-charts">' +
    (await outcomesChart(entriesA, entriesB, nameA, nameB)) +
    (await scorerChart(runA, runB, nameA, nameB)) +
    (await terminatedChart(entriesA, entriesB, nameA, nameB)) +
    "</div>";
  return (
    hero(runA, runB, matching) +
    '<div class="cmp-body">' +
    kpiSection +
    charts +
    (await deltaChart(matching)) +
    allMetricsTable(kpis, nameA, nameB) +
    diffTable(ridA, ridB, matching) +
    "</div>"
  );
}

export type ResolvedRun<T> =
  | readonly ["ok", T]
  | readonly ["missing", null]
  | readonly ["error", null];

export async function resolveRun<T = unknown>(
  rid: string,
  roots: readonly string[],
  surface: string,
): Promise<ResolvedRun<T>> {
  return loadTypedReport<T>(rid, roots, surface);
}

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export async function errorPage(
  message: string,
  status: number,
  surface: string,
): Promise<Response> {
  const body =
    '<header class="report-hero"><h2 class="report-hero-title">Run comparison</h2></header>' +
    `<p class="sim-empty">${esc(message)}</p>`;
  return htmlResponse(
    await page("Compare", body, {
      activeSurface: surface,
      backHtml: reportBackLink(surface),
    }),
    status,
  );
}

export async function compareSimRoute(
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const ridA = query.get("a") || "";
  const ridB = query.get("b") || "";
  if (!ridA || !ridB) return errorPage("Pick two runs to compare.", 400, "sim");
  if (ridA === ridB)
    return errorPage("Pick two different runs to compare.", 400, "sim");
  const [statusA, runA] = await resolveRun<SimulationRun>(ridA, roots, "sim");
  const [statusB, runB] = await resolveRun<SimulationRun>(ridB, roots, "sim");
  if (statusA === "error" || statusB === "error")
    return errorPage(
      `Run ${statusA === "error" ? "A" : "B"} could not be loaded (the report may be corrupt).`,
      422,
      "sim",
    );
  if (runA === null || runB === null)
    return errorPage(
      `Run ${runA === null ? "A" : "B"} was not found or is not a simulation run.`,
      404,
      "sim",
    );
  const body = await renderComparePage(ridA, ridB, runA, runB);
  return htmlResponse(
    await page("Compare", body, {
      activeSurface: "sim",
      backHtml: reportBackLink("sim"),
    }),
  );
}

const PY_INT = /^\s*[+-]?\d(?:_?\d)*\s*$/;

export async function compareSimTranscriptRoute(
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const ridA = query.get("a") || "";
  const ridB = query.get("b") || "";
  const rawA = query.get("ia") ?? "";
  const rawB = query.get("ib") ?? "";
  if (!PY_INT.test(rawA) || !PY_INT.test(rawB))
    return htmlResponse(
      '<p class="sim-empty">Invalid conversation index.</p>',
      400,
    );
  const ia = Number(rawA.trim().replaceAll("_", ""));
  const ib = Number(rawB.trim().replaceAll("_", ""));
  const [statusA, runA] = await resolveRun<SimulationRun>(ridA, roots, "sim");
  const [statusB, runB] = await resolveRun<SimulationRun>(ridB, roots, "sim");
  if (statusA === "error" || statusB === "error")
    return htmlResponse(
      '<p class="sim-empty">A run could not be loaded (report may be corrupt).</p>',
      422,
    );
  if (runA === null || runB === null)
    return htmlResponse('<p class="sim-empty">Run not found.</p>', 404);
  const ea = simCompareEntries(runA).find((e) => e.index === ia);
  const eb = simCompareEntries(runB).find((e) => e.index === ib);
  if (!ea || !eb)
    return htmlResponse(
      '<p class="sim-empty">No conversation at that index.</p>',
      404,
    );
  const body = await cliSlugRenderScope(() =>
    renderCompareTranscript(ea, eb, runA.runName, runB.runName),
  );
  return htmlResponse(body);
}
