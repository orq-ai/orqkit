import { orqBaseUrl } from "../common/llm-client.js";
import { redteamBrief } from "../common/reports/brief.js";
import {
  esc,
  htmlTable,
  humanizeDuration,
  kpiCards,
  pct,
} from "../common/reports/html-helpers.js";
import { pyFixed } from "../common/reports/number-format.js";
import { pythonStrip } from "../common/sanitize.js";
import { REPORT_TAB_RENDERERS } from "../redteam/reports/html-sections.js";
import type {
  RedTeamReport,
  RedTeamResult,
} from "../redteam/reports/models.js";
import { JuryHealth } from "../redteam/reports/models.js";
import { buildRedteamReportSections } from "../redteam/reports/sections.js";
import {
  isApplyEnabled,
  renderApplyPanel,
  renderRecApplyButton,
} from "./apply-ui.js";
import { orqStudioUrl } from "./orq-links.js";
import { fmtVulnerability } from "./redteam-charts.js";
import { renderAttackFragment } from "./redteam-transcripts.js";
import {
  barRows,
  callout,
  dial,
  donut,
  focusTier,
  heatmap,
  metaGrid,
  outcomePill,
  panel,
  SCALE_HEAT_RT,
  severityPill,
  tag,
} from "./report-kit.js";
import type { ReportSections } from "./report-tabs.js";
import { renderSections, reportTabs } from "./report-tabs.js";
import { runTraceUrl, traceLinkButton } from "./trace-links.js";

type Row = Record<string, unknown>;
const n = (value: unknown): number => (typeof value === "number" ? value : 0);
const rate = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
const str = (value: unknown): string => (value == null ? "" : String(value));
const data = (
  sections: ReportSections,
  kind: Parameters<ReportSections["get"]>[0],
): Row => sections.get(kind)?.data ?? {};
export interface RedteamAgentStats {
  display_name: string;
  model: string;
  attacks: number;
  evaluated: number;
  vulns: number;
  critical: number;
  errors: number;
  asr: number | null;
  resistance: number | null;
}
export function redteamAgentStats(
  report: RedTeamReport,
): Map<string, RedteamAgentStats> {
  const stats = new Map<string, RedteamAgentStats>();
  for (const r of report.results) {
    const key =
        r.agent.key || r.agent.displayName || r.agent.model || "unknown",
      entry = stats.get(key) ?? {
        display_name: r.agent.displayName || key,
        model: r.agent.model || "",
        attacks: 0,
        evaluated: 0,
        vulns: 0,
        critical: 0,
        errors: 0,
        asr: null,
        resistance: null,
      };
    entry.attacks++;
    if (r.vulnerable !== null) {
      entry.evaluated++;
      if (r.vulnerable) {
        entry.vulns++;
        if (r.attack.severity === "critical") entry.critical++;
      }
    }
    if (r.error !== null) entry.errors++;
    stats.set(key, entry);
  }
  for (const entry of stats.values()) {
    entry.asr = entry.evaluated ? entry.vulns / entry.evaluated : null;
    entry.resistance = entry.asr !== null ? 1 - entry.asr : null;
  }
  return stats;
}
export function zeroEvaluatedAttacks(summary: Row): boolean {
  if (summary.evaluated_attacks == null) return false;
  if (summary.total_attacks != null && n(summary.total_attacks) === 0)
    return false;
  return n(summary.evaluated_attacks) === 0;
}
export function redteamExecSummary(
  summary: Row,
  sections: ReportSections,
): string {
  const total = n(summary.total_attacks),
    pre = n(summary.pre_execution_errors),
    narrative = summary.narrative,
    confidence =
      typeof summary.confidence === "string" ? summary.confidence : null;
  const narrativeHtml = narrative
    ? callout(esc(String(narrative)), {
        label: "Saved executive summary",
        confidence,
      })
    : "";
  if (!total && !pre) return narrativeHtml;
  if (!total)
    return (
      callout(
        `<strong>${pre}</strong> row${pre !== 1 ? "s" : ""} failed before execution. No attack results were produced for this run.`,
        { confidence },
      ) + narrativeHtml
    );
  let evaluated = rate(summary.evaluated_attacks),
    unevaluated = rate(summary.unevaluated_attacks);
  if (evaluated === null && unevaluated !== null)
    evaluated = Math.max(total - unevaluated, 0);
  if (unevaluated === null && evaluated !== null)
    unevaluated = Math.max(total - evaluated, 0);
  const coverage =
      rate(summary.evaluation_coverage) ??
      (total && evaluated !== null ? evaluated / total : null),
    errors = n(summary.total_errors);
  let note = ` ${errors} recorded error${errors !== 1 ? "s" : ""}.`;
  if (pre) note += ` ${pre} pre-execution failure${pre !== 1 ? "s" : ""}.`;
  const coverageSentence =
    evaluated !== null && unevaluated !== null
      ? `<strong>${evaluated}/${total}</strong> attacks evaluated (${pct(coverage)} coverage); <strong>${unevaluated}</strong> had no verdict.${note}`
      : `Evaluation coverage was not recorded; the verdict denominator is unknown.${note}`;
  if (zeroEvaluatedAttacks(summary))
    return (
      callout(`No attacks were evaluated: ${coverageSentence}`, {
        confidence: null,
      }) + narrativeHtml
    );
  if (narrative)
    return (
      callout(esc(String(narrative)), { confidence }) +
      callout(coverageSentence, {
        label: "Evaluation coverage",
        confidence: null,
      })
    );
  const categories = rows(data(sections, "category_breakdown").rows),
    vulns = n(summary.vulnerabilities_found),
    critical = n(summary.critical_exposure),
    resistant = evaluated !== null ? Math.max(evaluated - vulns, 0) : null;
  const criticalClause = critical
    ? `, including <strong>${critical} critical</strong>`
    : "";
  const verdict =
    evaluated !== null
      ? `Among evaluated attacks, the agent resisted <strong>${resistant}/${evaluated}</strong> (${pct(rate(summary.resistance_rate))}) and exposed <strong>${vulns}</strong> vulnerabilit${vulns === 1 ? "y" : "ies"}${criticalClause}.`
      : "Verdict counts were unavailable for this saved report.";
  let sentence = `Across <strong>${total}</strong> adversarial attacks spanning ${categories.length} OWASP categor${categories.length === 1 ? "y" : "ies"}, ${coverageSentence} ${verdict}`;
  const top = categories[0],
    topRate = rate(top?.vulnerability_rate);
  if (top && topRate !== null && topRate > 0)
    sentence += ` <strong>${esc(str(top.category_name))}</strong> is the weakest area (${pct(topRate)} attack success rate).`;
  const turns = rows(data(sections, "turn_depth_analysis").rows),
    first = turns[0],
    last = turns.at(-1);
  if (turns.length >= 2 && first && last) {
    const firstRate = rate(first.vulnerability_rate),
      lastRate = rate(last.vulnerability_rate);
    if (firstRate !== null && lastRate !== null && lastRate > firstRate)
      sentence += ` Attack success climbs with conversation depth - from ${pct(firstRate)} at ${first.turn_count} turns to ${pct(lastRate)} at ${last.turn_count} turns.`;
  }
  return callout(sentence, { confidence });
}
export function redteamKpiBand(s: Row): string {
  const asr = Object.hasOwn(s, "vulnerability_rate")
      ? rate(s.vulnerability_rate)
      : 0,
    resistance = Object.hasOwn(s, "resistance_rate")
      ? rate(s.resistance_rate)
      : 0,
    vulns = n(s.vulnerabilities_found),
    critical = n(s.critical_exposure),
    total = n(s.total_attacks);
  const unknown = total && s.evaluated_attacks == null;
  const unscored =
    zeroEvaluatedAttacks(s) || unknown || resistance === null || asr === null;
  let evaluated = rate(s.evaluated_attacks);
  if (evaluated === null && s.unevaluated_attacks != null)
    evaluated = Math.max(total - n(s.unevaluated_attacks), 0);
  const coverage =
    rate(s.evaluation_coverage) ??
    (total && evaluated !== null ? evaluated / total : null);
  return kpiCards([
    { label: "Attacks run", value: String(total), status: "neutral" },
    {
      label: "Vulnerabilities",
      value: String(vulns),
      status: vulns ? "fail" : "pass",
    },
    unscored
      ? { label: "Attack success rate", value: "n/a", status: "neutral" }
      : {
          label: "Attack success rate",
          value: pct(asr),
          status: n(asr) >= 0.25 ? "fail" : n(asr) > 0 ? "warn" : "pass",
        },
    unscored
      ? { label: "Resistance rate", value: "n/a", status: "neutral" }
      : {
          label: "Resistance rate",
          value: pct(resistance),
          status: n(resistance) >= 0.8 ? "pass" : "warn",
        },
    {
      label: "Critical findings",
      value: String(critical),
      status: critical ? "fail" : "pass",
    },
    {
      label: "Evaluation coverage",
      value:
        coverage !== null && total
          ? `${evaluated}/${total} (${pct(coverage)})`
          : "n/a",
      status: "neutral",
    },
  ]);
}
function agentDot(stats: RedteamAgentStats): string {
  return stats.critical
    ? "rt-hero-dot--critical"
    : stats.vulns
      ? "rt-hero-dot--vuln"
      : stats.evaluated < stats.attacks
        ? "rt-hero-dot--unknown"
        : "rt-hero-dot--clean";
}
export function redteamAgentRow(stats: RedteamAgentStats): string {
  const bar =
      stats.asr !== null ? Math.max(0, Math.min(1, stats.asr)) * 100 : 0,
    barColor = stats.critical ? "var(--red-600)" : "var(--orange-500)",
    color =
      stats.asr === null
        ? "var(--gray-500)"
        : stats.vulns
          ? "var(--orange-600)"
          : "var(--green-600)";
  const model = stats.model
    ? `<div class="rt-agent-row-model">${esc(stats.model)}</div>`
    : "";
  return `<div class="rt-agent-row"><div class="rt-agent-row-name"><span class="rt-hero-dot ${agentDot(stats)}"></span><span>${esc(stats.display_name)}</span>${model}</div><div class="rt-agent-row-count">${stats.vulns}/${stats.attacks}</div><div class="rt-agent-row-track"><div class="rt-agent-row-fill" style="width:${pyFixed(bar, 1)}%;background:${barColor}"></div></div><div class="rt-agent-row-asr" style="color:${color}">${pct(stats.asr)}</div></div>`;
}
export function redteamAgentsUnderTest(report: RedTeamReport): string {
  const stats = [...redteamAgentStats(report).values()];
  if (!stats.length) return "";
  stats.sort(
    (a, b) =>
      Number(a.asr === null) - Number(b.asr === null) ||
      (b.asr ?? 0) - (a.asr ?? 0),
  );
  return panel(
    "Agents under test",
    `<div class="rt-agents-table">${stats.map(redteamAgentRow).join("")}</div>`,
    { sub: `${stats.length} agents · per-agent attack success, weakest first` },
  );
}
export function redteamOverview(
  sections: ReportSections,
  report: RedTeamReport,
): string {
  const s = data(sections, "summary"),
    evaluated = n(s.evaluated_attacks),
    vulns = n(s.vulnerabilities_found),
    unevaluated =
      rate(s.unevaluated_attacks) ??
      Math.max(n(s.total_attacks) - evaluated, 0),
    pre = n(s.pre_execution_errors);
  const resistance = zeroEvaluatedAttacks(s)
    ? null
    : Object.hasOwn(s, "resistance_rate")
      ? rate(s.resistance_rate)
      : 0;
  const outcome = donut(
    [
      {
        label: "Resistant",
        value: Math.max(evaluated - vulns, 0),
        color: "var(--green-600)",
      },
      { label: "Vulnerable", value: vulns, color: "var(--red-600)" },
      { label: "Unevaluated", value: unevaluated, color: "var(--gray-500)" },
    ],
    pct(resistance),
    "resistant",
  );
  const errors = `<p class="rt-outcome-errors">Recorded errors: ${n(s.total_errors)} (including ${pre} pre-execution failure${pre !== 1 ? "s" : ""}).</p>`;
  const bySeverity = (s.by_severity ?? {}) as Record<string, Row>,
    count = (name: string) => n(bySeverity[name]?.vulnerabilities_found),
    max = Math.max(count("high"), 3);
  const bars = (
    [
      ["Critical", "critical", "var(--red-600)"],
      ["High", "high", "var(--orange-500)"],
      ["Medium", "medium", "var(--text-muted)"],
      ["Low", "low", "var(--green-600)"],
    ] as const
  )
    .map(([label, key, color]) =>
      barRows([[label, count(key)]], {
        width: 420,
        labelWidth: 84,
        color,
        format: (v) => String(Math.trunc(v)),
        maxValue: max,
      }),
    )
    .join("");
  return `${redteamExecSummary(s, sections)}${redteamKpiBand(s)}<div class="rt-overview-grid-2">${panel("Outcome", outcome + errors)}${panel("Vulnerabilities by severity", bars)}</div>${report.testedAgents.length > 1 ? redteamAgentsUnderTest(report) : ""}`;
}
export function redteamAgentPill(stats: RedteamAgentStats): string {
  const incomplete = stats.evaluated < stats.attacks;
  let sub = stats.vulns
    ? `${stats.vulns} vuln${incomplete ? ` · ${stats.evaluated}/${stats.attacks} evaluated` : ""}`
    : incomplete
      ? `${stats.evaluated === 0 ? "unjudged" : "incomplete"} · ${stats.evaluated}/${stats.attacks} evaluated`
      : "clean";
  if (stats.model) sub = `${stats.model} · ${sub}`;
  return `<span class="rt-hero-pill${incomplete && !stats.vulns ? " rt-hero-pill--unknown" : ""}"><span class="rt-hero-dot ${agentDot(stats)}"></span><span class="rt-hero-pill-name">${esc(stats.display_name)}</span><span class="rt-hero-pill-sub">${esc(sub)}</span></span>`;
}
export function redteamRunName(report: RedTeamReport): string {
  const bare = (s: string) =>
      pythonStrip(s.split(":").at(-1) ?? "").toLowerCase(),
    known = new Set([
      "static",
      "dynamic",
      "hybrid",
      ...report.testedAgents.map(bare),
    ]);
  let name = pythonStrip(report.description || "");
  for (;;) {
    const match = /\s*\(([^()]*)\)\s*$/.exec(name);
    if (!match) break;
    const inner = bare(match[1] ?? "");
    if (known.has(inner) || /^\d+ targets?$/.test(inner))
      name = pythonStrip(name.slice(0, match.index));
    else break;
  }
  return name || "Red teaming report";
}
export async function redteamHero(report: RedTeamReport): Promise<string> {
  const agents =
      report.testedAgents.length > 1
        ? `<span class="rt-hero-agents-pill">${report.testedAgents.length} agents</span>`
        : "",
    pills = [...redteamAgentStats(report).values()]
      .map(redteamAgentPill)
      .join(""),
    row = pills ? `<div class="rt-hero-agent-row">${pills}</div>` : "";
  const pipeline = pythonStrip(report.pipeline || ""),
    kicker = pipeline
      ? `Red Team · ${pipeline[0]?.toUpperCase()}${pipeline.slice(1).toLowerCase()}`
      : "Red Team";
  const button = traceLinkButton(
      await runTraceUrl(report.runId, report.experimentUrl),
      "View all run traces ↗",
    ),
    actions = button ? `<div class="report-hero-actions">${button}</div>` : "";
  return `<header class="report-hero rt-hero"><p class="report-hero-kicker">${esc(kicker)}</p><h2 class="report-hero-title rt-hero-title">${esc(redteamRunName(report))}${agents}</h2>${row}${actions}</header>`;
}

export function redteamFocusAreaCard(
  area: Row,
  applied: ReadonlySet<string> = new Set(),
  rid = "",
): string {
  const risk = n(area.risk_score),
    [code, label, color] = focusTier(risk),
    recommendations = (area.llm_recommendations ?? {}) as Row;
  const main = `<div class="rt-focus-head-main"><div class="rt-focus-tier-row"><span class="rt-focus-tier-dot" style="background:${color}"></span><span class="rt-focus-tier-label" style="color:${color}">${esc(code)} · ${esc(label)}</span></div><div class="rt-focus-category-name">${esc(str(area.category_name))} <span class="rt-focus-category-code">${esc(str(area.category))}</span></div></div>`;
  const riskDial = dial(pyFixed(risk, 1), risk / 8, {
    radius: 26,
    stroke: 7,
    color,
    sub: "RISK",
  });
  const stats = `<div class="rt-focus-head-stats"><div class="rt-focus-stat rt-focus-stat--dial">${riskDial}</div><div class="rt-focus-stat"><span class="rt-focus-mini-key">ASR</span><span class="rt-focus-mini-value">${pct(Object.hasOwn(area, "vulnerability_rate") ? rate(area.vulnerability_rate) : 0)}</span></div><div class="rt-focus-stat"><span class="rt-focus-mini-key">Hits</span><span class="rt-focus-mini-value" style="color:${color}">${n(area.vulnerabilities_found)}</span></div></div>`;
  const patterns = recommendations.patterns_observed
    ? `<div class="rt-focus-patterns"><span class="rt-focus-pattern-dot" style="background:${color}"></span><span>${esc(str(recommendations.patterns_observed))}</span></div>`
    : "";
  const fix = area.remediation
    ? `<div class="rt-focus-fixbox"><div class="rt-focus-fixbox-label">Recommended fix</div><div class="rt-focus-fixbox-body">${esc(str(area.remediation))}</div></div>`
    : "";
  const bullets = Array.isArray(recommendations.recommendations)
    ? recommendations.recommendations
    : [];
  const list = bullets.length
    ? `<div class="rt-focus-recs-section"><div class="rt-focus-fixbox-label rt-focus-recs-label">Recommendations</div><ul class="rt-focus-recs">${bullets
        .map((value) => {
          const text = String(value),
            done = applied.has(pythonStrip(text)),
            tail = done
              ? '<span class="rt-focus-rec-applied">✓ applied</span>'
              : rid
                ? renderRecApplyButton(rid, str(area.category), text)
                : "";
          return `<li class="rt-focus-rec${done ? " rt-focus-rec--applied" : ""}"><span class="rt-focus-rec-text">${esc(text)}</span>${tail}</li>`;
        })
        .join("")}</ul></div>`
    : "";
  return `<div class="rk-panel rt-focus-card"><div class="rt-focus-head">${main}${stats}</div><div class="rt-focus-body">${patterns}${fix}${list}</div></div>`;
}
export function redteamFocus(
  sections: ReportSections,
  rid: string,
  report: RedTeamReport,
  options: { standalone?: boolean } = {},
): string {
  const areas = rows(data(sections, "focus_areas").focus_areas);
  if (!areas.length) return "";
  const bar = options.standalone ? "" : renderApplyPanel(rid, report),
    action = options.standalone ? "" : isApplyEnabled(report) ? rid : "",
    applied = new Set(report.appliedRecommendations.map(pythonStrip));
  return `${bar}<p class="rt-focus-intro">Prioritized fixes, ranked by <code>risk = success rate × avg severity</code>. Start at the top - P1 first.</p>${areas.map((area) => redteamFocusAreaCard(area, applied, action)).join("")}`;
}
function agentCardChipRow(label: string, items: string[]): string {
  const body = items.length
    ? items.map((item) => tag(item)).join("")
    : '<span class="rt-agent-card-chip-empty">-</span>';
  return `<div class="rt-agent-card-chiprow"><span class="rt-agent-card-chip-label">${esc(label)}</span><div class="rt-agent-card-chips">${body}</div></div>`;
}
export async function redteamAgentCard(
  context: Row | null,
  key: string,
  stats: Partial<RedteamAgentStats>,
  experimentUrl: string | null = null,
): Promise<string> {
  const ctx = context ?? {},
    display = ctx.display_name || stats.display_name || key,
    model = ctx.model || stats.model || "",
    version = ctx.version || "",
    description = ctx.description || "";
  const studio = await orqStudioUrl({
    targetKind: typeof ctx.target_kind === "string" ? ctx.target_kind : null,
    entityId: typeof ctx.id === "string" ? ctx.id : null,
    workspaceId: typeof ctx.workspace_id === "string" ? ctx.workspace_id : null,
    experimentUrl,
    baseUrl: orqBaseUrl(),
  });
  const studioHtml = studio
    ? `<a class="rt-agent-card-studio" href="${esc(studio)}" target="_blank" rel="noopener">Open in Studio</a>`
    : "";
  const attacks = stats.attacks ?? 0,
    vulns = stats.vulns ?? 0,
    critical = stats.critical ?? 0,
    asr = Object.hasOwn(stats, "asr") ? (stats.asr ?? null) : 0;
  let resistance = stats.resistance ?? null;
  if (
    resistance === null &&
    asr !== null &&
    !Object.hasOwn(stats, "resistance")
  )
    resistance = 1 - asr;
  const color =
    asr === null
      ? "var(--gray-500)"
      : critical
        ? "var(--red-600)"
        : vulns
          ? "var(--orange-500)"
          : "var(--green-600)";
  const dialHtml = dial(pct(asr), asr || 0, {
      radius: 24,
      stroke: 6,
      color,
      sub: "ASR",
    }),
    chip = critical
      ? `<span class="rt-agent-card-critical">${critical} critical</span>`
      : "";
  const line = [esc(String(model)), version ? `v${esc(String(version))}` : ""]
      .filter(Boolean)
      .join(" · "),
    modelHtml = line ? `<div class="rt-agent-card-model">${line}</div>` : "",
    descriptionHtml = description
      ? `<div class="rt-agent-card-desc">${esc(String(description))}</div>`
      : "";
  const strip = `<div class="rt-agent-card-stats"><div class="rt-agent-card-stat"><span class="rt-agent-card-stat-key">Found</span><span class="rt-agent-card-stat-value">${vulns}/${attacks}</span></div><div class="rt-agent-card-stat"><span class="rt-agent-card-stat-key">Critical</span><span class="rt-agent-card-stat-value" style="${critical ? "color:var(--red-600)" : ""}">${critical}</span></div><div class="rt-agent-card-stat"><span class="rt-agent-card-stat-key">Resisted</span><span class="rt-agent-card-stat-value" style="color:var(--green-600)">${pct(resistance)}</span></div></div>`;
  const chips =
    agentCardChipRow("TOOLS", (ctx.tools || []) as string[]) +
    agentCardChipRow("SKILLS", (ctx.skills || []) as string[]) +
    agentCardChipRow("KNOWLEDGE", (ctx.knowledge_bases || []) as string[]);
  return `<div class="rk-panel rt-agent-card"><div class="rt-agent-card-dial">${dialHtml}</div><div class="rt-agent-card-main"><div class="rt-agent-card-name-row"><span class="rt-agent-card-name">${esc(String(display))}</span>${chip}${studioHtml}</div>${modelHtml}${descriptionHtml}${strip}${chips}</div></div>`;
}
export async function redteamAttackRow(
  result: RedTeamResult,
  rid: string,
  index: number,
  options: { standalone?: boolean } = {},
): Promise<string> {
  const attack = result.attack,
    title = attack.vulnerability
      ? fmtVulnerability(attack.vulnerability)
      : attack.category,
    outcome = result.error
      ? "error"
      : result.vulnerable === null
        ? "Not evaluated"
        : result.vulnerable
          ? "vulnerable"
          : "resistant";
  const summary = `<summary class="rt-attack-row-summary"><div class="rt-attack-row-title"><strong>${esc(title)}</strong><span class="rt-attack-row-id">${esc(attack.id)}</span></div><div class="rt-attack-row-agent">${esc((result.agent.displayName || result.agent.key) ?? "None")}</div><div class="rt-attack-row-vector">${esc(attack.attackTechnique)}</div><div class="rt-attack-row-severity">${severityPill(attack.severity)}</div><div class="rt-attack-row-outcome">${outcomePill(outcome)}</div><div class="rt-attack-row-chevron">&#9660;</div></summary>`;
  if (options.standalone)
    return `<details class="rt-attack-row export-attack export-evidence" id="attack-${index + 1}">${summary}<div class="rt-attack-row-body">${await renderAttackFragment(result)}</div></details>`;
  return `<details class="rt-attack-row" hx-get="/r/${esc(rid)}/redteam/attack?idx=${index}" hx-include="#filter-form" hx-trigger="toggle once" hx-target="find .rt-attack-row-body" hx-swap="innerHTML">${summary}<div class="rt-attack-row-body"></div></details>`;
}
export function redteamBreakdownsCategoryTable(values: Row[]): string {
  return htmlTable(
    ["Cat", "Category", "Run", "Found", "ASR"],
    values.map((r) => {
      const found = n(r.vulnerabilities_found);
      return [
        tag(str(r.category)),
        `<strong>${esc(str(r.category_name))}</strong>`,
        `<span style="font-variant-numeric:tabular-nums">${n(r.total_attacks)}</span>`,
        found
          ? `<span style="color:var(--red-600);font-weight:600">${found}</span>`
          : `<span style="color:var(--text-muted)">${found}</span>`,
        `<span style="font-family:var(--font-mono)">${pct(Object.hasOwn(r, "vulnerability_rate") ? rate(r.vulnerability_rate) : 0)}</span>`,
      ];
    }),
  );
}
export function redteamBreakdownsDepthSection(
  sections: ReportSections,
): string {
  const values = rows(data(sections, "turn_depth_analysis").rows);
  if (!values.length) return "";
  const evaluated = values.filter((r) => r.vulnerability_rate != null);
  let bars = "",
    leadin = "";
  if (evaluated.length) {
    const max = Math.max(...evaluated.map((r) => n(r.vulnerability_rate))) || 1;
    bars = barRows(
      evaluated.map((r) => [`${r.turn_count} turns`, n(r.vulnerability_rate)]),
      {
        width: 520,
        labelWidth: 70,
        color: "var(--orange-500)",
        format: pct,
        maxValue: max,
      },
    );
  }
  const first = evaluated[0],
    last = evaluated.at(-1);
  if (
    evaluated.length >= 2 &&
    first &&
    last &&
    n(last.vulnerability_rate) > n(first.vulnerability_rate)
  )
    leadin = `<p class="rt-breakdowns-leadin">Attack success climbs from <strong>${pct(rate(first.vulnerability_rate))}</strong> at ${first.turn_count} turns to <strong>${pct(rate(last.vulnerability_rate))}</strong> at ${last.turn_count} turns - single-turn defenses are not enough.</p>`;
  const footnote = `<div class="rt-breakdowns-footnote">${esc(values.map((r) => `${r.turn_count}t: ${n(r.vulnerabilities_found)}/${n(r.total_attacks)}`).join(" · "))}</div>`;
  return panel(
    "Attack success by conversation depth",
    leadin + bars + footnote,
    { sub: "multi-turn results only" },
  );
}
export function redteamBreakdownsTurnScopeGrid(
  sections: ReportSections,
): string {
  const domains = (data(sections, "turn_scope_breakdown").by_domain ??
      {}) as Record<string, Row>,
    values: [string, number][] = Object.entries(domains)
      .filter(([, r]) => r.vulnerability_rate != null)
      .map(([name, r]) => [name.replaceAll("_", " "), n(r.vulnerability_rate)]);
  return values.length
    ? panel(
        "By domain",
        barRows(values, {
          width: 420,
          labelWidth: 110,
          colorScale: SCALE_HEAT_RT,
          format: pct,
          maxValue: 1,
        }),
      )
    : "";
}
export function redteamBreakdowns(sections: ReportSections): string {
  const categories = rows(data(sections, "category_breakdown").rows),
    category = categories.length
      ? panel(
          "Attack success by OWASP category",
          redteamBreakdownsCategoryTable(categories),
          { sub: "Worst first" },
        )
      : "";
  const h = data(sections, "attack_heatmap");
  let heat = "";
  if (rows(h.cells).length)
    heat = panel(
      "Attack success heatmap",
      heatmap(
        (h.vulnerabilities ?? []) as string[],
        (h.techniques ?? []) as string[],
        rows(h.cells).filter((c) => c.vulnerability_rate != null),
        {
          rowKey: "vulnerability",
          colKey: "technique",
          valueKey: "vulnerability_rate",
          colorScale: SCALE_HEAT_RT,
        },
      ),
      { sub: "Category × technique - sand → orange → red as ASR rises" },
    );
  const ratePanel = (
    title: string,
    kind: Parameters<ReportSections["get"]>[0],
    key: string,
  ) => {
    const values: [string, number][] = rows(data(sections, kind).rows)
      .filter((r) => r.vulnerability_rate != null)
      .map((r) => [str(r[key]), n(r.vulnerability_rate)]);
    return values.length
      ? panel(
          title,
          barRows(values, {
            width: 420,
            labelWidth: 150,
            colorScale: SCALE_HEAT_RT,
            format: pct,
            maxValue: 1,
          }),
        )
      : "";
  };
  const technique = ratePanel(
      "By technique",
      "technique_breakdown",
      "technique",
    ),
    delivery = ratePanel(
      "By delivery method",
      "delivery_breakdown",
      "delivery_method",
    );
  return `${category}${heat}${technique || delivery ? `<div class="rt-breakdowns-grid-2">${technique}${delivery}</div>` : ""}${redteamBreakdownsDepthSection(sections)}${redteamBreakdownsTurnScopeGrid(sections)}`;
}

function reportSections(report: RedTeamReport): ReportSections {
  return new Map(
    buildRedteamReportSections(report).map((section) => [
      section.kind,
      section,
    ]),
  );
}
export async function redteamAgents(
  sections: ReportSections,
  report: RedTeamReport,
): Promise<string> {
  const contexts = rows(data(sections, "agent_context").agents),
    byKey = new Map(contexts.map((ctx) => [str(ctx.key), ctx])),
    stats = redteamAgentStats(report),
    keys = [
      ...byKey.keys(),
      ...[...stats.keys()].filter((key) => !byKey.has(key)),
    ];
  if (!keys.length) return "";
  const multi = report.testedAgents.length > 1,
    intro = multi
      ? `The job targeted a <strong>${report.testedAgents.length}-agent system</strong>. When an orchestrator delegates to sub-agents that trust its routing context, a breach upstream propagates downstream.`
      : "Single agent under assessment.";
  const cards: string[] = [];
  for (const key of keys)
    cards.push(
      await redteamAgentCard(
        byKey.get(key) ?? null,
        key,
        stats.get(key) ?? {},
        report.experimentUrl,
      ),
    );
  const tail = multi
    ? await renderSections(sections, REPORT_TAB_RENDERERS, [
        "agent_comparison",
        "agent_disagreements",
      ])
    : "";
  return `<p class="rt-agents-intro">${intro}</p>${cards.join("")}${tail}`;
}
export async function redteamAttacks(
  report: RedTeamReport,
  rid: string,
  options: { standalone?: boolean } = {},
): Promise<string> {
  const count = report.results.length,
    intro = count
      ? `<p class="rt-attacks-intro">Evidence - ${count} attack${count !== 1 ? "s" : ""}. ${options.standalone ? "Expand an attack to read its verdict and full transcript." : "Click a row to expand the evaluator verdict and full transcript."}</p>`
      : '<p class="rt-attacks-intro">No attacks match the current filters.</p>';
  const header =
      '<div class="rt-attack-row-header"><div>Attack</div><div>Agent</div><div>Vector</div><div>Severity</div><div>Outcome</div><div></div></div>',
    attackRows: string[] = [];
  for (const [index, result] of report.results.entries())
    attackRows.push(await redteamAttackRow(result, rid, index, options));
  const table = count
      ? `<div class="rk-panel rt-attack-table">${header}${attackRows.join("")}</div>`
      : "",
    kept = await renderSections(reportSections(report), REPORT_TAB_RENDERERS, [
      "source_distribution",
    ]);
  return `${intro}${table}${kept}`;
}
export async function redteamConfig(
  sections: ReportSections,
  report: RedTeamReport,
): Promise<string> {
  const summary = data(sections, "summary"),
    method = data(sections, "methodology"),
    created = summary.created_at,
    generated =
      typeof created === "string" && /^\d{4}-\d{2}-\d{2}T/.test(created)
        ? created.slice(0, 10)
        : created == null
          ? "None"
          : String(created);
  const configuration = panel(
    "Run configuration",
    metaGrid([
      ["Target", str(summary.target) || null],
      ["Pipeline", str(summary.pipeline) || null],
      ["Framework", str(method.framework) || null],
      ["Scoring method", str(method.scoring_method) || null],
      [
        "Agents",
        report.testedAgents.length ? String(report.testedAgents.length) : null,
      ],
      [
        "Attacks",
        summary.total_attacks != null ? String(summary.total_attacks) : null,
      ],
      ["Generated", generated],
      ["Duration", humanizeDuration(rate(summary.duration_seconds)) || null],
    ]),
  );
  const tested = (method.categories_tested ?? []) as string[],
    untested = (method.untested_categories ?? []) as string[],
    names = (method.untested_category_names ?? {}) as Record<string, string>;
  const testedHtml = tested.length
    ? `<div class="rt-config-methodology-row"><span class="rt-config-methodology-label">TESTED</span><div class="rt-config-methodology-tags">${tested.map((c) => tag(c)).join("")}</div></div>`
    : "";
  const untestedHtml = untested.length
    ? `<div class="rt-config-methodology-row"><span class="rt-config-methodology-label">NOT TESTED</span><div class="rt-config-methodology-tags">${untested.map((c) => tag(names[c] ?? c)).join("")}</div></div>`
    : "";
  let juryHtml = "",
    healthHtml = "";
  if (summary.jury_reliability != null) {
    const jury = summary.jury_reliability as Row;
    juryHtml = `<div class="rt-config-methodology-row"><span class="rt-config-methodology-label">JURY RELIABILITY</span>${metaGrid(
      [
        [
          "Krippendorff alpha",
          jury.krippendorff_alpha != null
            ? pyFixed(n(jury.krippendorff_alpha), 2)
            : null,
        ],
        ["Samples", jury.samples != null ? String(jury.samples) : null],
        ["Method", str(jury.method) || null],
      ],
    )}</div>`;
  }
  if (summary.jury_health != null) {
    const h = new JuryHealth(summary.jury_health);
    healthHtml = `<div class="rt-config-methodology-row"><span class="rt-config-methodology-label">JURY HEALTH</span>${metaGrid(
      [
        ["Status", h.issueSummary()],
        ["Samples", String(h.samples)],
        ["Issue types", String(h.issueCount())],
        ["Judge failures", String(h.samplesWithJudgeFailure)],
        ["Replacement judges", String(h.replacementsUsed)],
        ["Ties", String(h.ties)],
        ["Inconclusive", String(h.inconclusive)],
        ["Repetition failures", String(h.samplesWithRepetitionFailure)],
        ["Abstentions", String(h.samplesWithAbstention)],
      ],
    )}</div>`;
    const reasons = h.judgeFailureReasons
      .map((reason) => `<li>${esc(reason)}</li>`)
      .join("");
    if (reasons)
      healthHtml += `<section class="rt-judge-failures"><h4>Judge failure reasons</h4><ul>${reasons}</ul></section>`;
  }
  const pipeline = str(method.pipeline),
    scoring = str(method.scoring_method),
    sub = pipeline || scoring ? `${pipeline} pipeline · ${scoring}` : null;
  const methodology = panel(
    "Methodology",
    testedHtml + untestedHtml + juryHtml + healthHtml,
    { sub },
  );
  const kept = await renderSections(sections, REPORT_TAB_RENDERERS, [
    "severity_definitions",
    "error_analysis",
  ]);
  return (
    configuration + methodology + kept ||
    '<p class="rk-empty">No config data available.</p>'
  );
}
export async function redteamReportTabs(
  rid: string,
  report: RedTeamReport,
  options: { standalone?: boolean } = {},
): Promise<string> {
  const sections = reportSections(report),
    hero = await redteamHero(report),
    warnings = await renderSections(sections, REPORT_TAB_RENDERERS, [
      "pipeline_warnings",
    ]),
    focusCount = rows(data(sections, "focus_areas").focus_areas).length;
  const agents = await redteamAgents(sections, report),
    focus = redteamFocus(sections, rid, report, options),
    breakdowns =
      redteamBreakdowns(sections) +
      (await renderSections(sections, REPORT_TAB_RENDERERS, [
        "framework_breakdown",
        "vulnerability_breakdown",
      ])),
    attacks = await redteamAttacks(report, rid, options),
    usage =
      (await renderSections(sections, REPORT_TAB_RENDERERS, ["token_usage"])) ||
      '<p class="rk-empty">No token usage data recorded for this run.</p>',
    config = await redteamConfig(sections, report);
  const brief = options.standalone ? redteamBrief(report, sections) : "";
  const tabs = reportTabs(
    "rttab",
    [
      ["Overview", redteamOverview(sections, report)],
      [
        "Agents",
        agents,
        `Agents <span class="tab-count">${report.testedAgents.length}</span>`,
      ],
      [
        "Focus areas",
        focus,
        `Focus areas <span class="tab-count">${focusCount}</span>`,
      ],
      ["Breakdowns", breakdowns],
      [
        "Attacks",
        attacks,
        `Attacks <span class="tab-count">${report.results.length}</span>`,
      ],
      ["Usage", usage],
      ["Config", config],
    ],
    { standalone: options.standalone, brief },
  );
  return `<div class="report-aligned rt-report">${hero}${warnings}${tabs}</div>`;
}
