import {
  esc,
  htmlTable,
  scaleColor,
} from "../../../common/reports/html-helpers.js";
import { pyFixed } from "../../../common/reports/number-format.js";
import { COLORS } from "../../../common/reports/palette.js";
import type { RendererRegistry } from "../../../common/reports/render.js";
import {
  pythonSplit,
  pythonStrip,
  pythonTitle,
} from "../../../common/sanitize.js";
import type { ReportSection } from "../../../contracts.js";
import { buildSimulationTokenUsageRows } from "./token-usage.js";

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const n = (v: unknown): number => (typeof v === "number" ? v : 0);
const labels: Readonly<Record<string, string>> = {
  goal_achieved: "Resolved the issue",
  criteria_met: "Met success criteria",
  turn_efficiency: "Efficient (few turns)",
  conversation_quality: "Conversation quality",
  response_quality: "Response quality",
  tone_appropriateness: "Appropriate tone",
  factual_accuracy: "Factual accuracy",
  hallucination_risk: "Hallucination risk",
};
export function prettyEvaluator(name: string): string {
  if (Object.hasOwn(labels, name)) return labels[name] as string;
  const clean = name.replaceAll("_", " "),
    first = Array.from(clean)[0] ?? "";
  return (
    pythonTitle(first) + clean.toLowerCase().slice(first.toLowerCase().length)
  );
}
export function scoreIsLowerBetter(name: string): boolean {
  return [
    "risk",
    "hallucinat",
    "toxic",
    "latency",
    "cost",
    "error",
    "violation",
  ].some((token) => name.toLowerCase().includes(token));
}
export function directionArrow(name: string): string {
  return scoreIsLowerBetter(name) ? "▼" : "▲";
}
export function scoreChip(
  value: number,
  options: { lowerIsBetter: boolean },
): string {
  const goodness = options.lowerIsBetter ? 1 - value : value,
    color = scaleColor(Math.max(0, Math.min(1, goodness)), [
      [0, COLORS.red_400],
      [1, "#157f57"],
    ]);
  return `<span class="score-chip" style="background:${color}">${pyFixed(value, 2)}</span>`;
}
export function renderSimulationJudgeVerdictsHtml(
  section: ReportSection,
): string {
  const reasons = (section.data.terminated_by ?? {}) as Record<string, number>;
  if (Object.keys(reasons).length <= 1) return "";
  return `<section class="report-card"><h2>${esc(section.title)}</h2><h3>Terminated By</h3>${htmlTable(
    ["Reason", "Count"],
    Object.entries(reasons)
      .sort(([, a], [, b]) => b - a)
      .map(([r, count]) => [esc(r), String(count)]),
  )}</section>`;
}
export function renderSimulationEvaluatorScoresHtml(
  section: ReportSection,
): string {
  const values = rows(section.data.rows);
  if (!values.length) return "";
  const table = htmlTable(
    ["Evaluator", "Runs", "Dropped", "Mean", "Min", "Max"],
    values.map((r) => {
      const raw = String(r.evaluator),
        lower = scoreIsLowerBetter(raw),
        arrow = lower ? "▼" : "▲",
        hint = lower ? "lower is better" : "higher is better",
        dropped = n(r.dropped),
        droppedCell =
          dropped && r.first_error
            ? `<span title="${esc(String(r.first_error))}">${dropped}</span>`
            : String(dropped);
      return [
        `${esc(prettyEvaluator(raw))} <span class="dir" title="${esc(raw)} · ${hint}">${arrow}</span>`,
        String(r.runs),
        droppedCell,
        r.mean_score == null
          ? "-"
          : scoreChip(n(r.mean_score), { lowerIsBetter: lower }),
        r.min_score == null ? "-" : pyFixed(n(r.min_score), 2),
        r.max_score == null ? "-" : pyFixed(n(r.max_score), 2),
      ];
    }),
  );
  const legend =
    '<p class="score-legend"><span class="dir">▲</span> higher is better &nbsp;·&nbsp; <span class="dir">▼</span> lower is better &nbsp;·&nbsp; mean shaded <span class="score-chip score-chip--bad">worse</span> → <span class="score-chip score-chip--good">better</span></p>';
  return `<section class="report-card"><h2>${esc(section.title)}</h2>${table}${legend}</section>`;
}
export function renderSimulationTokenUsageHtml(section: ReportSection): string {
  return `<section class="report-card"><h2>${esc(section.title)}</h2>${htmlTable(["Metric", "Value"], buildSimulationTokenUsageRows(section.data))}</section>`;
}
export function renderSimulationErrorsHtml(section: ReportSection): string {
  const data = section.data,
    messages = (data.by_message ?? {}) as Record<string, number>,
    parts = [
      `<section class="report-card"><h2>${esc(section.title)}</h2>`,
      `<p>Total errored conversations: <strong>${n(data.total_errored)}</strong></p>`,
    ];
  if (Object.keys(messages).length)
    parts.push(
      htmlTable(
        ["Error", "Count"],
        Object.entries(messages).map(([message, count]) => [
          esc(message),
          String(count),
        ]),
      ),
    );
  parts.push("</section>");
  return parts.join("");
}
export const SIMULATION_TAB_RENDERERS: RendererRegistry = {
  judge_verdicts: renderSimulationJudgeVerdictsHtml,
  evaluator_scores: renderSimulationEvaluatorScoresHtml,
  token_usage: renderSimulationTokenUsageHtml,
  errors: renderSimulationErrorsHtml,
};

const CRIT_CARET =
  '<svg class="crit-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
export function criteriaDots(criteria: Row[]): string {
  if (!criteria.length) return '<span class="crit-empty">-</span>';
  const failures = criteria.filter((c) => !c.passed).length,
    unknown = criteria.filter((c) => c.state === "unknown").length,
    dots: string[] = [],
    items: string[] = [];
  for (const c of criteria) {
    const state = Object.hasOwn(c, "state")
        ? String(c.state)
        : c.passed
          ? "pass"
          : "fail",
      cls = c.safety && !c.passed ? "safety" : state,
      suffix = state === "unknown" ? " (not audited)" : "",
      description = String(c.description) + suffix;
    dots.push(
      `<span class="crit-dot crit-dot--${cls}" title="${esc(description)}"></span>`,
    );
    items.push(`<li class="crit-li crit-li--${cls}">${esc(description)}</li>`);
  }
  const label = `${failures} of ${criteria.length} criteria failed${unknown ? `, ${unknown} not audited` : ""} - show details`;
  return `<details class="crit-cell"><summary class="crit-summary" aria-label="${esc(label)}" title="${esc(label)}"><span class="crit-dots">${dots.join("")}</span>${CRIT_CARET}</summary><ul class="crit-list">${items.join("")}</ul></details>`;
}
export function capTableText(text: string, maxChars = 90): string {
  const normalized = pythonSplit(text).join(" "),
    chars = Array.from(normalized);
  return chars.length <= maxChars
    ? normalized
    : `${pythonStrip(chars.slice(0, maxChars - 1).join(""))}…`;
}
