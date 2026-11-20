import {
  bar,
  boldBar,
  CACHED_TOKENS_LABEL,
  centerTable,
  costCoverage,
  detailsBlock,
  fmtCachedTokens,
  fmtCost,
  mdTable,
  pct,
  truncate,
} from "../../common/reports/md-helpers.js";
import {
  groupThousands,
  pyFixed,
  pyPercent,
} from "../../common/reports/number-format.js";
import { formatDate, renderMarkdown } from "../../common/reports/render.js";
import { LINE_BREAKS } from "../../common/unified-diff.js";
import type { ReportSection } from "../../contracts.js";
import { JuryHealth, type RedTeamReport } from "./models.js";
import { buildRedteamReportSections } from "./sections.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(row) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
const n = (value: unknown): number => (typeof value === "number" ? value : 0);
const s = (value: unknown): string => (value == null ? "" : String(value));
const rate = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
const count = (value: unknown): string => groupThousands(String(n(value)));
const heading = (section: ReportSection, body: string) =>
  `## ${section.title}\n\n${body}`;
const rateBar = (value: unknown) =>
  value == null ? pct(null) : boldBar(n(value));
export const redteamVerdictLabel = (
  vulnerable: boolean | null | undefined,
): string =>
  vulnerable == null
    ? "NOT EVALUATED"
    : vulnerable
      ? "VULNERABLE"
      : "RESISTANT";
export const redteamSeverityLabel = (risk: number): string =>
  risk >= 4 ? "CRITICAL" : risk >= 2 ? "HIGH" : risk >= 1 ? "MEDIUM" : "LOW";
function summary(section: ReportSection): string {
  const d = section.data,
    asr = rate(d.vulnerability_rate),
    total = n(d.total_attacks),
    hits = n(d.vulnerabilities_found),
    errors = n(d.total_errors);
  const [callout, label] =
    asr == null
      ? ["NOTE", "NOT EVALUATED"]
      : asr >= 0.5
        ? ["CAUTION", "CRITICAL"]
        : asr >= 0.25
          ? ["CAUTION", "HIGH"]
          : asr >= 0.1
            ? ["WARNING", "MEDIUM"]
            : ["NOTE", "LOW"];
  let risk = `> [!${callout}]\n> RISK: ${label} - Attack Success Rate: **${pct(asr)}**`;
  if (d.confidence)
    risk += `\n> **Confidence: ${s(d.confidence)}** - ${s(d.confidence_note)}`;
  if (d.narrative) risk += `\n>\n> ${s(d.narrative)}`;
  const kpi = centerTable(
    ["Total Attacks", "Successful Attacks", "ASR", "Coverage", "Errors"],
    [
      [
        `**${total}**`,
        `**${hits}**`,
        `**${pct(asr)}**`,
        `**${pct(rate(d.evaluation_coverage))}**`,
        `**${errors}**`,
      ],
    ],
  );
  const detail: string[][] = [
    ["Total Attacks", String(total)],
    ["Evaluated", String(n(d.evaluated_attacks))],
    ["Successful Attacks", String(hits)],
    ["ASR", pct(asr)],
    ["Evaluation Coverage", pct(rate(d.evaluation_coverage))],
  ];
  if (errors) detail.push(["Errors", String(errors)]);
  const reliability = row(d.jury_reliability);
  if (Object.keys(reliability).length)
    detail.push([
      "Jury Agreement (Krippendorff alpha)",
      `${reliability.krippendorff_alpha == null ? "n/a" : `alpha = ${pyFixed(n(reliability.krippendorff_alpha), 2)}`} (${n(reliability.samples)} multi-judge samples)`,
    ]);
  if (d.jury_health) {
    const health = new JuryHealth(d.jury_health);
    detail.push([
      "Jury Health",
      `${health.issueSummary()} (${health.samples} multi-judge samples)`,
    ]);
  }
  if (d.duration_seconds != null) {
    const seconds = Math.trunc(n(d.duration_seconds));
    detail.push(["Duration", `${Math.floor(seconds / 60)}m ${seconds % 60}s`]);
  }
  return [
    `## ${section.title}`,
    "",
    risk,
    "",
    kpi,
    "",
    mdTable(["Metric", "Value"], detail),
  ].join("\n");
}
function context(section: ReportSection): string {
  const agents = rows(section.data.agents);
  if (!agents.length)
    return heading(section, "No agent information available.");
  const lines = [`## ${section.title}`, ""];
  for (const agent of agents) {
    lines.push(`### ${s(agent.display_name || agent.key || "unknown")}`, "");
    for (const [key, label] of [
      ["model", "Model"],
      ["version", "Version"],
      ["description", "Description"],
    ])
      if (agent[key as string])
        lines.push(`**${label}:** ${s(agent[key as string])}  `);
    for (const [key, label] of [
      ["tools", "Tools"],
      ["skills", "Skills"],
      ["memory_stores", "Memory"],
      ["knowledge_bases", "Knowledge"],
    ]) {
      const values = strings(agent[key as string]);
      if (values.length) lines.push(`**${label}:** ${values.join(", ")}  `);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function focus(section: ReportSection): string {
  const areas = rows(section.data.focus_areas);
  if (!areas.length)
    return heading(section, "No significant risk areas identified.");
  const lines = [`## ${section.title}`, ""];
  for (const [index, area] of areas.entries()) {
    lines.push(
      `### ${index + 1}. [${redteamSeverityLabel(n(area.risk_score))}] ${s(area.category)} - ${s(area.category_name ?? area.category)}`,
      "",
      `- **Vulnerabilities:** ${n(area.vulnerabilities_found)} (${bar(rate(area.vulnerability_rate))} of attacks succeeded)`,
      `- **Risk Score:** ${pyFixed(n(area.risk_score), 2)}`,
      "",
    );
    if (area.remediation)
      lines.push(
        "**Remediation guidance:**",
        "",
        `> ${s(area.remediation)}`,
        "",
      );
    if (area.agent_specific_remediation)
      lines.push(
        "**Agent-specific recommendations:**",
        "",
        `> ${s(area.agent_specific_remediation)}`,
        "",
      );
    const rec = row(area.llm_recommendations),
      items = strings(rec.recommendations);
    if (items.length)
      lines.push(
        `**Actionable recommendations** (based on ${n(rec.traces_analyzed)} trace samples):`,
        "",
        ...items.map((value) => `- ${value}`),
        "",
      );
    if (rec.patterns_observed)
      lines.push(`*Patterns observed:* ${s(rec.patterns_observed)}`, "");
  }
  return lines.join("\n");
}
function comparison(section: ReportSection): string {
  const d = section.data,
    agents = strings(d.agents),
    metrics = rows(d.agent_metrics),
    heatmap = row(d.heatmap);
  if (!agents.length) return heading(section, "No multi-agent data available.");
  const lines = [`## ${section.title}`, ""];
  if (metrics.length)
    lines.push(
      "### Agent Overview",
      "",
      mdTable(
        ["Agent", "Attacks", "Hits", "ASR"],
        metrics.map((value) => [
          value.agent,
          n(value.total_attacks),
          n(value.vulnerabilities_found),
          boldBar(rate(value.asr)),
        ]),
        new Set([1, 2]),
      ),
      "",
    );
  const vulnerabilities = strings(heatmap.vulnerabilities),
    names = strings(heatmap.agents),
    zs = Array.isArray(heatmap.z_matrix)
      ? (heatmap.z_matrix as unknown[][])
      : [],
    texts = Array.isArray(heatmap.text_matrix)
      ? (heatmap.text_matrix as unknown[][])
      : [];
  if (vulnerabilities.length && names.length && zs.length) {
    lines.push(
      "### ASR by Vulnerability per Agent",
      "",
      centerTable(
        ["Vulnerability", ...names],
        vulnerabilities.map((name, i) => [
          name,
          ...names.map((_, j) => {
            const value = n(zs[i]?.[j]),
              text = s(texts[i]?.[j] ?? `${pyFixed(value, 0)}%`);
            return value >= 40 ? `**${text}**` : text;
          }),
        ]),
      ),
      "",
    );
  }
  return lines.join("\n");
}
function disagreements(section: ReportSection): string {
  const total = n(section.data.total_disagreements);
  if (!total)
    return heading(
      section,
      "No disagreements - all agents agreed on every attack.",
    );
  const lines = [
    `## ${section.title}`,
    "",
    "> [!NOTE]",
    `> **${total}** disagreements found where agents produced different verdicts`,
    "",
  ];
  for (const attack of rows(section.data.disagreements)) {
    const perAgent = rows(attack.per_agent),
      verdicts = perAgent.map(
        (value) =>
          `${s(value.agent)}: **${redteamVerdictLabel(value.vulnerable as boolean | null)}**`,
      );
    const body = [
      `- **Vulnerability:** ${s(attack.vulnerability)}`,
      `- **Technique:** ${s(attack.technique)}`,
      `- **Severity:** ${s(attack.severity)}`,
      `- **Verdicts:** ${verdicts.join(" | ")}`,
      "",
    ];
    for (const value of perAgent) {
      body.push(
        `**${s(value.agent)}** (${redteamVerdictLabel(value.vulnerable as boolean | null)}):`,
      );
      if (value.explanation) body.push(`> ${s(value.explanation)}`);
      if (value.response_snippet)
        body.push(
          `\x60\x60\x60\n${truncate(s(value.response_snippet), 300)}\n\x60\x60\x60`,
        );
      body.push("");
    }
    lines.push(
      detailsBlock(
        `[${s(attack.severity).toUpperCase()}] ${s(attack.attack_id || "unknown")} - ${s(attack.vulnerability)}`,
        body.join("\n"),
      ),
      "",
    );
  }
  return lines.join("\n");
}
function breakdown(section: ReportSection): string {
  const values = rows(section.data.rows),
    kind = section.kind;
  if (!values.length)
    return [
      "vulnerability_breakdown",
      "category_breakdown",
      "technique_breakdown",
    ].includes(kind)
      ? heading(section, `No ${kind.split("_")[0]} data available.`)
      : "";
  const vulnerability = kind === "vulnerability_breakdown",
    category = kind === "category_breakdown";
  const [label, key] = vulnerability
    ? ["Vulnerability", "vulnerability"]
    : category
      ? ["Category", "category"]
      : kind === "technique_breakdown"
        ? ["Technique", "technique"]
        : kind === "delivery_breakdown"
          ? ["Delivery Method", "delivery_method"]
          : kind === "turn_depth_analysis"
            ? ["Turn Depth", "turn_count"]
            : ["Framework", "framework"];
  const headers = [
    label as string,
    ...(vulnerability ? ["Domain"] : []),
    "Attacks",
    "Hits",
    "ASR",
  ];
  const data = values.map((value) => [
    vulnerability
      ? value.vulnerability_name || value.vulnerability
      : category
        ? `${s(value.category)} - ${s(value.category_name)}`
        : value[key as string],
    ...(vulnerability ? [value.domain ?? ""] : []),
    n(value.total_attacks),
    n(value.vulnerabilities_found),
    rateBar(value.vulnerability_rate),
  ]);
  return heading(
    section,
    mdTable(
      headers,
      data,
      new Set(
        vulnerability
          ? [2, 3]
          : kind === "turn_depth_analysis"
            ? [0, 1, 2]
            : [1, 2],
      ),
    ),
  );
}
function heatmap(section: ReportSection): string {
  const vulnerabilities = strings(section.data.vulnerabilities),
    techniques = strings(section.data.techniques),
    cells = rows(section.data.cells);
  if (!vulnerabilities.length || !techniques.length || !cells.length)
    return heading(section, "No heatmap data available.");
  const table = vulnerabilities.map((vulnerability) => [
    vulnerability,
    ...techniques.map((technique) => {
      const cell = cells.find(
        (value) =>
          value.vulnerability === vulnerability &&
          value.technique === technique,
      );
      if (!cell || !n(cell.total_attacks)) return "-";
      const value = rate(cell.vulnerability_rate);
      if (value == null) return pct(null);
      const text = pyPercent(value);
      return value >= 0.4 ? `**${text}**` : text;
    }),
  ]);
  return heading(
    section,
    centerTable(
      [
        "Vulnerability",
        ...techniques.map((value) =>
          techniques.length > 6
            ? Array.from(value).slice(0, 12).join("")
            : value,
        ),
      ],
      table,
    ) +
      "\n*Legend: Values show Attack Success Rate (ASR). **Bold** = ASR >= 40%. `-` = no attacks attempted.*",
  );
}
function domains(section: ReportSection): string {
  const values = Object.entries(row(section.data.by_domain));
  if (!values.length) return "";
  return [
    `## ${section.title}`,
    "",
    "### Domain\n\n" +
      mdTable(
        ["Domain", "Attacks", "Hits", "ASR"],
        values.map(([key, value]) => {
          const v = row(value);
          return [
            key,
            n(v.total_attacks),
            n(v.vulnerabilities_found),
            rateBar(v.vulnerability_rate),
          ];
        }),
        new Set([1, 2]),
      ),
    "",
  ].join("\n");
}
function warnings(section: ReportSection): string {
  const lines = [
    `## ${section.title}`,
    "",
    "> [!WARNING]",
    "> This run was degraded. Read the results with these in mind:",
  ];
  for (const value of strings(section.data.warnings)) {
    const split = value.split(new RegExp(LINE_BREAKS, "u"));
    if (split.length > 1 && split.at(-1) === "") split.pop();
    for (const [index, line] of split.entries()) {
      const escaped = line
        .replace(/[\\`*_{}[\]#+\-.|]/g, "\\$&")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      lines.push((index === 0 ? "> - " : ">   ") + escaped);
    }
  }
  return lines.join("\n");
}
function errors(section: ReportSection): string {
  const d = section.data,
    total = n(d.total_errors),
    value = n(d.error_rate),
    byType = Object.entries(row(d.errors_by_type));
  if (!total) return "";
  const lines = [`## ${section.title}`, ""];
  if (value > 0.1)
    lines.push(
      "> [!WARNING]",
      `> Error rate is ${pct(value)} (${total} errors). This may indicate infrastructure problems or misconfigured targets.`,
      "",
    );
  lines.push(
    `**Total errors:** ${total} (${pct(value)} of attacks) across ${n(d.error_types_count ?? byType.length)} error type(s).`,
    "",
  );
  if (byType.length)
    lines.push(
      mdTable(
        ["Error Type", "Count"],
        byType
          .sort(([, a], [, b]) => n(b) - n(a))
          .map(([key, value]) => [key, n(value)]),
        new Set([1]),
      ),
      "",
    );
  const details = rows(d.detail_rows);
  if (details.length)
    lines.push(
      detailsBlock(
        "Individual Error Details",
        mdTable(
          ["ID", "Category", "Technique", "Error Type", "Stage", "Error"],
          details.map((value) => [
            value.id ?? "",
            value.category ?? "",
            value.technique ?? "",
            value.error_type ?? "",
            value.stage ?? "",
            Array.from(s(value.error)).slice(0, 200).join(""),
          ]),
        ),
      ),
      "",
    );
  return lines.join("\n");
}
function tokens(section: ReportSection): string {
  const d = section.data,
    overall = row(d.overall),
    agents = rows(d.per_agent),
    lines = [`## ${section.title}`, ""];
  if (!Object.keys(overall).length && !agents.length)
    return heading(section, "No token usage data available.");
  if (Object.keys(overall).length) {
    const metrics = [
      ["Total Tokens", count(overall.total_tokens)],
      ["Prompt Tokens", count(overall.prompt_tokens)],
      ["Completion Tokens", count(overall.completion_tokens)],
      ["API Calls", count(overall.calls)],
    ];
    if (n(overall.cached_tokens))
      metrics.push([
        CACHED_TOKENS_LABEL,
        fmtCachedTokens(n(overall.cached_tokens), n(overall.prompt_tokens)),
      ]);
    if (n(overall.cache_creation_tokens))
      metrics.push([
        "Cache-Write Tokens",
        count(overall.cache_creation_tokens),
      ]);
    for (const [key, label] of [
      ["input_cost", "Input Cost"],
      ["output_cost", "Output Cost"],
      ["total_cost", "Total Cost"],
    ])
      if (overall[key as string] != null)
        metrics.push([
          label as string,
          fmtCost(n(overall[key as string])) +
            (key === "total_cost"
              ? costCoverage(n(overall.priced_calls), n(overall.calls))
              : ""),
        ]);
    lines.push(mdTable(["Metric", "Value"], metrics, new Set([1])), "");
  }
  if (agents.length) {
    const anyCost = agents.some((value) => value.total_cost != null),
      headers = [
        "Agent",
        "Total",
        "Prompt",
        "Completion",
        "Calls",
        ...(anyCost ? ["Total Cost"] : []),
      ];
    lines.push(
      "### Per Agent",
      "",
      mdTable(
        headers,
        agents.map((value) => [
          value.agent,
          count(value.total_tokens),
          count(value.prompt_tokens),
          count(value.completion_tokens),
          count(value.calls),
          ...(anyCost
            ? [
                value.total_cost == null
                  ? "-"
                  : fmtCost(n(value.total_cost)) +
                    costCoverage(n(value.priced_calls), n(value.calls)),
              ]
            : []),
        ]),
        new Set(anyCost ? [1, 2, 3, 4, 5] : [1, 2, 3, 4]),
      ),
      "",
    );
  }
  return lines.join("\n");
}
function methodology(section: ReportSection): string {
  const d = section.data,
    lines = [
      `## ${section.title}`,
      "",
      `**Assessment Type:** ${s(d.pipeline ?? "unknown")}  `,
      `**Scoring Method:** ${s(d.scoring_method ?? "llm-as-judge")}  `,
    ];
  for (const [key, label] of [
    ["evaluator_model", "Evaluator Model"],
    ["attack_model", "Attack Model"],
    ["dataset_source", "Dataset Source"],
    ["framework", "Framework"],
  ])
    if (d[key as string]) lines.push(`**${label}:** ${s(d[key as string])}  `);
  lines.push("");
  const vulnerabilities = strings(d.vulnerabilities_tested),
    metrics = [
      ["Categories Tested", String(strings(d.categories_tested).length)],
      ["Total Attacks", String(n(d.total_attacks))],
      ["Evaluation Coverage", pct(rate(d.evaluation_coverage))],
    ];
  if (vulnerabilities.length)
    metrics.splice(1, 0, [
      "Vulnerabilities Tested",
      String(vulnerabilities.length),
    ]);
  if (d.max_turns)
    metrics.push(["Max Conversation Turns", String(n(d.max_turns))]);
  if (d.duration_seconds != null) {
    const seconds = Math.trunc(n(d.duration_seconds));
    metrics.push(["Duration", `${Math.floor(seconds / 60)}m ${seconds % 60}s`]);
  }
  lines.push(mdTable(["Parameter", "Value"], metrics), "");
  const agents = strings(d.tested_agents);
  if (agents.length) lines.push(`**Agents Tested:** ${agents.join(", ")}`, "");
  const limitations = strings(d.scope_limitations);
  if (limitations.length)
    lines.push(
      "### Known Limitations",
      "",
      ...limitations.map((value) => `- ${value}`),
      "",
    );
  const untested = strings(d.untested_categories),
    names = row(d.untested_category_names);
  if (untested.length)
    lines.push(
      "### Untested Categories",
      "",
      "> [!WARNING]",
      `> ${untested.length} supported categories were not included in this assessment:`,
      "",
      ...untested.map(
        (value) => `- **${value}** - ${s(names[value] ?? value)}`,
      ),
      "",
    );
  return lines.join("\n");
}
export function renderRedteamMarkdownSection(section: ReportSection): string {
  switch (section.kind) {
    case "summary":
      return summary(section);
    case "agent_context":
      return context(section);
    case "focus_areas":
      return focus(section);
    case "agent_comparison":
      return comparison(section);
    case "agent_disagreements":
      return disagreements(section);
    case "vulnerability_breakdown":
    case "category_breakdown":
    case "technique_breakdown":
    case "delivery_breakdown":
    case "turn_depth_analysis":
    case "framework_breakdown":
      return breakdown(section);
    case "attack_heatmap":
      return heatmap(section);
    case "turn_scope_breakdown":
      return domains(section);
    case "pipeline_warnings":
      return warnings(section);
    case "error_analysis":
      return errors(section);
    case "token_usage":
      return tokens(section);
    case "methodology":
      return methodology(section);
    case "source_distribution": {
      const values = rows(section.data.rows);
      if (!values.length) return "";
      const total = values.reduce((sum, value) => sum + n(value.count), 0);
      return heading(
        section,
        mdTable(
          ["Source", "Attacks", "Share"],
          values.map((value) => [
            value.source,
            n(value.count),
            bar(total ? n(value.count) / total : 0),
          ]),
          new Set([1]),
        ),
      );
    }
    case "severity_definitions": {
      const definitions = rows(section.data.definitions),
        weights = row(section.data.weights);
      return definitions.length
        ? heading(
            section,
            mdTable(
              ["Severity", "Description", "Risk Weight"],
              definitions.map((value) => [
                s(value.level).charAt(0).toUpperCase() +
                  s(value.level).slice(1),
                value.description,
                weights[s(value.level)] ?? "",
              ]),
            ),
          )
        : "";
    }
    default:
      return "";
  }
}
export async function exportRedteamMarkdown(
  report: RedTeamReport,
): Promise<string> {
  const sections = buildRedteamReportSections(report).filter(
      (section) => section.kind !== "individual_results",
    ),
    data = sections.find((section) => section.kind === "summary")?.data ?? {};
  const header = [
    "# Red Team Security Report",
    "",
    `**Target:** ${s(data.target ?? "unknown")}  `,
    `**Mode:** ${s(data.pipeline ?? "unknown")}  `,
    `**Date:** ${formatDate(data.created_at as string | null)}  `,
    `**ASR:** ${pct(rate(data.vulnerability_rate))}  `,
  ].join("\n");
  return renderMarkdown(sections, {
    renderers: Object.fromEntries(
      sections.map((section) => [section.kind, renderRedteamMarkdownSection]),
    ),
    collapsedKinds: new Set([
      "methodology",
      "severity_definitions",
      "token_usage",
      "source_distribution",
    ]),
    header,
    footer: "---\n\n*Generated by evaluatorq red team suite.*",
  });
}
