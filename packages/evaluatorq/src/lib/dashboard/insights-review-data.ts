import { sumStructuredUsage } from "../common/structured-output.js";
import { costIsPartial } from "../contracts.js";
import {
  type InsightsRunFields,
  labelKey,
  populationSource,
  readsSnapshot,
  realAssistantErrors,
} from "../insights/models.js";
import { CODING_LABELS } from "../insights/presets.js";
import { SHELL_TOOL_NAMES } from "../signals/config.js";
import { timeMicros } from "../trace-finder/models.js";
import { SOURCE_BY_MODE, SOURCES } from "./insights-launch.js";
import {
  reviewTraceKey,
  reviewXy,
  reviewXyState,
} from "./insights-review-projection.js";
import { conversationRereadable } from "./insights-trace-source.js";
import { signalSummary, snakeJson, traceHref } from "./insights-views.js";
import { traceSpanUrl } from "./trace-links.js";

type Run = InsightsRunFields;
type Json = Record<string, unknown>;

/** One saved trace's full signal report and coverage, or null when the key is not in this run. */
export function buildSignalDetailPayload(
  run: Run,
  traceId: string,
  spanId: string | null,
): Json | null {
  const trace = run.traces.find(
    (item) => item.traceId === traceId && item.spanId === spanId,
  );
  if (trace === undefined) return null;
  const report = trace.signals;
  return {
    trace_id: trace.traceId,
    span_id: trace.spanId,
    has_signals: report !== null,
    signals: report !== null ? snakeJson(report) : null,
    source_coverage: { ...trace.sourceCoverage },
  };
}

/** Stages that never call a model, so a missing cost there means none was spent. */
function stagesWithoutModelCalls(run: Run): string[] {
  const source = populationSource(run.population);
  const stages = ["priority", "write"];
  const config = run.config;
  if (
    !(
      config.labels.length ||
      config.codingLabels.length ||
      config.codingAnalysis ||
      source === "query"
    )
  )
    stages.unshift("label");
  if (source === "snapshot" || source === "export" || source === "filter")
    stages.unshift("population");
  return stages;
}

function sourceLabel(mode: unknown): string {
  const source = SOURCE_BY_MODE[String(mode)];
  return source !== undefined
    ? SOURCES[source].label
    : mode
      ? String(mode)
      : "";
}

/** UTC ISO time with a Z suffix, formatted like Python's isoformat. */
export function utcTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const text = typeof value === "string" ? value : value.toISOString();
  let microseconds: bigint;
  try {
    microseconds = timeMicros(text);
  } catch {
    return text;
  }
  const second =
    microseconds >= 0n
      ? microseconds / 1000000n
      : (microseconds - 999999n) / 1000000n;
  const fraction = Number(microseconds - second * 1000000n);
  const utc = new Date(Number(second) * 1000).toISOString().slice(0, 19);
  return `${utc}${fraction ? `.${String(fraction).padStart(6, "0")}` : ""}Z`;
}

/** Map a saved Insights run into the complete, JSON-safe dashboard contract. */
export async function buildReviewPayload(run: Run): Promise<Json> {
  const names = Object.keys(run.dimensions);
  const projections = new Map(names.map((name) => [name, reviewXy(run, name)]));
  const mapStates = Object.fromEntries(
    names.map((name) => [
      name,
      reviewXyState(run, name, projections.get(name)),
    ]),
  );
  const labelSpecs = new Map(
    run.config.labels.map((spec) => [spec.name, spec]),
  );
  const codingSpecs = run.config.codingAnalysis
    ? CODING_LABELS
    : run.config.codingLabels.length
      ? [CODING_LABELS[0], ...run.config.codingLabels]
      : [];
  for (const spec of codingSpecs) if (spec) labelSpecs.set(spec.name, spec);
  const labels = Object.values(run.labels).map((result) => ({
    name: result.spec.name,
    kind: result.spec.kind,
    criteria: result.spec.criteria,
    instructions: result.spec.instructions,
    counts: { ...result.counts },
    counts_warning: result.countsWarning,
    n_failed: result.nFailed,
    n_not_asked: result.nNotAsked,
    mean_confidence: result.meanConfidence,
    n_low_confidence: result.nLowConfidence,
  }));
  const traceView = (await conversationRereadable(run)) ? "trace" : "analysis";
  const snapshot = readsSnapshot(run.population);
  const traces: Json[] = [];
  for (const trace of run.traces) {
    const key = reviewTraceKey(trace);
    const answers: Record<string, unknown[]> = {};
    const questionErrors: Record<string, string> = {};
    for (const [name, answer] of Object.entries(trace.labels)) {
      const spec = labelSpecs.get(name);
      if (answer.error) questionErrors[name] = answer.error;
      else if (answer.value === null || answer.value === undefined)
        questionErrors[name] = "The question returned no answer";
      else answers[name] = [spec ? labelKey(spec, answer.value) : answer.value];
    }
    const summary = trace.summary;
    const stats = trace.toolStats;
    const signals = signalSummary(trace);
    const xy: Record<string, number[]> = {};
    for (const [name, points] of projections) {
      const point = points.get(key);
      if (point) xy[name] = [...point];
    }
    traces.push({
      id: key,
      trace_id: trace.traceId,
      span_id: trace.spanId,
      trace_url: traceHref(run, trace, traceView),
      orq_url: snapshot
        ? null
        : await traceSpanUrl(trace.traceId, trace.spanId),
      ts: utcTimestamp(trace.timestamp ?? null),
      agent: trace.agentName,
      l: answers,
      label_errors: questionErrors,
      a: Object.fromEntries(
        Object.entries(trace.assignments).map(([name, value]) => [
          name,
          value.base,
        ]),
      ),
      xy,
      errors: summary ? realAssistantErrors(summary) : [],
      summary: summary?.summary ?? null,
      request: summary?.request ?? null,
      topic: summary?.topic ?? null,
      has_summary: summary !== null,
      has_tool_stats: stats !== null,
      tools: stats ? { ...stats.tools } : {},
      skills: stats ? { ...stats.skills } : {},
      commands: stats ? { ...stats.commands } : {},
      has_signals: signals !== null,
      has_signal_details: signals !== null,
      signals,
      signal_detail_url:
        signals !== null
          ? `/insights/${encodeURIComponent(run.runId)}/trace-signals.json?${new URLSearchParams(
              { trace_id: trace.traceId, span_id: trace.spanId ?? "" },
            ).toString()}`
          : null,
    });
  }
  const dims = Object.fromEntries(
    Object.entries(run.dimensions).map(([name, dimension]) => [
      name,
      {
        source_field: dimension.sourceField,
        clusters: dimension.clusters.map((cluster) => ({
          id: cluster.id,
          parent_id: cluster.parentId,
          level: cluster.level,
          name: cluster.name,
          description: cluster.description,
          size: cluster.size,
          trace_ids: [...cluster.traceIds],
          example_trace_ids: [...cluster.exampleTraceIds],
          group: cluster.group,
        })),
        n_noise: dimension.nNoise,
        n_no_signal: dimension.nNoSignal,
        n_failed: dimension.nFailed,
        warnings: [...dimension.warnings],
      },
    ]),
  );
  const stageUsage = Object.entries(run.costByStage);
  const total = sumStructuredUsage(stageUsage.map(([, usage]) => usage));
  const population = { ...run.population };
  return {
    run: {
      id: run.runId,
      name: run.runName,
      created: utcTimestamp(run.createdAt),
      status: run.status,
      population,
      source_label: sourceLabel(population.mode),
      cost: total?.totalCost ?? null,
      cost_is_partial: total ? costIsPartial(total) : null,
      cost_by_stage: Object.fromEntries(
        stageUsage.map(([name, usage]) => [name, usage?.totalCost ?? null]),
      ),
      stages_without_model_calls: stagesWithoutModelCalls(run),
      cost_by_stage_details: Object.fromEntries(
        stageUsage.map(([name, usage]) => [
          name,
          usage
            ? {
                cost: usage.totalCost,
                is_partial: costIsPartial(usage),
                priced_calls: usage.pricedCalls,
                calls: usage.calls,
              }
            : null,
        ]),
      ),
      summary_model: run.config.summaryModel,
      classifier_model: run.config.classifierModel,
      embedding_model: run.config.embeddingModel,
      warnings: [...run.warnings],
      priority: run.priority !== null ? snakeJson(run.priority) : null,
      priority_reason: run.priorityReason,
      priority_dimension: run.config.priorityDimension,
      counts: { ...run.counts },
      stage_failures: snakeJson(run.stageFailures),
    },
    dims,
    labels,
    traces,
    map_states: mapStates,
    activity: { shell_tools: [...SHELL_TOOL_NAMES].sort() },
  };
}
