import { randomUUID } from "node:crypto";

import type OpenAI from "openai";

import type { Orq } from "@orq-ai/node";

import { resolveLlmClient } from "../common/llm-client.js";
import { roleModel } from "../common/model-roles.js";
import { resolveOrqClient } from "../common/orq-client.js";
import { startManifest } from "../common/run-manifest.js";
import { traceDocumentWithSignals } from "../common/trace-document.js";
import { SignalsConfig } from "../signals/config.js";
import { computeSignals } from "../signals/registry.js";
import type { InsightsCache } from "./cache.js";
import { InsightsCache as RuntimeCache } from "./cache.js";
import { centroids, clusterTwoLevel, nearestNeighbours } from "./cluster.js";
import {
  type ClusterName,
  describeClusters,
  describeTopLevel,
} from "./describe.js";
import { embedTexts } from "./embed.js";
import type { LabelOutcome } from "./labeling.js";
import { labelTraces } from "./labeling.js";
import { mergeSimilar } from "./merge.js";
import {
  type DimensionName,
  type DimensionResult,
  DimensionResultSchema,
  InsightsConfig,
  type InsightsPopulation,
  type InsightsRunFields,
  InsightsRunSchema,
  LabelResult,
  LabelSpec,
  labelKey,
  readsOrq,
  realAssistantErrors,
  type TraceInsight,
  TraceInsightSchema,
} from "./models.js";
import { resolvePopulation } from "./population.js";
import {
  CODING_LABELS,
  DIMENSION_FIELDS,
  LABEL_PRESETS,
  SENTIMENT,
} from "./presets.js";
import { priorityPoints } from "./priority.js";
import { stageHistoryForSave, stagePlan } from "./progress.js";
import { project2d, reduce3d } from "./reduce.js";
import { getInsightsRunsDir, saveRun } from "./store.js";
import { summarizeTraces } from "./summarize.js";
import { toolStats } from "./transcript.js";
import type { UsageLedger } from "./usage.js";
import { UsageLedger as RuntimeLedger } from "./usage.js";

export function resolveLabelSpecs(
  labels: readonly (LabelSpec | string)[],
  dimensions: readonly DimensionName[],
): LabelSpec[] {
  const resolved = labels.map((label) => {
    if (label instanceof LabelSpec) return label;
    const preset = LABEL_PRESETS[label];
    if (!preset) throw new Error(`unknown Insights label preset: '${label}'`);
    return preset;
  });
  if (
    dimensions.includes("sentiment") &&
    !resolved.some((spec) => spec.name === "sentiment")
  )
    resolved.push(SENTIMENT);
  const names = resolved.map((spec) => spec.name);
  if (new Set(names).size !== names.length)
    throw new Error("Insights labels must have unique names");
  const reserved = new Set(CODING_LABELS.map((spec) => spec.name)),
    clashes = names.filter((name) => reserved.has(name)).sort();
  if (clashes.length)
    throw new Error(
      `Insights label names are reserved for coding analysis: ${clashes.join(", ")}`,
    );
  return resolved;
}
export function dimensionSource(
  trace: TraceInsight,
  dimension: DimensionName,
): string | null {
  const summary = trace.summary;
  if (!summary) return null;
  if (dimension === "intent") return summary.request;
  if (dimension === "failure")
    return realAssistantErrors(summary).join(" ; ") || null;
  return summary.sentimentExplanation;
}
export function aggregateLabelResults(
  traces: readonly TraceInsight[],
  specs: readonly LabelSpec[],
): Record<string, LabelResult> {
  return Object.fromEntries(
    specs.map((spec) => {
      const counts: Record<string, number> = {},
        confidences: number[] = [];
      let low = 0,
        failed = 0,
        notAsked = 0;
      for (const trace of traces) {
        const answer = trace.labels[spec.name];
        if (answer === undefined) {
          notAsked++;
          continue;
        }
        if (answer.error !== null || answer.value === null) {
          failed++;
          continue;
        }
        if (answer.confidence !== null) {
          confidences.push(answer.confidence);
          if (answer.confidence < 0.6) low++;
        }
        const key = labelKey(spec, answer.value);
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return [
        spec.name,
        new LabelResult({
          spec,
          counts,
          meanConfidence: confidences.length
            ? confidences.reduce((a, b) => a + b, 0) / confidences.length
            : null,
          nLowConfidence: low,
          nFailed: failed,
          nNotAsked: notAsked,
        }),
      ];
    }),
  );
}
export function discardDimension(
  traces: readonly TraceInsight[],
  dimension: DimensionName,
): void {
  for (const trace of traces) {
    delete trace.assignments[dimension];
    delete trace.coords[dimension];
    if (trace.coords2d !== null) delete trace.coords2d[dimension];
    delete trace.errors[`dimension:${dimension}`];
  }
}

export interface BuildDimensionOptions {
  client: OpenAI;
  cache: InsightsCache;
  embeddingModel: string;
  summaryModel: string;
  classifierModel: string;
  maxClusters: number;
  maxSubclusters: number;
  outlierZscore: number | null;
  parallelism: number;
  usage?: UsageLedger;
  signal?: AbortSignal;
}
export async function buildDimension(
  dimension: DimensionName,
  traces: TraceInsight[],
  options: BuildDimensionOptions,
): Promise<DimensionResult> {
  for (const [index, trace] of traces.entries())
    traces[index] = {
      ...trace,
      assignments: { ...trace.assignments },
      coords: { ...trace.coords },
      coords2d: { ...trace.coords2d },
      errors: { ...trace.errors },
    };
  const usable: { trace: TraceInsight; text: string }[] = [];
  let noSignal = 0;
  for (const trace of traces) {
    if (Object.hasOwn(trace.errors, "summary")) continue;
    const text = dimensionSource(trace, dimension);
    if (!text || !text.trim()) noSignal++;
    else usable.push({ trace, text });
  }
  const failedCount = () =>
    traces.filter((trace) =>
      Object.hasOwn(trace.errors, `dimension:${dimension}`),
    ).length;
  const result = {
    ...DimensionResultSchema.parse({
      name: dimension,
      sourceField: DIMENSION_FIELDS[dimension],
      clusters: [],
      nNoSignal: noSignal,
      nFailed: failedCount(),
    }),
  };
  if (usable.length < 5) {
    const noun = usable.length === 1 ? "trace has" : "traces have";
    result.warnings.push(
      `dimension ${dimension} skipped: only ${usable.length} ${noun} signal (need at least 5)`,
    );
    return result;
  }
  const groups = new Map<string | null, number[]>();
  for (const [index, item] of usable.entries()) {
    const answer = item.trace.labels.sentiment;
    const group =
      dimension === "sentiment"
        ? answer && answer.error === null && answer.value !== null
          ? String(answer.value)
          : "unknown"
        : null;
    const indices = groups.get(group) ?? [];
    indices.push(index);
    groups.set(group, indices);
  }
  const usage = options.usage?.scoped(`dimension:${dimension}`);
  let nextBase = 0,
    nextTop = 0;
  for (const [group, indices] of groups) {
    options.signal?.throwIfAborted();
    if (indices.length === 1) {
      const warning = `dimension ${dimension} group '${group}' has one signal trace; marked unclassified`,
        trace = (usable[indices[0] as number] as { trace: TraceInsight }).trace;
      result.warnings.push(warning);
      trace.assignments[dimension] = {
        top: "unclassified",
        base: "unclassified",
      };
      trace.errors[`dimension:${dimension}`] = warning;
      continue;
    }
    const rows = indices.map(
        (index) => usable[index] as { trace: TraceInsight; text: string },
      ),
      texts = rows.map((row) => row.text);
    const embedded = await embedTexts(texts, {
      client: options.client,
      model: options.embeddingModel,
      cache: options.cache,
      usage,
      signal: options.signal,
    });
    const vectors = texts.map((text) => embedded[text] as number[]);
    const tree = clusterTwoLevel(vectors, {
      maxClusters: options.maxClusters,
      maxSubclusters: options.maxSubclusters,
      minClusterSize: 5,
      outlierZscore: options.outlierZscore,
    });
    const labels = tree.baseLabels,
      ids = [...new Set(labels)]
        .filter((id) => id !== -1)
        .sort((a, b) => a - b);
    const centers = centroids(vectors, labels),
      neighbours = nearestNeighbours(centers);
    const members: Record<number, string[]> = {},
      memberTraces: Record<number, TraceInsight[]> = {},
      examples: Record<number, string[]> = {},
      exampleIds: Record<number, string[]> = {};
    for (const id of ids) {
      members[id] = [];
      memberTraces[id] = [];
    }
    for (const [index, id] of labels.entries()) {
      const row = rows[index] as { trace: TraceInsight; text: string };
      if (id === -1) {
        row.trace.assignments[dimension] = { top: "noise", base: "noise" };
        result.nNoise++;
        continue;
      }
      members[id]?.push(row.text);
      memberTraces[id]?.push(row.trace);
    }
    for (const id of ids) {
      const center = centers[id] as number[];
      const nearest = labels
        .flatMap((label, i) => (label === id ? [i] : []))
        .sort((a, b) => {
          const distance = (index: number) =>
            (vectors[index] as number[]).reduce(
              (sum, value, j) => sum + (value - (center[j] as number)) ** 2,
              0,
            );
          return distance(a) - distance(b);
        })
        .slice(0, 5);
      examples[id] = nearest.map(
        (index) => (rows[index] as { text: string }).text,
      );
      exampleIds[id] = nearest.map(
        (index) => (rows[index] as { trace: TraceInsight }).trace.traceId,
      );
    }
    const described = await describeClusters(members, neighbours, dimension, {
      client: options.client,
      model: options.summaryModel,
      parallelism: options.parallelism,
      usage,
      signal: options.signal,
    });
    if (
      Object.keys(described).length &&
      Object.values(described).every((value) => typeof value === "string")
    )
      throw new Error("describe failed for every base cluster");
    const names = Object.fromEntries(
      Object.entries(described).filter(
        ([, value]) => typeof value !== "string",
      ),
    ) as Record<number, ClusterName>;
    const sameTop = Object.fromEntries(
      ids.map((id) => [
        id,
        (neighbours[id] ?? []).filter(
          (other) => tree.topOfBase[other] === tree.topOfBase[id],
        ),
      ]),
    );
    const merge = await mergeSimilar(names, examples, sameTop, {
      client: options.client,
      model: options.classifierModel,
      parallelism: options.parallelism,
      usage,
      signal: options.signal,
    });
    if (merge.nPairs && merge.nFailed === merge.nPairs)
      throw new Error(
        `merge failed for every one of ${merge.nPairs} cluster pair checks`,
      );
    if (merge.nFailed)
      result.warnings.push(
        `dimension ${dimension}: merge: ${merge.nFailed}/${merge.nPairs} pair checks failed; those clusters were left unmerged`,
      );
    const reps = { ...merge.representatives },
      byTop = new Map<number, number[]>();
    for (const id of ids) {
      const top = tree.topOfBase[id] ?? id,
        siblings = byTop.get(top) ?? [];
      siblings.push(id);
      byTop.set(top, siblings);
    }
    for (const siblings of byTop.values())
      if (
        siblings.length > 1 &&
        new Set(siblings.map((id) => reps[id] ?? id)).size === 1
      )
        for (const id of siblings) reps[id] = id;
    const merged = new Map<number, number[]>();
    for (const id of ids) {
      const rep = reps[id] ?? id,
        old = merged.get(rep) ?? [];
      old.push(id);
      merged.set(rep, old);
    }
    const mergedIds = [...merged.keys()].sort((a, b) => a - b),
      remapped = new Map<number, TraceInsight[]>(),
      mergedNames = new Map<number, ClusterName>(),
      topMap = new Map<number, number>(),
      children: Record<number, ClusterName[]> = {};
    for (const [rep, old] of merged) {
      remapped.set(
        rep,
        old.flatMap((id) => memberTraces[id] ?? []),
      );
      const known = old.flatMap((id) =>
        names[id] ? [names[id] as ClusterName] : [],
      );
      if (known[0]) mergedNames.set(rep, known[0]);
    }
    for (const id of ids) {
      const rep = reps[id] ?? id,
        top = tree.topOfBase[id] ?? id;
      topMap.set(rep, top);
      const name = mergedNames.get(rep);
      if (name) {
        const list = children[top] ?? [];
        list.push(name);
        children[top] = list;
      }
    }
    const descriptions = Object.keys(children).length
      ? await describeTopLevel(children, {
          client: options.client,
          model: options.summaryModel,
          parallelism: options.parallelism,
          usage,
          signal: options.signal,
        })
      : {};
    const topIds = [...new Set(topMap.values())].sort((a, b) => a - b),
      topGlobal = new Map<number, string>(),
      baseGlobal = new Map<number, string>(),
      groupSlug = group === null ? "" : `${group}-`;
    for (const id of topIds)
      topGlobal.set(id, `${dimension}-t${groupSlug}${nextTop++}`);
    for (const id of mergedIds)
      baseGlobal.set(id, `${dimension}-b${groupSlug}${nextBase++}`);
    for (const [rep, baseTraces] of remapped) {
      const top = topMap.get(rep) as number,
        name = mergedNames.get(rep) ?? {
          name: "Unlabeled cluster",
          description: "Cluster description unavailable.",
        },
        base = baseGlobal.get(rep) as string,
        parent = topGlobal.get(top) as string;
      result.clusters.push({
        id: base,
        parentId: parent,
        level: "base",
        name: name.name,
        description: name.description,
        size: baseTraces.length,
        traceIds: baseTraces.map((trace) => trace.traceId),
        exampleTraceIds: (merged.get(rep) ?? [])
          .flatMap((id) => exampleIds[id] ?? [])
          .slice(0, 5),
        group,
      });
      for (const trace of baseTraces)
        trace.assignments[dimension] = { top: parent, base };
    }
    for (const top of topIds) {
      const childTraces = [...topMap]
          .filter(([, value]) => value === top)
          .flatMap(([rep]) => remapped.get(rep) ?? []),
        value = descriptions[top],
        name =
          value && typeof value !== "string"
            ? value
            : {
                name: "Conversation group",
                description: "Related conversation clusters.",
              };
      result.clusters.push({
        id: topGlobal.get(top) as string,
        parentId: null,
        level: "top",
        name: name.name,
        description: name.description,
        size: childTraces.length,
        traceIds: childTraces.map((trace) => trace.traceId),
        exampleTraceIds: childTraces.slice(0, 5).map((trace) => trace.traceId),
        group,
      });
    }
    const coords = await reduce3d(vectors);
    if (coords)
      for (const [index, coord] of coords.entries())
        (rows[index] as { trace: TraceInsight }).trace.coords[dimension] = [
          coord[0] as number,
          coord[1] as number,
          coord[2] as number,
        ];
    else
      result.warnings.push(
        `dimension ${dimension} group ${group === null ? "None" : `'${group}'`}: UMAP unavailable for ${indices.length} traces`,
      );
  }
  const mapped = traces.filter(
    (trace) => trace.coords[dimension] !== undefined,
  );
  if (mapped.length) {
    const review = await project2d(
      mapped.map(
        (trace) => trace.coords[dimension] as [number, number, number],
      ),
    );
    if (review)
      for (const [index, coord] of review.entries()) {
        const trace = mapped[index] as TraceInsight;
        if (trace.coords2d)
          trace.coords2d[dimension] = [coord[0] as number, coord[1] as number];
      }
    else
      result.warnings.push(
        `dimension ${dimension}: 2D review layout unavailable for ${mapped.length} traces`,
      );
  }
  result.nFailed = failedCount();
  return result;
}

export function applyLabelOutcomes(
  traces: readonly TraceInsight[],
  outcomes: readonly LabelOutcome[],
  hasMatch: boolean,
): {
  traces: TraceInsight[];
  nMatched: number;
  nFailedMatch: number;
  warnings: string[];
  allFailed: boolean;
} {
  const byId = new Map(traces.map((trace) => [trace.traceId, trace]));
  const retained: TraceInsight[] = [],
    warnings: string[] = [];
  let nMatched = hasMatch ? 0 : outcomes.length,
    nFailedMatch = 0;
  for (const outcome of outcomes) {
    if (hasMatch && outcome.matched === false) continue;
    if (hasMatch && outcome.matched === true) nMatched++;
    if (hasMatch && outcome.matched === null) {
      nFailedMatch++;
      const message =
        outcome.error ?? "population match could not be determined";
      warnings.push(
        `Trace ${outcome.trace.traceId} was excluded because its population match could not be determined: ${message}`,
      );
      continue;
    }
    const previous = byId.get(outcome.trace.traceId);
    if (!previous)
      throw new Error(
        `missing trace ${outcome.trace.traceId} for label outcome`,
      );
    const labels = { ...previous.labels, ...outcome.answers },
      errors = { ...previous.errors };
    if (outcome.error) errors.label = outcome.error;
    else {
      const failed = Object.entries(outcome.answers)
        .filter(([, answer]) => answer.error !== null)
        .map(([name]) => name);
      if (failed.length)
        errors.label = `unreadable label answer(s): ${failed.join(", ")}`;
    }
    retained.push({ ...previous, labels, errors });
  }
  return {
    traces: retained,
    nMatched,
    nFailedMatch,
    warnings,
    allFailed:
      outcomes.length > 0 &&
      outcomes.every((outcome) => outcome.error !== null),
  };
}

export interface InsightsRunOptions {
  labels?: readonly (LabelSpec | string)[];
  dimensions?: readonly DimensionName[];
  maxClusters?: number;
  maxSubclusters?: number;
  outlierZscore?: number | null;
  summaryModel?: string;
  classifierModel?: string;
  compilerModel?: string;
  embeddingModel?: string;
  priorityDimension?: DimensionName;
  parallelism?: number;
  traceInputChars?: number;
  cache?: boolean;
  codingAnalysis?: boolean;
  codingLabels?: readonly string[] | null;
  signalsConfig?: SignalsConfig;
}
export async function prepareInsightsConfig(
  options: InsightsRunOptions = {},
): Promise<{
  config: InsightsConfig;
  finderClassifierModel: string;
  codingEnabled: boolean;
}> {
  const dimensions = options.dimensions ?? ["intent", "failure", "sentiment"],
    labels = resolveLabelSpecs(options.labels ?? [], dimensions);
  const codingByName = new Map(
    CODING_LABELS.slice(1).map((spec) => [spec.name, spec]),
  );
  let selected: LabelSpec[];
  if (options.codingAnalysis) selected = [...CODING_LABELS.slice(1)];
  else {
    const names = options.codingLabels ?? [];
    if (new Set(names).size !== names.length)
      throw new Error("Insights coding labels must have unique names");
    const unknown = names.filter((name) => !codingByName.has(name)).sort();
    if (unknown.length)
      throw new Error(
        `unknown Insights coding label(s): ${unknown.join(", ")}`,
      );
    selected = names.map((name) => codingByName.get(name) as LabelSpec);
  }
  const signals = options.signalsConfig ?? new SignalsConfig();
  const config = await InsightsConfig.create({
    labels,
    dimensions,
    codingLabels: selected,
    codingAnalysis: options.codingAnalysis ?? false,
    compilerModel:
      options.compilerModel ?? roleModel("fast", { task: "finder.compiler" }),
    signals: { ...signals, tagThresholds: signals.resolvedTagThresholds() },
    ...Object.fromEntries(
      Object.entries({
        maxClusters: options.maxClusters,
        maxSubclusters: options.maxSubclusters,
        outlierZscore: options.outlierZscore,
        summaryModel: options.summaryModel,
        classifierModel: options.classifierModel,
        embeddingModel: options.embeddingModel,
        priorityDimension: options.priorityDimension,
        parallelism: options.parallelism,
        traceInputChars: options.traceInputChars,
        cache: options.cache,
      }).filter(([, value]) => value !== undefined),
    ),
  });
  return {
    config,
    finderClassifierModel:
      options.classifierModel ??
      roleModel("classifier", { task: "finder.classifier" }),
    codingEnabled: Boolean(options.codingAnalysis || selected.length),
  };
}

export interface InsightsOptions extends InsightsRunOptions {
  runName?: string;
  runsDir?: string;
  runId?: string;
  llmClient?: OpenAI | null;
  orqClient?: Orq | null;
  onSaved?: (path: string) => void | Promise<void>;
  signal?: AbortSignal;
  finderExportSource?: string | null;
  finderExportSha256?: string | null;
  sourceName?: string | null;
  orqScope?: Readonly<Record<string, string | null>> | null;
}
export async function insights(
  population: InsightsPopulation,
  options: InsightsOptions = {},
): Promise<InsightsRunFields> {
  const { config, finderClassifierModel, codingEnabled } =
    await prepareInsightsConfig(options);
  const runId = options.runId ?? randomUUID(),
    now = new Date(),
    name =
      options.runName ??
      `insights-${now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`,
    directory = options.runsDir ?? getInsightsRunsDir();
  const allSpecs = [
    ...config.labels,
    ...(codingEnabled ? [CODING_LABELS[0] as LabelSpec] : []),
    ...config.codingLabels,
  ];
  const plan = stagePlan(population, allSpecs, config.dimensions, {
    priorityDimension: config.priorityDimension,
  });
  const writer = await startManifest({
    runId,
    surface: "insights",
    runName: name,
    runsDir: directory,
    plannedStages: plan.map(([stage]) => stage),
    stageLabels: Object.fromEntries(plan),
    parallelism: config.parallelism,
  });
  const run = {
    ...InsightsRunSchema.parse({
      runId,
      runName: name,
      createdAt: now.toISOString(),
      status: "completed",
      stageFailures: [],
      population: {},
      config,
      traces: [],
      dimensions: {},
      labels: {},
      priority: null,
      priorityReason: null,
      counts: {},
      warnings: [],
    }),
  };
  const cache = await RuntimeCache.open({ enabled: config.cache }),
    ledger = new RuntimeLedger();
  let llm = options.llmClient ?? null,
    orq = options.orqClient ?? null,
    saved = false,
    callbackAttempted = false;
  const ensureClient = async () => {
    if (llm === null)
      llm = (await resolveLlmClient(null, { maxRetries: 0 })).client;
    return llm;
  };
  const fail = (
    stage: string,
    error: unknown,
    dimension: string | null = null,
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    run.status = "error";
    run.stageFailures.push({ stage, message, dimension });
    return message;
  };
  try {
    options.signal?.throwIfAborted();
    if (population.query !== null) await ensureClient();
    if (!orq && population.snapshotPath === null)
      orq = await resolveOrqClient();
    await writer.startStage("population");
    const coverageSpecs = [
      ...config.labels,
      ...config.codingLabels.filter(
        (spec) => !["unfixed_error", "risky_action"].includes(spec.name),
      ),
    ];
    const resolved = await resolvePopulation(population, {
      orq,
      client: llm,
      compilerModel: config.compilerModel as string,
      classifierModel: finderClassifierModel,
      labelClassifierModel: config.classifierModel,
      traceInputChars: config.traceInputChars,
      classifierQuestions: Object.fromEntries(
        coverageSpecs.map((spec) => [spec.name, spec.toQuestion({})]),
      ),
      usage: ledger,
      signal: options.signal,
    });
    const signalsConfig = new SignalsConfig(config.signals ?? {});
    const documents = resolved.traces.map((trace) =>
      traceDocumentWithSignals(
        trace,
        computeSignals(trace.trajectory, { config: signalsConfig }),
      ),
    );
    run.population = {
      ...resolved.echo,
      nScanned: resolved.nScanned,
      nMatched: resolved.compiled?.length ? 0 : documents.length,
      nFailedMatch: 0,
    };
    if (
      options.finderExportSource != null &&
      population.finderExport !== null
    ) {
      run.population.finderExport = options.finderExportSource;
      if (options.finderExportSha256 != null)
        run.population.finderExportSha256 = options.finderExportSha256;
    }
    if (options.sourceName) run.population.sourceName = options.sourceName;
    if (options.orqScope != null && readsOrq(run.population))
      run.population.orqScope = { ...options.orqScope };
    const truncated = Number(resolved.echo.nProjectionTruncated ?? 0);
    if (truncated)
      run.warnings.push(
        `Input character cap: ${truncated} of ${documents.length} traces exceeded the model projection budget for summary or classifier input.`,
      );
    run.traces = documents.map((trace) => ({
      ...TraceInsightSchema.parse({
        traceId: trace.traceId,
        spanId: trace.spanId,
        timestamp: trace.timestamp,
        dataset: trace.metadata.dataset,
        outcome: trace.metadata.outcome,
        agentName: trace.agentName ?? "",
        project: trace.project ?? "",
        toolStats: toolStats(trace),
        signals: trace.metadata.signals,
        sourceCoverage: trace.sourceCoverage,
        coords2d: {},
      }),
    }));
    await writer.endStage("population");
    const missing = Number(resolved.echo.nMissingExportIds ?? 0);
    if (missing > 0)
      run.warnings.push(
        `${missing} of ${Number(resolved.echo.nMatchedIds ?? 0)} matched Finder traces could not be reloaded from Orq; ${run.traces.length} traces will be analyzed.`,
      );
    if (!run.traces.length) run.warnings.push("population is empty");
    else {
      const client = await ensureClient();
      await writer.startStage("label");
      const outcomes = await labelTraces(documents, {
        labels: config.labels,
        compiled: resolved.compiled,
        client,
        model: config.classifierModel,
        parallelism: config.parallelism,
        usage: ledger,
        onProgress: (done, total) => writer.stageProgress("label", done, total),
        coding: codingEnabled,
        codingLabels: config.codingLabels,
        traceInputChars: config.traceInputChars,
        signal: options.signal,
      });
      const applied = applyLabelOutcomes(
        run.traces,
        outcomes,
        Boolean(resolved.compiled?.length),
      );
      run.traces = applied.traces;
      run.population.nMatched = applied.nMatched;
      run.population.nFailedMatch = applied.nFailedMatch;
      run.warnings.push(...applied.warnings);
      const labelError =
        applied.allFailed &&
        Boolean(config.labels.length || resolved.compiled?.length)
          ? fail("label", "every label request failed")
          : null;
      await writer.endStage("label", { error: labelError });
      if (labelError && !resolved.compiled?.length) {
        const message = "skipped because every label request failed";
        for (const stage of [
          "summary",
          ...config.dimensions.map((value) => `dimension:${value}`),
        ]) {
          await writer.startStage(stage);
          await writer.endStage(stage, { error: message });
          run.warnings.push(`${stage} stage ${message}`);
        }
      } else if (run.traces.length) {
        await writer.startStage("summary");
        const ids = new Set(run.traces.map((trace) => trace.traceId));
        const summaries = await summarizeTraces(
          documents.filter((trace) => ids.has(trace.traceId)),
          {
            client,
            model: config.summaryModel,
            cache,
            parallelism: config.parallelism,
            usage: ledger,
            inputCharCap: config.traceInputChars,
            onProgress: (done, total) =>
              writer.stageProgress("summary", done, total),
            signal: options.signal,
          },
        );
        run.traces = run.traces.map((trace) => {
          const summary = summaries[trace.traceId];
          return typeof summary === "string"
            ? { ...trace, errors: { ...trace.errors, summary } }
            : summary
              ? { ...trace, summary }
              : trace;
        });
        const summaryErrors = Object.values(summaries).filter(
          (value): value is string => typeof value === "string",
        );
        const summaryError =
          summaryErrors.length &&
          summaryErrors.length === Object.keys(summaries).length
            ? fail(
                "summary",
                `every summary request failed: ${summaryErrors[0]}`,
              )
            : null;
        await writer.endStage("summary", { error: summaryError });
        if (!summaryError)
          for (const dimension of config.dimensions) {
            const stage = `dimension:${dimension}`;
            await writer.startStage(stage);
            try {
              const value = await buildDimension(dimension, run.traces, {
                client,
                cache,
                embeddingModel: config.embeddingModel,
                summaryModel: config.summaryModel,
                classifierModel: config.classifierModel,
                maxClusters: config.maxClusters,
                maxSubclusters: config.maxSubclusters,
                outlierZscore: config.outlierZscore,
                parallelism: config.parallelism,
                usage: ledger,
                signal: options.signal,
              });
              run.dimensions[dimension] = value;
              run.warnings.push(...value.warnings);
              await writer.endStage(stage);
            } catch (error) {
              options.signal?.throwIfAborted();
              discardDimension(run.traces, dimension);
              const message = fail(stage, error, dimension);
              await writer.endStage(stage, { error: message });
            }
          }
      } else run.warnings.push("population is empty");
    }
    run.labels = aggregateLabelResults(run.traces, allSpecs);
    run.counts = {
      nTraces: run.traces.length,
      nFailedTraces: run.traces.filter(
        (trace) => Object.keys(trace.errors).length > 0,
      ).length,
      perStageFailed: run.traces.reduce(
        (count, trace) => count + Object.keys(trace.errors).length,
        0,
      ),
    };
    await writer.startStage("priority");
    const dimension = run.dimensions[config.priorityDimension],
      satisfaction = config.labels.find(
        (spec) => spec.name === "customer_satisfaction",
      );
    if (dimension && satisfaction)
      [run.priority, run.priorityReason] = priorityPoints(
        run.traces,
        dimension,
        { satisfactionSpec: satisfaction },
      );
    else
      run.priorityReason = !dimension
        ? `priority dimension '${config.priorityDimension}' is unavailable`
        : "customer_satisfaction label was not requested";
    await writer.endStage("priority");
  } catch (error) {
    if (options.signal?.aborted) {
      await writer.cancel();
      throw error;
    }
    fail(writer.manifest.stage ?? "setup", error);
  } finally {
    try {
      cache.close();
    } catch (error) {
      console.warn(`Could not close Insights cache: ${String(error)}`);
    }
    if (!saved) {
      try {
        await writer.startStage("write");
        run.costByStage = ledger.totals();
        run.stageHistory = stageHistoryForSave(writer.manifest, {
          failedStage:
            run.status === "error"
              ? (run.stageFailures.at(-1)?.stage ?? null)
              : null,
        });
        const path = await saveRun(InsightsRunSchema.parse(run), directory);
        saved = true;
        if (options.onSaved && !callbackAttempted) {
          callbackAttempted = true;
          await options.onSaved(path);
        }
        await writer.endStage("write");
        if (run.status === "error")
          await writer.fail(
            run.stageFailures.at(-1)?.message ?? "Insights failed",
            run.stageFailures.at(-1)?.stage,
          );
        else await writer.complete(path);
      } catch (error) {
        const message = fail("write", error);
        if (saved) {
          try {
            run.stageHistory = stageHistoryForSave(writer.manifest, {
              failedStage: "write",
            });
            await saveRun(InsightsRunSchema.parse(run), directory);
          } catch (persistError) {
            console.warn(
              `Could not persist failed Insights run: ${String(persistError)}`,
            );
          }
        }
        await writer.fail(message, "write");
      }
    }
  }
  return InsightsRunSchema.parse(run);
}
