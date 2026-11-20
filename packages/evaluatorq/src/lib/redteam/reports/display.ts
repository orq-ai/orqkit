import type { PlanConsole } from "../../common/reports/console.js";
import { pct } from "../../common/reports/html-helpers.js";
import { pyFixed, pyPercent } from "../../common/reports/number-format.js";
import { OWASP_CATEGORY_NAMES, type Vulnerability } from "../contracts.js";
import { VULNERABILITY_DEFS } from "../vulnerability-registry.js";
import type { RedTeamReport } from "./models.js";

interface SummaryTable {
  title: string;
  headers: string[];
  rows: string[][];
}
export function formatRedteamVulnerabilityLabel(value: string): string {
  const definition = VULNERABILITY_DEFS[value as Vulnerability];
  if (!definition) return value;
  const categories = Object.values(definition.frameworkMappings).flat();
  return categories.length
    ? `${definition.name} (${categories.join(", ")})`
    : definition.name;
}
export function formatRedteamCategoryLabel(value: string): string {
  const name = OWASP_CATEGORY_NAMES[value];
  return name ? `${value} - ${name}` : value;
}
const order = (
  a: { resistanceRate: number | null; totalAttacks: number },
  b: { resistanceRate: number | null; totalAttacks: number },
) =>
  a.resistanceRate == null
    ? b.resistanceRate == null
      ? b.totalAttacks - a.totalAttacks
      : 1
    : b.resistanceRate == null
      ? -1
      : a.resistanceRate - b.resistanceRate || b.totalAttacks - a.totalAttacks;
export function buildRedteamSummaryTables(
  report: RedTeamReport,
): SummaryTable[] {
  const s = report.summary,
    stats = [
      ["Total Attacks", String(s.totalAttacks)],
      ["Evaluated", String(s.evaluatedAttacks)],
      ["Vulnerabilities", String(s.vulnerabilitiesFound)],
      ["ASR", pct(s.vulnerabilityRate)],
      ["Eval Coverage", pyPercent(s.evaluationCoverage)],
    ];
  if (report.durationSeconds != null) {
    const seconds = Math.trunc(report.durationSeconds);
    stats.push(["Duration", `${Math.floor(seconds / 60)}m ${seconds % 60}s`]);
  }
  if (s.totalErrors) stats.push(["Errors", String(s.totalErrors)]);
  if (s.juryReliability) {
    const rel = s.juryReliability;
    stats.push([
      "Jury Agreement",
      `${rel.krippendorffAlpha == null ? "n/a" : `alpha=${pyFixed(rel.krippendorffAlpha, 2)}`} (${rel.samples} samples)`,
    ]);
  }
  if (s.juryHealth)
    stats.push([
      "Jury Health",
      `${s.juryHealth.issueSummary()}; ${s.juryHealth.samples} multi-judge samples`,
    ]);
  if (s.datapointBreakdown) {
    const parts = Object.entries({
      static: "static",
      template_dynamic: "template",
      generated_dynamic: "generated",
    }).flatMap(([key, label]) =>
      s.datapointBreakdown?.[key]
        ? [`${s.datapointBreakdown[key]} ${label}`]
        : [],
    );
    if (parts.length) stats.push(["Breakdown", parts.join(", ")]);
  }
  const sections: SummaryTable[] = [
    { title: "", headers: ["Metric", "Value"], rows: stats },
  ];
  const vulnerabilities = Object.values(s.byVulnerability).sort(order);
  if (vulnerabilities.length)
    sections.push({
      title: "Per-Vulnerability Breakdown",
      headers: ["Vulnerability", "Domain", "Tested", "Passed", "ASR"],
      rows: vulnerabilities.map((row) => [
        formatRedteamVulnerabilityLabel(row.vulnerability),
        row.domain
          .replaceAll("_", " ")
          .replace(/\b\w/g, (char) => char.toUpperCase()),
        row.evaluatedAttacks === row.totalAttacks
          ? String(row.totalAttacks)
          : `${row.evaluatedAttacks} of ${row.totalAttacks}`,
        String(row.evaluatedAttacks - row.vulnerabilitiesFound),
        pct(row.resistanceRate == null ? null : 1 - row.resistanceRate),
      ]),
    });
  const categories = Object.values(s.byCategory).sort(order);
  if (categories.length)
    sections.push({
      title: "Per-Category Breakdown",
      headers: ["Category", "Attacks", "Vulnerable", "ASR"],
      rows: categories.map((row) => [
        formatRedteamCategoryLabel(row.category),
        String(row.totalAttacks),
        String(row.vulnerabilitiesFound),
        pct(row.resistanceRate == null ? null : 1 - row.resistanceRate),
      ]),
    });
  const techniques = Object.entries(s.byTechnique)
    .sort(([, a], [, b]) => b.vulnerabilitiesFound - a.vulnerabilitiesFound)
    .slice(0, 5);
  if (techniques.length)
    sections.push({
      title: "Top Vulnerable Techniques",
      headers: ["Technique", "Vulnerabilities"],
      rows: techniques.map(([key, row]) => [
        key,
        String(row.vulnerabilitiesFound),
      ]),
    });
  const errors = Object.entries(s.errorsByType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (errors.length) {
    const samples = new Map<string, { stage: string; message: string }>();
    for (const row of report.results)
      if (row.error) {
        const key = row.errorCode || row.errorType || "unknown";
        if (!samples.has(key)) {
          const message = Array.from(row.error);
          samples.set(key, {
            stage: row.errorStage || "",
            message:
              message.length > 100
                ? `${message.slice(0, 100).join("")}...`
                : row.error,
          });
        }
      }
    sections.push({
      title: "Top Error Causes",
      headers: ["Error", "Stage", "Count", "Example"],
      rows: errors.map(([key, count]) => [
        key,
        samples.get(key)?.stage ?? "",
        String(count),
        samples.get(key)?.message ?? "",
      ]),
    });
  }
  return sections;
}
function terminalTable(table: SummaryTable): string {
  const widths = table.headers.map((header, i) =>
    Math.max(
      Array.from(header).length,
      ...table.rows.map((row) => Array.from(row[i] ?? "").length),
    ),
  );
  const format = (row: string[]) =>
    row
      .map(
        (value, i) =>
          value +
          " ".repeat(Math.max(0, (widths[i] ?? 0) - Array.from(value).length)),
      )
      .join("  ")
      .trimEnd();
  return [
    format(table.headers),
    format(widths.map((width) => "-".repeat(width))),
    ...table.rows.map(format),
  ].join("\n");
}
export function renderRedteamSummary(report: RedTeamReport): string {
  const lines = ["", "RED TEAM REPORT SUMMARY", ""];
  if (report.executiveSummary)
    lines.push("Executive Summary", report.executiveSummary, "");
  for (const table of buildRedteamSummaryTables(report)) {
    if (table.title) lines.push(`${table.title}:`);
    lines.push(terminalTable(table), "");
  }
  return lines.join("\n");
}
export function printRedteamSummary(
  report: RedTeamReport,
  options: { output?: PlanConsole } = {},
): void {
  const text = renderRedteamSummary(report);
  if (options.output) options.output.log(text);
  else console.error(text);
}
