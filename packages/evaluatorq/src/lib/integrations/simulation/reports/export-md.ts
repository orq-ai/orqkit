import {
  boldBar,
  centerTable,
  detailsBlock,
  mdTable,
  pct,
  truncate,
} from "../../../common/reports/md-helpers.js";
import {
  groupThousands,
  pyFixed,
  pyPercent,
  pyRound,
} from "../../../common/reports/number-format.js";
import {
  formatDate,
  renderHeaderMd,
  renderMarkdown,
} from "../../../common/reports/render.js";
import type { ReportSection } from "../../../contracts.js";
import type { ReportResult } from "./helpers.js";
import { reportScalar } from "./helpers.js";
import {
  type BuildSimulationSectionsOptions,
  buildSimulationReportSections,
} from "./sections.js";
import { buildSimulationTokenUsageRows } from "./token-usage.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
const dict = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const n = (value: unknown): number => (typeof value === "number" ? value : 0);
const s = (value: unknown): string => (value == null ? "" : String(value));
const fixed = (value: unknown, places = 2) => pyFixed(n(value), places);
const comma = (value: unknown) => groupThousands(String(n(value)));
const table = (headers: string[], values: unknown[][], right: number[] = []) =>
  mdTable(headers, values, new Set(right));

export function renderSimulationMarkdownSection(
  section: ReportSection,
): string {
  const d = section.data,
    heading = `## ${section.title}\n\n`,
    rs = rows(d.rows);
  switch (section.kind) {
    case "summary": {
      const rate = n(d.success_rate),
        achieved = n(d.goals_achieved),
        total = n(d.total_conversations),
        errors = n(d.errors);
      const [callout, label] =
        rate >= 0.8
          ? ["TIP", "STRONG"]
          : rate >= 0.5
            ? ["NOTE", "MIXED"]
            : rate >= 0.25
              ? ["WARNING", "LOW"]
              : ["CAUTION", "VERY LOW"];
      let risk = `> [!${callout}]\n> GOAL ACHIEVEMENT: ${label} - success rate: **${pct(rate)}**`;
      if (d.confidence)
        risk += `\n> **Confidence: ${d.confidence}** - ${d.confidence_note}`;
      if (d.narrative) risk += `\n>\n> ${d.narrative}`;
      const kpis = centerTable(
        [
          "Conversations",
          "Goals Achieved",
          "Success Rate",
          "Avg Score",
          "Errors",
        ],
        [
          [
            `**${total}**`,
            `**${achieved}**`,
            `**${pct(rate)}**`,
            `**${fixed(d.avg_goal_completion_score)}**`,
            `**${errors}**`,
          ],
        ],
      );
      const detail = [
        ["Total Conversations", String(total)],
        ["Goals Achieved", String(achieved)],
        ["Success Rate", pct(rate)],
        ["Avg Goal Completion Score", fixed(d.avg_goal_completion_score)],
        ["Avg Turn Count", fixed(d.avg_turn_count, 1)],
        ["Total Tokens", comma(d.total_tokens)],
      ];
      if (errors) detail.push(["Errors", String(errors)]);
      return (
        heading +
        risk +
        "\n\n" +
        kpis +
        "\n\n" +
        table(["Metric", "Value"], detail)
      );
    }
    case "persona_breakdown":
    case "scenario_breakdown": {
      const persona = section.kind === "persona_breakdown";
      if (!rs.length)
        return `${heading}No ${persona ? "persona" : "scenario"} data.`;
      return (
        heading +
        table(
          [
            persona ? "Persona" : "Scenario",
            "Convs",
            "Achieved",
            "Success",
            "Avg Score",
            persona ? "Tokens" : "Avg Turns",
          ],
          rs.map((r) => [
            r[persona ? "persona" : "scenario"],
            String(r.conversations),
            String(r.goals_achieved),
            boldBar(n(r.success_rate)),
            fixed(r.avg_goal_completion_score),
            persona ? comma(r.total_tokens) : fixed(r.avg_turn_count, 1),
          ]),
          [1, 2, 5],
        )
      );
    }
    case "judge_verdicts": {
      const entries = Object.entries(dict(d.terminated_by)).sort(
        (a, b) => n(b[1]) - n(a[1]),
      );
      return (
        heading +
        (entries.length
          ? "**Terminated By:**\n\n" +
            table(
              ["Reason", "Count"],
              entries.map(([k, v]) => [k, String(v)]),
              [1],
            )
          : "No termination data.")
      );
    }
    case "turn_metrics": {
      const lines = [`## ${section.title}`, ""];
      const dist = Object.entries(dict(d.turn_count_distribution)),
        qualities = Object.entries(dict(d.avg_quality_metrics));
      if (dist.length)
        lines.push(
          "**Turn Count Distribution:**",
          "",
          table(
            ["Turns", "Conversations"],
            dist.map(([k, v]) => [k, String(v)]),
            [1],
          ),
          "",
        );
      if (qualities.length)
        lines.push(
          "**Average Per-Turn Quality Metrics:**",
          "",
          table(
            ["Metric", "Avg Score"],
            qualities.map(([k, v]) => [k, fixed(v)]),
          ),
        );
      return lines.join("\n");
    }
    case "evaluator_scores": {
      if (!rs.length) return "";
      const num = (v: unknown) => (v == null ? "-" : fixed(v));
      const body = table(
        ["Evaluator", "Runs", "Dropped", "Mean", "Min", "Max"],
        rs.map((r) => [
          r.evaluator,
          String(r.runs),
          String(r.dropped ?? 0),
          num(r.mean_score),
          num(r.min_score),
          num(r.max_score),
        ]),
        [1, 2, 3, 4, 5],
      );
      const notes = rs
        .filter((r) => r.dropped && r.first_error)
        .map(
          (r) =>
            `- \`${r.evaluator}\`: ${r.dropped} score(s) dropped - ${r.first_error}`,
        );
      return (
        heading +
        body +
        (notes.length ? `\n\n**Dropped scores:**\n\n${notes.join("\n")}\n` : "")
      );
    }
    case "token_usage":
      return (
        heading + table(["Metric", "Value"], buildSimulationTokenUsageRows(d))
      );
    case "errors": {
      const lines = [
        `## ${section.title}`,
        "",
        `**Total errored conversations:** ${d.total_errored ?? 0}`,
        "",
      ];
      const entries = Object.entries(dict(d.by_message));
      if (entries.length)
        lines.push(
          table(
            ["Error", "Count"],
            entries.map(([k, v]) => [k, String(v)]),
            [1],
          ),
        );
      return lines.join("\n");
    }
    case "failures_first":
      return (
        heading +
        (!rs.length
          ? "No failed conversations."
          : table(
              [
                "#",
                "Persona",
                "Scenario",
                "Violated criteria",
                "Score",
                "Ended",
              ],
              rs.map((r) => [
                `[#${r.index}](#${r.anchor})`,
                r.persona,
                r.scenario,
                (strings(r.violated).join(", ") || "-") +
                  (r.has_safety ? " ⚠️" : ""),
                fixed(r.score),
                r.terminated_by,
              ]),
            ))
      );
    case "persona_scenario_heatmap": {
      const personas = strings(d.personas),
        scenarios = strings(d.scenarios),
        cells = rows(d.cells);
      if (!personas.length || !scenarios.length) return `${heading}No data.`;
      return (
        heading +
        table(
          ["Scenario", ...personas],
          scenarios.map((scenario) => [
            scenario,
            ...personas.map((persona) => {
              const cell = cells.find(
                (c) => c.persona === persona && c.scenario === scenario,
              );
              return cell ? pyPercent(n(cell.success_rate)) : "-";
            }),
          ]),
        )
      );
    }
    case "score_distribution": {
      const scores = Array.isArray(d.scores) ? d.scores.map(Number) : [];
      if (!scores.length) return `${heading}No scores.`;
      const counts = Array<number>(10).fill(0);
      for (const score of scores) {
        const index = Math.min(9, Math.max(0, Math.trunc(score * 10)));
        counts[index] = (counts[index] ?? 0) + 1;
      }
      const max = Math.max(...counts) || 1;
      return (
        heading +
        counts
          .map((count, index) => {
            const filled = pyRound((count / max) * 20);
            return `\`${pyFixed(index / 10, 1)}-${pyFixed((index + 1) / 10, 1)}\` ${"█".repeat(filled)}${"░".repeat(20 - filled)} ${count}`;
          })
          .join("\n")
      );
    }
    case "turn_quality_timeline": {
      const turns = Array.isArray(d.turns) ? d.turns : [],
        series = dict(d.series);
      if (!turns.length || !Object.keys(series).length)
        return `${heading}No turn data.`;
      let names = Object.keys(series).filter(
        (key) =>
          Array.isArray(series[key]) &&
          (series[key] as unknown[]).some((v) => v != null),
      );
      if (!names.length) names = Object.keys(series);
      return (
        heading +
        table(
          ["Turn", ...names],
          turns.map((turn, index) => [
            String(turn),
            ...names.map((key) => {
              const values = Array.isArray(series[key])
                ? (series[key] as unknown[])
                : [];
              return values[index] == null ? "-" : fixed(values[index]);
            }),
          ]),
          names.map((_, i) => i + 1),
        )
      );
    }
    case "failure_mode":
      return (
        heading +
        (!rs.length
          ? "No failure modes."
          : table(
              ["Scenario: Criterion", "Count"],
              (d.rows as unknown[][]).map(([label, count]) => [
                label,
                String(count),
              ]),
              [1],
            ))
      );
    case "individual_results": {
      const entries = rows(d.entries);
      if (!entries.length) return `${heading}No conversations.`;
      const lines = [`## ${section.title}`, ""];
      for (const entry of entries) {
        const title = `#${n(entry.index) + 1}: ${entry.persona} / ${entry.scenario} - **${entry.goal_achieved ? "ACHIEVED" : "NOT ACHIEVED"}** (${entry.turn_count} turns, score ${fixed(entry.goal_completion_score)})`;
        const body: string[] = [];
        if (entry.target_model) body.push(`- **Model:** ${entry.target_model}`);
        body.push(
          `- **Terminated by:** ${entry.terminated_by}`,
          `- **Tokens:** ${comma(entry.total_tokens)}`,
        );
        const criteria = rows(entry.criteria),
          failed = criteria.filter((c) => !c.passed),
          unaudited = criteria.filter((c) => c.state === "unknown");
        if (failed.length)
          body.push(
            "- **Criteria violated:** " +
              failed.map((c) => c.description).join(", "),
          );
        if (unaudited.length)
          body.push(
            "- **Criteria not audited:** " +
              unaudited.map((c) => c.description).join(", "),
          );
        if (entry.criteria_verified === false)
          body.push(
            "- **Criteria audit:** unverified - the judge did not audit every criterion and `criteria_met` scored this run 0.0.",
          );
        const evidence = criteria.filter((c) => c.evidence);
        if (evidence.length)
          body.push(
            "- **Evidence:**",
            ...evidence.map((c) => `    - ${c.description}: "${c.evidence}"`),
          );
        const scores = Object.entries(dict(entry.evaluator_scores));
        if (scores.length)
          body.push(
            "- **Evaluator scores:** " +
              scores.map(([k, v]) => `${k}=${fixed(v)}`).join(", "),
          );
        if (entry.error) body.push(`- **Error:** ${entry.error}`);
        body.push(
          "",
          `**Judge reason:** ${entry.judge_reason}`,
          "",
          "**Transcript:**",
          "",
        );
        for (const message of rows(entry.transcript))
          body.push(
            `_${message.role}_:`,
            "",
            `> ${truncate(s(message.content), 600).replaceAll("\n", "\n> ")}`,
            "",
          );
        lines.push(detailsBlock(title, body.join("\n")), "");
      }
      return lines.join("\n");
    }
    case "overview": {
      const personas = rows(d.personas),
        scenarios = rows(d.scenarios);
      if (!personas.length && !scenarios.length) return "";
      const lines = [
        `## ${section.title}`,
        "",
        `This report evaluates the target agent across **${personas.length}** persona(s) and **${scenarios.length}** scenario(s), for **${d.total_conversations ?? 0}** simulated conversation(s). In each, a simulated user (the persona) pursues the scenario goal while a judge scores success criteria and per-turn quality.`,
        "",
        "**Personas**",
        "",
      ];
      for (const p of personas) {
        lines.push(`- ${p.name} (${p.conversations} conv.)`);
        if (
          p.traits &&
          typeof p.traits === "object" &&
          !Array.isArray(p.traits)
        ) {
          const traits = dict(p.traits);
          const parts = [
            ["patience", "patience"],
            ["assertiveness", "assertiveness"],
            ["politeness", "politeness"],
            ["technical", "technical_level"],
          ].map(
            ([label, key]) =>
              `${label} ${reportScalar(traits[key ?? ""] ?? "?")}`,
          );
          if (traits.communication_style)
            parts.push(String(traits.communication_style));
          lines.push(`  - _traits_: ${parts.join(" · ")}`);
        }
        if (p.background) lines.push(`  - _background_: ${p.background}`);
      }
      lines.push("", "**Scenarios**", "");
      for (const scenario of scenarios) {
        lines.push(`- ${scenario.name}`);
        if (scenario.goal) lines.push(`  - **Goal:** ${scenario.goal}`);
        if (scenario.context)
          lines.push(`  - **Context:** ${scenario.context}`);
        for (const c of rows(scenario.criteria))
          lines.push(
            `  - _${c.type === "must_not_happen" ? "must NOT" : "must"}_: ${c.description}`,
          );
      }
      return lines.join("\n");
    }
    case "recommendations": {
      if (!rs.length) return `${heading}No remediation suggestions.`;
      const lines = [`## ${section.title}`, ""];
      for (const r of rs) {
        lines.push(
          `### [#${r.index}](#${r.anchor}) ${r.persona} / ${r.scenario}${r.datapoint_id ? ` (datapoint \`${r.datapoint_id}\`)` : ""}`,
          "",
          ...strings(r.triggers).map((t) => `- **Flagged:** ${t}`),
          ...strings(r.suggestions).map((t) => `- **Fix:** ${t}`),
          "",
        );
      }
      return lines.join("\n").trimEnd();
    }
    default:
      throw new Error(`Unsupported simulation report section: ${section.kind}`);
  }
}

export async function exportSimulationMarkdown(
  results: readonly ReportResult[],
  options: BuildSimulationSectionsOptions & {
    target?: string;
    runDate?: Date | string;
  } = {},
): Promise<string> {
  const sections = buildSimulationReportSections(results, options);
  const summary =
    sections.find((section) => section.kind === "summary")?.data ?? {};
  return renderMarkdown(sections, {
    renderers: Object.fromEntries(
      sections.map((section) => [
        section.kind,
        renderSimulationMarkdownSection,
      ]),
    ),
    collapsedKinds: new Set(["token_usage", "individual_results"]),
    header: renderHeaderMd({
      title: "Agent Simulation Report",
      rows: [
        ["Target", options.target ?? "agent"],
        ["Date", formatDate(options.runDate ?? new Date())],
        ["Conversations", String(summary.total_conversations ?? 0)],
        ["Success Rate", pct(n(summary.success_rate))],
      ],
    }),
    footer: "\n---\n\n*Generated by evaluatorq agent simulation suite.*",
  });
}
