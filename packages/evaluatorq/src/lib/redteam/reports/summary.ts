import { addUsage, type Usage } from "../../contracts.js";
import { OWASP_CATEGORY_NAMES, Pipeline } from "../contracts.js";
import type { RunError } from "../strategy.js";
import {
  getFrameworkCategories,
  getVulnerabilityDef,
  getVulnerabilityName,
} from "../vulnerability-registry.js";
import {
  type CategorySummary,
  codepointCompare,
  type DimensionSummary,
  JuryHealth,
  type JuryReliability,
  RedTeamReport,
  type RedTeamResult,
  ReportSummary,
  type VulnerabilitySummary,
} from "./models.js";

const isEvaluated = (result: RedTeamResult) =>
  typeof result.evaluation?.passed === "boolean";
const isVulnerable = (result: RedTeamResult) =>
  result.evaluation?.passed === false;
const verdictRate = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : null;
interface GroupCounts {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  turns: number;
}
function groupCounts(
  results: readonly RedTeamResult[],
  key: (result: RedTeamResult) => string | null,
): Map<string, GroupCounts> {
  const groups = new Map<string, GroupCounts>();
  for (const result of results) {
    const name = key(result);
    if (name === null) continue;
    const counts = groups.get(name) ?? {
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      turns: 0,
    };
    counts.total++;
    if (isEvaluated(result)) {
      if (isVulnerable(result)) counts.failed++;
      else counts.passed++;
    }
    if (result.error) counts.errored++;
    counts.turns += result.execution?.turns ?? 0;
    groups.set(name, counts);
  }
  return groups;
}
function dimensionSummaries(
  grouped: Map<string, GroupCounts>,
): Record<string, DimensionSummary> {
  return Object.fromEntries(
    [...grouped].map(([name, counts]) => [
      name,
      {
        totalAttacks: counts.total,
        vulnerabilitiesFound: counts.failed,
        resistanceRate: verdictRate(
          counts.passed,
          counts.passed + counts.failed,
        ),
        vulnerabilityRate: verdictRate(
          counts.failed,
          counts.passed + counts.failed,
        ),
      },
    ]),
  );
}
function juryReliability(
  results: readonly RedTeamResult[],
): JuryReliability | null {
  let o01 = 0,
    n0 = 0,
    n1 = 0,
    samples = 0;
  for (const result of results) {
    const ratings = result.evaluation?.jury?.votes
      .filter(
        (vote) =>
          vote.success && !vote.abstained && typeof vote.value === "boolean",
      )
      .map((vote) => vote.value);
    if (!ratings || ratings.length < 2) continue;
    samples++;
    const c1 = ratings.filter((value) => value === true).length,
      c0 = ratings.length - c1;
    o01 += (c0 * c1) / (ratings.length - 1);
    n0 += c0;
    n1 += c1;
  }
  return samples
    ? Object.freeze({
        krippendorffAlpha:
          n0 * n1 === 0 ? null : 1 - ((n0 + n1 - 1) * o01) / (n0 * n1),
        samples,
        method: "krippendorff_alpha_nominal",
      })
    : null;
}
function juryHealth(results: readonly RedTeamResult[]): JuryHealth | null {
  let samples = 0,
    samplesWithJudgeFailure = 0,
    replacementsUsed = 0,
    ties = 0,
    inconclusive = 0,
    samplesWithRepetitionFailure = 0,
    samplesWithAbstention = 0;
  const judgeFailureReasons: string[] = [];
  for (const result of results) {
    const jury = result.evaluation?.jury;
    if (!jury || jury.judgesConfigured < 2) continue;
    samples++;
    samplesWithJudgeFailure += Number(jury.judgesFailed > 0);
    replacementsUsed += jury.replacementsUsed;
    ties += Number(jury.tie);
    inconclusive += Number(jury.inconclusive);
    samplesWithRepetitionFailure += Number(
      jury.votes.some((vote) => vote.repetitionsFailed > 0),
    );
    samplesWithAbstention += Number(jury.votes.some((vote) => vote.abstained));
    for (const vote of jury.votes)
      if (!vote.success && vote.error) judgeFailureReasons.push(vote.error);
  }
  return samples
    ? new JuryHealth({
        samples,
        samplesWithJudgeFailure,
        replacementsUsed,
        ties,
        inconclusive,
        samplesWithRepetitionFailure,
        samplesWithAbstention,
        judgeFailureReasons,
      })
    : null;
}
export function computeReportSummary(
  results: readonly RedTeamResult[],
  options: {
    minEvaluationCoverage?: number | null;
    runErrors?: readonly RunError[];
  } = {},
): ReportSummary {
  const runErrors = options.runErrors ?? [];
  const errors = new Map<string, number>();
  const addError = (key: string) => errors.set(key, (errors.get(key) ?? 0) + 1);
  if (!results.length) {
    for (const error of runErrors)
      addError(error.code || error.errorType || "unknown");
    return new ReportSummary({
      minEvaluationCoverage: options.minEvaluationCoverage ?? null,
      totalErrors: runErrors.length,
      preExecutionErrors: runErrors.length,
      errorsByType: Object.fromEntries(errors),
    });
  }
  const total = results.length,
    evaluated = results.filter(isEvaluated).length,
    vulnerable = results.filter(isVulnerable).length;
  const totalTurns = results.reduce(
    (sum, result) => sum + (result.execution?.turns ?? 0),
    0,
  );
  const strategies = (filter: (result: RedTeamResult) => boolean) => [
    ...new Set(
      results
        .filter(filter)
        .map((result) => result.attack.strategyName)
        .filter((name): name is string => !!name),
    ),
  ];
  const byCategory: Record<string, CategorySummary> = Object.fromEntries(
    [...groupCounts(results, (result) => result.attack.category)].map(
      ([category, counts]) => {
        const evaluatedAttacks = counts.passed + counts.failed;
        return [
          category,
          {
            category,
            categoryName: Object.hasOwn(OWASP_CATEGORY_NAMES, category)
              ? OWASP_CATEGORY_NAMES[category]
              : category,
            totalAttacks: counts.total,
            evaluatedAttacks,
            unevaluatedAttacks: counts.total - evaluatedAttacks,
            evaluationCoverage:
              counts.total > 0 ? evaluatedAttacks / counts.total : 0,
            totalConversations: counts.total,
            totalTurns: counts.turns,
            vulnerabilitiesFound: counts.failed,
            vulnerabilityRate: verdictRate(counts.failed, evaluatedAttacks),
            resistanceRate: verdictRate(counts.passed, evaluatedAttacks),
            totalErrors: counts.errored,
            strategiesUsed: strategies(
              (result) => result.attack.category === category,
            ),
          },
        ];
      },
    ),
  );
  const unresolved = results.filter(
    (result) => !result.attack.vulnerability,
  ).length;
  if (unresolved)
    console.warn(
      `${unresolved} result(s) have no vulnerability identifier and are excluded from byVulnerability.`,
    );
  const vulnerabilities = new Map<string, VulnerabilitySummary>();
  for (const [vulnerability, counts] of groupCounts(
    results,
    (result) => result.attack.vulnerability || null,
  )) {
    const definition = getVulnerabilityDef(vulnerability);
    if (!definition) {
      console.warn(
        `Skipping unknown vulnerability ${JSON.stringify(vulnerability)} in byVulnerability grouping.`,
      );
      continue;
    }
    vulnerabilities.set(vulnerability, {
      vulnerability,
      vulnerabilityName: getVulnerabilityName(vulnerability),
      domain: definition.domain,
      totalAttacks: counts.total,
      evaluatedAttacks: counts.passed + counts.failed,
      vulnerabilitiesFound: counts.failed,
      resistanceRate: verdictRate(counts.passed, counts.passed + counts.failed),
      strategiesUsed: strategies(
        (result) => result.attack.vulnerability === vulnerability,
      ),
      frameworkCategories: getFrameworkCategories(vulnerability),
    });
  }
  const deliveryRows = new Map<string, RedTeamResult[]>();
  for (const result of results)
    for (const method of result.attack.deliveryMethods) {
      const rows = deliveryRows.get(method) ?? [];
      rows.push(result);
      deliveryRows.set(method, rows);
    }
  const deliveryCounts = new Map<string, GroupCounts>();
  for (const [method, rows] of deliveryRows) {
    const counts = groupCounts(rows, () => method).get(method);
    if (counts) deliveryCounts.set(method, counts);
  }
  const turnCounts = groupCounts(results, (result) => result.attack.turnType);
  const byTurnType = Object.fromEntries(
    Object.entries(dimensionSummaries(turnCounts)).map(([name, value]) => [
      name,
      {
        ...value,
        averageTurns: (turnCounts.get(name)?.turns ?? 0) / value.totalAttacks,
      },
    ]),
  );
  let tokenUsageTotal: Usage | null = null,
    totalErrors = 0;
  const bySource = new Map<string, Usage>();
  for (const result of results) {
    for (const usage of [
      result.execution?.tokenUsage,
      result.evaluation?.tokenUsage,
    ]) {
      if (usage === null || usage === undefined) continue;
      tokenUsageTotal =
        tokenUsageTotal === null
          ? addUsage(usage)
          : addUsage(tokenUsageTotal, usage);
      const source = result.attack.source || "unknown",
        prior = bySource.get(source);
      bySource.set(source, prior ? addUsage(prior, usage) : addUsage(usage));
    }
    if (result.error) {
      totalErrors++;
      addError(result.errorCode || result.errorType || "unknown");
    }
    if (result.evaluationError) {
      totalErrors++;
      const error = result.evaluationError;
      addError(`evaluation/${error.code || error.errorType || "unknown"}`);
    }
  }
  for (const error of runErrors) {
    totalErrors++;
    addError(error.code || error.errorType || "unknown");
  }
  return new ReportSummary({
    totalAttacks: total,
    evaluatedAttacks: evaluated,
    unevaluatedAttacks: total - evaluated,
    evaluationCoverage: evaluated / total,
    minEvaluationCoverage: options.minEvaluationCoverage ?? null,
    totalConversations: total,
    totalTurns,
    averageTurnsPerAttack: totalTurns / total,
    vulnerabilitiesFound: vulnerable,
    vulnerabilityRate: verdictRate(vulnerable, evaluated),
    resistanceRate: verdictRate(evaluated - vulnerable, evaluated),
    totalErrors,
    preExecutionErrors: runErrors.length,
    errorsByType: Object.fromEntries(errors),
    tokenUsageTotal,
    tokenUsageBySource: Object.fromEntries(bySource),
    byVulnerability: Object.fromEntries(vulnerabilities),
    byCategory,
    byTechnique: dimensionSummaries(
      groupCounts(results, (result) => result.attack.attackTechnique),
    ),
    bySeverity: dimensionSummaries(
      groupCounts(results, (result) => result.attack.severity),
    ),
    byDeliveryMethod: dimensionSummaries(deliveryCounts),
    byTurnType,
    byDomain: dimensionSummaries(
      groupCounts(results, (result) => result.attack.vulnerabilityDomain),
    ),
    byFramework: dimensionSummaries(
      groupCounts(results, (result) => result.attack.framework),
    ),
    juryReliability: juryReliability(results),
    juryHealth: juryHealth(results),
  });
}
export function rebuildFilteredReport(
  report: RedTeamReport,
  filteredResults: readonly RedTeamResult[],
): RedTeamReport {
  return new RedTeamReport({
    ...report,
    results: [...filteredResults],
    summary: computeReportSummary(filteredResults, {
      minEvaluationCoverage: report.summary.minEvaluationCoverage,
      runErrors: report.errors,
    }),
    totalResults: filteredResults.length,
    categoriesTested: [
      ...new Set(filteredResults.map((result) => result.attack.category)),
    ].sort(codepointCompare),
  });
}
export function mergeReports(
  reports: readonly RedTeamReport[],
  options: { description?: string | null } = {},
): RedTeamReport {
  if (!reports.length)
    throw new RangeError("mergeReports() requires at least one report");
  if (reports.length === 1) return reports[0] as RedTeamReport;
  const results = reports.flatMap((report) => report.results),
    errors = reports.flatMap((report) => report.errors);
  const frameworks = new Set(
      reports
        .map((report) => report.framework)
        .filter((value) => value !== null),
    ),
    pipelines = new Set(reports.map((report) => report.pipeline));
  const agentContexts = Object.assign(
    {},
    ...reports.map((report) => report.agentContexts),
  );
  return new RedTeamReport({
    createdAt: new Date(),
    description: options.description || "Merged report",
    pipeline: pipelines.size === 1 ? [...pipelines][0] : Pipeline.HYBRID,
    framework: frameworks.size === 1 ? [...frameworks][0] : null,
    categoriesTested: [
      ...new Set(results.map((result) => result.attack.category)),
    ].sort(codepointCompare),
    testedAgents: [
      ...new Set([
        ...Object.keys(agentContexts),
        ...reports.flatMap((report) => report.testedAgents),
      ]),
    ].sort(codepointCompare),
    totalResults: results.length,
    errors,
    agentContexts,
    results,
    summary: computeReportSummary(results, {
      minEvaluationCoverage:
        reports.find((report) => report.summary.minEvaluationCoverage !== null)
          ?.summary.minEvaluationCoverage ?? null,
      runErrors: errors,
    }),
    runId: reports.find((report) => report.runId)?.runId ?? null,
  });
}
