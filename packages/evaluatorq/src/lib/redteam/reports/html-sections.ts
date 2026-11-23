import {
  esc,
  htmlTable,
  pct,
  scaleColor,
} from "../../common/reports/html-helpers.js";
import {
  CACHED_TOKENS_LABEL,
  costCoverage,
  fmtCachedTokens,
  fmtCost,
  truncate,
} from "../../common/reports/md-helpers.js";
import { pyFixed } from "../../common/reports/number-format.js";
import { COLORS } from "../../common/reports/palette.js";
import type { RendererRegistry } from "../../common/reports/render.js";
import {
  renderSvg,
  type VegaSpec,
  vlBarH,
  vlDonut,
} from "../../common/reports/vega.js";
import type { ReportSection } from "../../contracts.js";

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const n = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (v == null ? "" : String(v));
const rate = (v: unknown): number | null => (typeof v === "number" ? v : null);
const head = (s: ReportSection) => `<h2>${esc(s.title)}</h2>`;
const cell = (v: unknown) => esc(str(v));
const headingEmpty = (s: ReportSection, message: string) =>
  `${head(s)}\n<p>${message}</p>`;
async function chart(spec: VegaSpec): Promise<string> {
  const svg = await renderSvg(spec);
  return svg ? `<div class="chart-container">${svg}</div>` : "";
}
export function renderPipelineWarningsHtml(section: ReportSection): string {
  return `${head(section)}\n<div class="callout warn"><p>This run was degraded. Read the results with these in mind:</p><ul>${((section.data.warnings ?? []) as string[]).map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
}
export function renderErrorBarChart(errors: Record<string, number>): string {
  const total = Object.values(errors).reduce((a, b) => a + b, 0);
  if (!total) return "";
  return `<div style="margin:1rem 0">${Object.entries(errors)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([type, count]) =>
        `<div class="error-bar-container"><span class="error-bar-label">${esc(type)}</span><div class="error-bar-track"><div class="error-bar-fill" style="width:${Math.min(100, Math.trunc((count / total) * 100))}%"></div></div><span class="error-bar-count">${count}</span></div>`,
    )
    .join("")}</div>`;
}
export function renderErrorAnalysisHtml(section: ReportSection): string {
  const data = section.data,
    total = n(data.total_errors);
  if (!total) return headingEmpty(section, "No errors recorded.");
  const errors = (data.errors_by_type ?? {}) as Record<string, number>,
    types = data.error_types_count ?? Object.keys(errors).length;
  const cards = `<div class="kpi-row"><div class="kpi-card kpi-warn"><div class="kpi-value">${total}</div><div class="kpi-label">Total Errors</div></div><div class="kpi-card"><div class="kpi-value">${pct(Object.hasOwn(data, "error_rate") ? rate(data.error_rate) : 0)}</div><div class="kpi-label">Error Rate</div></div><div class="kpi-card"><div class="kpi-value">${cell(types)}</div><div class="kpi-label">Error Types</div></div></div>`;
  const details = rows(data.detail_rows);
  let detailHtml = "";
  if (details.length) {
    detailHtml = htmlTable(
      ["ID", "Category", "Technique", "Error Type", "Stage", "Error"],
      details
        .slice(0, 100)
        .map((r) => [
          cell(r.id),
          cell(r.category),
          cell(r.technique),
          cell(r.error_type),
          cell(r.stage),
          esc(truncate(str(r.error), 200)),
        ]),
    );
    if (details.length > 100)
      detailHtml += `<p><em>${details.length - 100} more rows omitted.</em></p>`;
  }
  return `${head(section)}\n${cards}\n${renderErrorBarChart(errors)}\n${detailHtml}`;
}
export async function renderVulnerabilityBreakdownHtml(
  section: ReportSection,
): Promise<string> {
  const values = rows(section.data.rows);
  if (!values.length)
    return headingEmpty(section, "No vulnerability data available.");
  const sorted = values
      .filter((r) => r.vulnerability_rate != null)
      .sort((a, b) => n(b.vulnerability_rate) - n(a.vulnerability_rate))
      .slice(0, 15),
    rates = sorted.map((r) => n(r.vulnerability_rate) * 100);
  const svg = await chart(
    vlBarH({
      labels: sorted.map((r) =>
        str(r.vulnerability_name || r.vulnerability || "?"),
      ),
      values: rates,
      color: COLORS.orange_300,
      xTitle: "Attack Success Rate (%)",
      valueLabels: rates.map((r) => `${pyFixed(r, 0)}%`),
    }),
  );
  const table = htmlTable(
    ["Vulnerability", "Domain", "Attacks", "Hits", "ASR"],
    values.map((r) => [
      cell(r.vulnerability_name || r.vulnerability),
      cell(r.domain),
      cell(r.total_attacks),
      cell(r.vulnerabilities_found),
      pct(rate(r.vulnerability_rate)),
    ]),
  );
  return `${head(section)}\n${svg}\n${table}`;
}
export async function renderFrameworkBreakdownHtml(
  section: ReportSection,
): Promise<string> {
  const values = rows(section.data.rows);
  if (!values.length)
    return headingEmpty(section, "No framework data available.");
  const evaluated = values.filter((r) => r.vulnerability_rate != null),
    rates = evaluated.map((r) => n(r.vulnerability_rate) * 100);
  const svg = evaluated.length
    ? await chart(
        vlBarH({
          labels: evaluated.map((r) => str(r.framework)),
          values: rates,
          color: COLORS.orange_300,
          xTitle: "ASR (%)",
          valueLabels: rates.map(
            (rate, i) =>
              `${pyFixed(rate, 1)}% n=${evaluated[i]?.total_attacks}`,
          ),
        }),
      )
    : "";
  const table = htmlTable(
    ["Framework", "Attacks", "Hits", "ASR", "Resistance Rate"],
    values.map((r) => [
      cell(r.framework),
      cell(r.total_attacks),
      cell(r.vulnerabilities_found),
      pct(rate(r.vulnerability_rate)),
      pct(rate(r.resistance_rate)),
    ]),
  );
  return `${head(section)}\n${svg}\n${table}`;
}
export async function renderSourceDistributionHtml(
  section: ReportSection,
): Promise<string> {
  const values = rows(section.data.rows);
  if (!values.length) return headingEmpty(section, "No source data available.");
  const palette = [
    COLORS.teal_400,
    COLORS.orange_300,
    COLORS.blue_400,
    COLORS.success_400,
    COLORS.yellow_400,
    COLORS.red_400,
  ];
  const svg = await chart(
    vlDonut({
      labels: values.map((r) => str(r.source)),
      values: values.map((r) => n(r.count)),
      colors: values.map((_, i) => palette[i % palette.length] as string),
    }),
  );
  return `${head(section)}\n${svg}\n${htmlTable(
    ["Source", "Count"],
    values.map((r) => [cell(r.source), cell(r.count)]),
  )}`;
}
export function renderSeverityDefinitionsHtml(section: ReportSection): string {
  const definitions = rows(section.data.definitions),
    weights = (section.data.weights ?? {}) as Row;
  if (!definitions.length) return "";
  return `${head(section)}\n${htmlTable(
    ["Severity", "Description", "Risk Weight"],
    definitions.map((d) => {
      const level = str(d.level);
      return [
        `<span class="severity-${level}">${esc(level[0]?.toUpperCase() + level.slice(1).toLowerCase())}</span>`,
        cell(d.description),
        String(weights[level] ?? ""),
      ];
    }),
  )}`;
}
function usageCard(value: string, label: string): string {
  return `<div class="kpi-card"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${label}</div></div>`;
}
export async function renderTokenUsageHtml(
  section: ReportSection,
): Promise<string> {
  const overall = (section.data.overall ?? {}) as Row,
    agents = rows(section.data.per_agent);
  if (!Object.keys(overall).length && !agents.length)
    return headingEmpty(section, "No token usage data available.");
  const parts = [head(section)];
  if (Object.keys(overall).length) {
    parts.push(
      `<div class="kpi-row">${[
        ["total_tokens", "Total Tokens"],
        ["prompt_tokens", "Prompt Tokens"],
        ["completion_tokens", "Completion Tokens"],
        ["calls", "API Calls"],
      ]
        .map(([key, label]) =>
          usageCard(String(n(overall[key as string])), label as string),
        )
        .join("")}</div>`,
    );
    const cache: string[] = [];
    if (n(overall.cached_tokens))
      cache.push(
        usageCard(
          fmtCachedTokens(n(overall.cached_tokens), n(overall.prompt_tokens)),
          CACHED_TOKENS_LABEL,
        ),
      );
    if (n(overall.cache_creation_tokens))
      cache.push(
        usageCard(
          String(n(overall.cache_creation_tokens)),
          "Cache-Write Tokens",
        ),
      );
    if (cache.length)
      parts.push(`<div class="kpi-row">${cache.join("")}</div>`);
    const costs: string[] = [];
    if (overall.input_cost != null)
      costs.push(usageCard(fmtCost(n(overall.input_cost)), "Input Cost"));
    if (overall.output_cost != null)
      costs.push(usageCard(fmtCost(n(overall.output_cost)), "Output Cost"));
    if (overall.total_cost != null)
      costs.push(
        usageCard(
          fmtCost(n(overall.total_cost)),
          `Total Cost${esc(costCoverage(n(overall.priced_calls), n(overall.calls)))}`,
        ),
      );
    if (costs.length)
      parts.push(`<div class="kpi-row">${costs.join("")}</div>`);
  }
  if (agents.length) {
    const amounts = agents.map((r) => n(r.total_tokens));
    if (amounts.some(Boolean)) {
      const svg = await chart(
        vlBarH({
          labels: agents.map((r) => str(r.agent ?? "?")),
          values: amounts,
          color: COLORS.teal_400,
          xTitle: "Total Tokens",
          valueLabels: amounts.map((v) => String(Math.trunc(v))),
        }),
      );
      if (svg) parts.push(svg);
    }
    const anyCost = agents.some((r) => r.total_cost != null),
      headers = [
        "Agent",
        "Total Tokens",
        "Prompt Tokens",
        "Completion Tokens",
        "API Calls",
      ];
    if (anyCost) headers.push("Total Cost");
    const table = htmlTable(
      headers,
      agents.map((r) => {
        const row = [
          cell(r.agent ?? "?"),
          ...[
            "total_tokens",
            "prompt_tokens",
            "completion_tokens",
            "calls",
          ].map((k) => cell(r[k] ?? 0)),
        ];
        if (anyCost)
          row.push(
            r.total_cost != null
              ? esc(
                  `${fmtCost(n(r.total_cost))}${costCoverage(n(r.priced_calls), n(r.calls))}`,
                )
              : "-",
          );
        return row;
      }),
    );
    parts.push("<h3>Per-Agent Breakdown</h3>", table);
  }
  return parts.join("\n");
}
export function renderAgentComparisonHtml(section: ReportSection): string {
  const data = section.data,
    agents = (data.agents ?? []) as string[],
    metrics = rows(data.agent_metrics),
    heatmap = (data.heatmap ?? {}) as Row;
  if (agents.length < 2)
    return headingEmpty(
      section,
      "Agent comparison requires at least 2 agents.",
    );
  const parts = [head(section), '<div class="kpi-row">'];
  for (const metric of metrics) {
    const asr = rate(metric.asr),
      cls =
        asr === null
          ? ""
          : asr >= 0.5
            ? "kpi-alert"
            : asr >= 0.2
              ? "kpi-warn"
              : "";
    parts.push(
      `<div class="kpi-card ${cls}" style="flex:1 1 160px;"><div class="kpi-label" style="font-size:.9em;color:var(--clay);">${cell(metric.agent)}</div><div class="kpi-value">${pct(asr)}</div><div class="kpi-subtitle">${cell(metric.vulnerabilities_found)} vulns / ${cell(metric.total_attacks)} attacks</div></div>`,
    );
  }
  parts.push("</div>");
  const vulnerabilities = (heatmap.vulnerabilities ?? []) as string[],
    agentList = (heatmap.agents ?? []) as string[],
    matrix = (heatmap.z_matrix ?? []) as number[][],
    texts = (heatmap.text_matrix ?? []) as string[][];
  if (vulnerabilities.length && agentList.length && matrix.length) {
    parts.push("<h3>ASR Heatmap (Vulnerability × Agent)</h3>");
    const table = [
      '<div style="overflow-x:auto"><table class="heatmap-table">',
      "<thead><tr>",
      "<th>Vulnerability</th>",
      ...agentList.map((a) => `<th>${esc(a)}</th>`),
      "</tr></thead><tbody>",
    ];
    for (const [ri, vuln] of vulnerabilities.entries()) {
      table.push("<tr>", `<td><strong>${esc(vuln)}</strong></td>`);
      for (let ci = 0; ci < agentList.length; ci++) {
        let asr = matrix[ri]?.[ci] ?? 0,
          text = texts.length ? texts[ri]?.[ci] : `${pyFixed(asr, 0)}%`;
        if (matrix[ri]?.[ci] === undefined || text === undefined) {
          asr = 0;
          text = "-";
        }
        const unevaluated = text.startsWith("n/a"),
          bg = unevaluated
            ? COLORS.sand_400
            : scaleColor(asr / 100, [
                [0, "#299D8F"],
                [0.5, "#ff8f34"],
                [1, "#df5325"],
              ]),
          color = unevaluated
            ? COLORS.ink_700
            : asr >= 30
              ? "white"
              : COLORS.ink_700;
        table.push(
          `<td style="text-align:center;"><span class="heatmap-cell" style="background:${bg};color:${color};">${esc(text)}</span></td>`,
        );
      }
      table.push("</tr>");
    }
    table.push("</tbody></table></div>");
    parts.push(table.join("\n"));
  }
  return parts.join("\n");
}
export function renderAgentDisagreementsHtml(section: ReportSection): string {
  const data = section.data,
    agents = (data.agents ?? []) as string[],
    disagreements = rows(data.disagreements);
  if (!disagreements.length)
    return headingEmpty(
      section,
      `No disagreements found between agents (${agents.map(esc).join(", ")}).`,
    );
  const parts = [
    head(section),
    `<p>Found <strong>${cell(data.total_disagreements ?? 0)}</strong> attack(s) where agents disagreed (one found vulnerable, another resistant).</p>`,
  ];
  for (const [index, dis] of disagreements.entries()) {
    const severity = str(dis.severity),
      sevClass = severity ? `severity-${esc(severity)}` : "",
      summary = `#${index + 1} &nbsp; ${cell(dis.attack_id)} &nbsp; ${cell(dis.vulnerability)} / ${cell(dis.technique)}${severity ? ` &nbsp; <span class="${sevClass}">[${esc(severity)}]</span>` : ""}`;
    const panels = rows(dis.per_agent)
      .map((agent) => {
        const vulnerable = agent.vulnerable,
          cls =
            vulnerable === null
              ? "badge-error"
              : vulnerable
                ? "badge-vulnerable"
                : "badge-resistant",
          label =
            vulnerable === null
              ? "NOT EVALUATED"
              : vulnerable
                ? "VULNERABLE"
                : "RESISTANT",
          parts = [
            '<div style="flex:1 1 45%;min-width:180px;">',
            `<strong>${cell(agent.agent)}</strong> <span class="badge ${cls}">${label}</span>`,
          ];
        if (agent.explanation)
          parts.push(`<p><em>${cell(agent.explanation)}</em></p>`);
        if (agent.response_snippet)
          parts.push(
            `<pre>${esc(truncate(str(agent.response_snippet), 500))}</pre>`,
          );
        parts.push("</div>");
        return parts.join("\n");
      })
      .join("");
    const panelHtml = `<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.5rem;">${panels}</div>`,
      prompt = dis.prompt_snippet
        ? `<p><strong>Attack prompt:</strong></p><pre>${esc(truncate(str(dis.prompt_snippet), 300))}</pre>`
        : "";
    parts.push(
      `<details><summary>${summary}</summary><div style="padding:.5rem 0 .5rem 1rem;">${prompt}${panelHtml}</div></details>`,
    );
  }
  return parts.join("\n");
}
export const REPORT_TAB_RENDERERS: RendererRegistry = {
  pipeline_warnings: renderPipelineWarningsHtml,
  error_analysis: renderErrorAnalysisHtml,
  vulnerability_breakdown: renderVulnerabilityBreakdownHtml,
  framework_breakdown: renderFrameworkBreakdownHtml,
  source_distribution: renderSourceDistributionHtml,
  severity_definitions: renderSeverityDefinitionsHtml,
  token_usage: renderTokenUsageHtml,
  agent_comparison: renderAgentComparisonHtml,
  agent_disagreements: renderAgentDisagreementsHtml,
};
