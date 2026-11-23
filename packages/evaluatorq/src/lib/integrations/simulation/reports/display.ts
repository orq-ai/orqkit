import type { PlanConsole } from "../../../common/reports/console.js";
import {
  groupThousands,
  pyFixed,
  pyPercent,
} from "../../../common/reports/number-format.js";
import type { ReportResult } from "./helpers.js";
import {
  type BuildSimulationSectionsOptions,
  buildSimulationReportSections,
} from "./sections.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
function terminalTable(headers: string[], data: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(
      Array.from(header).length,
      ...data.map((row) => Array.from(row[index] ?? "").length),
    ),
  );
  const line = (row: string[]) =>
    row
      .map(
        (value, index) =>
          value +
          " ".repeat(
            Math.max(0, (widths[index] ?? 0) - Array.from(value).length),
          ),
      )
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...data.map(line),
  ].join("\n");
}
export function renderSimulationSummary(
  results: readonly ReportResult[],
  options: BuildSimulationSectionsOptions & {
    experimentUrl?: string | null;
  } = {},
): string {
  const lines = ["", `SIMULATION SUMMARY (${results.length} simulations)`];
  if (!results.length)
    return lines
      .concat("No results (run aborted or produced nothing).")
      .join("\n");
  const sections = new Map(
    buildSimulationReportSections(results, options).map((section) => [
      section.kind,
      section.data,
    ]),
  );
  const summary = sections.get("summary") ?? {};
  if (summary.narrative)
    lines.push("", "Executive Summary", String(summary.narrative));
  const stats = [
    ["Conversations", String(summary.total_conversations)],
    [
      "Goals Achieved",
      `${summary.goals_achieved}/${summary.total_conversations}`,
    ],
    ["Success Rate", pyPercent(Number(summary.success_rate))],
    [
      "Avg Completion Score",
      pyFixed(Number(summary.avg_goal_completion_score), 2),
    ],
    ["Avg Turn Count", pyFixed(Number(summary.avg_turn_count), 1)],
    ["Total Tokens", groupThousands(String(summary.total_tokens))],
  ];
  if (summary.errors) stats.push(["Errors", String(summary.errors)]);
  if (options.runTokenUsageTotal)
    stats.push([
      "Run Total Tokens (incl. generation & summary)",
      groupThousands(String(options.runTokenUsageTotal.totalTokens)),
    ]);
  lines.push("", terminalTable(["Metric", "Value"], stats), "");
  for (const kind of ["persona_breakdown", "scenario_breakdown"] as const) {
    const key = kind === "persona_breakdown" ? "persona" : "scenario";
    const items = rows(sections.get(kind)?.rows);
    if (!items.length) continue;
    lines.push(
      key === "persona" ? "Per-Persona Breakdown" : "Per-Scenario Breakdown",
      terminalTable(
        [
          key === "persona" ? "Persona" : "Scenario",
          "Runs",
          "Achieved",
          "Rate",
        ],
        items.map((row) => [
          String(row[key]),
          String(row.conversations),
          String(row.goals_achieved),
          pyPercent(Number(row.success_rate)),
        ]),
      ),
      "",
    );
  }
  const terminated = sections.get("judge_verdicts")?.terminated_by as
    | Row
    | undefined;
  if (terminated && Object.keys(terminated).length)
    lines.push(
      "Judge Verdicts",
      terminalTable(
        ["Terminated By", "Count"],
        Object.entries(terminated).map(([key, value]) => [key, String(value)]),
      ),
      "",
    );
  const errors = sections.get("errors")?.by_message as Row | undefined;
  if (errors)
    lines.push(
      "Errors",
      terminalTable(
        ["Message", "Count"],
        Object.entries(errors).map(([message, count]) => [
          Array.from(message).length > 80
            ? `${Array.from(message).slice(0, 80).join("")}…`
            : message,
          String(count),
        ]),
      ),
      "",
    );
  if (options.experimentUrl)
    lines.push(`View on Orq: ${options.experimentUrl}`, "");
  return lines.join("\n");
}
export function printSimulationSummary(
  results: readonly ReportResult[],
  options: BuildSimulationSectionsOptions & {
    experimentUrl?: string | null;
    output?: PlanConsole;
  } = {},
): void {
  const text = renderSimulationSummary(results, options);
  if (options.output) options.output.log(text);
  else console.error(text);
}
