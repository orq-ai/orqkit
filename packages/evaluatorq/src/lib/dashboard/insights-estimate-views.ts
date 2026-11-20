import { esc } from "../common/reports/html-helpers.js";
import type { RunEstimate, StageEstimate } from "../insights/estimate.js";

const CODING_TITLE = "Coding questions (extra classify call)";

const grouped = (value: number, digits = 0) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function money(value: number): string {
  if (value === 0) return "$0.00";
  return value < 0.01 ? "<$0.01" : `$${grouped(value, 2)}`;
}

function duration(seconds: number): string {
  if (seconds < 90) return `${roundHalfEven(seconds)} s`;
  if (seconds < 5400) return `${roundHalfEven(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** One ceiling when the figures agree, else the range they span. */
function span(
  low: number,
  high: number,
  fmt: (value: number) => string,
  prefix = "",
): string {
  if (fmt(low) === fmt(high))
    return prefix ? `${prefix}${fmt(high)}` : `up to ${fmt(high)}`;
  return `${prefix}${fmt(low)} to ${fmt(high)}`;
}

function tracesValue(estimate: RunEstimate): string {
  const n = estimate.bound.n ?? 0;
  const noun = n === 1 ? "trace" : "traces";
  return estimate.bound.exact
    ? `${grouped(n)} ${noun}`
    : `up to ${grouped(n)} ${noun}`;
}

function costValue(estimate: RunEstimate): string {
  if (estimate.costLow === null || estimate.costHigh === null) return "unknown";
  const text = span(estimate.costLow, estimate.costHigh, money);
  return estimate.costPartial ? `${text} (priced stages only)` : text;
}

function timeValue(estimate: RunEstimate): string {
  if (estimate.secondsLow === null || estimate.secondsHigh === null)
    return estimate.timeNote || "unknown";
  const text = span(
    estimate.secondsLow,
    estimate.secondsHigh,
    duration,
    "about ",
  );
  return estimate.timePartial ? `${text} (timed stages only)` : text;
}

/** The one-line summary shown in the step bar. */
export function renderCompactEstimate(estimate: RunEstimate): string {
  const traces =
    estimate.bound.n === null ? "traces unknown" : tracesValue(estimate);
  return esc(
    `${traces} · cost ${costValue(estimate)} · time ${timeValue(estimate)}`,
  );
}

/** The step-bar line while the form cannot be estimated yet. */
export function renderEstimateUnavailable(message: string): string {
  return esc(`Estimate unavailable: ${message}`);
}

function stageTitle(row: StageEstimate, titles: Map<string, string>): string {
  return row.name === "label_coding"
    ? CODING_TITLE
    : (titles.get(row.name) ?? row.name);
}

function stageRow(row: StageEstimate, titles: Map<string, string>): string {
  const traces =
    row.tracesLow === row.tracesHigh
      ? grouped(row.tracesHigh)
      : `${grouped(row.tracesLow)} to ${grouped(row.tracesHigh)}`;
  const cost =
    row.costLow === null || row.costHigh === null
      ? "unknown"
      : span(row.costLow, row.costHigh, money);
  const time =
    row.secondsLow === null || row.secondsHigh === null
      ? "unknown"
      : span(row.secondsLow, row.secondsHigh, duration, "about ");
  return (
    `<tr><th scope="row">${esc(stageTitle(row, titles))}</th><td class="num">${esc(traces)}</td>` +
    `<td class="num">${esc(cost)}</td><td class="num">${esc(time)}</td>` +
    `<td class="irf-estimate-basis">${esc(row.basis)}</td></tr>`
  );
}

function total(label: string, value: string, basis: string): string {
  const detail =
    basis && basis !== value
      ? `<dd class="irf-total-basis">${esc(basis)}</dd>`
      : "";
  return `<div><dt>${label}</dt><dd class="irf-total-value">${esc(value)}</dd>${detail}</div>`;
}

/** The review step's full block: totals, each number's basis, the per-stage table and what is unknown. */
export function renderEstimate(
  estimate: RunEstimate,
  stages: ReadonlyArray<readonly [string, string]>,
): string {
  const titles = new Map(stages.map(([name, title]) => [name, title]));
  const traces = estimate.bound.n === null ? "unknown" : tracesValue(estimate);
  const totals =
    total("Traces", traces, estimate.bound.basis) +
    total(
      "Cost",
      costValue(estimate),
      "traces × tokens per stage × each stage's model price in the Orq catalogue",
    ) +
    total("Time", timeValue(estimate), estimate.timeBasis);
  const note =
    estimate.timeNote && estimate.secondsHigh
      ? `<p class="irf-hint">${esc(estimate.timeNote)}.</p>`
      : "";
  const unknowns = estimate.unknowns
    .map((item) => `<li>${esc(item)}</li>`)
    .join("");
  const unknownBlock = unknowns
    ? `<h5>Unknown</h5><ul class="irf-estimate-unknowns">${unknowns}</ul>`
    : "";
  const head =
    '<th scope="col">Stage</th><th scope="col" class="num">Traces</th><th scope="col" class="num">Cost</th>' +
    '<th scope="col" class="num">Time</th><th scope="col">Basis</th>';
  const body = estimate.rows.map((row) => stageRow(row, titles)).join("");
  const excluded = `<p class="irf-hint">Not included: ${esc(estimate.excluded.join("; "))}.</p>`;
  return (
    '<section class="irf-estimate"><h4>Estimate</h4>' +
    `<dl class="irf-estimate-totals">${totals}</dl>${note}` +
    '<div class="irf-estimate-scroll">' +
    `<table class="irf-estimate-table no-stack"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    `${unknownBlock}${excluded}</section>`
  );
}
