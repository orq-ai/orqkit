import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exactSum } from "../common/jury.js";
import { esc, kpiCards } from "../common/reports/html-helpers.js";
import {
  groupThousands,
  pyFixed,
  pyG,
  pyPercent,
} from "../common/reports/number-format.js";
import {
  biasCell,
  consistencyCell,
  rate,
} from "../pairwise-reports/export-html.js";
import {
  buildReportSections,
  type ConsensusData,
  INCONCLUSIVE_WARN,
  type JudgesData,
  judgeOrder,
  observedSwap,
  POSITION_BIAS_WARN,
} from "../pairwise-reports/sections.js";
import {
  generationMetrics,
  judgeUsage,
  type TrustSignal,
  trustSignals,
  type Verdict,
  verdict,
  wilsonInterval,
} from "../pairwise-reports/stats.js";
import { type PairwiseEntry, PairwiseRun } from "../pairwise-run.js";
import { pwSideColour, verdictEyebrow } from "./pairwise-palette.js";
import { renderPairwiseComparisons, validFocus } from "./pairwise-views.js";
import { barRows, donut, metaGrid, panel } from "./report-kit.js";
import { reportTabs } from "./report-tabs.js";
import { minuteStamp } from "./sim-compare.js";

const PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const pct0 = (value: number) => pyPercent(value);
const signed = (text: string) => (text.startsWith("-") ? text : `+${text}`);

function showAllButton(rid: string, label = "Show all"): string {
  return (
    '<button type="button" class="pw-filtered-clear" ' +
    `hx-post="/r/${esc(rid)}/filter" hx-target="#filter-swap" hx-swap="outerHTML">${esc(label)}</button>`
  );
}

const emptyFiltered = (rid: string) =>
  `<div class="pw-note">No comparisons match the current filter. ${showAllButton(rid)}</div>`;

function filteredBanner(rid: string, shown: number, total: number): string {
  return (
    '<div class="pw-filtered" role="status"><span class="pw-filtered-text">' +
    `Filtered view · ${shown} of ${total} comparisons. The verdict uses all ${total}; ` +
    "counts, trust signals, judges and performance below cover only these.</span>" +
    `${showAllButton(rid, `Show all ${total}`)}</div>`
  );
}

const EMPTY_RUN = '<p class="pw-note">No comparisons in this run.</p>';
const BIAS_HEADER_TIP =
  "Share of completed pairs where the judge changed its answer when the sides were swapped. " +
  `Flagged at ${pyG(POSITION_BIAS_WARN)} or more.`;
const SHRUNK_TIP = "reliability weight, shrunk toward the panel mean";
const RAW_TIP = "how often the judge agreed with itself across repeated passes";

const aggregation = (run: PairwiseRun) =>
  run.report?.btSigma ? "bt-sigma" : "plurality";

export function withEntries(
  run: PairwiseRun,
  entries: readonly PairwiseEntry[],
): PairwiseRun {
  const filtered: PairwiseRun = Object.assign(
    Object.create(PairwiseRun.prototype),
    run,
    { entries: [...entries], report: null },
  );
  filtered.report = filtered.rollup(aggregation(run));
  return filtered;
}

function swatch(side: string, label: string): string {
  const cls = side === "A" ? "pw-side-a" : "pw-side-b";
  return `<span class="pw-swatch" style="background:${pwSideColour(side)}"></span><span class="${cls}">${esc(label)}</span>`;
}

function swapText(run: PairwiseRun): string {
  if (!run.swap) return "off";
  return observedSwap(run) ? "on" : "on (never observed)";
}

function hero(run: PairwiseRun, actions: string): string {
  const judges = run.judges.length || judgeOrder(run).length;
  const criteria = run.criteria ? ` · criteria: ${esc(run.criteria)}` : "";
  const actionsHtml = actions
    ? `<div class="report-hero-actions">${actions}</div>`
    : "";
  return (
    '<header class="report-hero">' +
    '<p class="report-hero-kicker">Pairwise</p>' +
    `<h2 class="report-hero-title">${esc(run.runName)}</h2>` +
    `<p class="report-hero-sub">${swatch("A", run.labelA)} vs ${swatch("B", run.labelB)}` +
    ` · ${judges} ${judges === 1 ? "judge" : "judges"} · swap ${esc(swapText(run))}${criteria}</p>` +
    `${actionsHtml}</header>`
  );
}

function verdictText(v: Verdict): [string, string, string] {
  const leftOut =
    `${v.ties} ${v.ties === 1 ? "tie" : "ties"} and ${v.inconclusive} inconclusive ` +
    `${v.inconclusive === 1 ? "comparison" : "comparisons"} are left out of the win rate.`;
  if (
    v.state === "no_decided" ||
    v.low === null ||
    v.high === null ||
    v.winRate === null
  ) {
    const detail = v.total
      ? `Of ${v.total} comparisons, ${v.ties} ended in a tie and ${v.inconclusive} were inconclusive.`
      : "This run has no comparisons.";
    return [
      verdictEyebrow(v.state),
      "No comparison was decided, so there is no winner to report.",
      detail,
    ];
  }
  const interval = `95% range ${pct0(v.low)}\u2013${pct0(v.high)} over ${v.decided} decided comparisons`;
  if (v.state === "clear")
    return [
      verdictEyebrow(v.state),
      `${v.leaderLabel} wins ${pct0(v.winRate)} of decided comparisons.`,
      `${interval} stays above 50%. ${leftOut}`,
    ];
  const crossing = `${interval} crosses 50%, so the gap could still go either way. More comparisons would settle it. `;
  const headline =
    v.leader === null
      ? "The two sides won the same number of decided comparisons."
      : `${v.leaderLabel} leads with ${pct0(v.winRate)} of decided comparisons, but this run can’t call it yet.`;
  return [verdictEyebrow(v.state), headline, crossing + leftOut];
}

export function intervalBar(
  v: Verdict,
  options: { side?: "A" | "B" | null; label?: string | null } = {},
): string {
  if (
    v.state === "no_decided" ||
    v.low === null ||
    v.high === null ||
    v.winRate === null ||
    !v.decided
  )
    return "";
  let colour: string;
  let who: string;
  let r: number;
  let low: number;
  let high: number;
  if (!options.side) {
    colour = pwSideColour(v.leader ?? "tie");
    who = v.leaderLabel || "Either side";
    ({ winRate: r, low, high } = v);
  } else {
    const wins = options.side === "A" ? v.winsA : v.winsB;
    colour = pwSideColour(options.side);
    who = options.label || options.side;
    r = wins / v.decided;
    ({ low, high } = wilsonInterval(wins, v.decided));
  }
  const description =
    `${who} won ${pct0(r)} of ${v.decided} decided comparisons. ` +
    `95% uncertainty range: ${pct0(low)} to ${pct0(high)}. 50% means equal wins.`;
  return (
    `<figure class="pw-ci-figure" style="--c:${colour}">` +
    '<div class="pw-ci-head">' +
    `<figcaption class="pw-ci-title">${esc(who)} win rate</figcaption>` +
    '<div class="pw-ci-readout">' +
    `<span><i class="pw-ci-key-dot" aria-hidden="true"></i>Observed <strong>${pct0(r)}</strong></span>` +
    '<span><i class="pw-ci-key-range" aria-hidden="true"></i>95% range ' +
    `<strong>${pct0(low)}\u2013${pct0(high)}</strong></span></div></div>` +
    `<div class="pw-ci" role="img" aria-label="${esc(description)}">` +
    `<div class="pw-ci-range" style="left:${pyFixed(low * 100, 1)}%;width:${pyFixed((high - low) * 100, 1)}%"></div>` +
    '<div class="pw-ci-mid"></div>' +
    `<div class="pw-ci-dot" style="left:${pyFixed(r * 100, 1)}%"></div></div>` +
    '<div class="pw-ci-cap"><span>0%</span><span>50% · equal wins</span><span>100%</span></div>' +
    "</figure>"
  );
}

function sideCard(
  label: string,
  side: string,
  wins: number,
  decided: number,
): string {
  const r = decided ? pct0(wins / decided) : "\u2014";
  return (
    `<div class="pw-side-card" style="--c:${pwSideColour(side)}"><div class="nm">${esc(label)}</div>` +
    `<div class="pw-side-rate">${r}</div>` +
    `<div class="pw-side-sub">${wins} wins of ${decided} decided</div></div>`
  );
}

function verdictCard(run: PairwiseRun, v: Verdict, narrowed: boolean): string {
  const [eyebrow, headline, explanation] = verdictText(v);
  const isOpen = v.state === "clear" ? "" : " is-open";
  const scope = narrowed
    ? `<p class="pw-verdict-scope">All ${run.entries.length} comparisons · filter not applied</p>`
    : "";
  return (
    `<div class="pw-verdict${isOpen}">` +
    `<p class="pw-verdict-eyebrow">${esc(eyebrow)}</p>` +
    `<p class="pw-verdict-head">${esc(headline)}</p>` +
    `<p class="pw-verdict-expl">${esc(explanation)}</p>` +
    `${scope}${intervalBar(v)}` +
    '<div class="pw-verdict-sides">' +
    `${sideCard(run.labelA, "A", v.winsA, v.decided)}${sideCard(run.labelB, "B", v.winsB, v.decided)}` +
    "</div></div>"
  );
}

function kpis(v: Verdict, narrowed: boolean): string {
  const warned = v.total && v.inconclusive / v.total > INCONCLUSIVE_WARN;
  return kpiCards([
    { label: "Comparisons", value: String(v.total), status: "neutral" },
    { label: "Decided", value: String(v.decided), status: "neutral" },
    { label: "Ties", value: String(v.ties), status: "neutral" },
    {
      label: "Inconclusive",
      value: String(v.inconclusive),
      status: warned && !narrowed ? "warn" : "neutral",
    },
  ]);
}

const fmtMs = (ms: number) =>
  ms < 10_000
    ? `${groupThousands(pyFixed(ms, 0))} ms`
    : `${groupThousands(pyFixed(ms / 1000, 1))} s`;

function latencyText(mean: number, measured: number, total: number): string {
  const text = fmtMs(mean);
  return measured < total ? `${text} (${measured} measured)` : text;
}

function meanLatencyText(
  sum: number | null,
  measured: number,
  total: number,
): string {
  if (sum === null || !measured) return "Not recorded";
  return latencyText(sum / measured, measured, total);
}

function perfRow(
  metric: string,
  labelA: string,
  a: string,
  labelB: string,
  b: string,
  deltaHead: string,
  delta: string,
): string {
  return (
    `<tr><th scope="row">${esc(metric)}</th>` +
    `<td data-label="${esc(labelA)}">${esc(a)}</td>` +
    `<td data-label="${esc(labelB)}">${esc(b)}</td>` +
    `<td class="pw-perf-delta" data-label="${esc(deltaHead)}">${esc(delta)}</td></tr>`
  );
}

function outcomesPanel(run: PairwiseRun, v: Verdict): string {
  return panel(
    "Outcomes",
    donut(
      [
        { label: run.labelA, value: v.winsA, color: pwSideColour("A") },
        { label: run.labelB, value: v.winsB, color: pwSideColour("B") },
        { label: "tie", value: v.ties, color: pwSideColour("tie") },
        {
          label: "inconclusive",
          value: v.inconclusive,
          color: pwSideColour("inconclusive"),
        },
      ],
      String(v.total),
      "comparisons",
    ),
  );
}

function trustRow(signal: TrustSignal): string {
  const cls = signal.tone ? ` class="pw-tone-${signal.tone}"` : "";
  return `<tr><td>${esc(signal.label)}</td><td${cls}><b>${esc(signal.value)}</b> ${esc(signal.detail)}</td></tr>`;
}

function trustPanel(run: PairwiseRun, narrowed: boolean): string {
  let signals = trustSignals(run);
  if (narrowed) signals = signals.map((s) => ({ ...s, tone: "" as const }));
  return panel(
    narrowed ? "Signals in these comparisons" : "How much to trust this",
    `<table class="pw-trust no-stack"><tbody>${signals.map(trustRow).join("")}</tbody></table>`,
    {
      info: narrowed
        ? "Covers only the filtered comparisons, which were picked by outcome, so these signals are skewed " +
          "by the filter. Warning colours are off."
        : "Signals about the run, not about either side. Orange means read the verdict with care.",
    },
  );
}

function costText(
  value: number | null,
  partial: boolean,
  recorded: number,
  total: number,
): string {
  if (value === null) return "Not recorded";
  let formatted = `$${pyFixed(value, 6)}`;
  if (value > 0 && formatted === "$0.000000") formatted = `$${pyG(value)}`;
  return partial
    ? `${formatted} recorded subtotal (${recorded} of ${total})`
    : formatted;
}

function generationPanel(run: PairwiseRun): string {
  const s = generationMetrics(run);
  const total = run.entries.length;
  const aCost = costText(s.aCost, s.aCostPartial, s.aCostRecorded, total);
  const bCost = costText(s.bCost, s.bCostPartial, s.bCostRecorded, total);
  const aLatency = meanLatencyText(s.aLatencyMs, s.aLatencyRecorded, total);
  const bLatency = meanLatencyText(s.bLatencyMs, s.bLatencyRecorded, total);
  let deltaCost = "\u2014";
  if (
    s.aCost !== null &&
    s.bCost !== null &&
    s.aCost > 0 &&
    !s.aCostPartial &&
    !s.bCostPartial &&
    s.pairedCostEntries === total
  )
    deltaCost = `${pyFixed(s.bCost / s.aCost, 1)}×`;
  let deltaLatency = "\u2014";
  if (
    s.aLatencyMs !== null &&
    s.bLatencyMs !== null &&
    s.aLatencyRecorded &&
    s.pairedLatencyEntries === total
  ) {
    const meanA = s.aLatencyMs / s.aLatencyRecorded;
    const meanB = s.bLatencyMs / s.bLatencyRecorded;
    if (meanA > 0)
      deltaLatency =
        `${signed(groupThousands(pyFixed(meanB - meanA, 0)))} ms ` +
        `(${signed(pyPercent((meanB - meanA) / meanA))})`;
  }
  const deltaHead = `${run.labelB} vs ${run.labelA}`;
  const fully = s.aLatencyRecorded === total && total === s.bLatencyRecorded;
  const latencyScope = fully ? `mean of ${total}` : "mean";
  const table =
    '<div class="pw-performance-table-wrap"><table class="pw-performance-table"><thead><tr>' +
    `<th>Metric</th><th class="pw-side-a">${esc(run.labelA)}</th><th class="pw-side-b">${esc(run.labelB)}</th>` +
    `<th class="pw-perf-delta">${esc(deltaHead)}</th>` +
    "</tr></thead><tbody>" +
    perfRow(
      "Generation cost (total)",
      run.labelA,
      aCost,
      run.labelB,
      bCost,
      deltaHead,
      deltaCost,
    ) +
    perfRow(
      `Generation latency (${latencyScope})`,
      run.labelA,
      aLatency,
      run.labelB,
      bLatency,
      deltaHead,
      deltaLatency,
    ) +
    "</tbody></table></div>";
  let note =
    `<p class="pw-note">Fully priced A/B pairs: ${s.pairedCostEntries} of ${total}. ` +
    `Paired generation latencies: ${s.pairedLatencyEntries} of ${total}.</p>`;
  if (s.pairedCostEntries < Math.max(s.aCostRecorded, s.bCostRecorded))
    note +=
      '<p class="pw-note">Generation costs are not like-for-like: pricing is incomplete or the measured comparisons differ.</p>';
  if (s.pairedLatencyEntries < Math.max(s.aLatencyRecorded, s.bLatencyRecorded))
    note +=
      '<p class="pw-note">Generation latencies are not like-for-like: the measured comparisons differ.</p>';
  return panel("Response generation", table + note, {
    info: "Cost uses recorded response usage; partial pricing and missing comparisons are shown as recorded subtotals. Latency is mean response-generation time, not judging time.",
  });
}

function performance(run: PairwiseRun): string {
  if (!run.entries.length) return EMPTY_RUN;
  const total = run.entries.length;
  const usage = judgeUsage(run);
  const cost = costText(
    usage.cost,
    usage.costPartial,
    usage.costRecorded,
    total,
  );
  const judgeLatency = run.entries
    .map((e) => e.comparison.judgeLatencyMs)
    .filter((v): v is number => v !== null && v !== undefined);
  const latency = judgeLatency.length
    ? latencyText(
        exactSum(judgeLatency) / judgeLatency.length,
        judgeLatency.length,
        total,
      )
    : "Not recorded";
  let usagePanel: string;
  if (usage.withUsage) {
    const average = usage.totalTokens / usage.withUsage;
    const sub = `${groupThousands(String(usage.totalTokens))} total · ${groupThousands(pyFixed(average, 0))} per comparison with usage (${usage.withUsage} of ${total})`;
    const tokens = barRows(
      [
        ["Input", usage.inputTokens],
        ["Output", usage.outputTokens],
      ],
      {
        width: 520,
        labelWidth: 70,
        color: "var(--text-muted)",
        format: (value) => groupThousands(String(Math.trunc(value))),
      },
    );
    usagePanel = panel("Judge tokens", tokens, { sub });
  } else
    usagePanel = panel("Judge tokens", '<p class="pw-note">Not recorded</p>');
  const costPanel = panel(
    "Judging cost",
    `<p class="pw-performance-value">${esc(cost)}</p>`,
  );
  const latencyPanel = panel(
    "Judging latency",
    `<p class="pw-performance-value">${esc(latency)}</p>`,
    {
      info: "Mean end-to-end judging wall time per comparison, including swapped and replacement judgements; not run elapsed time.",
    },
  );
  return (
    generationPanel(run) +
    `<div class="pw-grid-2 pw-performance-overhead">${costPanel}${latencyPanel}</div>` +
    usagePanel
  );
}

function overview(
  run: PairwiseRun,
  fullRun: PairwiseRun,
  narrowed: boolean,
): string {
  const v = verdict(run);
  const scopeNote = narrowed
    ? `<p class="pw-note pw-scope-note">Below: ${run.entries.length} of ${fullRun.entries.length} ` +
      "filtered comparisons</p>"
    : "";
  return (
    verdictCard(fullRun, verdict(fullRun), narrowed) +
    scopeNote +
    kpis(v, narrowed) +
    trustPanel(run, narrowed) +
    outcomesPanel(run, v)
  );
}

function th(labelHtml: string, plain: string, tip: string | null): string {
  const title = tip ? ` title="${esc(tip)}"` : "";
  return `<th${title} data-label="${esc(plain)}">${labelHtml}</th>`;
}

function judgeNotes(data: JudgesData): string {
  const notes: string[] = [];
  if (!data.observedSwap)
    notes.push(
      data.swap
        ? "No pair completed both orderings, so position bias could not be measured for this run despite " +
            "swapping being enabled."
        : "This run used a single ordering, so position bias was not measured.",
    );
  if (!data.observedConsistency)
    notes.push(
      data.repeated
        ? "Repeated passes ran but no judge completed two decisive passes of the same ordering, so judge " +
            "self-consistency could not be measured for this run."
        : "This run used a single pass per ordering, so judge self-consistency was not measured.",
    );
  return notes.map((n) => `<p class="pw-note">${esc(n)}</p>`).join("");
}

function judgesPanel(
  run: PairwiseRun,
  data: JudgesData,
  narrowed: boolean,
): string {
  const rows = data.rows ?? [];
  let sub =
    `Position bias is flagged at ${pyFixed(POSITION_BIAS_WARN, 2)} or more: ` +
    `the judge changed its pick on at least ${pct0(POSITION_BIAS_WARN)} of swapped pairs. ` +
    "Side shares exclude ties and abstentions.";
  if (narrowed)
    sub =
      `Covers only the ${run.entries.length} filtered comparisons; filters on thrown-out votes or splits ` +
      `push position bias up. ${sub}`;
  if (!rows.length)
    return panel(
      "Judges",
      '<p class="pw-note">No judge voted in this run.</p>',
      { sub },
    );
  const failed = new Map<string, number>();
  for (const entry of run.entries)
    for (const vote of entry.comparison.votes)
      failed.set(
        vote.model,
        (failed.get(vote.model) ?? 0) + vote.repetitionFailures,
      );
  const observed = Boolean(data.observedSwap);
  const showConsistency = Boolean(data.observedConsistency);
  const columns: [string, string, string | null][] = [
    ["Judge", "Judge", null],
    [
      `<span class="pw-side-a">${esc(run.labelA)}</span> share of picks`,
      `${run.labelA} share of picks`,
      null,
    ],
    [
      `<span class="pw-side-b">${esc(run.labelB)}</span> share of picks`,
      `${run.labelB} share of picks`,
      null,
    ],
    ["Tie (of all votes)", "Tie (of all votes)", null],
    ["Position bias ⓘ", "Position bias", BIAS_HEADER_TIP],
    ["Failed passes", "Failed passes", null],
  ];
  if (showConsistency)
    columns.push(
      ["Consistency (shrunk)", "Consistency (shrunk)", SHRUNK_TIP],
      ["Consistency (raw)", "Consistency (raw)", RAW_TIP],
    );
  const heads = columns.map(([h, p, t]) => th(h, p, t)).join("");
  const body = rows
    .map((r) => {
      const cells = [
        esc(r.model) +
          (r.replacement ? ' <span class="pw-tag">stand-in</span>' : ""),
        rate(r.aRate),
        rate(r.bRate),
        rate(r.tieRate),
        biasCell(r, observed),
        String(failed.get(r.model) ?? 0),
      ];
      if (showConsistency)
        cells.push(
          consistencyCell(r.consistency),
          consistencyCell(r.consistencyRaw),
        );
      return `<tr>${cells.map((c, i) => `<td data-label="${esc((columns[i] as [string, string, string | null])[1])}">${c}</td>`).join("")}</tr>`;
    })
    .join("");
  const table = `<table><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`;
  return panel("Judges", table + judgeNotes(data), { sub });
}

function weightedPanel(run: PairwiseRun, consensus: ConsensusData): string {
  const weighted = consensus.btSigma;
  if (!weighted) return "";
  let bars = "";
  for (const [label, side, r] of [
    [run.labelA, "A", weighted.aWinRate],
    [run.labelB, "B", weighted.bWinRate],
  ] as const)
    if (r !== null)
      bars += barRows([[label, r]], {
        width: 520,
        labelWidth: 110,
        color: pwSideColour(side),
        format: pct0,
        maxValue: 1.0,
      });
  const warnings = (weighted.fitWarnings ?? [])
    .map((w) => `<li>${esc(w)}</li>`)
    .join("");
  const warningHtml = warnings
    ? `<ul class="pw-warnings">${warnings}</ul>`
    : "";
  return panel("Reliability-weighted consensus", bars + warningHtml, {
    sub: "Each judge’s vote is weighted by how consistent it was with itself (BT-sigma).",
  });
}

function judges(run: PairwiseRun, narrowed: boolean): string {
  const byKind = new Map(buildReportSections(run).map((s) => [s.kind, s]));
  const data = byKind.get("pairwise_judges")?.data as JudgesData;
  const consensus = byKind.get("pairwise_consensus")?.data as ConsensusData;
  return judgesPanel(run, data, narrowed) + weightedPanel(run, consensus);
}

function passesPerOrdering(run: PairwiseRun): number {
  const seen = run.entries.flatMap((e) =>
    e.comparison.votes.flatMap((v) => v.observations.map((o) => o.repetition)),
  );
  return seen.length ? Math.max(...seen) + 1 : 1;
}

export function evaluatorqVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {}
  return "unknown";
}

function methodHtml(run: PairwiseRun): string {
  let ordering: string;
  if (observedSwap(run)) {
    ordering = "Recorded votes include judgements completed in both orders.";
    if (!run.swap)
      ordering +=
        " This differs from the saved configuration, which disables swapping.";
    ordering +=
      " For a judge completing both orders, picking different sides throws out its vote for that pair; " +
      "position bias measures these completed judgements.";
  } else if (run.swap)
    ordering =
      "Swapping was configured, but no recorded judge completed both orderings. " +
      "Position bias cannot be measured from these votes.";
  else
    ordering =
      "Swapping was disabled: judges were asked to evaluate one ordering. " +
      "Single-ordering votes do not measure position bias.";
  return (
    '<div class="rk-panel pw-method-panel"><details class="pw-method">' +
    "<summary>How this was judged</summary>" +
    `<p>${ordering} The panel outcome follows the aggregation shown above; ` +
    "with no votes left the comparison is inconclusive.</p>" +
    "<p>The 95% range on the headline win rate is a Wilson interval over decided comparisons only. When it " +
    "crosses 50% the page says the run is too close to call rather than naming a winner.</p>" +
    "</details></div>"
  );
}

function config(run: PairwiseRun): string {
  const panelJudges = run.judges.length ? [...run.judges] : judgeOrder(run);
  const grid = metaGrid([
    ["Side A", run.labelA],
    ["Side B", run.labelB],
    ["Judges", panelJudges.join(", ")],
    ["Criteria", run.criteria],
    ["Swap orderings", swapText(run)],
    ["Passes per ordering", String(passesPerOrdering(run))],
    ["Aggregation", aggregation(run)],
    ["Created", minuteStamp(run.createdAt)],
    ["Comparisons", String(run.entries.length)],
  ]);
  const fingerprint = `Run fingerprint · evaluatorq ${evaluatorqVersion()} · judges: ${panelJudges.join(", ")}`;
  return (
    panel("Run configuration", grid) +
    methodHtml(run) +
    `<p class="pw-note">${esc(fingerprint)}</p>`
  );
}

export async function pairwiseReportTabs(
  rid: string,
  run: PairwiseRun,
  entries: readonly PairwiseEntry[] | null = null,
  options: { heroActionsHtml?: string; focus?: number | null } = {},
): Promise<string> {
  const view = entries === null ? run : withEntries(run, entries);
  const focus = validFocus(run, view.entries, options.focus);
  const empty = emptyFiltered(rid);
  let comparisons: string;
  if (view.entries.length)
    comparisons = await renderPairwiseComparisons(rid, run, view.entries, {
      focus,
    });
  else comparisons = entries !== null ? empty : EMPTY_RUN;
  const filteredEmpty = entries !== null && !view.entries.length;
  const total = run.entries.length;
  const narrowed =
    entries !== null && view.entries.length > 0 && view.entries.length < total;
  const banner = narrowed
    ? filteredBanner(rid, view.entries.length, total)
    : "";
  const tabs = reportTabs(
    "pwtab",
    [
      ["Overview", filteredEmpty ? empty : overview(view, run, narrowed)],
      ["Performance", filteredEmpty ? empty : performance(view)],
      ["Judges", filteredEmpty ? empty : judges(view, narrowed)],
      [
        "Comparisons",
        comparisons,
        `Comparisons <span class="tab-count">${view.entries.length}</span>`,
      ],
      ["Config", config(view)],
    ],
    { active: focus !== null ? "Comparisons" : null },
  );
  return `<div class="report-aligned pw-report">${hero(view, options.heroActionsHtml ?? "")}${banner}${tabs}</div>`;
}
