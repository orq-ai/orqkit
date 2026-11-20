import type { ReportSection } from "../../contracts.js";
import { donut } from "../../dashboard/report-kit.js";
import type { SimulationRun } from "../../integrations/simulation/run-store.js";
import type { RedTeamReport } from "../../redteam/reports/models.js";
import { codepointCompare, pythonStrip, SPACE } from "../sanitize.js";
import { esc } from "./html-helpers.js";
import { COLORS, STATUS_COLORS } from "./palette.js";

type Row = Record<string, unknown>;
export type BriefSections = ReadonlyMap<ReportSection["kind"], ReportSection>;
export type FindingRow = readonly [
  finding: string,
  impact: string,
  affected: string,
  fix: string,
  anchor: string,
  fullLink: string | null,
];
const record = (value: unknown): Row =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(record) : [];
const n = (value: unknown) => (typeof value === "number" ? value : 0);
const s = (value: unknown) => (value == null ? "" : String(value));
const section = (byKind: BriefSections, kind: ReportSection["kind"]) =>
  byKind.get(kind)?.data ?? {};
export function recommendationExcerpt(text: string, limit = 180): string {
  const first =
    pythonStrip(text).split(new RegExp(`(?<=[.!?])${SPACE}+`, "u"), 1)[0] ?? "";
  if (first && Array.from(first).length <= limit) return first;
  if (Array.from(text).length <= limit) return text;
  return `${Array.from(text)
    .slice(0, limit)
    .join("")
    .replace(
      new RegExp(`${SPACE}+$`, "u"),
      "",
    )}… (excerpt; full recommendation linked below)`;
}
export function findingRowsSimulation(
  run: SimulationRun,
  byKind: BriefSections,
): FindingRow[] {
  const entries = rows(section(byKind, "individual_results").entries),
    recommendations = rows(section(byKind, "recommendations").rows),
    byIndex = new Map<number, string[]>();
  for (const row of recommendations)
    if (Number.isInteger(row.index))
      byIndex.set(
        n(row.index) - 1,
        Array.isArray(row.suggestions) ? row.suggestions.map(String) : [],
      );
  for (const rec of run.recommendations ?? [])
    byIndex.set(rec.resultIndex, [...rec.suggestions]);
  const ranked: { rank: number; index: number; row: FindingRow }[] = [];
  for (const entry of entries) {
    if (!Number.isInteger(entry.index)) continue;
    const index = n(entry.index),
      suggestions = byIndex.get(index) ?? [],
      failed = rows(entry.criteria)
        .filter((value) => value.state === "fail")
        .sort(
          (a, b) =>
            Number(a.type !== "must_not_happen") -
            Number(b.type !== "must_not_happen"),
        );
    const executionError = !!entry.error || entry.terminated_by === "error",
      missed = entry.goal_achieved === false && !executionError;
    if (!failed.length && !suggestions.length && !missed && !executionError)
      continue;
    const criterion = failed[0] ?? {};
    let description = s(criterion.description || "Goal was not achieved"),
      impact: string,
      rank: number;
    if (failed.length) {
      impact =
        criterion.type === "must_not_happen"
          ? "A prohibited behavior was confirmed."
          : "A criterion was confirmed violated.";
      rank = criterion.type === "must_not_happen" ? 0 : 1;
    } else if (missed) {
      impact = "The conversation did not achieve its goal.";
      rank = 1;
    } else if (suggestions.length && !executionError) {
      description = "Recorded improvement suggestion";
      impact =
        "The goal was achieved; the saved recommendation suggests a possible improvement.";
      rank = 1;
    } else {
      description = "Execution did not complete";
      impact =
        "The conversation ended before a complete outcome was available.";
      rank = 2;
    }
    const recommendation = suggestions.find(Boolean),
      fix = recommendation
        ? `Recorded recommendation excerpt: ${recommendationExcerpt(recommendation)}`
        : "No recommendation recorded; review the linked evidence.",
      affected = `${s(entry.persona || "Persona")} · ${s(entry.scenario || "Scenario")}`;
    const fullLink =
      recommendation && (recommendations.length || run.recommendations?.length)
        ? "simtab-recommendations"
        : null;
    ranked.push({
      rank,
      index,
      row: [description, impact, affected, fix, `#conv-${index + 1}`, fullLink],
    });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((value) => value.row);
}
export function findingRowsRedteam(
  report: RedTeamReport,
  byKind: BriefSections,
): FindingRow[] {
  const data = section(byKind, "focus_areas"),
    focus = rows(data.ranked_focus_areas ?? data.focus_areas),
    findings: FindingRow[] = [];
  for (const area of focus) {
    const category = s(area.category),
      recommendation = record(area.llm_recommendations),
      saved = Array.isArray(recommendation.recommendations)
        ? recommendation.recommendations
        : [],
      recorded = saved.find(Boolean),
      guidance = area.remediation;
    let fix = "No recommendation recorded; review the linked evidence.",
      fullLink: string | null = null;
    if (recorded) {
      fix = `Recorded recommendation excerpt: ${recommendationExcerpt(String(recorded))}`;
      fullLink = "rttab-focus-areas";
    } else if (guidance) {
      fix = `Framework guidance excerpt: ${recommendationExcerpt(String(guidance))}`;
      fullLink = "rttab-focus-areas";
    }
    const matching = report.results.flatMap((result, index) =>
      result.attack.category === category && result.vulnerable === true
        ? [{ result, index: index + 1 }]
        : [],
    );
    const first = matching[0];
    if (!first) continue;
    const agents = [
      ...new Set(
        matching.map(
          ({ result }) =>
            result.agent.displayName || result.agent.key || "Unknown agent",
        ),
      ),
    ].sort(codepointCompare);
    findings.push([
      s(area.category_name || category),
      `${n(area.vulnerabilities_found)} confirmed vulnerable attacks in this category.`,
      `${agents.join(", ")} · ${s(area.vulnerability_name || category)}`,
      fix,
      `#attack-${first.index}`,
      fullLink,
    ]);
  }
  return findings;
}
function findingsTable(findings: readonly FindingRow[]): string {
  if (!findings.length)
    return '<p class="export-reading-note">No confirmed findings are available in the saved report sections.</p>';
  const body = findings
    .map(([finding, impact, affected, fix, anchor, fullLink], index) => {
      const full = fullLink
        ? ` <a href="#${esc(fullLink)}">Full recommendation</a>`
        : "";
      return `<tr><th scope="row" data-label="Finding" id="export-finding-${index + 1}"><span class="export-finding-value">${index + 1}. ${esc(finding)}</span></th><td data-label="Impact"><span class="export-finding-value">${esc(impact)}</span></td><td data-label="Affected"><span class="export-finding-value">${esc(affected)}</span></td><td data-label="Recommended next step"><span class="export-finding-value">${esc(fix)}${full}</span></td><td data-label="Evidence"><span class="export-finding-value"><a href="${esc(anchor)}">Review evidence</a></span></td></tr>`;
    })
    .join("");
  return `<div class="export-findings"><table class="no-stack"><thead><tr><th>Finding</th><th>Impact</th><th>Affected</th><th>Recommended next step</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
function brief(
  title: string,
  summary: readonly string[],
  findings: readonly FindingRow[],
  total: number,
  chart: string,
  links: readonly (readonly [string, string])[],
): string {
  const stats = summary.map((value) => `<li>${esc(value)}</li>`).join(""),
    nav = links
      .map(([target, label]) => `<a href="#${esc(target)}">${esc(label)}</a>`)
      .join("");
  return `<section id="export-brief" class="export-brief" aria-labelledby="export-brief-title"><h2 id="export-brief-title">${esc(title)}</h2><div class="export-brief-overview"><ul class="export-takeaway">${stats}</ul>${chart}</div><p class="export-reading-note">${esc(`Findings shown: ${findings.length} of ${total}.`)} Follow the evidence links to inspect the saved conversation or attack.</p>${findingsTable(findings)}<nav aria-label="Full report sections">${nav}</nav></section>`;
}
export function simulationBrief(
  run: SimulationRun,
  byKind: BriefSections,
): string {
  const data = section(byKind, "summary"),
    total = n(data.total_conversations ?? run.totalResults),
    achieved = n(data.goals_achieved),
    failed = n(data.goals_failed),
    errors = n(data.errors),
    verdicts = Math.max(0, total - errors),
    findings = findingRowsSimulation(run, byKind);
  const chart = total
    ? '<figure class="chart-card"><figcaption>Conversation outcomes</figcaption>' +
      donut(
        [
          {
            label: "Goal achieved",
            value: achieved,
            color: COLORS.success_400,
          },
          { label: "Goal missed", value: failed, color: COLORS.red_400 },
          { label: "Execution error", value: errors, color: COLORS.yellow_400 },
        ],
        String(total),
        "conversations",
      ) +
      "</figure>"
    : "";
  const links: [string, string][] = [];
  if (byKind.has("individual_results"))
    links.push(["simtab-breakdown", "All conversations"]);
  if (byKind.has("recommendations") || run.recommendations?.length)
    links.push(["simtab-recommendations", "All saved recommendations"]);
  const target = run.target || run.targetKind.replaceAll("_", " "),
    model = run.targetModel ? ` using ${run.targetModel}` : "",
    coverage = `${verdicts}/${total} conversations have a completed outcome; ${errors} ended in execution error.`,
    takeaway =
      total === 0
        ? "No conversations were tested."
        : verdicts === 0
          ? "No goal verdict is available because every conversation ended in execution error."
          : `${achieved}/${verdicts} completed goals achieved; ${failed} completed goals missed.`;
  return brief(
    "Simulation report brief",
    [`Tested: ${target}${model}; ${total} conversations.`, takeaway, coverage],
    findings.slice(0, 3),
    findings.length,
    chart,
    links,
  );
}
export function redteamBrief(
  report: RedTeamReport,
  byKind: BriefSections,
): string {
  const data = section(byKind, "summary"),
    total = n(data.total_attacks ?? report.totalResults),
    evaluated = n(data.evaluated_attacks),
    vulnerable = n(data.vulnerabilities_found),
    errors = n(data.total_errors),
    resistant = Math.max(0, evaluated - vulnerable),
    noVerdict = Math.max(0, total - evaluated),
    findings = findingRowsRedteam(report, byKind);
  const chart = total
    ? '<figure class="chart-card"><figcaption>Attack outcomes</figcaption>' +
      donut(
        [
          {
            label: "Resisted",
            value: resistant,
            color: STATUS_COLORS.resistant,
          },
          {
            label: "Vulnerable",
            value: vulnerable,
            color: STATUS_COLORS.vulnerable,
          },
          { label: "No verdict", value: noVerdict, color: STATUS_COLORS.error },
        ],
        String(total),
        "attacks",
      ) +
      "</figure>"
    : "";
  const links: [string, string][] = [];
  if (byKind.has("focus_areas"))
    links.push(["rttab-focus-areas", "Focus areas"]);
  if (byKind.has("individual_results"))
    links.push(["rttab-attacks", "All attacks"]);
  const agents = report.testedAgents.join(", ") || "agents in saved results",
    count = report.categoriesTested.length,
    categories = `${count} tested categor${count === 1 ? "y" : "ies"}`,
    takeaway =
      total === 0
        ? "No attacks were tested."
        : evaluated === 0
          ? "No verdict is available for the tested attacks."
          : `Confirmed vulnerable attacks: ${vulnerable}; resistant attacks: ${resistant} among evaluated attacks.`,
    coverage = `${evaluated}/${total} attacks received a verdict across ${categories}; ${noVerdict} have no verdict; errors: ${errors}.`;
  return brief(
    "Red-team report brief",
    [`Tested: ${agents} (${report.pipeline} pipeline).`, takeaway, coverage],
    findings.slice(0, 3),
    findings.length,
    chart,
    links,
  );
}
