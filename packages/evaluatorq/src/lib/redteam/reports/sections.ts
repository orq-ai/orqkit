import { pythonFixed } from "../../common/jury.js";
import {
  SEVERITY_RANK,
  SEVERITY_WEIGHTS,
} from "../../common/reports/palette.js";
import { sumStructuredUsage } from "../../common/structured-output.js";
import type { ReportSection, Usage } from "../../contracts.js";
import { OWASP_CATEGORY_NAMES, SEVERITY_DEFINITIONS } from "../contracts.js";
import { REMEDIATION_GUIDANCE } from "./guidance.js";
import {
  codepointCompare,
  type DimensionSummary,
  type RedTeamReport,
  type RedTeamResult,
} from "./models.js";
import { computeTopRiskAreas } from "./recommendations.js";
import { extractPrompt, extractResponse } from "./utils.js";

type Row = Record<string, unknown>;
const section = (
  kind: ReportSection["kind"],
  title: string,
  data: Row,
): ReportSection => ({ kind, title, data });
const sorted = (values: Iterable<string>) => [...values].sort(codepointCompare);
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const fieldsView = (value: object) =>
  Object.fromEntries(
    Object.entries(value).map(([key, item]) => [snake(key), item]),
  );
const dimension = (row: DimensionSummary) => ({
  total_attacks: row.totalAttacks,
  vulnerabilities_found: row.vulnerabilitiesFound,
  vulnerability_rate: row.vulnerabilityRate,
  resistance_rate: row.resistanceRate,
});
const worstFirst = (a: number | null, b: number | null) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a;
interface Counts {
  total: number;
  evaluated: number;
  vulnerable: number;
}
const counts = (): Counts => ({ total: 0, evaluated: 0, vulnerable: 0 });
function countResult(target: Counts, result: RedTeamResult): void {
  target.total++;
  if (result.vulnerable != null) {
    target.evaluated++;
    if (result.vulnerable) target.vulnerable++;
  }
}
const asr = (value: Counts): number | null =>
  value.evaluated ? value.vulnerable / value.evaluated : null;
const agentKey = (row: RedTeamResult) =>
  row.agent.key || row.agent.displayName || "unknown";

function summarySection(report: RedTeamReport): ReportSection {
  const s = report.summary;
  const targets = report.testedAgents.length
    ? sorted(new Set(report.testedAgents))
    : Object.keys(report.agentContexts).length
      ? sorted(Object.keys(report.agentContexts))
      : report.results.length
        ? sorted(
            new Set(
              report.results.map(
                (row) =>
                  row.agent.key ||
                  row.agent.displayName ||
                  row.agent.model ||
                  "unknown",
              ),
            ),
          )
        : ["unknown"];
  const total = s.totalAttacks,
    categories = report.categoriesTested.length;
  const confidence =
    total >= 100 && categories >= 5
      ? "HIGH"
      : total >= 30 && categories >= 3
        ? "MEDIUM"
        : "LOW";
  const reasons = [];
  if (total < 30) reasons.push(`only ${total} attack${total === 1 ? "" : "s"}`);
  if (categories < 3)
    reasons.push(`only ${categories} categor${categories === 1 ? "y" : "ies"}`);
  return section("summary", "Executive Summary", {
    target: targets.join(", "),
    pipeline: report.pipeline,
    created_at: report.createdAt,
    total_attacks: total,
    evaluated_attacks: s.evaluatedAttacks,
    vulnerabilities_found: s.vulnerabilitiesFound,
    vulnerability_rate: s.vulnerabilityRate,
    resistance_rate: s.resistanceRate,
    evaluation_coverage: s.evaluationCoverage,
    total_errors: s.totalErrors,
    pre_execution_errors: s.preExecutionErrors,
    duration_seconds: report.durationSeconds,
    critical_exposure: s.bySeverity.critical?.vulnerabilitiesFound ?? 0,
    by_severity: Object.fromEntries(
      Object.entries(s.bySeverity).map(([key, value]) => [
        key,
        fieldsView(value),
      ]),
    ),
    confidence,
    confidence_note:
      confidence === "LOW"
        ? reasons.join(", ")
        : `${total} attacks across ${categories} categories`,
    narrative: report.executiveSummary,
    jury_reliability: s.juryReliability ? fieldsView(s.juryReliability) : null,
    jury_health: s.juryHealth ? fieldsView(s.juryHealth) : null,
  });
}
function focusSection(report: RedTeamReport): ReportSection {
  const recommendations = new Map(
    report.focusAreaRecommendations?.map((row) => [row.category, row]) ?? [],
  );
  const areas = computeTopRiskAreas(report, Number.POSITIVE_INFINITY).map(
    (area) => {
      const summary = report.summary.byCategory[area.category],
        rec = recommendations.get(area.category);
      const row: Row = {
        category: area.category,
        category_name: area.categoryName,
        vulnerability: area.vulnerability,
        vulnerability_name: area.vulnerabilityName,
        vulnerabilities_found: summary?.vulnerabilitiesFound ?? 0,
        vulnerability_rate: area.vulnerabilityRate,
        risk_score: area.riskScore,
        remediation: REMEDIATION_GUIDANCE[area.category] ?? "",
      };
      if (rec)
        row.llm_recommendations = {
          recommendations: rec.recommendations,
          patterns_observed: rec.patternsObserved,
          traces_analyzed: rec.tracesAnalyzed,
        };
      return row;
    },
  );
  return section("focus_areas", "Focus Areas (Top Risks)", {
    focus_areas: areas.slice(0, 5),
    ranked_focus_areas: areas,
  });
}
function breakdowns(report: RedTeamReport): ReportSection[] {
  const s = report.summary;
  const vulnerability = Object.entries(s.byVulnerability)
    .map(([key, row]) => ({
      vulnerability: key,
      vulnerability_name: row.vulnerabilityName,
      domain: row.domain,
      total_attacks: row.totalAttacks,
      vulnerabilities_found: row.vulnerabilitiesFound,
      vulnerability_rate:
        row.resistanceRate == null ? null : 1 - row.resistanceRate,
      resistance_rate: row.resistanceRate,
    }))
    .sort((a, b) => worstFirst(a.vulnerability_rate, b.vulnerability_rate));
  const category = Object.entries(s.byCategory)
    .map(([key, row]) => ({
      category: key,
      category_name: OWASP_CATEGORY_NAMES[key] ?? key,
      ...dimension(row),
    }))
    .sort((a, b) => worstFirst(a.vulnerability_rate, b.vulnerability_rate));
  return [
    section("vulnerability_breakdown", "Per-Vulnerability Breakdown", {
      rows: vulnerability,
    }),
    section("category_breakdown", "Per-Category Breakdown", { rows: category }),
  ];
}
function dimensionSection(
  kind: ReportSection["kind"],
  title: string,
  values: Record<string, DimensionSummary>,
  key: string,
): ReportSection {
  const rows = Object.entries(values)
    .map(([name, row]) => ({ [key]: name, ...dimension(row) }))
    .sort((a, b) => worstFirst(a.vulnerability_rate, b.vulnerability_rate));
  return section(kind, title, { rows });
}
function heatmapSection(report: RedTeamReport): ReportSection {
  const matrix = new Map<string, Map<string, Counts>>(),
    techniques = new Set<string>();
  for (const row of report.results) {
    const vulnerability = row.attack.vulnerability || row.attack.category,
      technique = row.attack.attackTechnique;
    const group = matrix.get(vulnerability) ?? new Map<string, Counts>();
    const value = group.get(technique) ?? counts();
    countResult(value, row);
    group.set(technique, value);
    matrix.set(vulnerability, group);
    techniques.add(technique);
  }
  const vulnerabilities = sorted(matrix.keys()),
    names = sorted(techniques),
    cells = [];
  for (const vulnerability of vulnerabilities)
    for (const technique of names) {
      const value = matrix.get(vulnerability)?.get(technique) ?? counts();
      cells.push({
        vulnerability,
        technique,
        total_attacks: value.total,
        vulnerabilities_found: value.vulnerable,
        vulnerability_rate: asr(value),
      });
    }
  return section(
    "attack_heatmap",
    "Attack Success Heatmap (Vulnerability × Technique)",
    { cells, vulnerabilities, techniques: names },
  );
}
function collectAgentResults(
  report: RedTeamReport,
): Map<string, RedTeamResult[]> {
  const groups = new Map(
      report.testedAgents.map((key) => [key, [] as RedTeamResult[]]),
    ),
    warned = new Set<string>();
  for (const row of report.results) {
    const key = agentKey(row),
      display = row.agent.displayName || row.agent.key || "unknown",
      group = groups.get(key) ?? groups.get(display);
    if (group) group.push(row);
    else if (!warned.has(key)) {
      console.warn(
        `Result agent '${key}' (display='${display}') not in testedAgents, skipping`,
      );
      warned.add(key);
    }
  }
  return groups;
}
function agentComparisonSection(report: RedTeamReport): ReportSection {
  const agents = [...report.testedAgents],
    groups = collectAgentResults(report),
    pivot = new Map<string, Map<string, Counts>>();
  const metrics = agents.map((agent) => {
    const value = counts();
    for (const row of groups.get(agent) ?? []) countResult(value, row);
    return {
      agent,
      total_attacks: value.total,
      vulnerabilities_found: value.vulnerable,
      asr: asr(value),
    };
  });
  for (const agent of agents)
    for (const row of groups.get(agent) ?? []) {
      const vulnerability =
          row.attack.vulnerability || row.attack.category || "unknown",
        group = pivot.get(vulnerability) ?? new Map<string, Counts>();
      const value = group.get(agent) ?? counts();
      countResult(value, row);
      group.set(agent, value);
      pivot.set(vulnerability, group);
    }
  const rows = [...pivot]
    .map(([vulnerability, group]) => {
      const values = agents.map((agent) => {
        const value = group.get(agent) ?? counts();
        return [agent, { asr: asr(value), total: value.total }] as const;
      });
      const known = values
        .map(([, value]) => value.asr)
        .filter((value): value is number => value != null);
      return {
        vulnerability,
        agents: Object.fromEntries(values),
        avg_asr: known.length
          ? known.reduce((a, b) => a + b, 0) / known.length
          : null,
      };
    })
    .sort((a, b) => worstFirst(a.avg_asr, b.avg_asr));
  const z_matrix = rows.map((row) =>
    agents.map((agent) => {
      const rate = row.agents[agent]?.asr;
      return rate == null ? 0 : Number(pythonFixed(rate * 100, 1));
    }),
  );
  const text_matrix = rows.map((row) =>
    agents.map((agent) => {
      const value = row.agents[agent];
      return value?.asr == null
        ? `n/a (n=${value?.total ?? 0})`
        : `${pythonFixed(value.asr * 100, 0)}% (n=${value.total})`;
    }),
  );
  return section("agent_comparison", "Multi-Agent Comparison", {
    agents,
    agent_metrics: metrics,
    vuln_asr_rows: rows,
    heatmap: {
      vulnerabilities: rows.map((row) => row.vulnerability),
      agents,
      z_matrix,
      text_matrix,
    },
  });
}
function disagreementsSection(report: RedTeamReport): ReportSection {
  const agents = [...report.testedAgents],
    attacks = new Map<string, Map<string, RedTeamResult>>();
  for (const row of report.results) {
    const group =
      attacks.get(row.attack.id) ?? new Map<string, RedTeamResult>();
    group.set(agentKey(row), row);
    attacks.set(row.attack.id, group);
  }
  const disagreements = [];
  for (const [id, group] of attacks) {
    const present = agents.filter((agent) => group.has(agent));
    if (
      present.length < 2 ||
      new Set(present.map((agent) => group.get(agent)?.vulnerable)).size === 1
    )
      continue;
    const first = group.get(present[0] as string) as RedTeamResult;
    disagreements.push({
      attack_id: id,
      vulnerability:
        first.attack.vulnerability || first.attack.category || "unknown",
      technique: first.attack.attackTechnique,
      severity: first.attack.severity,
      prompt_snippet: Array.from(extractPrompt(first)).slice(0, 300).join(""),
      per_agent: present.map((agent) => {
        const row = group.get(agent) as RedTeamResult;
        return {
          agent,
          vulnerable: row.vulnerable,
          response_snippet: Array.from(extractResponse(row))
            .slice(0, 500)
            .join(""),
          explanation: row.evaluation?.explanation ?? "",
        };
      }),
    });
  }
  disagreements.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  return section("agent_disagreements", "Agent Disagreements", {
    agents,
    total_disagreements: disagreements.length,
    disagreements,
  });
}
function contextSection(report: RedTeamReport): ReportSection | null {
  const agents = Object.keys(report.agentContexts).length
    ? Object.entries(report.agentContexts).map(([key, ctx]) => ({
        key,
        id: ctx.id,
        workspace_id: ctx.workspaceId,
        target_kind: ctx.targetKind,
        display_name: ctx.displayName || key,
        model: ctx.model || "",
        description: ctx.description || "",
        tools: ctx.tools.map((tool) => tool.name),
        memory_stores: ctx.memoryStores.map((store) => store.key || store.id),
        knowledge_bases: ctx.knowledgeBases.map(
          (kb) => kb.name || kb.key || kb.id,
        ),
        version: ctx.version,
        skills: [...ctx.skills],
        agent_type: ctx.agentType,
        engine: ctx.engine,
      }))
    : sorted(new Set(report.testedAgents)).map((key) => ({
        key,
        id: null,
        workspace_id: null,
        target_kind: null,
        display_name: key,
        model: "",
        description: "",
        tools: [],
        memory_stores: [],
        knowledge_bases: [],
        version: null,
        skills: [],
        agent_type: null,
        engine: null,
      }));
  return agents.length
    ? section("agent_context", "Tested Agents", { agents })
    : null;
}
function depthSection(report: RedTeamReport): ReportSection | null {
  const depths = new Map<number, Counts>();
  for (const row of report.results) {
    const turns = row.execution?.turns;
    if (turns == null || turns <= 1) continue;
    const value = depths.get(turns) ?? counts();
    countResult(value, row);
    depths.set(turns, value);
  }
  if (!depths.size) return null;
  return section(
    "turn_depth_analysis",
    "Conversation Depth Analysis (Multi-Turn)",
    {
      rows: [...depths]
        .sort(([a], [b]) => a - b)
        .map(([turn_count, row]) => ({
          turn_count,
          total_attacks: row.total,
          vulnerabilities_found: row.vulnerable,
          vulnerability_rate: asr(row),
        })),
    },
  );
}
function usageView(usage: Usage) {
  return {
    total_tokens: usage.totalTokens,
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    cached_tokens: usage.cachedTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
    calls: usage.calls,
    priced_calls: usage.pricedCalls,
    input_cost: usage.inputCost,
    output_cost: usage.outputCost,
    total_cost: usage.totalCost,
  };
}
function tokenSection(report: RedTeamReport): ReportSection | null {
  const overall = report.summary.tokenUsageTotal ?? report.tokenUsageSummary,
    groups = new Map<string, Usage[]>();
  for (const row of report.results)
    if (row.execution?.tokenUsage) {
      const key = agentKey(row),
        list = groups.get(key) ?? [];
      list.push(row.execution.tokenUsage);
      groups.set(key, list);
    }
  if (!overall && !groups.size) return null;
  const per_agent = [...groups]
    .map(([agent, items]) => ({
      agent,
      ...usageView(sumStructuredUsage(items) as Usage),
    }))
    .sort((a, b) => Number(b.total_tokens) - Number(a.total_tokens));
  return section("token_usage", "Token Usage", {
    overall: overall ? usageView(overall) : {},
    per_agent,
  });
}
function errorsSection(report: RedTeamReport): ReportSection {
  const s = report.summary,
    denominator = s.totalAttacks + s.preExecutionErrors;
  const details: {
    id: string;
    category: string;
    technique: string;
    error_type: string;
    stage: string;
    error: string | null;
  }[] = report.results
    .filter((row) => row.error)
    .map((row) => ({
      id: row.attack.id,
      category: row.attack.category,
      technique: row.attack.attackTechnique,
      error_type: row.errorType || "unknown",
      stage: row.errorStage || "",
      error: row.error,
    }));
  details.push(
    ...report.errors.map((row, index) => ({
      id: `pre-execution-${index + 1}`,
      category: "",
      technique: "",
      error_type: row.errorType,
      stage: row.stage || "",
      error: row.message,
    })),
  );
  const byType = { ...s.errorsByType };
  if (!Object.keys(byType).length)
    for (const row of details)
      byType[row.error_type] = (byType[row.error_type] ?? 0) + 1;
  return section("error_analysis", "Error Analysis", {
    total_errors: s.totalErrors,
    error_rate: denominator ? s.totalErrors / denominator : 0,
    error_types_count: Object.keys(byType).length,
    errors_by_type: byType,
    detail_rows: details,
  });
}
function methodologySection(report: RedTeamReport): ReportSection {
  const supported = Object.keys(OWASP_CATEGORY_NAMES).filter(
      (key) => !key.startsWith("OWASP-"),
    ),
    tested = new Set(report.categoriesTested),
    untested = sorted(supported.filter((key) => !tested.has(key)));
  const data: Row = {
    pipeline: report.pipeline,
    categories_tested: report.categoriesTested,
    scoring_method: "llm-as-judge",
    total_attacks: report.summary.totalAttacks,
    evaluation_coverage: report.summary.evaluationCoverage,
    tested_agents: report.testedAgents,
    framework: report.framework,
    duration_seconds: report.durationSeconds,
  };
  if (untested.length) {
    data.untested_categories = untested;
    data.untested_category_names = Object.fromEntries(
      untested.map((key) => [key, OWASP_CATEGORY_NAMES[key] ?? key]),
    );
  }
  return section("methodology", "Methodology", data);
}
export function buildRedteamReportSections(
  report: RedTeamReport,
): ReportSection[] {
  const s = report.summary,
    sections = [summarySection(report)];
  if (report.pipelineWarnings.length)
    sections.push(
      section("pipeline_warnings", "Run Warnings", {
        warnings: [...report.pipelineWarnings],
      }),
    );
  sections.push(methodologySection(report));
  const context = contextSection(report);
  if (context) sections.push(context);
  sections.push(focusSection(report));
  if (report.testedAgents.length >= 2)
    sections.push(agentComparisonSection(report), disagreementsSection(report));
  sections.push(...breakdowns(report));
  if (report.results.length) sections.push(heatmapSection(report));
  sections.push(
    dimensionSection(
      "technique_breakdown",
      "Per-Technique Breakdown",
      s.byTechnique,
      "technique",
    ),
  );
  if (Object.keys(s.byDeliveryMethod).length)
    sections.push(
      dimensionSection(
        "delivery_breakdown",
        "ASR by Delivery Method",
        s.byDeliveryMethod,
        "delivery_method",
      ),
    );
  if (Object.keys(s.byDomain).length)
    sections.push(
      section("turn_scope_breakdown", "Domain Breakdown", {
        by_domain: Object.fromEntries(
          Object.entries(s.byDomain).map(([key, row]) => [key, dimension(row)]),
        ),
      }),
    );
  const depth = depthSection(report);
  if (depth) sections.push(depth);
  if (s.totalErrors > 0) sections.push(errorsSection(report));
  if (Object.keys(s.byFramework).length > 1)
    sections.push(
      dimensionSection(
        "framework_breakdown",
        "Framework Breakdown",
        s.byFramework,
        "framework",
      ),
    );
  sections.push(
    section("individual_results", "Individual Attack Results", {
      entries: report.results.map((row) => ({
        id: row.attack.id,
        vulnerability: row.attack.vulnerability,
        category: row.attack.category,
        category_name:
          OWASP_CATEGORY_NAMES[row.attack.category] ?? row.attack.category,
        technique: row.attack.attackTechnique,
        severity: row.attack.severity,
        vulnerable: row.vulnerable,
        prompt: extractPrompt(row),
        response: extractResponse(row),
        explanation: row.evaluation?.explanation ?? "",
        error: row.error,
      })),
    }),
  );
  const sources = new Map<string, number>();
  for (const row of report.results)
    sources.set(row.attack.source, (sources.get(row.attack.source) ?? 0) + 1);
  if (sources.size >= 2)
    sections.push(
      section("source_distribution", "Attack Source Distribution", {
        rows: [...sources]
          .sort(([, a], [, b]) => b - a)
          .map(([source, count]) => ({ source, count })),
      }),
    );
  const tokens = tokenSection(report);
  if (tokens) sections.push(tokens);
  sections.push(
    section("severity_definitions", "Severity Levels", {
      definitions: Object.entries(SEVERITY_DEFINITIONS).map(
        ([level, description]) => ({ level, description }),
      ),
      weights: { ...SEVERITY_WEIGHTS },
    }),
  );
  return sections;
}
