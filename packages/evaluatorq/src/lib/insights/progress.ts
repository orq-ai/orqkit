import { isDeepStrictEqual } from "node:util";

import {
  ManifestStatus,
  ManifestSurface,
  type RunManifest,
  RunManifestSchema,
  type StageRecord,
} from "../contracts.js";
import {
  FacetSelection,
  NumericFilters,
  timeMicros,
} from "../trace-finder/models.js";
import type {
  DimensionName,
  InsightsPopulation,
  InsightsRunFields,
  InsightsStageHistory,
  LabelSpec,
} from "./models.js";

const halting = new Set(["population", "label", "summary"]);
function selectionLabels(
  mode: unknown,
  hasFilters: boolean,
  hasLabels: boolean,
): [string | null, string] {
  const source =
    mode === "snapshot"
      ? "Load local traces"
      : mode === "export"
        ? "Load Finder matches"
        : mode === "query"
          ? "Find matching traces"
          : mode === "filter"
            ? hasFilters
              ? "Filter recent traces"
              : "Load recent traces"
            : null;
  const classify =
    mode === "query"
      ? hasLabels
        ? "Match and classify traces"
        : "Match traces"
      : hasLabels
        ? "Classify traces"
        : hasFilters
          ? "Keep selected traces"
          : "Prepare traces";
  return [source, classify];
}
export function stagePlan(
  population: InsightsPopulation,
  labels: readonly LabelSpec[],
  dimensions: readonly DimensionName[],
  options: { priorityDimension?: DimensionName } = {},
): [string, string][] {
  const hasLabels = Boolean(labels.length) || dimensions.includes("sentiment");
  const hasFilters =
    !isDeepStrictEqual(population.facets, new FacetSelection()) ||
    !isDeepStrictEqual(population.numeric, new NumericFilters()) ||
    population.start !== null ||
    population.end !== null ||
    population.windowDays !== 7 ||
    population.limit !== 500;
  const mode =
    population.snapshotPath !== null
      ? "snapshot"
      : population.finderExport !== null
        ? "export"
        : population.query !== null
          ? "query"
          : "filter";
  const [source, classify] = selectionLabels(mode, hasFilters, hasLabels);
  if (source === null)
    throw new Error(`Unknown Insights population mode: ${mode}`);
  const ready =
    dimensions.includes(options.priorityDimension ?? "intent") &&
    labels.some((spec) => spec.name === "customer_satisfaction");
  return [
    ["population", source],
    ["label", classify],
    ["summary", "Summarize traces"],
    ...dimensions.map(
      (name) =>
        [`dimension:${name}`, `Cluster and map ${name}`] as [string, string],
    ),
    ["priority", ready ? "Build priority matrix" : "Check priority matrix"],
    ["write", "Save run"],
  ];
}
export function stageHistoryForSave(
  manifest: RunManifest,
  options: { failedStage: string | null; now?: Date },
): InsightsStageHistory {
  const now = options.now ?? new Date();
  return {
    plannedStages: [...manifest.plannedStages],
    stageLabels: { ...manifest.stageLabels },
    stages: manifest.stages.map((stage) =>
      stage.endedAt !== null
        ? structuredClone(stage)
        : {
            ...structuredClone(stage),
            status:
              options.failedStage !== null &&
              (stage.name !== "write" || options.failedStage === "write")
                ? ManifestStatus.ERROR
                : ManifestStatus.COMPLETED,
            endedAt: now,
          },
    ),
  };
}
function rebuiltLabels(run: InsightsRunFields): Record<string, string> {
  const config = run.config,
    dimensions = config.dimensions,
    hasLabels =
      Boolean(
        config.labels.length ||
          config.codingLabels.length ||
          config.codingAnalysis,
      ) || dimensions.includes("sentiment"),
    population = run.population;
  const facets = new FacetSelection(population.facets || {}),
    numeric = new NumericFilters(population.numeric || {});
  let hasFilters =
    !isDeepStrictEqual(facets, new FacetSelection()) ||
    !isDeepStrictEqual(numeric, new NumericFilters()) ||
    (population.window_days ?? 7) !== 7 ||
    (population.limit ?? 500) !== 500;
  if (
    typeof population.start === "string" &&
    typeof population.end === "string"
  )
    hasFilters ||=
      timeMicros(population.end) - timeMicros(population.start) !==
      604800000000n;
  const [source, classify] = selectionLabels(
      population.mode,
      hasFilters,
      hasLabels,
    ),
    ready =
      dimensions.includes(config.priorityDimension) &&
      config.labels.some((spec) => spec.name === "customer_satisfaction");
  return Object.fromEntries([
    ...(source === null ? [] : [["population", source]]),
    ["label", classify],
    ["summary", "Summarize traces"],
    ...dimensions.map((name) => [
      `dimension:${name}`,
      `Cluster and map ${name}`,
    ]),
    ["priority", ready ? "Build priority matrix" : "Check priority matrix"],
    ["write", "Save run"],
  ]);
}
export function runManifestFor(run: InsightsRunFields): RunManifest {
  const failed = run.status === "error",
    history = run.stageHistory,
    failures = new Map(run.stageFailures.map((f) => [f.stage, f]));
  let planned: string[], labels: Record<string, string>, stages: StageRecord[];
  if (history) {
    planned = [...history.plannedStages];
    labels = { ...history.stageLabels };
    stages = structuredClone(history.stages);
  } else {
    planned = [
      "population",
      "label",
      "summary",
      ...run.config.dimensions.map((d) => `dimension:${d}`),
      "priority",
      "write",
    ];
    const all = rebuiltLabels(run);
    labels = Object.fromEntries(
      planned.flatMap((name) =>
        Object.hasOwn(all, name) ? [[name, all[name]]] : [],
      ),
    );
    const halts = planned.flatMap((name, index) =>
        failures.has(name) && halting.has(name) ? [index] : [],
      ),
      first = failures.has("setup")
        ? -1
        : halts.length
          ? Math.min(...halts)
          : null;
    stages = [];
    for (const [index, name] of planned.entries()) {
      let status: "error" | "completed";
      if (failures.has(name)) status = ManifestStatus.ERROR;
      else if (
        !run.traces.length &&
        (name === "summary" ||
          name.startsWith("dimension:") ||
          (name === "label" &&
            !(
              run.population.mode === "query" &&
              Number(run.population.n_scanned ?? 0) > 0
            )))
      )
        continue;
      else if (
        name === "write" ||
        (name === "priority" && first !== -1 && first !== 0) ||
        first === null ||
        index < first
      )
        status = ManifestStatus.COMPLETED;
      else continue;
      stages.push({
        name,
        target: null,
        status,
        startedAt: new Date(run.createdAt),
        endedAt: null,
        completed: null,
        total: null,
      });
    }
  }
  const failure = failed ? run.stageFailures.at(-1) : undefined,
    createdAt = new Date(run.createdAt);
  return RunManifestSchema.parse({
    runId: run.runId,
    surface: ManifestSurface.INSIGHTS,
    runName: run.runName,
    status: failed ? ManifestStatus.ERROR : ManifestStatus.COMPLETED,
    stage: failure?.stage ?? "write",
    stages,
    plannedStages: planned,
    stageLabels: labels,
    startedAt: createdAt,
    updatedAt: createdAt,
    endedAt: createdAt,
    error: failure?.message ?? null,
  });
}
