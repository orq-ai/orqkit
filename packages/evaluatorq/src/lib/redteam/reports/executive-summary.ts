import { truncateText } from "../../common/reports/executive-summary.js";
import { pct } from "../../common/reports/html-helpers.js";
import { SEVERITY_RANK } from "../../common/reports/palette.js";
import { OWASP_CATEGORY_NAMES } from "../contracts.js";
import type { RedTeamReport } from "./models.js";
import { extractPrompt, extractResponse } from "./utils.js";

export function buildRedteamFacts(report: RedTeamReport): string {
  const summary = report.summary;
  if (!summary.totalAttacks) return "";
  const lines = [
    `Total attacks: ${summary.totalAttacks}`,
    `Categories tested: ${report.categoriesTested.length}${report.categoriesTested.length ? ` (${report.categoriesTested.join(", ")})` : ""}`,
    `Evaluation coverage: ${summary.evaluatedAttacks}/${summary.totalAttacks} attacks scored`,
    summary.resistanceRate == null
      ? "Resistance rate: unknown - no attack could be evaluated. Do not describe the target as resistant or safe; state that it was not tested."
      : `Resistance rate: ${pct(summary.resistanceRate)}`,
    `Vulnerabilities found: ${summary.vulnerabilitiesFound}`,
  ];
  const severities = Object.entries(summary.bySeverity)
    .filter(([, row]) => row.vulnerabilitiesFound)
    .map(([name, row]) => `${name}: ${row.vulnerabilitiesFound}`);
  if (severities.length)
    lines.push(`Vulnerabilities by severity: ${severities.join(", ")}`);
  const finding = report.results
    .filter((row) => row.vulnerable)
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.attack.severity] - SEVERITY_RANK[a.attack.severity],
    )[0];
  if (finding) {
    const category = finding.attack.category;
    lines.push(
      `Most severe confirmed finding - severity ${finding.attack.severity}, category ${category} (${OWASP_CATEGORY_NAMES[category] ?? category}), technique ${finding.attack.attackTechnique}, ${finding.execution?.turns ?? 1} turn(s).`,
      `  Attack prompt: ${truncateText(extractPrompt(finding))}`,
      `  Agent response: ${truncateText(extractResponse(finding))}`,
    );
    if (finding.evaluation?.explanation)
      lines.push(
        `  Evaluator rationale: ${truncateText(finding.evaluation.explanation)}`,
      );
  }
  const dominant = Object.entries(summary.byTechnique).sort(
    (a, b) =>
      b[1].vulnerabilitiesFound - a[1].vulnerabilitiesFound ||
      b[1].totalAttacks - a[1].totalAttacks,
  )[0];
  if (dominant)
    lines.push(
      `Most-exploited technique: ${dominant[0]} (${dominant[1].vulnerabilitiesFound} vuln / ${dominant[1].totalAttacks} attacks)`,
    );
  for (const key of ["single", "multi"] as const) {
    const row = summary.byTurnType[key];
    if (row?.totalAttacks)
      lines.push(
        `${key[0]?.toUpperCase()}${key.slice(1)}-turn attacks: ${row.totalAttacks}, vulnerability rate ${pct(row.vulnerabilityRate)}`,
      );
  }
  return lines.join("\n");
}
