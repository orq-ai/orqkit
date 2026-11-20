import { pairIndicesByKey } from "../common/matching.js";
import { esc, kpiCards, pct } from "../common/reports/html-helpers.js";
import { pyFixed, pyPercent } from "../common/reports/number-format.js";
import { fleissKappa, kappaLabel, verdict } from "../pairwise-reports/stats.js";
import type { PairwiseRun } from "../pairwise-run.js";
import {
  pwSideColour,
  pwSideLabel,
  verdictEyebrow,
} from "./pairwise-palette.js";
import { intervalBar } from "./pairwise-tabs.js";
import { panel } from "./report-kit.js";
import { page } from "./shell.js";
import { errorPage, minuteStamp, resolveRun } from "./sim-compare.js";
import { reportBackLink } from "./view.js";

const MATCH_WARN_BELOW = 0.5;
const DASH = "\u2014";

export interface PairwiseMatching {
  matched: [number, number][];
  aOnly: number[];
  bOnly: number[];
  total: number;
}

export const pairwiseMatchRate = (m: PairwiseMatching) =>
  m.matched.length / Math.max(m.total, 1);

export function matchComparisons(
  a: PairwiseRun,
  b: PairwiseRun,
): PairwiseMatching {
  const { matched, aOnly, bOnly } = pairIndicesByKey(
    a.entries,
    b.entries,
    (entry) => entry.question,
  );
  return {
    matched,
    aOnly,
    bOnly,
    total: Math.max(a.entries.length, b.entries.length),
  };
}

function headline(run: PairwiseRun): string {
  const v = verdict(run);
  const eyebrow = verdictEyebrow(v.state);
  return v.leaderLabel === null ? eyebrow : `${eyebrow}: ${v.leaderLabel}`;
}

function runPanel(side: string, run: PairwiseRun): string {
  const v = verdict(run);
  const total = run.entries.length;
  const share = total ? pct(v.decided / total) : DASH;
  const rates = v.decided
    ? `${esc(run.labelA)} ${pct(v.winsA / v.decided)} · ${esc(run.labelB)} ${pct(v.winsB / v.decided)}`
    : DASH;
  const { kappa, rows } = fleissKappa(run);
  const kappaTxt =
    kappa === null || rows === 0
      ? DASH
      : `${pyFixed(kappa, 2)} (${esc(kappaLabel(kappa))})`;
  const body =
    `<p class="pw-cmp-verdict">${esc(headline(run))}</p>` +
    '<dl class="pw-cmp-facts">' +
    `<dt>Win rate</dt><dd>${rates}</dd>` +
    `<dt>Decided</dt><dd>${share}</dd>` +
    `<dt>Judge agreement (κ)</dt><dd>${kappaTxt}</dd>` +
    "</dl>" +
    `<div class="pw-cmp-run-ci">${intervalBar(v, { side: "B", label: run.labelB })}</div>`;
  return panel(`${side} · ${run.runName}`, body, {
    sub: `${run.labelA} vs ${run.labelB}`,
  });
}

const link = (rid: string, n: number) =>
  `<a href="/r/${esc(rid)}?cmp=${n}#cmp-${n}">#${n}</a>`;

function displayOutcome(
  value: string | null,
  run: PairwiseRun,
  labelsCollide: boolean,
): string {
  const label = pwSideLabel(value, run);
  if (
    (value === "A" || value === "B") &&
    (labelsCollide || label === "tie" || label === "inconclusive")
  )
    return `${label} (${value})`;
  return label;
}

function diffTable(
  ridA: string,
  ridB: string,
  runA: PairwiseRun,
  runB: PairwiseRun,
  m: PairwiseMatching,
): string {
  if (!m.matched.length)
    return panel(
      "Matched comparisons",
      '<p class="pw-empty">No question appears in both runs.</p>',
    );
  const labelsCollide =
    runA.labelA === runA.labelB || runB.labelA === runB.labelB;
  const rows = m.matched.map(([i, j]): [boolean, string] => {
    const ea = runA.entries[i] as PairwiseRun["entries"][number];
    const eb = runB.entries[j] as PairwiseRun["entries"][number];
    const outcomeA = ea.comparison.winner;
    const outcomeB = eb.comparison.winner;
    const wa = displayOutcome(outcomeA, runA, labelsCollide);
    const wb = displayOutcome(outcomeB, runB, labelsCollide);
    const isChanged = outcomeA !== outcomeB;
    const changed = isChanged
      ? ' <span class="tag pw-changed">changed</span>'
      : "";
    return [
      isChanged,
      `<tr><td data-label="#A">${link(ridA, i + 1)}</td><td data-label="#B">${link(ridB, j + 1)}</td>` +
        `<td class="pw-cmp-q" data-label="Question">${esc(ea.question)}</td>` +
        `<td data-label="Winner in run A"><span class="pw-vchip" style="--c:${pwSideColour(outcomeA)}">${esc(wa)}</span></td>` +
        `<td data-label="Winner in run B"><span class="pw-vchip" style="--c:${pwSideColour(outcomeB)}">${esc(wb)}</span>${changed}</td></tr>`,
    ];
  });
  const ordered = [...rows.filter(([c]) => c), ...rows.filter(([c]) => !c)];
  const table =
    '<table class="pw-cmp-table"><thead><tr>' +
    "<th>#A</th><th>#B</th><th>Question</th><th>Winner in run A</th><th>Winner in run B</th>" +
    `</tr></thead><tbody>${ordered.map(([, r]) => r).join("")}</tbody></table>`;
  const nChanged = rows.filter(([c]) => c).length;
  return panel("Matched comparisons", table, {
    sub: `${m.matched.length} compared · ${nChanged} changed`,
  });
}

export function renderPairwiseComparePage(
  ridA: string,
  ridB: string,
  runA: PairwiseRun,
  runB: PairwiseRun,
): string {
  const m = matchComparisons(runA, runB);
  const rate = pairwiseMatchRate(m);
  const warn =
    m.total > 0 && rate < MATCH_WARN_BELOW
      ? ` <span class="cmp-warn">low overlap (${pyPercent(rate)}) ${DASH} the two runs share few questions, ` +
        "so most comparisons can't be set against each other.</span>"
      : "";
  const leftoverNote =
    m.aOnly.length || m.bOnly.length
      ? ` ${m.aOnly.length} only in A, ${m.bOnly.length} only in B.`
      : "";
  const hero =
    '<header class="report-hero">' +
    '<p class="report-hero-kicker">Pairwise · Run comparison</p>' +
    `<h2 class="report-hero-title">${esc(runA.runName)} <span class="cmp-vs">vs</span> ${esc(runB.runName)}</h2>` +
    `<p class="report-hero-sub">A: ${esc(runA.runName)} · ${minuteStamp(runA.createdAt)} &nbsp;&nbsp; B: ${esc(runB.runName)} · ${minuteStamp(runB.createdAt)}</p>` +
    "</header>" +
    `<p class="cmp-note">${m.matched.length} of ${m.total} comparisons matched by question.` +
    `${leftoverNote}${warn}</p>`;
  const columns = `<div class="pw-cmp-cols">${runPanel("A", runA)}${runPanel("B", runB)}</div>`;
  const leftovers =
    m.aOnly.length || m.bOnly.length
      ? kpiCards([
          {
            label: "Only in run A",
            value: String(m.aOnly.length),
            status: "neutral",
          },
          {
            label: "Only in run B",
            value: String(m.bOnly.length),
            status: "neutral",
          },
        ])
      : "";
  return (
    `<div class="report-aligned pw-report pw-compare">${hero}${columns}` +
    `${diffTable(ridA, ridB, runA, runB, m)}${leftovers}</div>`
  );
}

export async function comparePairwiseRoute(
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const ridA = query.get("a") || "";
  const ridB = query.get("b") || "";
  if (!ridA || !ridB)
    return errorPage("Pick two runs to compare.", 400, "pairwise");
  if (ridA === ridB)
    return errorPage("Pick two different runs to compare.", 400, "pairwise");
  const [statusA, runA] = await resolveRun<PairwiseRun>(
    ridA,
    roots,
    "pairwise",
  );
  const [statusB, runB] = await resolveRun<PairwiseRun>(
    ridB,
    roots,
    "pairwise",
  );
  if (statusA === "error" || statusB === "error")
    return errorPage(
      `Run ${statusA === "error" ? "A" : "B"} could not be loaded (the report may be corrupt).`,
      422,
      "pairwise",
    );
  if (runA === null || runB === null)
    return errorPage(
      `Run ${runA === null ? "A" : "B"} was not found or is not a pairwise run.`,
      404,
      "pairwise",
    );
  const body = renderPairwiseComparePage(ridA, ridB, runA, runB);
  return new Response(
    await page("Compare", body, {
      activeSurface: "pairwise",
      backHtml: reportBackLink("pairwise"),
    }),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
