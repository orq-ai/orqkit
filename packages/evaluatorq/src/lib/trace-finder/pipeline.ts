import type OpenAI from "openai";

import type { Orq } from "@orq-ai/node";

import { roleModel } from "../common/model-roles.js";
import { runClassifier } from "./classifier.js";
import { ExplorerStore } from "./explorer.js";
import { PopulationRequest, timeMicros } from "./models.js";
import { OrqTraceSource } from "./orq-source.js";
import { planQuery } from "./planner.js";
import { projectTrace } from "./projection.js";
import { fromMicroseconds } from "./rows.js";
import { RunStore } from "./run-store.js";
import type { DashboardSettings } from "./settings.js";

export function buildRunStore(
  settings: DashboardSettings,
  options: { client: OpenAI; orq: Orq; cleanup?: () => void | Promise<void> },
): RunStore {
  const source = new OrqTraceSource(options.orq);
  const explorer = new ExplorerStore({
    search: (params) => source.search(params),
    hydrate: (rows) => source.hydrateRows(rows),
    loadSpans: (id) => source.listSpans(id),
    loadFirstErrorMessage: (id, spans) => source.firstErrorMessage(id, spans),
  });
  const classifierModel = roleModel("classifier", {
      task: "finder.classifier",
    }),
    compilerModel = roleModel("fast", { task: "finder.compiler" }),
    fastFilterModel = roleModel("fast", { task: "finder.filters" });
  const window = (population: PopulationRequest) => {
    const end = population.end ?? new Date().toISOString();
    const start =
      population.start ??
      fromMicroseconds(
        timeMicros(end) - BigInt(settings.windowDays) * 86400_000_000n,
      );
    if (start === null)
      throw new RangeError("Trace finder time window is out of range");
    return { start, end };
  };
  return new RunStore({
    planner: (query, population, { withinResults, signal }) =>
      planQuery(
        query,
        new PopulationRequest({ ...population, ...window(population) }),
        {
          client: options.client,
          orq: options.orq,
          compilerModel,
          filterSelection: settings.filterSelection,
          classifierModel,
          fastFilterModel,
          withinResults,
          signal,
        },
      ),
    populationLoader: (request, signal) =>
      source.loadAsync({
        ...window(request),
        limit: request.limit,
        facets: request.facets,
        numeric: request.numeric,
        signal,
      }),
    runClassifier: (
      traces,
      projections,
      dimensions,
      { parallelism, onComplete, questionPayloads, signal },
    ) =>
      runClassifier(traces, projections, dimensions, {
        model: classifierModel,
        client: options.client,
        traceInputChars: settings.traceInputChars,
        parallelism,
        onComplete,
        questionPayloads,
        signal,
      }),
    projectTrace: (trace, { questionPayloads }) =>
      projectTrace(trace, {
        model: classifierModel,
        traceInputChars: settings.traceInputChars,
        questionPayloads,
      }),
    close: async () => {
      try {
        source.close();
      } finally {
        await options.cleanup?.();
      }
    },
    explorer,
    classifierModel,
  });
}
