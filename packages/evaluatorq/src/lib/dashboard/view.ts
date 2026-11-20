import { createHash } from "node:crypto";

import type { ReportCard } from "../common/dashboard/library.js";
import { DEFAULT_ORQ_BASE_URL } from "../common/env-config.js";
import {
  BUILTIN,
  ROLE_ENV,
  type Role,
  roleModel,
  roleSource,
  TASKS,
  taskOverride,
} from "../common/model-roles.js";
import {
  esc,
  type KpiCard,
  kpiCards,
  pct,
  statusBadge,
} from "../common/reports/html-helpers.js";
import { TARGET_ICONS } from "../common/reports/icons.js";
import {
  costCoverage,
  fmtCost as reportFmtCost,
} from "../common/reports/md-helpers.js";
import {
  groupThousands,
  pyFixed,
  pyG,
} from "../common/reports/number-format.js";
import { durationSeconds, type RunManifest } from "../contracts.js";
import { TURN_METRICS } from "../integrations/simulation/metrics.js";
import {
  DEFAULT_TRACE_INPUT_CHARS,
  MAX_TRACE_INPUT_CHARS,
  MIN_TRACE_INPUT_CHARS,
} from "../trace-finder/settings.js";
import type {
  Landing,
  RedTeamOverview,
  RedTeamRunRow,
  RunRow,
  SimOverview,
  SimRunRow,
} from "./metrics.js";
import type { OAuthScopes } from "./orq-scope.js";
import { csrfField } from "./security.js";
import { assetVersion } from "./static-assets.js";

export const SURFACE_LABELS: Readonly<Record<string, string>> = {
  redteam: "Red Team",
  sim: "Agent Sim",
  pairwise: "Pairwise",
};

export const RUN_PAGE_SIZES: readonly number[] = [8, 15, 25];

function dashboardJsVersion(): string {
  try {
    return assetVersion("dashboard.js");
  } catch {
    return "0";
  }
}

export const VEGA_SCRIPTS: readonly string[] = [
  "/static/vega.min.js",
  "/static/vega-lite.min.js",
  "/static/vega-embed.min.js",
];

export function headAssets(options: { charts?: boolean } = {}): string[] {
  const vega = options.charts
    ? VEGA_SCRIPTS.map((src) => `<script src="${src}"></script>`)
    : [];
  return [
    '<script src="/static/htmx.min.js"></script>',
    ...vega,
    `<script src="/static/dashboard.js?v=${dashboardJsVersion()}" defer></script>`,
  ];
}

// view.py renders a missing cost as an em dash; the shared TS helper says "n/a".
const fmtCost = (cost: number | null): string =>
  cost === null ? "—" : reportFmtCost(cost);

const int = (n: number): string => groupThousands(String(Math.trunc(n)));

function titleCase(text: string): string {
  return text.replace(
    /[A-Za-z]+/g,
    (w) => w[0].toUpperCase() + w.slice(1).toLowerCase(),
  );
}

function coverage(
  pricedCalls: number,
  calls: number,
  unknownCalls: number,
): string {
  const known = costCoverage(pricedCalls, calls);
  if (!unknownCalls) {
    return known;
  }
  const unknown = `${int(unknownCalls)} call${unknownCalls === 1 ? "" : "s"} of unknown coverage`;
  if (known) {
    return `${known.slice(0, -1)}, ${unknown})`;
  }
  if (pricedCalls > 0 && pricedCalls === calls) {
    return ` (${int(pricedCalls)} of ${int(calls)} calls priced, ${unknown})`;
  }
  return ` (${unknown})`;
}

function scoreCls(score: number | null): string {
  if (score === null) {
    return "none";
  }
  return score >= 0.8 ? "good" : "warn";
}

function fmtScore(score: number | null): string {
  return score === null ? "—" : pyFixed(score, 2);
}

const SCORE_TITLES: Readonly<Record<string, string>> = {
  redteam: "Resistance rate: attacks the target withstood",
  sim: "Mean scorer average across this run",
  pairwise:
    "Called rate: comparisons ending in a win or tie (not inconclusive)",
};

function scoreTitle(row: RunRow): string {
  const t = SCORE_TITLES[row.surface];
  const parts = t ? [t] : [];
  if (row.surface === "redteam" && row.attacks) {
    parts.push(`${row.evaluated} of ${row.attacks} attacks evaluated`);
  }
  if (row.storedScore !== null) {
    parts.push(
      `recalculated by the dashboard; the report for this run records ${pyFixed(row.storedScore, 2)}`,
    );
  }
  return parts.length ? ` title="${esc(parts.join(" · "))}"` : "";
}

function scoreMarker(row: RunRow): string {
  return row.storedScore !== null
    ? '<span class="score-recalc" aria-hidden="true">*</span>'
    : "";
}

function kindBadge(surface: string): string {
  const label = SURFACE_LABELS[surface] ?? surface;
  return `<span class="kind-badge ${esc(surface)}">${esc(label)}</span>`;
}

const STATUS_BADGES: Readonly<Record<string, [string, string]>> = {
  finished: ["Finished", "passed"],
  completed: ["Finished", "passed"],
  error: ["Error", "failed"],
  running: ["Running", "warning"],
  cancelled: ["Cancelled", "cancelled"],
};

function runStatusBadge(status: string): string {
  const [label, cls] = STATUS_BADGES[status] ?? [titleCase(status), status];
  return `<span class="status-badge ${esc(cls)}"><span class="dot"></span>${esc(label)}</span>`;
}

const LOAD_ERROR =
  '<span class="card-error" title="failed to load">error</span>';

function runRow(row: RunRow, showBadge = true): string {
  const err = row.error ? LOAD_ERROR : "";
  const badge = showBadge ? kindBadge(row.surface) : "";
  return (
    `<a class="run-row" href="/r/${esc(row.id)}">` +
    '<span class="run-id">' +
    `<span class="run-name-line"><span class="run-name">${esc(row.name)}</span>${badge}${err}</span>` +
    `<span class="run-meta">${esc(row.headline)} · ${esc(row.when)}</span>` +
    "</span>" +
    `<span class="run-score ${scoreCls(row.score)}"${scoreTitle(row)}>${fmtScore(row.score)}${scoreMarker(row)}</span>` +
    `${runStatusBadge(row.status)}` +
    "</a>"
  );
}

export const PAIRWISE_ICON_PATH =
  '<path d="M4 6h6v12H4z"/><path d="M14 6h6v12h-6z"/><path d="M12 4v16"/>';

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">';

const SURFACE_ICONS: Readonly<Record<string, string>> = {
  redteam:
    `${SVG_OPEN}<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 ` +
    "1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 " +
    '3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4M12 16h.01"/></svg>',
  sim:
    `${SVG_OPEN}<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 ` +
    '2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
  pairwise: `${SVG_OPEN}${PAIRWISE_ICON_PATH}</svg>`,
};

function typeCell(surface: string): string {
  const icon = SURFACE_ICONS[surface] ?? "";
  const label = SURFACE_LABELS[surface] ?? surface;
  return `<span class="type-cell ${esc(surface)}">${icon}${esc(label)}</span>`;
}

const LIFECYCLE_PILL: Readonly<Record<string, [string, string]>> = {
  finished: ["Finished", "pass"],
  error: ["Error", "fail"],
  running: ["Running", "warn"],
  cancelled: ["Cancelled", "neutral"],
};

function recentRunsTable(rows: readonly RunRow[]): string {
  const rowHtml = [
    '<div class="rr-head"><span>Type</span><span>Job</span><span>Cases</span>' +
      "<span>Time</span><span>Score</span><span>Status</span></div>",
  ];
  for (const r of rows) {
    const [label, status] = LIFECYCLE_PILL[r.status] ?? [
      titleCase(r.status),
      "neutral",
    ];
    const err = r.error ? LOAD_ERROR : "";
    rowHtml.push(
      `<a class="rr-row" href="/r/${esc(r.id)}">` +
        `<span class="rr-type">${typeCell(r.surface)}</span>` +
        `<span class="rr-job">${esc(r.name)}${err}</span>` +
        `<span class="rr-meta">${esc(r.headline)}</span>` +
        `<span class="rr-meta">${esc(r.when)}</span>` +
        `<span class="run-score ${scoreCls(r.score)}"${scoreTitle(r)}>${fmtScore(r.score)}${scoreMarker(r)}</span>` +
        `${statusBadge(label, status)}` +
        "</a>",
    );
  }
  return `<div class="recent-runs">${rowHtml.join("")}</div>`;
}

function statTile(label: string, value: string, unit = "", sub = ""): string {
  const unitHtml = unit ? `<span class="stat-unit">${esc(unit)}</span>` : "";
  const subHtml = sub ? `<div class="stat-sub">${esc(sub)}</div>` : "";
  return (
    `<div class="stat-tile"><div class="stat-label">${esc(label)}</div>` +
    `<div class="stat-value">${esc(value)}${unitHtml}</div>${subHtml}</div>`
  );
}

function panel(
  title: string,
  sub: string,
  inner: string,
  options: { cls?: string; titleTag?: string } = {},
): string {
  const { cls = "", titleTag = "div" } = options;
  const clsAttr = cls ? ` ${cls}` : "";
  const subHtml = sub ? `<div class="panel-sub">${esc(sub)}</div>` : "";
  return `<div class="panel${clsAttr}"><${titleTag} class="panel-title">${esc(title)}</${titleTag}>${subHtml}${inner}</div>`;
}

function fourSig(value: number): string {
  return String(Number(value.toPrecision(4)));
}

function bars(
  rows: ReadonlyArray<readonly [string, number]>,
  colors: readonly string[],
  options: { totalLabel?: string; fmt?: (v: number) => string } = {},
): string {
  const { totalLabel = "Total", fmt = String } = options;
  const sum = rows.reduce((acc, [, v]) => acc + v, 0);
  const total = sum || 1;
  const parts = ['<div class="bars">'];
  rows.forEach(([name, val], i) => {
    const raw = (val / total) * 100;
    const rounded = Math.round(raw);
    let pctLabel: string;
    if (val && rounded === 0) {
      pctLabel = "<1%";
    } else if (val < total && rounded === 100) {
      pctLabel = ">99%";
    } else {
      pctLabel = `${rounded}%`;
    }
    const width = val ? fourSig(Math.max(raw, 1)) : "0";
    const color = colors[i % colors.length];
    parts.push(
      '<div class="bar-row"><div class="bar-head">' +
        `<span class="bar-name">${esc(name)}</span>` +
        `<span class="bar-val">${esc(fmt(val))} <span class="bar-pct">· ${esc(pctLabel)}</span></span>` +
        `</div><div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color}"></div></div></div>`,
    );
  });
  parts.push(
    `<div class="bars-total"><span class="t-label">${esc(totalLabel)}</span>` +
      `<span class="t-val">${esc(fmt(sum))}</span></div></div>`,
  );
  return parts.join("");
}

const KIND_COLORS: Readonly<Record<string, string>> = {
  "Red team": "var(--chart-1)",
  "Agent sim": "var(--chart-2)",
  Pairwise: "var(--chart-3)",
};

function kindColors(rows: ReadonlyArray<readonly [string, number]>): string[] {
  return rows.map(([name]) => KIND_COLORS[name] ?? "var(--chart-4)");
}

const SEVERITY_PALETTE: Readonly<Record<string, string>> = {
  critical: "var(--red-600)",
  high: "var(--orange-500)",
  medium: "var(--amber-600)",
  low: "var(--green-600)",
};

export function landingBody(data: Landing): string {
  if (data.totalRuns === 0) {
    return (
      '<section class="dash-wrap"><div class="runs-empty">' +
      "No reports found. Run a red team, simulation, or pairwise job to generate reports." +
      "</div></section>"
    );
  }
  const totalTokens = data.tokensByKind.reduce((acc, [, n]) => acc + n, 0);
  const avgCost =
    data.totalCost !== null && data.costedRuns
      ? data.totalCost / data.costedRuns
      : null;
  let spendSub = "";
  if (data.totalInputCost !== null || data.totalOutputCost !== null) {
    spendSub = `in ${fmtCost(data.totalInputCost)} / out ${fmtCost(data.totalOutputCost)}`;
  }
  const cov =
    data.totalCost !== null
      ? coverage(data.pricedCalls, data.costCalls, data.unknownCalls)
      : "";
  if (cov) {
    spendSub = spendSub ? `${spendSub} ·${cov}` : cov.trim();
  }
  const band =
    '<div class="stat-band">' +
    statTile("Jobs run", String(data.totalRuns)) +
    statTile("Avg cost / job", fmtCost(avgCost)) +
    statTile("Total spend", fmtCost(data.totalCost), "", spendSub) +
    statTile("Total tokens", fmtCompact(totalTokens)) +
    "</div>";

  const byKindSub =
    data.byKind.map(([k]) => k.toLowerCase()).join(" · ") || "no runs yet";
  const byKindPanel = panel(
    "Runs by type",
    byKindSub,
    bars(data.byKind, kindColors(data.byKind)),
  );

  const sevRows = data.severity.map(
    ([s, n]) => [titleCase(s), n] as [string, number],
  );
  const sevColors = data.severity.map(
    ([s]) => SEVERITY_PALETTE[s] ?? "var(--text-faint)",
  );
  const sevInner = sevRows.length
    ? bars(sevRows, sevColors)
    : '<p class="rt-panel-loading">No findings.</p>';
  const severityPanel = panel(
    "Findings by severity",
    "Vulnerabilities found",
    sevInner,
  );
  const spendInner = data.costByKind.length
    ? bars(data.costByKind, kindColors(data.costByKind), { fmt: fmtCost })
    : '<p class="rt-panel-loading">No cost recorded.</p>';
  const spendPanel = panel(
    "Spend by job type",
    "Real cost across runs",
    spendInner,
  );
  const tokInner = data.tokensByKind.length
    ? bars(data.tokensByKind, kindColors(data.tokensByKind), { fmt: int })
    : '<p class="rt-panel-loading">No token usage recorded.</p>';
  const tokensPanel = panel("Token usage", "By job type", tokInner);

  const grid =
    `<div class="dash-row-eq">${byKindPanel}${severityPanel}</div>` +
    `<div class="dash-row-eq">${spendPanel}${tokensPanel}</div>`;
  const recentPanel = panel(
    "Recent runs",
    "Latest jobs",
    recentRunsTable(data.recent),
  );
  return `<section class="dash-wrap">${band}${grid}${recentPanel}</section>`;
}

const CHEVRON =
  '<svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

const DISPLAY_KIND: Readonly<Record<string, string>> = {
  orq_agent: "agent",
  orq_deployment: "deployment",
  openai_model: "llm",
  vercel: "deployment",
  callback: "external",
  other: "external",
};

function targetPill(label: string, kind: string, ellipsis = false): string {
  const displayKind =
    DISPLAY_KIND[kind] ?? (kind in TARGET_ICONS ? kind : "external");
  const text = ellipsis
    ? `<span class="target-label">${esc(label)}</span>`
    : esc(label);
  return `<span class="target-pill" data-kind="${esc(displayKind)}">${TARGET_ICONS[displayKind]}${text}</span>`;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  finished: "success",
  error: "error",
  running: "running",
};

function runStatusPill(status: string): string {
  return `<span class="run-status ${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

const RECENT_DAYS = 7;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function whenLabel(when: Date, now = new Date()): [string, string] {
  const relative = ago(when, now);
  const days = Math.floor((now.getTime() - when.getTime()) / 86_400_000);
  if (days < RECENT_DAYS) {
    return [relative, ""];
  }
  const year =
    when.getFullYear() === now.getFullYear() ? "" : `, ${when.getFullYear()}`;
  return [`${MONTHS[when.getMonth()]} ${when.getDate()}${year}`, relative];
}

const ASR_FLAG = 0.1;
const ASR_HIGH = 0.25;
const ASR_NOTE =
  "Attack success rate: share of evaluated attacks that broke the agent; " +
  `above ${pct(ASR_FLAG)} is flagged, above ${pct(ASR_HIGH)} is high`;
const ASR_HINT: Readonly<Record<string, string>> = {
  mid: `above ${pct(ASR_FLAG)}, flagged`,
  high: `above ${pct(ASR_HIGH)}, high`,
};
const ASR_SUB: Readonly<Record<string, string>> = {
  good: `At or below ${pct(ASR_FLAG)}`,
  mid: `Flagged above ${pct(ASR_FLAG)}`,
  high: `High: above ${pct(ASR_HIGH)}`,
};
const ASR_KPI_STATUS: Readonly<Record<string, string>> = {
  good: "pass",
  mid: "warn",
  high: "fail",
};

function asrOf(row: RedTeamRunRow): number | null {
  return row.evaluated ? row.vulnerable / row.evaluated : null;
}

function asrCls(asr: number | null): string {
  if (asr === null) {
    return "none";
  }
  if (asr <= ASR_FLAG) {
    return "good";
  }
  return asr <= ASR_HIGH ? "mid" : "high";
}

function goalStatus(rate: number | null): string {
  if (rate === null) {
    return "neutral";
  }
  if (rate >= 0.8) {
    return "pass";
  }
  return rate >= 0.5 ? "warn" : "fail";
}

function simRow(r: SimRunRow, now: Date): string {
  const err = r.error ? LOAD_ERROR : "";
  const [whenText, whenTitle] = whenLabel(r.when, now);
  const whenAttrs = whenTitle ? ` title="${esc(whenTitle)}"` : "";
  const rate = r.cases > r.errors ? r.achieved / r.cases : null;
  const rateText = rate === null ? "—" : pct(rate);
  const outcome = rate !== null ? `${int(r.achieved)}/${int(r.cases)}` : "—";
  const status = r.status !== "finished" ? runStatusPill(r.status) : "";
  const errorNote = r.errors
    ? `<span class="rg-sub">${int(r.errors)} errored</span>`
    : "";
  const outcomeClass = rate !== null ? "rg-broke-n" : "rg-broke-n is-none";
  const outcomeLabel =
    rate !== null
      ? `${r.achieved} of ${r.cases} achieved the goal`
      : "no goal verdict available";
  const allTargets = r.targets.map((t) => t[0]).join(", ") || "unknown target";
  const label =
    `${r.name}, ${whenText}, target ${allTargets}, status ${r.status}, ${outcomeLabel}, ` +
    `${r.errors} errored, goal completion ${rateText}, cost ${fmtSpend(r.cost)}`;
  const targets = r.targets.map(([l, k]) => targetPill(l, k, true)).join("");
  return (
    `<a class="runs-grid-row" href="/r/${esc(r.rid)}" aria-label="${esc(label)}">` +
    `<span class="rg-job"><span class="rg-name" title="${esc(r.name)}">${esc(r.name)}${err}</span>` +
    `<span class="rg-sub"${whenAttrs}>${esc(whenText)}</span></span>` +
    `<span class="rg-targets" title="${esc(allTargets)}">${targets}</span>` +
    `<span class="rg-status">${status}<span class="${outcomeClass}">${outcome}</span>${errorNote}</span>` +
    `<span class="run-score rg-score ${goalStatus(rate)}" ` +
    `title="Goals achieved across all conversations, including errors; higher is better">${rateText}</span>` +
    `<span class="rg-num rg-cases">${int(r.cases)}</span>` +
    `<span class="rg-num rg-cost">${esc(fmtSpend(r.cost))}</span>` +
    `${CHEVRON}</a>`
  );
}

function redteamRow(r: RedTeamRunRow, now: Date): string {
  const err = r.error ? LOAD_ERROR : "";
  const [whenText, whenTitle] = whenLabel(r.when, now);
  const whenAttrs = whenTitle ? ` title="${esc(whenTitle)}"` : "";
  const costText = fmtSpend(r.cost);
  const asr = asrOf(r);
  const asrText = asr === null ? "—" : pct(asr);
  const brokeText =
    asr === null ? "—" : `${int(r.vulnerable)}/${int(r.evaluated)}`;
  let broke = `<span class="rg-broke-n${asr !== null ? "" : " is-none"}">${brokeText}</span>`;
  if (asr === null && r.status !== "finished") {
    broke = "";
  }
  const statusLabel =
    r.status === "finished"
      ? "completed"
      : (STATUS_LABEL[r.status] ?? r.status);
  const statusCell =
    r.status === "finished" ? broke : runStatusPill(r.status) + broke;
  const allTargets = r.targets.map((t) => t[0]).join(", ") || "no target";
  const cls = asrCls(asr);
  const asrFlag = cls in ASR_HINT ? ` (${ASR_HINT[cls]})` : "";
  const brokeLabel = asr === null ? "none evaluated" : `${brokeText} broke`;
  const label =
    `${r.name}, ${whenText}, ${statusLabel}, target ${allTargets}, ` +
    `ASR ${asrText}${asrFlag}, ${brokeLabel}, ${r.cases} cases, cost ${costText}`;
  let targetsAttrs = "";
  let targets: string;
  if (r.targets.length > 1) {
    const [l, k] = r.targets[0];
    targets = `${targetPill(l, k, true)}<span class="target-more">+${r.targets.length - 1}</span>`;
    targetsAttrs = ` title="${esc(allTargets)}"`;
  } else {
    targets = r.targets.map(([l, k]) => targetPill(l, k, true)).join("");
    if (r.targets.length) {
      targetsAttrs = ` title="${esc(r.targets[0][0])}"`;
    }
  }
  const scoreHint = asrFlag
    ? `<span class="sr-only">${esc(asrFlag)}</span>`
    : "";
  return (
    `<a class="runs-grid-row" href="/r/${esc(r.rid)}" aria-label="${esc(label)}">` +
    `<span class="rg-job"><span class="rg-name" title="${esc(r.name)}">${esc(r.name)}${err}</span>` +
    `<span class="rg-sub"${whenAttrs}>${esc(whenText)}</span></span>` +
    `<span class="rg-targets"${targetsAttrs}>${targets}</span>` +
    `<span class="rg-status">${statusCell}</span>` +
    `<span class="run-score rg-score ${cls}" title="${esc(ASR_NOTE)}">${asrText}${scoreHint}</span>` +
    `<span class="rg-num rg-cases">${int(r.cases)}</span>` +
    `<span class="rg-num rg-cost">${esc(costText)}</span>` +
    `${CHEVRON}` +
    "</a>"
  );
}

function runGrid(
  rows: ReadonlyArray<SimRunRow | RedTeamRunRow>,
  redteam: boolean,
  now: Date,
): string {
  const [statusHead, scoreHead] = redteam
    ? ["Broke", "ASR"]
    : ["Achieved", "Goal rate"];
  const head =
    '<div class="runs-grid-head" aria-hidden="true"><span>Job</span><span>Target</span>' +
    `<span>${statusHead}</span><span>${scoreHead}</span><span>Cases</span><span>Cost</span><span></span></div>`;
  const body = rows
    .map((r) =>
      redteam
        ? redteamRow(r as RedTeamRunRow, now)
        : simRow(r as SimRunRow, now),
    )
    .join("");
  return `<div class="runs-grid">${head}${body}</div>`;
}

function runPager(
  surface: string,
  page: number,
  total: number,
  perPage: number,
): string {
  const last = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(page, last);

  const link = (
    label: string,
    pg: number,
    pp: number,
    opts: { disabled?: boolean; active?: boolean } = {},
  ): string => {
    let cls = "runs-pager-link";
    if (opts.active) {
      cls += " is-active";
    }
    if (opts.disabled) {
      return `<span class="${cls} is-disabled" aria-disabled="true">${label}</span>`;
    }
    const aria = opts.active ? ' aria-current="true"' : "";
    return `<a class="${cls}" href="/?surface=${esc(surface)}&page=${pg}&per_page=${pp}"${aria}>${label}</a>`;
  };

  const sizes = RUN_PAGE_SIZES.map((sz) =>
    link(String(sz), 1, sz, { active: sz === perPage }),
  ).join("");
  const fitsSmallest =
    (surface === "redteam" || surface === "sim") &&
    total <= Math.min(...RUN_PAGE_SIZES);
  const left = fitsSmallest
    ? ""
    : `<span class="runs-pager-sizes">Per page: ${sizes}</span>`;

  if (total <= perPage) {
    if (fitsSmallest) {
      return "";
    }
    const noun = total === 1 ? "run" : "runs";
    const count =
      surface === "redteam"
        ? ""
        : `<span class="runs-pager-count">Total ${total} ${noun}</span>`;
    return `<nav class="runs-pager" aria-label="Pagination">${left}<span class="runs-pager-right">${count}</span></nav>`;
  }

  const lo = (current - 1) * perPage + 1;
  const hi = Math.min(current * perPage, total);
  const count = `<span class="runs-pager-count">${lo}&ndash;${hi} of ${total}</span>`;
  const nav =
    link("&lsaquo; Prev", current - 1, perPage, { disabled: current <= 1 }) +
    link("Next &rsaquo;", current + 1, perPage, { disabled: current >= last });
  return (
    `<nav class="runs-pager" aria-label="Pagination">${left}` +
    `<span class="runs-pager-right">${count}<span class="runs-pager-nav">${nav}</span></span></nav>`
  );
}

function ago(when: Date, now = new Date()): string {
  const secs = Math.max(0, Math.trunc((now.getTime() - when.getTime()) / 1000));
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m ago`;
  }
  if (secs < 86400) {
    return `${Math.floor(secs / 3600)}h ago`;
  }
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) {
    return `${pyFixed(n / 1_000_000, 1)}M`;
  }
  if (n >= 1_000) {
    return `${pyFixed(n / 1_000, 1)}K`;
  }
  return String(n);
}

export function runCompareControl(
  rid: string,
  choices: ReadonlyArray<readonly [string, string]>,
  action: string,
): string {
  const others = choices.filter(([r]) => r !== rid);
  if (others.length === 0) {
    return "";
  }
  const opts = others
    .map(([r, name]) => `<option value="${esc(r)}">${esc(name)}</option>`)
    .join("");
  return (
    `<form class="cmp-bar" action="${esc(action)}" method="get">` +
    `<input type="hidden" name="a" value="${esc(rid)}">` +
    '<span class="cmp-bar-label">Compare with</span>' +
    `<select name="b" aria-label="Run B">${opts}</select>` +
    '<button type="submit" class="btn-secondary">Compare</button>' +
    "</form>"
  );
}

function spendCard(data: SimOverview | RedTeamOverview): KpiCard {
  const card: KpiCard = {
    label: "Total spend",
    value: fmtSpend(data.totalCost),
  };
  if (data.totalCost !== null) {
    const sub = spendCoverage(data);
    if (sub) {
      card.sub = sub;
    }
  }
  return card;
}

export function simOverviewBody(data: SimOverview, now = new Date()): string {
  if (data.totalRuns === 0) {
    return runsScreenBody([], "sim");
  }
  const gc = data.goalCompletion === null ? "—" : pct(data.goalCompletion);
  let goalSub = `${int(data.achieved)} of ${int(data.simulationsRun)} conversations achieved the goal`;
  if (data.goalCompletion === null) {
    goalSub = "No goal verdict available";
  }
  if (data.errors) {
    goalSub += ` · ${int(data.errors)} errored`;
  }
  const band = kpiCards(
    [
      {
        label: "Goal completion",
        value: gc,
        status: goalStatus(data.goalCompletion),
        sub: goalSub,
      },
      { label: "Simulations run", value: int(data.simulationsRun) },
      {
        label: "Avg turns",
        value: data.avgTurns === null ? "—" : pyFixed(data.avgTurns, 1),
      },
      spendCard(data),
    ],
    "strip",
  );
  return runOverview(data, "sim", band, now);
}

export function searchResults(
  cards: readonly ReportCard[],
  query: string,
): string {
  const q = query.trim().toLowerCase();
  if (!q) {
    return "";
  }
  const hits = cards.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (SURFACE_LABELS[c.surface] ?? c.surface).toLowerCase().includes(q),
  );
  if (hits.length === 0) {
    return '<div class="search-empty">No matching reports.</div>';
  }
  return hits
    .slice(0, 10)
    .map((c) => {
      const label = SURFACE_LABELS[c.surface] ?? c.surface;
      return (
        `<a class="search-hit" href="/r/${esc(c.id)}">` +
        `<span class="search-hit-kind">${esc(label)}</span>` +
        `<span class="search-hit-name">${esc(c.name)}</span></a>`
      );
    })
    .join("");
}

export function redteamOverviewBody(
  data: RedTeamOverview,
  now = new Date(),
): string {
  if (data.totalRuns === 0) {
    return runsScreenBody([], "redteam");
  }
  const asr = data.breakRate === null ? "—" : pct(data.breakRate);
  const cls = asrCls(data.breakRate);
  const asrCard: KpiCard = {
    label: "ASR",
    value: asr,
    status: ASR_KPI_STATUS[cls] ?? "neutral",
  };
  if (data.breakRate !== null) {
    asrCard.sub = ASR_SUB[cls];
  }
  const band = kpiCards(
    [
      asrCard,
      {
        label: "Critical findings",
        value: int(data.criticalFindings),
        status: data.criticalFindings ? "fail" : "pass",
      },
      { label: "Attacks run", value: int(data.attacksRun) },
      spendCard(data),
    ],
    "strip",
  );
  return runOverview(data, "redteam", band, now);
}

function runOverview(
  data: SimOverview | RedTeamOverview,
  surface: string,
  band: string,
  now: Date,
): string {
  const pager = runPager(surface, data.page, data.totalRuns, data.perPage);
  const runsPanel = panel(
    "Recent runs",
    "",
    runGrid(data.recent, surface === "redteam", now) + pager,
    { cls: pager ? "" : "panel--flush", titleTag: "h2" },
  );
  const scope =
    data.totalRuns !== 1 ? `All ${int(data.totalRuns)} runs` : "1 run";
  const surfaceClass = surface === "redteam" ? "rt-overview" : "sim-overview";
  return (
    `<section class="dash-wrap run-overview ${surfaceClass}">` +
    `<p class="rt-scope">${scope}</p>${band}${runsPanel}</section>`
  );
}

function fmtSpend(cost: number | null): string {
  return cost !== null && cost >= 1
    ? `$${groupThousands(pyFixed(cost, 2))}`
    : fmtCost(cost);
}

function spendCoverage(data: SimOverview | RedTeamOverview): string {
  let text = coverage(
    data.pricedCalls,
    data.costCalls,
    data.unknownCalls,
  ).trim();
  if (text.startsWith("(")) {
    text = text.slice(1);
  }
  if (text.endsWith(")")) {
    text = text.slice(0, -1);
  }
  const idx = text.indexOf(", ");
  let head = idx === -1 ? text : text.slice(0, idx);
  const rest = idx === -1 ? "" : text.slice(idx);
  if (head.endsWith(" calls")) {
    head += " priced";
  }
  return head + rest;
}

export function runsScreenBody(
  rows: readonly RunRow[],
  surface: string,
): string {
  const label = SURFACE_LABELS[surface] ?? "Reports";
  if (rows.length === 0) {
    return (
      '<section class="runs-screen"><div class="runs-card">' +
      '<div class="runs-empty">No reports found for this surface. ' +
      `Run a ${esc(label.toLowerCase())} job to generate one.</div>` +
      "</div></section>"
    );
  }
  const head =
    '<div class="runs-head"><span>Job</span><span>Score</span><span>Status</span><span></span></div>';
  const body = rows.map((r) => runRow(r, false)).join("");
  return `<section class="runs-screen"><div class="runs-card">${head}<div class="run-list">${body}</div></div></section>`;
}

const ARROW_LEFT =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
const DOWNLOAD_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
  '<path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

const BACK_LABELS: Readonly<Record<string, string>> = {
  redteam: "Red team runs",
  sim: "Agent sim runs",
  pairwise: "Pairwise runs",
};

export function reportBackLink(surface: string): string {
  const target = surface in BACK_LABELS ? `/?surface=${esc(surface)}` : "/";
  const label = BACK_LABELS[surface] ?? "All runs";
  return `<a class="report-back" href="${target}">${ARROW_LEFT} ${esc(label)}</a>`;
}

export function reportActions(rid: string): string {
  return `<a class="btn-secondary" href="/r/${esc(rid)}/export.html">${DOWNLOAD_ICON} Export</a>`;
}

export const MODEL_FIELDS: Readonly<Record<string, readonly [string, string]>> =
  {
    fast_model: ["Fast model", "Trace search, simulated users"],
    smart_model: [
      "Smart model",
      "Attack generation, judges, Insights summaries, apply-recommendations",
    ],
    classifier_model: ["Classifier model", "Ask AI, Insights labels, signals"],
    embedding_model: ["Embedding model", "Insights maps"],
  };

export function modelFieldRole(name: string): Role {
  return name.replace(/_model$/, "") as Role;
}

export function modelFieldSource(name: string): [string, string] {
  const role = modelFieldRole(name);
  const source = roleSource(role);
  if (source === "flag") {
    return [roleModel(role), `Set by --${role}-model`];
  }
  if (source === "env") {
    return [roleModel(role), `Set by ${ROLE_ENV[role]}`];
  }
  return ["", ""];
}

export type ModelGroups = Readonly<Record<string, readonly string[]>>;

export function modelControl(
  name: string,
  value: string,
  groups: ModelGroups,
  options: { label: string; note?: string; default?: string },
): string {
  const { label, note = "" } = options;
  const dflt = options.default ? `${options.default} (default)` : "";
  const noteHtml = note
    ? `<span class="settings-auth-hint">${esc(note)}</span>`
    : "";
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    const hint = dflt ? `placeholder="${esc(dflt)}"` : "required";
    return `<input id="${esc(name)}" name="${esc(name)}" type="text" value="${esc(value)}" ${hint}>${noteHtml}`;
  }
  const known = !value || entries.some(([, ids]) => ids.includes(value));
  const useDefault =
    `<button type="button" class="model-option${value ? "" : " is-selected"}" data-model=""` +
    ` aria-pressed="${value ? "false" : "true"}">Use default</button>`;
  const items: string[] = dflt ? [useDefault] : [];
  const subs: string[] = [];
  const all: Array<[string, readonly string[]]> = [...entries, ["Custom…", []]];
  all.forEach(([provider, ids], index) => {
    const key = `${name}-${index}`;
    const chosen = ids.length ? ids.includes(value) : Boolean(value) && !known;
    items.push(
      `<button type="button" class="facet-item" data-facet="${esc(key)}" aria-haspopup="true" aria-expanded="false">` +
        `<span>${esc(provider)}</span>${chosen ? "<span class=count>✓</span>" : ""}` +
        '<span class="chev" aria-hidden="true">&rsaquo;</span></button>',
    );
    let body: string;
    if (ids.length) {
      const prefix = `${provider}/`;
      const opts = ids
        .map((model) => {
          const on = model === value;
          const shown = model.startsWith(prefix)
            ? model.slice(prefix.length)
            : model;
          return (
            `<button type="button" class="model-option${on ? " is-selected" : ""}" data-model="${esc(model)}"` +
            ` aria-pressed="${on ? "true" : "false"}">${esc(shown)}</button>`
          );
        })
        .join("");
      body =
        `<input class="facet-search" type="search" placeholder="Search models" aria-label="Search ${esc(provider)} models" autocomplete="off">` +
        `<div class="facet-values">${opts}</div>` +
        '<p class="facet-no-results" hidden>No matching models.</p>';
    } else {
      body =
        `<input class="model-custom" type="text" value="${known ? "" : esc(value)}" ` +
        `placeholder="provider/model" aria-label="${esc(label)} (custom)">`;
    }
    subs.push(
      `<div class="facet-sub" data-facet-sub="${esc(key)}" hidden><div class="hd">${esc(provider)}</div>${body}</div>`,
    );
  });
  return (
    `<span class="model-pick"><input type="hidden" name="${esc(name)}" value="${esc(value)}">` +
    `<button type="button" id="${esc(name)}" class="model-pick-btn" data-default="${esc(dflt)}" aria-haspopup="true" aria-expanded="false">${esc(value || dflt || "Choose a model")}</button>` +
    `<div class="finder-facets"><div class="facet-list">${items.join("")}</div>${subs.join("")}</div></span>${noteHtml}`
  );
}

export function settingsModelControl(
  name: string,
  value: string,
  groups: ModelGroups,
  note = "",
): string {
  return modelControl(name, value, groups, {
    label: MODEL_FIELDS[name][0],
    note,
    default: BUILTIN[modelFieldRole(name)],
  });
}

const OAUTH_BADGES: Readonly<Record<string, [string, string]>> = {
  valid: ["passed", "Valid"],
  "signed-out": ["failed", "Signed out"],
  unknown: ["cancelled", "Couldn't check"],
  unreadable: ["failed", "Unreadable"],
};

function pickRow(title: string, note = "", badge?: [string, string]): string {
  const noteHtml = note ? `<span class="config-note">${esc(note)}</span>` : "";
  const badgeHtml = badge
    ? `<span class="status-badge ${badge[0]}"><span class="dot"></span>${esc(badge[1])}</span>`
    : "";
  return `<span class="rich-pick-id"><strong>${esc(title)}</strong>${noteHtml}</span>${badgeHtml}`;
}

const stripSlash = (text: string): string => text.replace(/\/+$/, "");

function richPick(
  name: string,
  value: string,
  options: ReadonlyArray<readonly [string, string]>,
  opts: {
    disabled?: readonly string[];
    current?: string;
    describedby?: string;
    compact?: boolean;
    filterable?: boolean;
  } = {},
): string {
  const {
    disabled = [],
    current = "",
    describedby = "",
    compact = false,
    filterable = false,
  } = opts;
  const match = value
    ? options.find(([option]) => stripSlash(option) === stripSlash(value))
    : undefined;
  const selected = match ? match[1] : current;
  const buttons = options
    .map(([option, row]) => {
      const on = row === selected;
      return (
        `<button type="button" class="model-option${on ? " is-selected" : ""}" data-model="${esc(option)}"` +
        ` data-rich aria-pressed="${on ? "true" : "false"}">${row}</button>`
      );
    })
    .join("");
  const rowsOff = disabled
    .map(
      (row) =>
        `<div class="rich-pick-disabled" aria-disabled="true">${row}</div>`,
    )
    .join("");
  const described = describedby
    ? ` aria-describedby="${esc(describedby)}"`
    : "";
  const searchHtml = filterable
    ? `<input class="facet-search" type="search" placeholder="Search" aria-label="Search ${esc(name.replaceAll("_", " "))} options" autocomplete="off">` +
      '<div class="facet-values">'
    : "";
  const emptyHtml = filterable
    ? '</div><p class="facet-no-results" hidden>No matches.</p>'
    : "";
  return (
    `<span class="model-pick rich-pick${compact ? " rich-pick--compact" : ""}${filterable ? " rich-pick--filter" : ""}">` +
    `<input type="hidden" name="${esc(name)}" value="${esc(value)}">` +
    `<button type="button" id="${esc(name)}" class="model-pick-btn" aria-haspopup="true" aria-expanded="false"${described}>` +
    `${selected}</button>` +
    '<div class="finder-facets"><div class="facet-list">' +
    `${searchHtml}${buttons}${rowsOff}${emptyHtml}` +
    "</div></div></span>"
  );
}

export interface OAuthSessionView {
  server: string;
  host: string;
  user: string | null;
  workspace: string | null;
  status: string;
}

export function oauthSessionField(
  value: string,
  sessions: readonly OAuthSessionView[],
): string {
  if (sessions.length === 0) {
    return (
      '<label class="settings-auth-detail-label" for="orq_oauth_server">Orq server</label>' +
      `<input id="orq_oauth_server" name="orq_oauth_server" type="url" value="${esc(value)}">`
    );
  }
  const options: Array<[string, string]> = [];
  if (sessions.every((s) => stripSlash(s.server) !== stripSlash(value))) {
    options.push([
      value,
      pickRow(value, "No saved login on this server", ["failed", "No login"]),
    ]);
  }
  const disabled = sessions
    .filter((s) => s.status === "unreadable")
    .map((s) =>
      pickRow(
        s.host,
        `Run orq auth login for ${s.host}`,
        OAUTH_BADGES.unreadable,
      ),
    );
  for (const s of sessions) {
    if (s.status !== "unreadable") {
      const account = [s.user, s.workspace].filter(Boolean).join(" · ");
      options.push([
        s.server,
        pickRow(s.host, account, OAUTH_BADGES[s.status]),
      ]);
    }
  }
  return (
    '<label class="settings-auth-detail-label" for="orq_oauth_server">CLI session</label>' +
    richPick("orq_oauth_server", value, options, { disabled })
  );
}

export function oauthScopeField(
  scope: OAuthScopes,
  workspace: string,
  projectId: string,
): string {
  if (scope.error && scope.workspaces.length === 0) {
    return (
      `<p class="settings-error">${esc(scope.error)}</p>` +
      `<input type="hidden" name="orq_workspace" value="${esc(workspace)}">` +
      `<input type="hidden" name="orq_project_id" value="${esc(projectId)}">`
    );
  }
  if (scope.workspaces.length === 0) {
    return '<p class="settings-auth-hint">No workspaces available for this CLI session.</p>';
  }
  const workspaceIds = new Map(scope.workspaces.map((w) => [w.key, w.id]));
  const ws = workspaceIds.has(workspace) ? workspace : "";
  const selectedId = workspaceIds.get(ws);
  const workspaces = scope.workspaces.map(
    (w) => [w.key, pickRow(w.key)] as [string, string],
  );
  const projects: Array<[string, string]> = [["", pickRow("All projects")]];
  for (const p of scope.projects) {
    if (p.workspaceId === selectedId) {
      projects.push([p.id, pickRow(p.name, p.id)]);
    }
  }
  let project = projectId;
  if (!scope.error && !projects.some(([option]) => option === project)) {
    project = "";
  }
  const projectCurrent =
    scope.error && project ? pickRow(project) : projects[0][1];
  const errorHtml = scope.error
    ? `<span class="settings-error" role="alert">${esc(scope.error)}</span>`
    : "";
  const placeholder =
    '<span class="rich-pick-placeholder">Choose a workspace</span>';
  return (
    '<label class="settings-auth-detail-label" for="orq_workspace">Workspace</label>' +
    richPick("orq_workspace", ws, workspaces, {
      current: placeholder,
      filterable: true,
    }) +
    '<label class="settings-auth-detail-label" for="orq_project_id">Project</label>' +
    richPick("orq_project_id", project, projects, {
      current: projectCurrent,
      filterable: true,
    }) +
    errorHtml
  );
}

export interface CliProfileView {
  name: string;
  server: string | null;
  apiKey: string;
}

export function profileField(
  chosen: string,
  profiles: readonly CliProfileView[],
  describedby = "",
): string {
  const options: Array<[string, string]> = [];
  const disabled: string[] = [];
  let current = '<span class="rich-pick-placeholder">Choose a profile</span>';
  if (chosen && profiles.every((p) => p.name !== chosen)) {
    current = pickRow(chosen, "Not in the Orq CLI any more", [
      "failed",
      "Unavailable",
    ]);
    disabled.push(current);
  }
  for (const p of profiles) {
    const server = p.server || "Default Orq server";
    if (p.apiKey.includes("*")) {
      const row = pickRow(p.name, server, ["failed", "Key hidden"]);
      disabled.push(row);
      if (p.name === chosen) {
        current = row;
      }
    } else {
      options.push([p.name, pickRow(p.name, server)]);
    }
  }
  return richPick("orq_profile", chosen, options, {
    disabled,
    current,
    describedby,
    compact: true,
  });
}

export const MODEL_FIELD_TRIGGER =
  "load, change[['orq_auth_method','orq_profile','orq_oauth_server'].includes(target.name)] " +
  "from:closest form delay:10ms";

function modelFieldInclude(name: string): string {
  return (
    `#${name}-field input[name=${name}], input[name=orq_auth_method]:checked, ` +
    "input[name=orq_profile], input[name=orq_oauth_server]"
  );
}

function urlencode(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([k, v]) => {
      const enc = (t: string) =>
        encodeURIComponent(t)
          .replace(
            /[!'()*]/g,
            (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
          )
          .replace(/%20/g, "+");
      return `${enc(k)}=${enc(v)}`;
    })
    .join("&");
}

/** Settings values keyed by the Python snake_case field names. */
export type SettingsValues = Readonly<Record<string, unknown>>;

export function settingsBody(
  config: ReadonlyArray<readonly [string, string | readonly string[]]>,
  settings: SettingsValues,
  options: {
    errors?: Readonly<Record<string, string>>;
    saved?: boolean;
    preview?: boolean;
    profiles?: readonly CliProfileView[];
  } = {},
): string {
  const {
    errors = {},
    saved = false,
    preview = false,
    profiles = [],
  } = options;
  const settingValue = (name: string): string => {
    const value = settings[name];
    return value === null || value === undefined ? "" : String(value);
  };

  const fieldRows: string[] = [];
  for (const [name, [label, hint]] of Object.entries(MODEL_FIELDS)) {
    const error = errors[name];
    const errorHtml = error
      ? `<span class="settings-error">${esc(error)}</span>`
      : "";
    const [pinned, note] = modelFieldSource(name);
    const control =
      `<span class="settings-model-field" id="${esc(name)}-field" hx-get="/settings/models?field=${esc(name)}" ` +
      `hx-trigger="${esc(MODEL_FIELD_TRIGGER)}" hx-include="${esc(modelFieldInclude(name))}" ` +
      `hx-swap="innerHTML">${settingsModelControl(name, pinned || settingValue(name), {}, note)}</span>`;
    fieldRows.push(
      `<div class="config-row settings-field"><label class="config-key" for="${esc(name)}">${esc(label)}</label>` +
        `<span class="config-val">${control}${errorHtml}<span class="settings-auth-hint">${esc(hint)}</span></span></div>`,
    );
  }
  const traceInputError = errors.trace_input_chars;
  const traceInputErrorHtml = traceInputError
    ? `<span class="settings-error" role="alert">${esc(traceInputError)}</span>`
    : "";
  fieldRows.push(
    '<div class="config-row settings-field"><label class="config-key" for="trace_input_chars">' +
      'Model input cap</label><span class="config-val">' +
      `<input id="trace_input_chars" name="trace_input_chars" type="number" min="${MIN_TRACE_INPUT_CHARS}" ` +
      `max="${MAX_TRACE_INPUT_CHARS}" step="1" ` +
      `value="${esc(settingValue("trace_input_chars") || String(DEFAULT_TRACE_INPUT_CHARS))}">` +
      `${traceInputErrorHtml}<span class="settings-auth-hint">Maximum characters sent to model requests, ` +
      "after scrubbing and before model-specific compression. Stored trace data is unchanged.</span>" +
      "</span></div>",
  );
  const pinnedTasks: Array<[string, { model: string; label: string }]> = [];
  for (const task of Object.keys(TASKS)) {
    const found = taskOverride(task);
    if (found) {
      pinnedTasks.push([task, found]);
    }
  }
  if (pinnedTasks.length) {
    const lines = pinnedTasks
      .map(
        ([task, { model, label }]) =>
          `<span class="config-val-item">${esc(task)} → ${esc(model)} (${esc(label)})</span>`,
      )
      .join("");
    fieldRows.push(
      '<div class="config-row"><span class="config-key">Task overrides</span>' +
        `<span class="config-val">${lines}<span class="settings-auth-hint">Set with --model-override or in the settings file.</span></span></div>`,
    );
  }
  const selectOptions = (
    current: string,
    pairs: ReadonlyArray<readonly [string, string]>,
  ): string =>
    pairs
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`,
      )
      .join("");
  const modeOptions = selectOptions(
    settingValue("ask_ai_mode") || "immediate",
    [
      ["immediate", "Just proceed"],
      ["review", "Review first"],
    ],
  );
  fieldRows.push(
    '<div class="config-row settings-field"><label class="config-key" for="ask_ai_mode">Ask AI on traces</label>' +
      `<span class="config-val"><span class="settings-select"><select id="ask_ai_mode" name="ask_ai_mode">${modeOptions}</select></span></span></div>`,
  );
  const filterOptions = selectOptions(
    settingValue("filter_selection") || "llm+jev",
    [
      ["llm+jev", "LLM + Jev"],
      ["llm", "LLM only"],
    ],
  );
  fieldRows.push(
    '<div class="config-row settings-field"><label class="config-key" for="filter_selection">Trace filters</label>' +
      `<span class="config-val"><span class="settings-select"><select id="filter_selection" name="filter_selection">${filterOptions}</select></span>` +
      '<span class="settings-auth-hint">Choose how natural-language trace metadata filters are selected.</span></span></div>',
  );
  let toastText = "";
  if (preview) {
    toastText = "Profile preview. Change a setting to save it.";
  } else if (saved) {
    toastText = "Settings saved";
  }
  const toastHtml =
    `<div id="settings-toast" class="settings-toast${toastText ? " show" : ""}" role="status" aria-live="polite">` +
    `${toastText}</div>`;
  const formError =
    "form" in errors
      ? `<p class="settings-error" role="alert">${esc(errors.form)}</p>`
      : "";
  const chosen = settingValue("orq_profile");
  const method =
    settingValue("orq_auth_method") || (chosen ? "cli_profile" : "environment");
  const profileError = errors.orq_profile;
  const profileErrorHtml = profileError
    ? `<span id="orq_profile_error" class="settings-error">${esc(profileError)}</span>`
    : "";
  const keyError = errors.orq_api_key_entry;
  const keyErrorHtml = keyError
    ? `<span class="settings-error" role="alert">${esc(keyError)}</span>`
    : "";
  const savedKeyHint = settingValue("orq_api_key_ciphertext")
    ? '<span class="settings-auth-hint">Leave blank to keep the saved API key.</span>'
    : "";
  const oauthServer = settingValue("orq_oauth_server") || DEFAULT_ORQ_BASE_URL;
  const oauthControl =
    `<span class="settings-oauth-field" hx-get="/settings/oauth-sessions?${esc(urlencode({ value: oauthServer }))}" ` +
    'hx-trigger="load" hx-swap="outerHTML">' +
    '<span class="settings-auth-detail-label">CLI session</span>' +
    `<input type="hidden" name="orq_oauth_server" value="${esc(oauthServer)}">` +
    '<span class="settings-auth-hint">Checking CLI sessions…</span></span>';
  const oauthScope =
    '<span class="settings-auth-scope" id="oauth-scope" hx-get="/settings/oauth-scope" ' +
    "hx-trigger=\"load, change[['orq_oauth_server','orq_workspace'].includes(target.name)] " +
    'from:closest form delay:10ms" ' +
    'hx-include="input[name=orq_oauth_server], #oauth-scope [name=orq_workspace], ' +
    '#oauth-scope [name=orq_project_id]" hx-swap="innerHTML">' +
    `<input type="hidden" name="orq_workspace" value="${esc(settingValue("orq_workspace"))}">` +
    `<input type="hidden" name="orq_project_id" value="${esc(settingValue("orq_project_id"))}">` +
    '<span class="settings-auth-hint">Loading workspaces and projects…</span></span>';
  const scopeError = errors.orq_workspace || errors.orq_project_id;
  const scopeErrorHtml = scopeError
    ? `<span class="settings-error" role="alert">${esc(scopeError)}</span>`
    : "";
  const cards: Array<[string, string, string, string]> = [
    [
      "environment",
      "Environment",
      "Use ORQ_API_KEY from the dashboard process.",
      "",
    ],
    [
      "cli_profile",
      "CLI API-key profile",
      "Reuse an API-key profile saved by the Orq CLI.",
      '<label class="settings-auth-detail-label" for="orq_profile">CLI profile</label>' +
        profileField(
          chosen,
          profiles,
          profileError ? "orq_profile_error" : "",
        ) +
        profileErrorHtml,
    ],
    [
      "cli_oauth",
      "CLI OAuth",
      "Use the current Orq CLI sign-in and let the CLI refresh its session.",
      `${oauthControl}${oauthScope}${scopeErrorHtml}` +
        '<span class="settings-auth-hint">Sign a session back in with ' +
        "<code>orq auth login --server &lt;url&gt;</code>.</span>",
    ],
    [
      "stored_api_key",
      "Enter API key",
      "Keep an encrypted copy in this dashboard's config file.",
      '<label class="settings-auth-detail-label" for="orq_api_key_entry">API key</label>' +
        '<input id="orq_api_key_entry" name="orq_api_key_entry" type="password" autocomplete="new-password" ' +
        'placeholder="Paste API key">' +
        `${savedKeyHint}${keyErrorHtml}` +
        '<label class="settings-auth-detail-label" for="orq_stored_key_host">Orq server</label>' +
        '<input id="orq_stored_key_host" name="orq_stored_key_host" type="url" ' +
        `value="${esc(settingValue("orq_profile_host") || DEFAULT_ORQ_BASE_URL)}">`,
    ],
  ];
  const authRows = [
    '<p class="settings-auth-step">1 · Choose a method</p>',
    '<div class="settings-auth-choices" role="radiogroup" aria-label="Authentication method">',
  ];
  for (const [value, title, description] of cards) {
    const checked = method === value ? " checked" : "";
    authRows.push(
      '<div class="settings-auth-choice">' +
        `<label class="settings-auth-card"><input type="radio" name="orq_auth_method" value="${value}"${checked}>` +
        `<span class="settings-auth-card-copy"><strong>${esc(title)}</strong><small>${esc(description)}</small></span>` +
        '<span class="settings-auth-card-check" aria-hidden="true"></span></label></div>',
    );
  }
  authRows.push("</div>");
  const selectedProfile = profiles.find((p) => p.name === chosen);
  let profileNote: string;
  if (chosen && selectedProfile === undefined) {
    profileNote = `The saved Orq CLI profile “${chosen}” is unavailable. Choose another credential source.`;
  } else if (chosen && selectedProfile?.apiKey.includes("*")) {
    profileNote = `The saved Orq CLI profile “${chosen}” does not expose its API key. Choose another source.`;
  } else if (chosen) {
    profileNote =
      "Uses the API key and host from this local Orq CLI profile. Settings saves its name, not its key.";
  } else {
    profileNote = "Choose a local Orq CLI API-key profile.";
  }
  authRows.push(
    '<div class="settings-auth-config"><p class="settings-auth-step">2 · Configure the method</p>',
    '<div class="settings-auth-details">',
  );
  for (const [value, , , cardDetail] of cards) {
    let detail = cardDetail;
    if (value === "environment") {
      detail =
        '<p class="settings-auth-note">Uses ORQ_API_KEY and ORQ_BASE_URL from this dashboard process.</p>';
    } else if (value === "cli_profile") {
      detail += `<p class="settings-auth-note">${esc(profileNote)}</p>`;
    }
    authRows.push(
      `<div class="settings-auth-detail" data-auth-method="${value}">${detail}</div>`,
    );
  }
  authRows.push("</div>", "</div>");
  const modelsPanel = panel(
    "Models",
    "Window, limit and parallelism are set per run on the Trace search page",
    `<div class="config-list">${fieldRows.join("")}</div>` +
      '<p id="models-warning" class="settings-error settings-model-warning" role="alert"></p>',
  );
  const authPanel = panel(
    "Authentication",
    "Choose the credential used for traces and Insights runs",
    `<div class="config-list">${authRows.join("")}</div>`,
    { cls: "settings-auth-panel" },
  );
  const inspectorChecked =
    settingValue("compression_inspector_enabled").toLowerCase() === "true"
      ? " checked"
      : "";
  const advancedPanel =
    '<details class="settings-advanced"><summary>Advanced</summary>' +
    '<div class="settings-auth-choices settings-advanced-choices"><div class="settings-auth-choice">' +
    '<label class="settings-auth-card settings-switch-card"><input id="compression_inspector_enabled" ' +
    `name="compression_inspector_enabled" type="checkbox" role="switch" value="true"${inspectorChecked}>` +
    '<span class="settings-auth-card-copy"><strong>Compression inspector</strong>' +
    "<small>Adds a sidebar page that shows a trace next to the compressed text a model would read. " +
    "Local previews may expose sensitive original content. Previews do not call models.</small></span>" +
    '<span class="settings-switch" aria-hidden="true"></span></label></div></div></details>';
  const form =
    '<form class="settings-form" method="post" action="/settings">' +
    `${csrfField()}<input type="hidden" name="settings_changed_fields" ` +
    `value="${esc(settingValue("settings_changed_fields"))}">` +
    `${formError}${modelsPanel}${authPanel}${advancedPanel}` +
    "</form>" +
    toastHtml;
  const valHtml = (v: string | readonly string[]): string =>
    (typeof v === "string" ? [v] : v)
      .map((item) => `<span class="config-val-item">${esc(item)}</span>`)
      .join("");
  const rows = config
    .map(
      ([k, v]) =>
        `<div class="config-row"><span class="config-key">${esc(k)}</span>` +
        `<span class="config-val">${valHtml(v)}</span></div>`,
    )
    .join("");
  const configPanel = panel(
    "Configuration",
    "What this dashboard is reading",
    `<div class="config-list">${rows}</div>`,
  );
  return `<section class="dash-wrap">${form}${configPanel}</section>${SETTINGS_SCRIPT}`;
}

const SETTINGS_SCRIPT =
  '<script>document.addEventListener("DOMContentLoaded",function(){' +
  'const form=document.querySelector(".settings-form");if(!form)return;' +
  'const changed=form.querySelector("[name=settings_changed_fields]");' +
  "const dirtyRevision=new Map();let revision=0;" +
  'function markChanged(event){const field=event.target;if(!field.name||field.name.startsWith("settings_")||field.name==="csrf")return;' +
  'const names=new Set(changed.value.split(",").filter(Boolean));const changedAt=++revision;' +
  "function add(name){names.add(name);dirtyRevision.set(name,changedAt);}add(field.name);" +
  'if(field.name==="orq_oauth_server"){add("orq_workspace");add("orq_project_id");}' +
  'if(field.name==="orq_workspace")add("orq_project_id");' +
  'changed.value=Array.from(names).join(",");}' +
  'form.addEventListener("input",markChanged);form.addEventListener("change",markChanged);' +
  "function syncAuthFields(){" +
  'const selected=form.querySelector("input[name=orq_auth_method]:checked");' +
  "if(!selected)return;" +
  'form.querySelectorAll(".settings-auth-detail[data-auth-method]").forEach(function(panel){' +
  "const inactive=panel.dataset.authMethod!==selected.value;" +
  'panel.querySelectorAll("input,select,textarea").forEach(function(field){field.disabled=inactive;});' +
  "});" +
  "}" +
  'const toast=document.getElementById("settings-toast");let hideTimer=null;' +
  "function showToast(text,isError){" +
  'toast.textContent=text;toast.classList.toggle("is-error",!!isError);toast.classList.add("show");' +
  'clearTimeout(hideTimer);hideTimer=setTimeout(function(){toast.classList.remove("show");},isError?6000:2200);' +
  "}" +
  "if(toast.textContent)showToast(toast.textContent,false);" +
  "let saving=false,again=false,timer=null,scopeChanged=false;" +
  "function save(){" +
  "if(saving){again=true;return;}" +
  "saving=true;" +
  'const submitted=new FormData(form);const sentNames=new Set((submitted.get("settings_changed_fields")||"").split(",").filter(Boolean));' +
  "const sentRevision=new Map();sentNames.forEach(function(name){sentRevision.set(name,dirtyRevision.get(name)||0);});" +
  'fetch("/settings",{method:"POST",body:submitted,headers:{"X-Autosave":"1"}})' +
  ".then(function(response){return response.json().then(function(data){return {ok:response.ok,data:data};});})" +
  ".then(function(result){" +
  "if(result.ok){" +
  'document.querySelector(".app-sidebar").outerHTML=result.data.sidebar;' +
  'const key=form.querySelector("[name=orq_api_key_entry]");' +
  'if(key&&sentNames.has("orq_api_key_entry")&&(dirtyRevision.get("orq_api_key_entry")||0)===sentRevision.get("orq_api_key_entry")&&key.value===submitted.get("orq_api_key_entry"))key.value="";' +
  'const names=new Set(changed.value.split(",").filter(Boolean));' +
  "sentNames.forEach(function(name){if((dirtyRevision.get(name)||0)===sentRevision.get(name))names.delete(name);});" +
  'changed.value=Array.from(names).join(",");' +
  'showToast("Settings saved",false);' +
  '}else{showToast(Object.values(result.data.errors||{}).join(" ")||"Could not save settings",true);}' +
  "})" +
  '.catch(function(){showToast("Could not save settings",true);})' +
  ".finally(function(){saving=false;if(again){again=false;save();}});" +
  "}" +
  "function scheduleSave(){clearTimeout(timer);timer=setTimeout(save,250);}" +
  'form.addEventListener("submit",function(event){event.preventDefault();scheduleSave();});' +
  'form.addEventListener("change",function(event){' +
  "const name=event.target.name;" +
  'if(name==="orq_auth_method")syncAuthFields();' +
  'if(name==="orq_oauth_server"||name==="orq_workspace"){scopeChanged=true;return;}' +
  "scheduleSave();" +
  "});" +
  'document.body.addEventListener("htmx:afterSettle",function(event){' +
  'if(scopeChanged&&event.target.id==="oauth-scope"){scopeChanged=false;scheduleSave();}' +
  "});" +
  'form.addEventListener("htmx:load",syncAuthFields);' +
  "syncAuthFields();" +
  "});</script>";

const BACK_TO_REPORTS = '<p><a href="/">Back to reports</a></p>';

export function reportNotFound(rid: string): string {
  return (
    '<section class="report-not-found">' +
    "<h1>Report not found</h1>" +
    `<p>No report with id <code>${esc(rid)}</code> could be located.</p>` +
    BACK_TO_REPORTS +
    "</section>"
  );
}

export function reportInFlight(manifest: RunManifest): string {
  const status = String(manifest.status);
  const surface = String(manifest.surface);
  const label = SURFACE_LABELS[surface] ?? surface;
  const stage = manifest.stage || "—";
  const rows = manifest.stages.map((rec) => {
    const secs = durationSeconds(rec);
    const dur = secs !== null ? `${pyFixed(secs, 1)}s` : "…";
    const target = rec.target ? ` (${esc(rec.target)})` : "";
    return (
      `<div class="config-row"><span class="config-key">${esc(rec.name)}${target}</span>` +
      `<span class="config-val">${esc(String(rec.status))} · ${esc(dur)}</span></div>`
    );
  });
  const stagesHtml =
    rows.join("") ||
    '<div class="config-row"><span class="config-val">No stages recorded.</span></div>';
  const errHtml = manifest.error
    ? `<p class="report-broken-detail">${esc(manifest.error)}</p>`
    : "";
  return (
    '<section class="report-in-flight">' +
    `<h1>${esc(manifest.runName)}</h1>` +
    `<p>${esc(label)} run — ${runStatusBadge(status)} · current stage: <code>${esc(stage)}</code></p>` +
    errHtml +
    `<div class="config-list">${stagesHtml}</div>` +
    BACK_TO_REPORTS +
    "</section>"
  );
}

export function reportBroken(
  _rid: string,
  filename: string,
  detail: string,
): string {
  return (
    '<section class="report-broken">' +
    "<h1>Report could not be loaded</h1>" +
    `<p class="report-broken-filename">File: <code>${esc(filename)}</code></p>` +
    `<p class="report-broken-detail">${esc(detail)}</p>` +
    BACK_TO_REPORTS +
    "</section>"
  );
}

type FilterOptions = Readonly<Record<string, readonly string[]>>;

const SLIDERS_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>' +
  '<line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>' +
  '<line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>' +
  '<line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>' +
  '<line x1="17" y1="16" x2="23" y2="16"/>' +
  "</svg>";
const FILTER_CHEVRON =
  '<svg class="filter-dd-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"' +
  ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m6 9 6 6 6-6"/></svg>';
const RAIL_HEADER = `<div class="filter-rail-header">${SLIDERS_ICON}<span class="filter-rail-title">Filters</span></div>`;

const GOAL_OUTCOME_DOT_CLASS: Readonly<Record<string, string>> = {
  Achieved: "chip-dot-green",
  "Not achieved": "chip-dot-red",
};

function filterInputId(name: string, value: string): string {
  return `fc-${name}-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
}

function chip(
  name: string,
  value: string,
  checked: boolean,
  dotCls: string,
  label?: string,
): string {
  return (
    `<label class="filter-chip${checked ? " is-active" : ""}">` +
    `<input type="checkbox" id="${esc(filterInputId(name, value))}" class="filter-chip-input" name="${esc(name)}"` +
    ` value="${esc(value)}"${checked ? " checked" : ""}>` +
    `<span class="filter-chip-dot ${dotCls}" aria-hidden="true"></span>` +
    `<span class="filter-chip-check ${dotCls}" aria-hidden="true">✓</span>` +
    `<span class="filter-chip-label">${esc(label ?? value)}</span>` +
    "</label>"
  );
}

function dropdown(
  dim: string,
  label: string,
  dimOpts: readonly string[],
  sel: readonly string[],
): string {
  const selectedSet = new Set(sel.length ? sel : dimOpts);
  const nSelected = selectedSet.size;
  let statusCls: string;
  let statusLabel: string;
  let valueCls: string;
  if (nSelected === dimOpts.length) {
    [statusCls, statusLabel, valueCls] = ["is-all", "All", "filter-dd-value"];
  } else if (nSelected === 0) {
    [statusCls, statusLabel, valueCls] = [
      "is-none",
      "None",
      "filter-dd-value is-none",
    ];
  } else {
    [statusCls, statusLabel, valueCls] = [
      "is-partial",
      `${nSelected} selected`,
      "filter-dd-value is-engaged",
    ];
  }
  const rows = dimOpts
    .map(
      (opt) =>
        '<label class="filter-dd-row">' +
        `<input type="checkbox" id="${esc(filterInputId(dim, opt))}" name="${esc(dim)}" value="${esc(opt)}"` +
        `${selectedSet.has(opt) ? " checked" : ""}>` +
        `<span>${esc(opt)}</span>` +
        "</label>",
    )
    .join("");
  return (
    `<details id="filter-dd-${esc(dim)}" class="filter-dd">` +
    '<summary class="filter-dd-trigger">' +
    `<span class="filter-dd-status ${statusCls}"></span>` +
    `<span class="filter-dd-name">${esc(label)}</span>` +
    `<span class="${valueCls}">${esc(statusLabel)}</span>` +
    FILTER_CHEVRON +
    "</summary>" +
    `<div class="filter-dd-menu">${rows}</div>` +
    "</details>"
  );
}

function fmtRangeValue(value: number, step: string): string {
  return step === "1" ? String(Math.trunc(value)) : pyG(value);
}

function parseFloatStrict(raw: string): number | null {
  const value = Number(raw.trim());
  return raw.trim() === "" || Number.isNaN(value) ? null : value;
}

function rangeEngaged(
  sel: readonly string[],
  minVal: number,
  maxVal: number,
  floor: boolean,
): boolean {
  if (sel.length === 0) {
    return false;
  }
  const value = parseFloatStrict(sel[0]);
  if (value === null) {
    return false;
  }
  return value !== (floor ? minVal : maxVal);
}

function rangeControl(
  dim: string,
  label: string,
  opts: {
    minVal: number;
    maxVal: number;
    step: string;
    sel: readonly string[];
    floor: boolean;
    showMax?: boolean;
  },
): string {
  const { minVal, maxVal, step, sel, floor, showMax = false } = opts;
  const dflt = floor ? minVal : maxVal;
  const value = (sel.length ? parseFloatStrict(sel[0]) : null) ?? dflt;
  const engaged = rangeEngaged(sel, minVal, maxVal, floor);
  const readoutCls = engaged
    ? "filter-slider-readout is-engaged"
    : "filter-slider-readout";
  const glyph = floor ? "≥" : "≤";
  const readout = `${glyph} ${fmtRangeValue(value, step)}`;
  const maxSpan = showMax
    ? `<span class="filter-slider-max">/ ${fmtRangeValue(maxVal, step)}</span>`
    : "";
  return (
    `<div class="filter-group" data-dim="${esc(dim)}">` +
    `<label class="filter-label">${esc(label)}</label>` +
    '<div class="filter-slider-row">' +
    `<input type="range" class="filter-slider" name="${esc(dim)}" min="${fmtRangeValue(minVal, step)}"` +
    ` max="${fmtRangeValue(maxVal, step)}" step="${esc(step)}" value="${fmtRangeValue(value, step)}"` +
    ` data-glyph="${glyph}" data-default="${fmtRangeValue(dflt, step)}">` +
    `<span class="${readoutCls}">${esc(readout)}</span>` +
    maxSpan +
    "</div>" +
    "</div>"
  );
}

function intOption(opts: FilterOptions, key: string, fallback: number): number {
  const raw = opts[key]?.[0];
  return raw ? Number.parseInt(raw, 10) || fallback : fallback;
}

function minTurnsControl(
  opts: FilterOptions,
  selections: FilterOptions,
): string {
  const maxTurns = intOption(opts, "max_turns", 1);
  if (maxTurns <= 1) {
    return "";
  }
  return rangeControl("min_turns", "Min. Turns", {
    minVal: 1,
    maxVal: maxTurns,
    step: "1",
    sel: selections.min_turns ?? [],
    floor: true,
    showMax: true,
  });
}

function chipGroup(dim: string, label: string, chips: string): string {
  return (
    `<div class="filter-group" data-dim="${dim}">` +
    `<label class="filter-label">${label}</label>` +
    `<div class="filter-chip-row">${chips}</div>` +
    "</div>"
  );
}

function moreFilters(rows: string, badge = ""): string {
  return (
    '<details id="filter-dd-more" class="filter-dd filter-dd-more">' +
    '<summary class="filter-dd-trigger">' +
    '<span class="filter-dd-name">More filters</span>' +
    badge +
    FILTER_CHEVRON +
    "</summary>" +
    `<div class="filter-dd-more-body">${rows}</div>` +
    "</details>"
  );
}

function filterForm(rid: string, cls: string, inner: string): string {
  return (
    `<form id="filter-form" class="${cls}"` +
    ` hx-post="/r/${esc(rid)}/filter"` +
    ' hx-trigger="change"' +
    ' hx-target="#filter-swap"' +
    ' hx-swap="outerHTML">' +
    inner +
    "</form>"
  );
}

function shownCounter(shown?: number | null, total?: number | null): string {
  return shown != null && total != null && shown < total
    ? `${shown} of ${total} shown`
    : "Showing all results";
}

function simFilterRail(
  rid: string,
  opts: FilterOptions,
  selections: FilterOptions,
  shown?: number | null,
  total?: number | null,
): string {
  const goalSel = new Set(selections.goal_outcome ?? []);
  const goalChips = (opts.goal_outcome ?? [])
    .filter((o) => o in GOAL_OUTCOME_DOT_CLASS)
    .map((o) =>
      chip("goal_outcome", o, goalSel.has(o), GOAL_OUTCOME_DOT_CLASS[o]),
    )
    .join("");
  const termOpts = opts.terminated_by ?? [];
  const termSel = new Set(
    selections.terminated_by?.length ? selections.terminated_by : termOpts,
  );
  const termChips = termOpts
    .map((o) => chip("terminated_by", o, termSel.has(o), "chip-dot-jade"))
    .join("");
  const personaDd = dropdown(
    "persona",
    "Persona",
    opts.persona ?? [],
    selections.persona ?? [],
  );
  const scenarioDd = dropdown(
    "scenario",
    "Scenario",
    opts.scenario ?? [],
    selections.scenario ?? [],
  );
  const ruleChip = chip(
    "rule_broken",
    "yes",
    (selections.rule_broken ?? []).includes("yes"),
    "chip-dot-red",
  );
  const goalScoreCtrl = rangeControl("max_goal_score", "Max Goal Score", {
    minVal: 0,
    maxVal: 1,
    step: "0.05",
    sel: selections.max_goal_score ?? [],
    floor: false,
  });
  const moreRows: string[] = [];
  let moreActive = 0;
  const maxTotalTokens = intOption(opts, "max_total_tokens", 0);
  if (maxTotalTokens > 0) {
    const tokSel = selections.min_total_tokens ?? [];
    moreActive += Number(rangeEngaged(tokSel, 0, maxTotalTokens, true));
    moreRows.push(
      rangeControl("min_total_tokens", "Min. Total Tokens", {
        minVal: 0,
        maxVal: maxTotalTokens,
        step: "1",
        sel: tokSel,
        floor: true,
      }),
    );
  }
  const available = new Set(opts.metrics ?? []);
  for (const metric of TURN_METRICS) {
    if (!available.has(metric.key)) {
      continue;
    }
    const dimKey = `${metric.highIsRisky ? "min" : "max"}_${metric.key}`;
    const prefix = metric.highIsRisky ? "Min." : "Max.";
    const metricSel = selections[dimKey] ?? [];
    moreActive += Number(rangeEngaged(metricSel, 0, 1, metric.highIsRisky));
    moreRows.push(
      rangeControl(dimKey, `${prefix} ${titleCase(metric.label)}`, {
        minVal: 0,
        maxVal: 1,
        step: "0.05",
        sel: metricSel,
        floor: metric.highIsRisky,
      }),
    );
  }
  let moreDd = "";
  if (moreRows.length) {
    const badge = moreActive
      ? `<span class="filter-dd-more-badge">${moreActive}</span>`
      : "";
    moreDd = moreFilters(moreRows.join(""), badge);
  }
  const inner =
    RAIL_HEADER +
    chipGroup("rule_broken", "Rule Violations", ruleChip) +
    chipGroup("goal_outcome", "Goal Outcome", goalChips) +
    chipGroup("terminated_by", "Terminated By", termChips) +
    goalScoreCtrl +
    minTurnsControl(opts, selections) +
    `<div class="filter-group" data-dim="persona">${personaDd}</div>` +
    `<div class="filter-group" data-dim="scenario">${scenarioDd}</div>` +
    `<div class="filter-rail-footer">${esc(shownCounter(shown, total))}</div>` +
    (moreDd
      ? `<div class="filter-group filter-group--more" data-dim="more">${moreDd}</div>`
      : "");
  return filterForm(rid, "filter-form filter-form--sim", inner);
}

const RESULT_DOT_CLASS: Readonly<Record<string, string>> = {
  Vulnerable: "chip-dot-red",
  Resistant: "chip-dot-green",
  Error: "chip-dot-amber",
};

const SEVERITY_DOT_CLASS: Readonly<Record<string, string>> = {
  critical: "chip-dot-red",
  high: "chip-dot-amber",
  medium: "chip-dot-gray",
  low: "chip-dot-green",
};

function redteamFilterRail(
  rid: string,
  opts: FilterOptions,
  selections: FilterOptions,
  shown?: number | null,
  total?: number | null,
): string {
  const resultSel = new Set(selections.result ?? []);
  const resultChips = (opts.result ?? [])
    .map((o) =>
      chip(
        "result",
        o,
        resultSel.has(o),
        RESULT_DOT_CLASS[o] ?? "chip-dot-gray",
      ),
    )
    .join("");
  const sevOpts = opts.severity ?? [];
  const sevSel = new Set(
    selections.severity?.length ? selections.severity : sevOpts,
  );
  const severityChips = sevOpts
    .map((o) =>
      chip(
        "severity",
        o,
        sevSel.has(o),
        SEVERITY_DOT_CLASS[o.toLowerCase()] ?? "chip-dot-gray",
      ),
    )
    .join("");
  const categoryDd = dropdown(
    "category",
    "Category",
    opts.category ?? [],
    selections.category ?? [],
  );
  const agentOpts = opts.agent ?? [];
  const agentDd =
    agentOpts.length > 1
      ? dropdown("agent", "Agent", agentOpts, selections.agent ?? [])
      : "";
  const moreRows = (
    [
      ["technique", "Technique"],
      ["delivery_method", "Delivery Method"],
      ["vulnerability", "Vulnerability"],
    ] as const
  )
    .map(([dim, label]) =>
      dropdown(dim, label, opts[dim] ?? [], selections[dim] ?? []),
    )
    .join("");
  const inner =
    RAIL_HEADER +
    chipGroup("result", "Outcome", resultChips) +
    chipGroup("severity", "Severity", severityChips) +
    minTurnsControl(opts, selections) +
    `<div class="filter-group" data-dim="category">${categoryDd}</div>` +
    (agentDd
      ? `<div class="filter-group" data-dim="agent">${agentDd}</div>`
      : "") +
    `<div class="filter-rail-footer">${esc(shownCounter(shown, total))}</div>` +
    `<div class="filter-group filter-group--more" data-dim="more">${moreFilters(moreRows)}</div>`;
  return filterForm(rid, "filter-form filter-form--redteam", inner);
}

function pairwiseFilterRail(
  rid: string,
  opts: FilterOptions,
  selections: FilterOptions,
  shown?: number | null,
  total?: number | null,
): string {
  const winnerDots = [
    "chip-dot-pw-a",
    "chip-dot-pw-b",
    "chip-dot-pw-tie",
    "chip-dot-pw-none",
  ];
  const winnerOpts = (opts.winner ?? []).slice(0, winnerDots.length);
  const winnerSel = new Set(
    selections.winner?.length ? selections.winner : (opts.winner ?? []),
  );
  const winnerChips = winnerOpts
    .map((o, i) => chip("winner", o, winnerSel.has(o), winnerDots[i]))
    .join("");
  const panelChips = (
    [
      ["split", "Judges split", "chip-dot-amber"],
      ["thrown_out", "Vote thrown out", "chip-dot-red"],
      ["judge_failed", "Judge failed", "chip-dot-red"],
    ] as const
  )
    .map(([dim, label, dot]) =>
      chip(dim, "yes", (selections[dim] ?? []).includes("yes"), dot, label),
    )
    .join("");
  const judgeDd = dropdown(
    "judge",
    "Judge",
    opts.judge ?? [],
    selections.judge ?? [],
  );
  const filtered = shown != null && total != null && shown < total;
  const counter = filtered
    ? `${shown} of ${total} comparisons`
    : "Showing all comparisons";
  const footerCls = filtered
    ? "filter-rail-footer is-filtered"
    : "filter-rail-footer";
  const inner =
    RAIL_HEADER +
    chipGroup("winner", "Winner", winnerChips) +
    chipGroup("panel", "Panel", panelChips) +
    `<div class="filter-group" data-dim="judge">${judgeDd}</div>` +
    `<div class="${footerCls}">${esc(counter)}</div>`;
  return filterForm(
    rid,
    "filter-form filter-form--sim filter-form--pairwise",
    inner,
  );
}

/** Every surface with filter dimensions has its own rail; any other surface gets none. */
export function renderFilterForm(
  rid: string,
  surface: string,
  opts: FilterOptions,
  selections: FilterOptions,
  counts: { shown?: number | null; total?: number | null } = {},
): string {
  const { shown, total } = counts;
  if (surface === "sim") {
    return simFilterRail(rid, opts, selections, shown, total);
  }
  if (surface === "redteam") {
    return redteamFilterRail(rid, opts, selections, shown, total);
  }
  if (surface === "pairwise") {
    return pairwiseFilterRail(rid, opts, selections, shown, total);
  }
  return "";
}

export function filterFragment(
  rid: string,
  _surface: string,
  bodyHtml: string,
  formHtml: string,
): string {
  return (
    `<div id="filter-swap" class="filter-swap-container" data-rid="${esc(rid)}">` +
    `<div class="report-body-area">${bodyHtml}</div>${formHtml}</div>`
  );
}

export function reportViewWithFilters(
  rid: string,
  surface: string,
  bodyHtml: string,
  formHtml: string,
): string {
  return `<section class="report-view">${filterFragment(rid, surface, bodyHtml, formHtml)}</section>`;
}
