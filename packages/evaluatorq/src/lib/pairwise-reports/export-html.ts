import { pythonFixed } from "../common/jury.js";
import {
  esc,
  htmlTable,
  kpiCards,
  loadCss,
  statusBadge,
} from "../common/reports/html-helpers.js";
import { COLORS } from "../common/reports/palette.js";
import {
  formatDate,
  type RendererRegistry,
  renderBody,
} from "../common/reports/render.js";
import type { ReportSection } from "../contracts.js";
import type { PairwiseRun } from "../pairwise-run.js";
import {
  buildReportSections,
  type ClassifyObservationView,
  type ComparisonRow,
  type ComparisonsData,
  type ConsensusData,
  INCONCLUSIVE_WARN,
  type JudgeRow,
  type JudgesData,
  observedSwap,
  type VoteCell,
} from "./sections.js";

// Neither is a good/bad colour: a side winning is not a pass or a failure.
const A_COLOR = COLORS.blue_400;
const B_COLOR = COLORS.purple_400;

export function rate(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "-"
    : `${pythonFixed(value * 100, 0)}%`;
}

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : pythonFixed(value, 2);
}

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(1, value)) * 100;

function sideBar(
  label: string,
  value: number | null | undefined,
  color: string,
): string {
  const width = value === null || value === undefined ? 0 : clampPercent(value);
  return (
    '<div class="pw-side">' +
    `<div class="pw-side__label">${esc(label)}</div>` +
    '<div class="pw-side__track">' +
    `<div class="pw-side__fill" style="width:${pythonFixed(width, 1)}%;background:${color}"></div>` +
    "</div>" +
    `<div class="pw-side__value">${rate(value)}</div>` +
    "</div>"
  );
}

function renderConsensusHtml(section: ReportSection): string {
  const d = section.data as ConsensusData;
  const bars =
    sideBar(d.labelA, d.aWinRate, A_COLOR) +
    sideBar(d.labelB, d.bWinRate, B_COLOR);
  // Both win rates share a denominator that excludes ties and inconclusive comparisons.
  const caption = `<p class="pw-caption">Win rates over the ${d.decided} of ${d.comparisons} comparisons the panel decided.</p>`;
  const stats = kpiCards([
    { label: "Ties", value: rate(d.tieRate), status: "neutral" },
    {
      label: "Inconclusive",
      value: rate(d.inconclusiveRate),
      status:
        (d.inconclusiveRate ?? 0) > INCONCLUSIVE_WARN ? "warn" : "neutral",
    },
    { label: "Mean agreement", value: num(d.meanAgreement), status: "neutral" },
  ]);
  let weightedHtml = "";
  if (d.btSigma) {
    const weightedBars =
      sideBar(d.labelA, d.btSigma.aWinRate, A_COLOR) +
      sideBar(d.labelB, d.btSigma.bWinRate, B_COLOR);
    const warnings = d.btSigma.fitWarnings
      .map((warning) => `<li>${esc(warning)}</li>`)
      .join("");
    const warningHtml = warnings
      ? `<ul class="pw-caption">${warnings}</ul>`
      : "";
    weightedHtml =
      "<h3>Reliability-weighted consensus (BT-sigma)</h3>" +
      `<div class="pw-sides">${weightedBars}</div>${warningHtml}`;
  }
  return (
    `<section id="${section.kind}"><h2>${esc(section.title)}</h2>` +
    `<div class="pw-sides">${bars}</div>${caption}${stats}${weightedHtml}</section>`
  );
}

export function biasCell(row: JudgeRow, swapObserved: boolean): string {
  const bias = row.positionBias;
  if (bias === null) {
    // When no judge completed a pair that is a run-level fact, not this judge's fault.
    const reason = swapObserved
      ? "This judge never completed both orderings of a pair, so no flip could be observed"
      : "No pair completed both orderings, so no flip was observable in this run";
    return `<span class="pw-muted" title="${esc(reason)}">n/a</span>`;
  }
  const warn = row.biased ? " pw-bias__fill--warn" : "";
  const marker = row.biased ? " ⚠" : "";
  return (
    '<span class="pw-bias">' +
    `<span class="pw-bias__track"><span class="pw-bias__fill${warn}" style="width:${pythonFixed(clampPercent(bias), 1)}%"></span></span>` +
    `${pythonFixed(bias, 2)}${marker}</span>`
  );
}

export function consistencyCell(value: number | null): string {
  if (value === null) {
    const reason =
      "This judge never completed two decisive passes of the same ordering, " +
      "so its self-agreement could not be measured";
    return `<span class="pw-muted" title="${esc(reason)}">n/a</span>`;
  }
  return num(value);
}

function renderJudgesHtml(section: ReportSection): string {
  const d = section.data as JudgesData;
  if (d.rows.length === 0) {
    return "";
  }
  const headers = [
    "Judge",
    `${d.labelA} rate`,
    `${d.labelB} rate`,
    "Tie rate",
    "Position bias",
  ];
  if (d.btSigma) {
    headers.push("Sigma");
  }
  if (d.observedConsistency) {
    headers.push("Consistency (shrunk)", "Consistency (raw)");
  }
  const rows = d.rows.map((r) => {
    const row = [
      esc(r.model) +
        (r.replacement ? ' <span class="pw-tag">stand-in</span>' : ""),
      rate(r.aRate),
      rate(r.bRate),
      rate(r.tieRate),
      biasCell(r, d.observedSwap),
    ];
    if (d.btSigma) {
      row.push(num(r.sigma));
    }
    if (d.observedConsistency) {
      row.push(
        consistencyCell(r.consistency),
        consistencyCell(r.consistencyRaw),
      );
    }
    return row;
  });
  // Keyed off what ran, not what was configured.
  let note = "";
  if (!d.observedSwap) {
    note = d.swap
      ? '<p class="pw-caption">No pair completed both orderings, so position bias could not be measured for this run despite swapping being enabled.</p>'
      : '<p class="pw-caption">This run used a single ordering, so position bias was not measured.</p>';
  }
  if (!d.observedConsistency) {
    note += d.repeated
      ? '<p class="pw-caption">Repeated passes ran but no judge completed two decisive passes of the same ordering, so judge self-consistency could not be measured for this run.</p>'
      : '<p class="pw-caption">This run used a single pass per ordering, so judge self-consistency was not measured.</p>';
  }
  return `<section id="${section.kind}"><h2>${esc(section.title)}</h2>${htmlTable(headers, rows)}${note}</section>`;
}

function voteChip(vote: VoteCell): string {
  if (!vote.present || vote.vote === null) {
    return '<span class="pw-chip pw-chip--abstain" title="abstained">&middot;</span>';
  }
  const tone = vote.vote === "A" ? "a" : vote.vote === "B" ? "b" : "tie";
  const flip = vote.flipped ? " pw-chip--flip" : "";
  return `<span class="pw-chip pw-chip--${tone}${flip}" title="${esc(vote.model)}">${esc(vote.label)}</span>`;
}

const FLIP_TAG = '<span class="pw-tag pw-tag--flip">flipped</span>';

interface ScaledDecimal {
  mantissa: bigint;
  exponent: number;
}

/** The value's shortest round-trip digits, the same digits Python's str(float) gives. */
function shortestDecimal(value: number): ScaledDecimal {
  const [coefficient = "0", scientific = "0"] = String(value).split("e");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  return {
    mantissa: BigInt(`${whole}${fraction}`),
    exponent: Number(scientific) - fraction.length,
  };
}

function roundHalfEven(mantissa: bigint, drop: number): bigint {
  const divisor = BigInt(10) ** BigInt(drop);
  const quotient = mantissa / divisor;
  const twice = (mantissa % divisor) * BigInt(2);
  const roundUp =
    twice > divisor ||
    (twice === divisor && quotient % BigInt(2) !== BigInt(0));
  return roundUp ? quotient + BigInt(1) : quotient;
}

function trimFraction(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function fixedDecimal(decimal: ScaledDecimal, places: number): string {
  let { mantissa } = decimal;
  const drop = -decimal.exponent - places;
  if (drop > 0) {
    mantissa = roundHalfEven(mantissa, drop);
  } else if (drop < 0) {
    mantissa *= BigInt(10) ** BigInt(-drop);
  }
  const digits = mantissa.toString().padStart(places + 1, "0");
  if (places === 0) {
    return digits;
  }
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

function fourSignificant(input: ScaledDecimal): string {
  let { mantissa, exponent } = input;
  while (mantissa % BigInt(10) === BigInt(0)) {
    mantissa /= BigInt(10);
    exponent += 1;
  }
  const excess = mantissa.toString().length - 4;
  if (excess > 0) {
    mantissa = roundHalfEven(mantissa, excess);
    exponent += excess;
    if (mantissa.toString().length > 4) {
      mantissa /= BigInt(10);
      exponent += 1;
    }
  }
  const digits = mantissa.toString();
  const leftDigits = exponent + digits.length;
  if (exponent <= 0 && leftDigits > -6) {
    if (leftDigits <= 0) {
      return `0.${"0".repeat(-leftDigits)}${digits}`;
    }
    return `${digits.slice(0, leftDigits)}${exponent < 0 ? `.${digits.slice(leftDigits)}` : ""}`;
  }
  const tail = digits.length > 1 ? `.${digits.slice(1)}` : "";
  const scientific = leftDigits - 1;
  return `${digits[0]}${tail}e${scientific < 0 ? "" : "+"}${scientific}`;
}

/** Keeps near-tie and tiny nonzero probabilities visible instead of rounding them away. */
function percentage(value: unknown): string | null {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    return null;
  }
  const shortest = shortestDecimal(value);
  const percent: ScaledDecimal = {
    mantissa: shortest.mantissa,
    exponent: shortest.exponent + 2,
  };
  if (percent.mantissa === BigInt(0)) {
    return "0%";
  }
  const scale = Math.max(1, -percent.exponent);
  const scaled = (whole: string): bigint =>
    BigInt(whole) * BigInt(10) ** BigInt(scale);
  const units =
    percent.mantissa * BigInt(10) ** BigInt(percent.exponent + scale);
  const distance = units - scaled("50");
  const tenth = BigInt(10) ** BigInt(scale - 1);
  if ((distance < BigInt(0) ? -distance : distance) <= tenth) {
    return `${trimFraction(fixedDecimal(percent, scale))}%`;
  }
  const hundredth = scale >= 2 ? BigInt(10) ** BigInt(scale - 2) : null;
  if (hundredth !== null && units < hundredth) {
    return `${fourSignificant(percent)}%`;
  }
  return `${trimFraction(fixedDecimal(percent, 2))}%`;
}

function observationHtml(observation: ClassifyObservationView): string {
  const order =
    observation.ordering === "ab" ? "original order" : "swapped order";
  const facts = [
    `<strong>${order}, pass ${observation.repetition + 1}</strong>`,
  ];
  if (observation.choice !== null && observation.choice !== undefined) {
    facts.push(`choice ${esc(observation.choice)}`);
  }
  const confidence = percentage(observation.confidence);
  if (confidence !== null) {
    facts.push(`confidence ${esc(confidence)}`);
  }
  const items = Object.entries(observation.probabilities ?? {}).flatMap(
    ([label, value]) => {
      const rendered = percentage(value);
      return rendered === null
        ? []
        : [`<span>${esc(label)} ${esc(rendered)}</span>`];
    },
  );
  const probabilities = items.length
    ? `<div class="pw-classify__probabilities">${items.join("")}</div>`
    : "";
  return `<div class="pw-classify__observation">${facts.join(" · ")}${probabilities}</div>`;
}

export function classifyDetails(vote: VoteCell): string {
  if (vote.classifyObservations.length === 0) {
    return "";
  }
  return `<details class="pw-classify"><summary>Classifier details</summary>${vote.classifyObservations.map(observationHtml).join("")}</details>`;
}

function voteRow(vote: VoteCell): string {
  return (
    '<li class="pw-vote">' +
    `<span class="pw-vote__model">${esc(vote.model)}</span>` +
    `${voteChip(vote)}${vote.flipped ? FLIP_TAG : ""}` +
    `<span class="pw-vote__why">${esc(vote.explanation)}</span>` +
    `${classifyDetails(vote)}` +
    "</li>"
  );
}

function detailHtml(
  row: ComparisonRow,
  labelA: string,
  labelB: string,
): string {
  const responses =
    '<div class="pw-responses">' +
    `<div class="pw-response"><h4>${esc(labelA)}</h4><pre>${esc(row.responseA)}</pre></div>` +
    `<div class="pw-response"><h4>${esc(labelB)}</h4><pre>${esc(row.responseB)}</pre></div>` +
    "</div>";
  return `${responses}<ul class="pw-votes">${row.votes.map(voteRow).join("")}</ul>`;
}

function winnerStatus(winner: string): string {
  if (winner === "inconclusive") {
    return "warn";
  }
  return winner === "tie" ? "neutral" : "pass";
}

function renderComparisonsHtml(section: ReportSection): string {
  const d = section.data as ComparisonsData;
  const heading = `<section id="${section.kind}"><h2>${esc(section.title)}</h2>`;
  if (d.rows.length === 0) {
    return `${heading}<p>No comparisons in this run.</p></section>`;
  }
  const parts = [heading];
  for (const row of d.rows) {
    const chips = row.votes.map(voteChip).join("");
    const mark = row.split
      ? '<span class="pw-split" title="judges split or panel undecided">⚠</span>'
      : "";
    parts.push(
      '<details class="pw-cmp">' +
        "<summary>" +
        `<span class="pw-cmp__idx">${row.index}</span>` +
        `<span class="pw-cmp__q">${esc(row.question)}</span>` +
        statusBadge(row.winnerLabel, winnerStatus(row.winner)) +
        `<span class="pw-cmp__chips">${chips}</span>${mark}` +
        "</summary>" +
        detailHtml(row, d.labelA, d.labelB) +
        "</details>",
    );
  }
  parts.push("</section>");
  return parts.join("");
}

const SECTION_RENDERERS: RendererRegistry = {
  pairwise_consensus: renderConsensusHtml,
  pairwise_judges: renderJudgesHtml,
  pairwise_comparisons: renderComparisonsHtml,
};

const PAIRWISE_CSS = `
.pw-sides{display:flex;flex-direction:column;gap:10px;margin:16px 0 8px}
.pw-side{display:flex;align-items:center;gap:12px}
.pw-side__label{width:160px;font-weight:600;text-align:right}
.pw-side__track{flex:1;height:22px;background:rgba(127,127,127,.15);border-radius:4px;overflow:hidden}
.pw-side__fill{height:100%;border-radius:4px}
.pw-side__value{width:56px;font-variant-numeric:tabular-nums}
.pw-caption{opacity:.7;font-size:.9em;margin:4px 0 12px}
.pw-muted{opacity:.6}
.pw-bias{display:inline-flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
.pw-bias__track{width:60px;height:8px;background:rgba(127,127,127,.15);border-radius:4px;overflow:hidden}
.pw-bias__fill{display:block;height:100%;background:#7f8c9a}
.pw-bias__fill--warn{background:#d9534f}
.pw-tag{font-size:.75em;padding:1px 6px;border-radius:10px;background:rgba(127,127,127,.18);margin-left:6px}
.pw-tag--flip{background:rgba(217,83,79,.18)}
.pw-chip{display:inline-block;min-width:34px;text-align:center;padding:1px 8px;margin-right:4px;
 border-radius:10px;font-size:.8em;background:rgba(127,127,127,.15)}
.pw-chip--a{background:rgba(59,111,212,.22)}
.pw-chip--b{background:rgba(130,87,197,.22)}
.pw-chip--tie{background:rgba(127,127,127,.2)}
.pw-chip--abstain{opacity:.5}
.pw-chip--flip{outline:1px dashed rgba(217,83,79,.6)}
.pw-split{margin-left:8px;color:#d9534f}
.pw-cmp{border:1px solid rgba(127,127,127,.25);border-radius:6px;margin:6px 0;padding:6px 10px}
/* Top-aligned rather than centred: now that the question wraps, a long one
   would otherwise leave the badge and chips floating in a tall row's middle. */
.pw-cmp summary{display:flex;align-items:flex-start;gap:10px;cursor:pointer}
.pw-cmp__idx{opacity:.6;width:28px;font-variant-numeric:tabular-nums}
/* Wraps rather than clipping to one line: the question is the only thing
   identifying a row, and an ellipsis made a long one readable nowhere. */
.pw-cmp__q{flex:1;min-width:0;overflow-wrap:anywhere}
.pw-cmp__chips{white-space:nowrap}
.pw-responses{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.pw-response pre{white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,.08);
 padding:8px;border-radius:4px;margin:4px 0 0}
.pw-votes{list-style:none;padding:0;margin:8px 0 4px}
.pw-vote{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;padding:6px 0;border-top:1px solid rgba(127,127,127,.15)}
.pw-vote__model{width:200px;font-weight:600;flex:none}
.pw-vote__why{flex:1;opacity:.85}
.pw-classify{flex-basis:100%;min-width:0;margin-left:210px;font-size:.9em;overflow-wrap:anywhere}
.pw-cmp .pw-classify>summary{display:list-item;cursor:pointer}
.pw-classify__observation{padding:6px 0}
.pw-classify__probabilities{display:flex;flex-wrap:wrap;gap:4px 16px;font-variant-numeric:tabular-nums}
@media (max-width:720px){.pw-responses{grid-template-columns:1fr}.pw-side__label{width:100px}
 .pw-classify{margin-left:0}.pw-classify__probabilities{flex-direction:column}}
`;

function swapSummary(run: PairwiseRun): string {
  if (!run.swap) {
    return "off";
  }
  return observedSwap(run)
    ? "on"
    : 'on <span class="pw-muted">(never observed)</span>';
}

function headerHtml(run: PairwiseRun): string {
  const report = run.rollup();
  const meta =
    `<p><strong>Comparing:</strong> ${esc(run.labelA)} vs ${esc(run.labelB)} &nbsp;|&nbsp; ` +
    `<strong>Judges:</strong> ${run.judges.length || report.perJudge.length} &nbsp;|&nbsp; ` +
    `<strong>Swap:</strong> ${swapSummary(run)} &nbsp;|&nbsp; ` +
    `<strong>Date:</strong> ${formatDate(run.createdAt)}</p>`;
  const criteria = run.criteria
    ? `<p class="pw-caption"><strong>Criteria:</strong> ${esc(run.criteria)}</p>`
    : "";
  return `<header class="hero"><h1>${esc(run.runName)}</h1>${meta}${criteria}</header>`;
}

export function renderReportBody(run: PairwiseRun): Promise<string> {
  return renderBody(buildReportSections(run), {
    renderers: SECTION_RENDERERS,
    bodyHeader: `<style>${PAIRWISE_CSS}</style>${headerHtml(run)}`,
    bodyFooter:
      '<footer><p class="footer">Generated by evaluatorq pairwise judging.</p></footer>',
  });
}

export async function exportHtml(run: PairwiseRun): Promise<string> {
  const head =
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${esc(run.runName)} - Pairwise Report</title>\n` +
    `<style>\n${loadCss()}\n</style>`;
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    `<head>\n${head}\n</head>\n` +
    '<body>\n<div class="container">\n' +
    `${await renderReportBody(run)}\n` +
    "</div>\n</body>\n" +
    "</html>\n"
  );
}
