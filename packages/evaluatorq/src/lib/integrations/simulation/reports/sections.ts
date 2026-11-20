import { createHash } from "node:crypto";

import { coerceContentText, messagesToText } from "../../../common/messages.js";
import { sumStructuredUsage } from "../../../common/structured-output.js";
import type { ReportSection, Usage } from "../../../contracts.js";
import { isErroredResult, TURN_METRICS } from "../metrics.js";
import type { SimulationRecommendation } from "../run-store.js";
import { usageDetails } from "../usage.js";
import {
  criteriaRows,
  personaName,
  type ReportResult,
  scenarioName,
} from "./helpers.js";

type Row = Record<string, unknown>;
const section = (
  kind: ReportSection["kind"],
  title: string,
  data: Row,
): ReportSection => ({ kind, title, data });
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const truthy = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : value !== null && typeof value === "object"
      ? Object.keys(value).length > 0
      : Boolean(value);
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort((a, b) => {
        const x = Array.from(a),
          y = Array.from(b);
        for (let i = 0; i < Math.min(x.length, y.length); i++) {
          const delta =
            (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
          if (delta) return delta;
        }
        return x.length - y.length;
      })
      .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Row)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null) ?? JSON.stringify(String(value));
}
export function simulationCohortId(
  result: ReportResult,
  kind: "persona" | "scenario",
): string {
  const explicit = result.metadata[`${kind}_id`];
  if (truthy(explicit)) return `${kind}:${String(explicit)}`;
  const snapshot =
    kind === "persona"
      ? {
          name: personaName(result),
          traits: truthy(result.metadata.persona_traits)
            ? result.metadata.persona_traits
            : {},
        }
      : {
          name: scenarioName(result),
          goal: result.metadata.scenario_goal ?? null,
          context: result.metadata.scenario_context ?? null,
          criteria: criteriaRows(result).map((row) => ({
            id: row.id,
            description: row.description,
            type: row.type,
          })),
        };
  const payload = sortedJson(snapshot).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${kind}:${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}
function groups(
  results: readonly ReportResult[],
  kind: "persona" | "scenario",
): Map<string, ReportResult[]> {
  const out = new Map<string, ReportResult[]>();
  for (const result of results) {
    const id = simulationCohortId(result, kind);
    const items = out.get(id) ?? [];
    items.push(result);
    out.set(id, items);
  }
  return out;
}
function counts(values: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}
const mostCommon = (values: Map<string, number>, limit = Infinity) =>
  [...values].sort((a, b) => b[1] - a[1]).slice(0, limit);
const goal = (result: ReportResult) =>
  truthy(result.metadata.scenario_goal)
    ? String(result.metadata.scenario_goal)
    : null;
const errorMessage = (result: ReportResult) =>
  truthy(result.metadata.error)
    ? String(result.metadata.error)
    : Array.isArray(result.metadata.criteria_errors) &&
        result.metadata.criteria_errors.length
      ? String(result.metadata.criteria_errors[0])
      : null;
function evaluatorScores(result: ReportResult): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(result.metadata.evaluator_scores))
      .filter(
        ([, value]) => typeof value === "number" || typeof value === "boolean",
      )
      .map(([key, value]) => [key, Number(value)]),
  );
}
export function simulationIndividualEntries(
  results: readonly ReportResult[],
): Row[] {
  return results.map((result, index) => ({
    index,
    persona: personaName(result),
    scenario: scenarioName(result),
    model: String(result.metadata.model ?? "unknown"),
    target_model: truthy(result.metadata.target_model)
      ? String(result.metadata.target_model)
      : null,
    terminated_by: result.terminated_by,
    goal_achieved: result.goal_achieved,
    goal_completion_score: result.goal_completion_score,
    rules_broken: [...result.rules_broken],
    criteria: criteriaRows(result),
    criteria_verified: result.criteria_verified ?? null,
    turn_count: result.turn_count,
    total_tokens: result.token_usage.total_tokens,
    judge_reason: result.reason,
    error: errorMessage(result),
    evaluator_scores: evaluatorScores(result),
    transcript: result.messages.map((message) => ({
      role: message.role,
      content: message.tool_calls?.length
        ? messagesToText([message])
        : coerceContentText(message.content),
    })),
    thread_id: result.thread_id ?? null,
    last_trace_id:
      [...(result.response_traces ?? [])]
        .reverse()
        .find((trace) => trace.traceId)?.traceId ?? null,
    goal: goal(result),
  }));
}
function breakdown(
  results: readonly ReportResult[],
  kind: "persona" | "scenario",
): ReportSection {
  const rows = [...groups(results, kind)]
    .map(([id, items]) => {
      const errors = items.filter(isErroredResult).length;
      const achieved = items.filter(
        (result) => result.goal_achieved && !isErroredResult(result),
      ).length;
      return {
        id,
        [kind]:
          kind === "persona"
            ? personaName(items[0] as ReportResult)
            : scenarioName(items[0] as ReportResult),
        conversations: items.length,
        completed_conversations: items.length - errors,
        errored_conversations: errors,
        goals_achieved: achieved,
        success_rate: achieved / items.length,
        avg_goal_completion_score: mean(
          items.map((result) => result.goal_completion_score),
        ),
        ...(kind === "scenario"
          ? { avg_turn_count: mean(items.map((result) => result.turn_count)) }
          : {}),
        total_tokens: items.reduce(
          (total, result) => total + result.token_usage.total_tokens,
          0,
        ),
      };
    })
    .sort((a, b) => a.success_rate - b.success_rate);
  return section(
    kind === "persona" ? "persona_breakdown" : "scenario_breakdown",
    kind === "persona" ? "Per-Persona Breakdown" : "Per-Scenario Breakdown",
    { rows },
  );
}
function overview(results: readonly ReportResult[]): ReportSection {
  const personas = [...groups(results, "persona")].map(([id, items]) => {
    const first = items[0] as ReportResult;
    const traits = first.metadata.persona_traits;
    return {
      id,
      name: personaName(first),
      conversations: items.length,
      traits:
        traits !== null && typeof traits === "object" && !Array.isArray(traits)
          ? traits
          : null,
      background: record(traits).background ?? null,
    };
  });
  const scenarios = [...groups(results, "scenario")].map(([id, items]) => {
    const first = items[0] as ReportResult;
    return {
      id,
      name: scenarioName(first),
      goal: goal(first),
      context: first.metadata.scenario_context ?? null,
      criteria: criteriaRows(first).map((row) => ({
        description: row.description,
        type: row.type,
      })),
      pass_rate: items.length
        ? items.filter((result) => result.goal_achieved).length / items.length
        : null,
    };
  });
  return section("overview", "Overview", {
    total_conversations: results.length,
    personas,
    scenarios,
  });
}
function failures(results: readonly ReportResult[]): ReportSection {
  return section("failures_first", "Failures", {
    rows: results.flatMap((result, index) => {
      if (result.goal_achieved || isErroredResult(result)) return [];
      const criteria = criteriaRows(result);
      return [
        {
          index: index + 1,
          persona: personaName(result),
          scenario: scenarioName(result),
          violated: criteria
            .filter((row) => !row.passed)
            .map((row) => row.description),
          criteria: criteria.map(({ description, passed, safety, state }) => ({
            description,
            passed,
            safety,
            state,
          })),
          has_safety: criteria.some((row) => row.safety),
          terminated_by: result.terminated_by,
          reason: result.reason || "",
          score: result.goal_completion_score,
          anchor: `conv-${index + 1}`,
        },
      ];
    }),
  });
}
function heatmap(results: readonly ReportResult[]): ReportSection {
  const names = {
    persona: new Map<string, string>(),
    scenario: new Map<string, string>(),
  };
  const pairs = new Map<
    string,
    { personaId: string; scenarioId: string; items: ReportResult[] }
  >();
  for (const result of results) {
    const p = simulationCohortId(result, "persona"),
      s = simulationCohortId(result, "scenario");
    names.persona.set(p, personaName(result));
    names.scenario.set(s, scenarioName(result));
    const key = JSON.stringify([p, s]),
      pair = pairs.get(key) ?? { personaId: p, scenarioId: s, items: [] };
    pair.items.push(result);
    pairs.set(key, pair);
  }
  const labels = (input: Map<string, string>) => {
    const raw = new Set(input.values()),
      used = new Set<string>(),
      out = new Map<string, string>();
    for (const [id, name] of input) {
      let label = name;
      if (used.has(label)) {
        let suffix = 2;
        label = `${name} (${suffix++})`;
        while (raw.has(label) || used.has(label))
          label = `${name} (${suffix++})`;
      }
      out.set(id, label);
      used.add(label);
    }
    return out;
  };
  const p = labels(names.persona),
    s = labels(names.scenario);
  return section("persona_scenario_heatmap", "Persona x Scenario Success", {
    personas: [...p.values()],
    scenarios: [...s.values()],
    cells: [...pairs.values()].map(({ personaId, scenarioId, items }) => ({
      persona_id: personaId,
      scenario_id: scenarioId,
      persona: p.get(personaId),
      scenario: s.get(scenarioId),
      success_rate: mean(
        items.map((result) =>
          Number(result.goal_achieved && !isErroredResult(result)),
        ),
      ),
      avg_score: mean(items.map((result) => result.goal_completion_score)),
      n: items.length,
      completed_conversations: items.filter(
        (result) => !isErroredResult(result),
      ).length,
      errored_conversations: items.filter(isErroredResult).length,
    })),
  });
}
function evaluatorSection(
  results: readonly ReportResult[],
): ReportSection | null {
  const values = new Map<string, number[]>(),
    dropped = new Map<string, number>(),
    reasons = new Map<string, string>();
  for (const result of results) {
    for (const [name, value] of Object.entries(evaluatorScores(result))) {
      const items = values.get(name) ?? [];
      items.push(value);
      values.set(name, items);
    }
    for (const [name, reason] of Object.entries(
      record(result.metadata.evaluator_errors),
    )) {
      dropped.set(name, (dropped.get(name) ?? 0) + 1);
      if (!reasons.has(name)) reasons.set(name, String(reason));
    }
  }
  if (!values.size && !dropped.size) return null;
  return section("evaluator_scores", "Evaluator Scores", {
    rows: [...new Set([...values.keys(), ...dropped.keys()])]
      .sort()
      .map((name) => {
        const items = values.get(name) ?? [];
        return {
          evaluator: name,
          runs: items.length,
          dropped: dropped.get(name) ?? 0,
          mean_score: items.length ? mean(items) : null,
          min_score: items.length ? Math.min(...items) : null,
          max_score: items.length ? Math.max(...items) : null,
          first_error: reasons.get(name) ?? null,
        };
      }),
  });
}
function usageSection(
  results: readonly ReportResult[],
  runUsage?: Usage | null,
): ReportSection {
  const usage = sumStructuredUsage(
    results.map((result) => usageDetails(result.token_usage, result.usage)),
  );
  const n = results.length || 1;
  const input = usage?.inputTokens ?? 0,
    output = usage?.outputTokens ?? 0,
    total = usage?.totalTokens ?? 0;
  return section("token_usage", "Token Usage", {
    prompt_tokens: input,
    completion_tokens: output,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cached_tokens: usage?.cachedTokens ?? 0,
    cache_creation_tokens: usage?.cacheCreationTokens ?? 0,
    reasoning_tokens: usage?.reasoningTokens ?? 0,
    avg_total_per_conversation: total / n,
    avg_input_per_conversation: input / n,
    avg_output_per_conversation: output / n,
    avg_prompt_per_conversation: input / n,
    avg_completion_per_conversation: output / n,
    input_cost: usage?.inputCost ?? null,
    output_cost: usage?.outputCost ?? null,
    total_cost: usage?.totalCost ?? null,
    calls: usage?.calls ?? 0,
    priced_calls: usage?.pricedCalls ?? 0,
    unknown_usage_conversations: results.filter(
      (result) => result.token_usage_known === false,
    ).length,
    ...(runUsage
      ? {
          run_total_input_tokens: runUsage.inputTokens,
          run_total_output_tokens: runUsage.outputTokens,
          run_total_total_tokens: runUsage.totalTokens,
          run_total_cost: runUsage.totalCost,
          run_total_calls: runUsage.calls,
          run_total_priced_calls: runUsage.pricedCalls,
        }
      : {}),
  });
}
function turnSections(
  results: readonly ReportResult[],
): [ReportSection, ReportSection] {
  const qualities = new Map<string, number[]>(),
    byTurn = new Map<number, Map<string, number[]>>();
  for (const result of results)
    for (const turn of result.turn_metrics)
      for (const metric of TURN_METRICS) {
        const value = turn[metric.key];
        if (value == null) continue;
        const all = qualities.get(metric.key) ?? [];
        all.push(value);
        qualities.set(metric.key, all);
        const perTurn =
          byTurn.get(turn.turn_number) ?? new Map<string, number[]>();
        const items = perTurn.get(metric.key) ?? [];
        items.push(value);
        perTurn.set(metric.key, items);
        byTurn.set(turn.turn_number, perTurn);
      }
  const turns = [...byTurn.keys()].sort((a, b) => a - b);
  const series = Object.fromEntries(
    TURN_METRICS.map((metric) => [
      metric.key,
      turns.map((turn) => {
        const values = byTurn.get(turn)?.get(metric.key) ?? [];
        return values.length ? mean(values) : null;
      }),
    ]).filter(([, values]) =>
      (values as unknown[]).some((value) => value !== null),
    ),
  );
  const distribution = counts(
    results.map((result) => String(result.turn_count)),
  );
  return [
    section("turn_quality_timeline", "Turn Quality Timeline", {
      turns,
      series,
    }),
    section("turn_metrics", "Turn Metrics", {
      per_conversation: results
        .map((result, index) => ({
          index: index + 1,
          label: `#${index + 1} ${personaName(result)} · ${scenarioName(result)}`,
          turns: result.turn_count,
        }))
        .sort((a, b) => b.turns - a.turns),
      turn_count_distribution: Object.fromEntries(
        [...distribution].sort((a, b) => Number(a[0]) - Number(b[0])),
      ),
      avg_quality_metrics: Object.fromEntries(
        [...qualities].map(([key, values]) => [key, mean(values)]),
      ),
    }),
  ];
}
function prettyTrigger(text: string): string {
  const index = text.indexOf(":"),
    kind = (index < 0 ? text : text.slice(0, index)).trim(),
    detail = index < 0 ? "" : text.slice(index + 1).trim();
  const labels: Record<string, string> = {
    rule_broken: "Rule broken",
    criterion_failed: "Criterion failed",
    low_factual_accuracy: "Low factual accuracy",
    high_hallucination_risk: "High hallucination risk",
    poor_tone: "Poor tone",
  };
  const raw = kind.replaceAll("_", " "),
    label =
      labels[kind] ??
      raw.slice(0, 1).toUpperCase() + raw.slice(1).toLowerCase();
  return detail ? `${label}: ${detail}` : label;
}
export interface BuildSimulationSectionsOptions {
  executiveSummary?: string | null;
  recommendations?: readonly SimulationRecommendation[] | null;
  runTokenUsageTotal?: Usage | null;
}
export function buildSimulationReportSections(
  results: readonly ReportResult[],
  options: BuildSimulationSectionsOptions = {},
): ReportSection[] {
  for (const result of results) criteriaRows(result);
  const total = results.length,
    achieved = results.filter(
      (result) => result.goal_achieved && !isErroredResult(result),
    ).length,
    errors = results.filter(isErroredResult).length,
    rate = total ? achieved / total : 0;
  const summary = section("summary", "Executive Summary", {
    total_conversations: total,
    goals_achieved: achieved,
    goals_failed: total - achieved - errors,
    errors,
    success_rate: rate,
    avg_goal_completion_score: mean(
      results.map((result) => result.goal_completion_score),
    ),
    avg_turn_count: mean(results.map((result) => result.turn_count)),
    total_tokens: results.reduce(
      (sum, result) => sum + result.token_usage.total_tokens,
      0,
    ),
    confidence: rate >= 0.8 ? "HIGH" : rate >= 0.5 ? "MEDIUM" : "LOW",
    confidence_note: `${rate >= 0.5 ? "" : "only "}${achieved}/${total} goals achieved`,
    verdict: rate >= 0.8 ? "pass" : rate >= 0.5 ? "warn" : "fail",
    narrative: options.executiveSummary ?? null,
  });
  const modes = counts(
    results
      .filter((result) => !result.goal_achieved)
      .flatMap((result) =>
        criteriaRows(result)
          .filter((row) => row.state === "fail")
          .map((row) => `${scenarioName(result)}: ${row.description}`),
      ),
  );
  const sections = [
    summary,
    overview(results),
    failures(results),
    section("failure_mode", "Failure Modes", { rows: mostCommon(modes, 15) }),
  ];
  if (options.recommendations?.length)
    sections.push(
      section("recommendations", "Remediation Suggestions", {
        rows: options.recommendations.map((rec) => ({
          index: rec.resultIndex + 1,
          datapoint_id: rec.datapointId,
          persona: rec.persona,
          scenario: rec.scenario,
          triggers: rec.triggers.map(prettyTrigger),
          suggestions: [...rec.suggestions],
          anchor: `conv-${rec.resultIndex + 1}`,
        })),
      }),
    );
  const [timeline, turnMetrics] = turnSections(results);
  const rules = counts(results.flatMap((result) => result.rules_broken));
  sections.push(
    heatmap(results),
    section("score_distribution", "Goal Score Distribution", {
      scores: results.map((result) => result.goal_completion_score),
      measured_scores: results
        .filter((result) => !isErroredResult(result))
        .map((result) => result.goal_completion_score),
      completed_conversations: total - errors,
      errored_conversations: errors,
      total_conversations: total,
    }),
    timeline,
    breakdown(results, "persona"),
    breakdown(results, "scenario"),
    section("judge_verdicts", "Judge Verdicts", {
      terminated_by: Object.fromEntries(
        counts(results.map((result) => result.terminated_by)),
      ),
      rules_broken: Object.fromEntries(mostCommon(rules, 15)),
      total_rules_broken_instances: [...rules.values()].reduce(
        (a, b) => a + b,
        0,
      ),
    }),
    turnMetrics,
  );
  const evaluators = evaluatorSection(results);
  if (evaluators) sections.push(evaluators);
  if (errors)
    sections.push(
      section("errors", "Errors", {
        total_errored: errors,
        by_message: Object.fromEntries(
          mostCommon(
            counts(
              results
                .filter(isErroredResult)
                .map(
                  (result) =>
                    errorMessage(result) || result.reason || "unknown",
                ),
            ),
            10,
          ),
        ),
      }),
    );
  sections.push(
    usageSection(results, options.runTokenUsageTotal),
    section("individual_results", "Individual Conversations", {
      entries: simulationIndividualEntries(results),
    }),
  );
  return sections;
}
