import { esc, scaleColor } from "../common/reports/html-helpers.js";
import { pyFixed } from "../common/reports/number-format.js";
import {
  COLORS,
  ORQ_SCALE_HEAT,
  QUALITATIVE,
  SEVERITY_ORDER,
} from "../common/reports/palette.js";
import {
  renderEmbed,
  stackedBarKey,
  vlBarH,
  vlHeatmap,
  vlStackedBar,
} from "../common/reports/vega.js";
import { codepointCompare, pythonTitle } from "../common/sanitize.js";
import { OWASP_CATEGORY_NAMES } from "../redteam/contracts.js";
import type {
  RedTeamReport,
  RedTeamResult,
} from "../redteam/reports/models.js";
import { getVulnerabilityDef } from "../redteam/vulnerability-registry.js";

const DIM_LABELS: Readonly<Record<string, string>> = {
  vulnerability: "Vulnerability",
  category: "Framework Category",
  severity: "Severity",
  attack_technique: "Attack Technique",
  delivery_method: "Delivery Method",
  source: "Source",
};
const HEATMAP_DIM_LABELS: Readonly<Record<string, string>> = {
  vulnerability: "Vulnerability",
  category: "Category",
  technique: "Technique",
  severity: "Severity",
};
export const quoteLinkPart = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export function fmtCategory(code: string): string {
  const name = Object.hasOwn(OWASP_CATEGORY_NAMES, code)
    ? OWASP_CATEGORY_NAMES[code as keyof typeof OWASP_CATEGORY_NAMES]
    : null;
  return name ? `${code} - ${name}` : code;
}
export function fmtVulnerability(id: string): string {
  return getVulnerabilityDef(id)?.name ?? pythonTitle(id.replaceAll("_", " "));
}
export function agentKey(result: RedTeamResult): string {
  return result.agent.key || result.agent.displayName || "unknown";
}
const isEvaluated = (r: RedTeamResult) =>
  typeof r.evaluation?.passed === "boolean";
const isVulnerable = (r: RedTeamResult) => r.evaluation?.passed === false;
function dimensionValue(r: RedTeamResult, dimension: string): string {
  switch (dimension) {
    case "category":
      return fmtCategory(r.attack.category);
    case "vulnerability":
      return r.attack.vulnerability
        ? fmtVulnerability(r.attack.vulnerability)
        : "unknown";
    case "severity":
      return r.attack.severity;
    case "attack_technique":
    case "technique":
      return r.attack.attackTechnique;
    case "delivery_method":
      return r.attack.deliveryMethods[0] || "unknown";
    case "source":
      return r.attack.source;
    default:
      return "unknown";
  }
}
function selectButtons(options: {
  options: string[];
  labels: Readonly<Record<string, string>>;
  selected: string;
  hxUrl: string;
  paramName: string;
  extraParams?: string;
  containerId: string;
}): string {
  const parts = [
    `<div class="rt-view-selector" id="${esc(options.containerId)}">`,
  ];
  for (const option of options.options) {
    const active =
        option === options.selected ? " rt-view-selector-active" : "",
      sep = options.extraParams ? "&" : "";
    const url = `${options.hxUrl}?${options.paramName}=${quoteLinkPart(option)}${sep}${options.extraParams ?? ""}`;
    parts.push(
      `<button class="rt-view-selector-btn${active}" hx-get="${url}" hx-target="#${esc(options.containerId)}" hx-swap="outerHTML">${esc(options.labels[option] ?? option)}</button>`,
    );
  }
  return `${parts.join("")}</div>`;
}
interface Counts {
  vuln: number;
  evaluated: number;
}
export function renderBreakdown(options: {
  report: RedTeamReport;
  groupBy: string;
  stackBy: string | null;
  rid: string;
  containerId?: string;
}): string {
  const { report, rid } = options,
    containerId = options.containerId ?? "rt-breakdown",
    dimensions = Object.keys(DIM_LABELS);
  const groupBy = dimensions.includes(options.groupBy)
    ? options.groupBy
    : "vulnerability";
  const stackBy =
    options.stackBy &&
    dimensions.includes(options.stackBy) &&
    options.stackBy !== groupBy
      ? options.stackBy
      : null;
  const baseUrl = `/r/${esc(rid)}/view/breakdown`,
    currentStack = stackBy || "none";
  const groupSelector = selectButtons({
    options: dimensions,
    labels: DIM_LABELS,
    selected: groupBy,
    hxUrl: baseUrl,
    paramName: "group_by",
    extraParams:
      currentStack !== "none" ? `stack_by=${quoteLinkPart(currentStack)}` : "",
    containerId,
  });
  const stackSelector = selectButtons({
    options: ["none", ...dimensions.filter((d) => d !== groupBy)],
    labels: { none: "None", ...DIM_LABELS },
    selected: currentStack,
    hxUrl: baseUrl,
    paramName: "stack_by",
    extraParams: `group_by=${quoteLinkPart(groupBy)}`,
    containerId,
  });
  if (!report.results.length || !report.results.some(isEvaluated))
    return `<div class="rt-breakdown" id="${esc(containerId)}">${groupSelector}${stackSelector}<p class="rt-view-empty">${!report.results.length ? "No results to display." : "No evaluated results to display."}</p></div>`;
  return `<div class="rt-breakdown" id="${esc(containerId)}"><div class="rt-breakdown-controls"><div class="rt-breakdown-control-group"><label class="rt-breakdown-label">Group by (Y-Axis)</label>${groupSelector}</div><div class="rt-breakdown-control-group"><label class="rt-breakdown-label">Stack / Color by</label>${stackSelector}</div></div>${buildBreakdownChart(report.results, groupBy, stackBy, containerId)}</div>`;
}
export function buildBreakdownChart(
  results: RedTeamResult[],
  groupBy: string,
  stackBy: string | null,
  containerId: string,
): string {
  if (stackBy === null) {
    const groups = new Map<string, Counts>();
    for (const r of results)
      if (isEvaluated(r)) {
        const key = dimensionValue(r, groupBy),
          counts = groups.get(key) ?? { vuln: 0, evaluated: 0 };
        counts.evaluated++;
        if (isVulnerable(r)) counts.vuln++;
        groups.set(key, counts);
      }
    const rows = [...groups]
      .map(([name, c]) => ({
        name,
        asr: Number(pyFixed(c.evaluated ? (c.vuln / c.evaluated) * 100 : 0, 1)),
        n: c.evaluated,
      }))
      .sort((a, b) => b.asr - a.asr);
    return renderEmbed(
      vlBarH({
        labels: rows.map((r) => r.name),
        values: rows.map((r) => r.asr),
        color: QUALITATIVE[0],
        xTitle: "ASR (%)",
        valueLabels: rows.map((r) => `${pyFixed(r.asr, 1)}% (n=${r.n})`),
        colors: rows.map(
          (_, i) => QUALITATIVE[i % QUALITATIVE.length] as string,
        ),
      }),
      `${containerId}-chart`,
    );
  }
  const groups = new Map<
    string,
    { dimension: string; stack: string; vuln: number; evaluated: number }
  >();
  for (const r of results)
    if (isEvaluated(r)) {
      const dimension = dimensionValue(r, groupBy),
        stack = dimensionValue(r, stackBy),
        key = stackedBarKey(dimension, stack),
        c = groups.get(key) ?? { dimension, stack, vuln: 0, evaluated: 0 };
      c.evaluated++;
      if (isVulnerable(r)) c.vuln++;
      groups.set(key, c);
    }
  const totals = new Map<string, Counts>();
  for (const row of groups.values()) {
    const c = totals.get(row.dimension) ?? { vuln: 0, evaluated: 0 };
    c.vuln += row.vuln;
    c.evaluated += row.evaluated;
    totals.set(row.dimension, c);
  }
  const dimensions = [...totals]
    .sort(
      ([, a], [, b]) =>
        b.vuln / Math.max(b.evaluated, 1) - a.vuln / Math.max(a.evaluated, 1),
    )
    .map(([name]) => name);
  const stacks = [...new Set([...groups.values()].map((r) => r.stack))].sort(
    codepointCompare,
  );
  const series: [string, number[]][] = [],
    valueLabels: string[][] = [];
  for (const stack of stacks) {
    const values: number[] = [],
      labels: string[] = [];
    for (const dimension of dimensions) {
      const row = groups.get(stackedBarKey(dimension, stack));
      values.push(row?.vuln ?? 0);
      labels.push(row?.evaluated ? `n=${row.evaluated}` : "");
    }
    series.push([stack, values]);
    valueLabels.push(labels);
  }
  const extraFields = new Map(
    [...groups].map(([key, c]) => [
      key,
      {
        asr: Number(pyFixed(c.evaluated ? (c.vuln / c.evaluated) * 100 : 0, 1)),
        evaluated: c.evaluated,
      },
    ]),
  );
  return renderEmbed(
    vlStackedBar({
      labels: dimensions,
      series,
      xTitle: "Vulnerable attacks",
      valueLabels,
      extraFields,
      tooltip: [
        { field: "value", type: "quantitative", title: "Vulnerable attacks" },
        {
          field: "asr",
          type: "quantitative",
          title: "Segment ASR (%)",
          format: ".1f",
        },
        {
          field: "evaluated",
          type: "quantitative",
          title: "Evaluated attacks",
        },
      ],
    }),
    `${containerId}-chart`,
  );
}
export function renderAgentHeatmap(options: {
  report: RedTeamReport;
  dim: string;
  rid: string;
  containerId?: string;
}): string {
  const { report, rid } = options,
    containerId = options.containerId ?? "rt-agent-heatmap",
    agents = [...new Set(report.results.map(agentKey))];
  if (agents.length < 2)
    return `<div class="rt-agent-heatmap" id="${esc(containerId)}"><p class="rt-view-empty">Agent heatmap requires 2 or more agents.</p></div>`;
  const dim = Object.hasOwn(HEATMAP_DIM_LABELS, options.dim)
    ? options.dim
    : "vulnerability";
  const selector = selectButtons({
    options: Object.keys(HEATMAP_DIM_LABELS),
    labels: HEATMAP_DIM_LABELS,
    selected: dim,
    hxUrl: `/r/${esc(rid)}/view/agent-heatmap`,
    paramName: "dim",
    containerId,
  });
  return `<div class="rt-agent-heatmap" id="${esc(containerId)}"><div class="rt-heatmap-controls"><label class="rt-breakdown-label">Group by</label>${selector}</div>${buildHeatmapChart(report.results, agents, dim, containerId)}</div>`;
}
export function buildHeatmapChart(
  results: RedTeamResult[],
  agents: string[],
  dim: string,
  containerId: string,
): string {
  const pivot = new Map<string, Map<string, Counts>>();
  for (const r of results)
    if (isEvaluated(r)) {
      const dimension = dimensionValue(r, dim),
        agent = agentKey(r),
        row = pivot.get(dimension) ?? new Map<string, Counts>(),
        c = row.get(agent) ?? { vuln: 0, evaluated: 0 };
      c.evaluated++;
      if (isVulnerable(r)) c.vuln++;
      row.set(agent, c);
      pivot.set(dimension, row);
    }
  const values =
    dim === "severity"
      ? [
          ...SEVERITY_ORDER.filter((s) => pivot.has(s)),
          ...[...pivot.keys()]
            .filter((s) => !(SEVERITY_ORDER as readonly string[]).includes(s))
            .sort(codepointCompare),
        ]
      : [...pivot.keys()].sort(codepointCompare);
  if (!values.length)
    return '<p class="rt-view-empty">No data for this dimension.</p>';
  const cellColors: string[][] = [],
    cellTexts: string[][] = [];
  for (const value of values) {
    const colors: string[] = [],
      texts: string[] = [];
    for (const agent of agents) {
      const c = pivot.get(value)?.get(agent);
      if (!c?.evaluated) {
        colors.push(COLORS.sand_400);
        texts.push("-");
      } else {
        const asr = c.vuln / c.evaluated;
        colors.push(scaleColor(asr, ORQ_SCALE_HEAT));
        texts.push(`${pyFixed(asr * 100, 0)}%\nn=${c.evaluated}`);
      }
    }
    cellColors.push(colors);
    cellTexts.push(texts);
  }
  return renderEmbed(
    vlHeatmap({ xLabels: agents, yLabels: values, cellColors, cellTexts }),
    `${containerId}-chart`,
  );
}
