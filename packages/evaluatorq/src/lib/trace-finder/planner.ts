import { isDeepStrictEqual } from "node:util";

import type OpenAI from "openai";

import type { Orq } from "@orq-ai/node";

import type { ClassifyResponse } from "../common/judge.js";
import {
  checkRunActive,
  runAbortSignal,
  withRunLifecycle,
} from "../common/run-lifecycle.js";
import { pythonCasefold, pythonStrip } from "../common/sanitize.js";
import type { Usage } from "../contracts.js";
import { parseIso } from "../formats/time.js";
import { pythonRegexEngine } from "../signals/python-regex.js";
import {
  canonicalGeneratedEnd,
  compileQuery,
  normalizeGeneratedTime,
  TimeFilters,
} from "./compiler.js";
import {
  type CachedFacetLoadOptions,
  facetCatalogueCacheHit,
  loadFacetCatalogueCached,
} from "./facets.js";
import {
  FilterSelectionResult,
  selectFiltersWithResponse,
  selectLlmFiltersWithResponse,
} from "./filter-selector.js";
import {
  type CompiledQuery,
  FACET_NAMES,
  type FacetCatalogue,
  FacetCatalogueSchema,
  type FacetName,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  timeMicros,
} from "./models.js";
import { OrqTraceSource } from "./orq-source.js";
import { fromMicroseconds } from "./rows.js";

type TimeWindow = readonly [string, string];
export type LiteralCandidate = readonly [FacetName, string];
const nativeFacet = (name: FacetName) =>
  name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()) as Exclude<
    keyof FacetSelection,
    "projectId"
  >;
const catalogueValues = (catalogue: FacetCatalogue, name: FacetName) =>
  catalogue[nativeFacet(name)] as readonly string[];
export function mergeFacets(
  explicit: FacetSelection,
  generated: FacetSelection,
): FacetSelection {
  return new FacetSelection({
    ...Object.fromEntries(
      FACET_NAMES.map((name) => {
        const key = nativeFacet(name);
        return [name, explicit[key].size ? explicit[key] : generated[key]];
      }),
    ),
    project_id: explicit.projectId || generated.projectId,
  });
}
export function mergeNumeric(
  explicit: NumericFilters,
  generated: NumericFilters,
): NumericFilters {
  return new NumericFilters(
    Object.fromEntries(
      (
        ["tokensMin", "tokensMax", "durationMsMin", "durationMsMax"] as const
      ).map((name) => [name, explicit[name] ?? generated[name]]),
    ),
  );
}
export function later(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return timeMicros(left) >= timeMicros(right) ? left : right;
}
export function earlier(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return timeMicros(left) <= timeMicros(right) ? left : right;
}
export function effectiveTimeScope(
  population: PopulationRequest,
  generatedTime: TimeWindow | null,
  options: { withinResults: boolean; forceEmpty?: boolean },
): readonly [
  string | null,
  string | null,
  "within_results" | "explicit" | "default",
  string,
  boolean,
] {
  let empty = Boolean(
    options.forceEmpty ||
      (generatedTime &&
        timeMicros(generatedTime[0]) >= timeMicros(generatedTime[1])),
  );
  if (options.withinResults || population.timeOrigin === "within_results") {
    let start = later(population.start, generatedTime?.[0] ?? null),
      end = earlier(population.end, generatedTime?.[1] ?? null);
    empty =
      empty ||
      (start !== null && end !== null && timeMicros(start) > timeMicros(end));
    if (empty) {
      start = population.start;
      end = population.end;
    }
    return [start, end, "within_results", "within-results", empty];
  }
  if (population.timeOrigin === "explicit")
    return [
      population.start,
      population.end,
      "explicit",
      population.start !== null || population.end !== null
        ? "explicit"
        : "default",
      empty,
    ];
  if (generatedTime && !empty)
    return [generatedTime[0], generatedTime[1], "explicit", "query", false];
  if (empty)
    return [population.start, population.end, "default", "query", true];
  return [population.start, population.end, "default", "default", false];
}
export function selectorQuery(
  query: string,
  candidates: readonly LiteralCandidate[],
  catalogue: FacetCatalogue,
): string {
  const available = new Set(catalogue.model),
    annotations = candidates
      .filter(
        ([name, value]) =>
          name === "model" && available.has(value) && !query.includes(value),
      )
      .map(([, value]) => value);
  return annotations.length
    ? `${query}\nExplicit model value: ${annotations.join(", ")}`
    : query;
}
export function candidateWindow(
  population: PopulationRequest,
  generatedTime: TimeWindow | null,
  options: {
    withinResults: boolean;
    fallbackStart: string;
    fallbackEnd: string;
  },
): TimeWindow {
  const start = population.start ?? options.fallbackStart,
    end = population.end ?? options.fallbackEnd;
  if (generatedTime === null) return [start, end];
  if (options.withinResults || population.timeOrigin === "within_results")
    return [
      later(start, generatedTime[0]) as string,
      earlier(end, generatedTime[1]) as string,
    ];
  if (population.timeOrigin === "explicit") return [start, end];
  return generatedTime;
}
export function literalCandidates(
  query: string,
  catalogue: FacetCatalogue,
): readonly LiteralCandidate[] {
  const result: LiteralCandidate[] = [],
    patterns: readonly (readonly [FacetName, string])[] = [
      [
        "model",
        String.raw`\b(?:model\s+([A-Za-z0-9_.:/-]+)|([A-Za-z0-9_.-]+/[A-Za-z0-9_.:/-]+))\b`,
      ],
      ["provider", String.raw`\bprovider\s+([A-Za-z0-9_.-]+)\b`],
      [
        "agent_name",
        String.raw`\bagent\s+([A-Za-z0-9_. -]+?)(?=\s+(?:with|on|from|and|where)\b|["“]|[,.;]|$)`,
      ],
      [
        "tool_name",
        String.raw`\btool\s+([A-Za-z0-9_. -]+?)(?=\s+(?:with|on|from|and|where)\b|["“]|[,.;]|$)`,
      ],
      [
        "project",
        String.raw`\bproject\s+([A-Za-z0-9_. -]+?)(?=\s+(?:with|on|from|and|where)\b|["“]|[,.;]|$)`,
      ],
    ];
  const contains = (name: FacetName, value: string) =>
    result.some(
      ([candidateName, candidate]) =>
        candidateName === name && candidate === value,
    );
  for (const [name, pattern] of patterns) {
    const expression = pythonRegexEngine(`(?i)${pattern}`);
    for (const match of query.matchAll(
      new RegExp(expression.source, `${expression.flags}g`),
    )) {
      const value = pythonStrip(
          match.slice(1).find((group) => group !== undefined) ?? "",
        ),
        values = catalogueValues(catalogue, name);
      let exact = values.find(
        (available) => pythonCasefold(available) === pythonCasefold(value),
      );
      if (name === "model" && exact === undefined && value.includes("/")) {
        const suffix = pythonCasefold(value.split("/").at(-1) as string),
          matches = values.filter((available) =>
            pythonCasefold(available).endsWith(`/${suffix}`),
          );
        exact = matches.reduce<string | undefined>(
          (longest, item) =>
            longest === undefined ||
            Array.from(item).length > Array.from(longest).length
              ? item
              : longest,
          undefined,
        );
      }
      const candidate = exact || value;
      if (candidate && !contains(name, candidate))
        result.push([name, candidate]);
    }
  }
  for (const match of query.matchAll(/["“]([^"”]{1,100})["”]/gu)) {
    const candidate = pythonStrip(match[1] as string);
    if (candidate)
      for (const name of FACET_NAMES) {
        if (!contains(name, candidate)) result.push([name, candidate]);
        if (result.length >= 8) break;
      }
    if (result.length >= 8) break;
  }
  return Object.freeze(
    result.slice(0, 8).map((candidate) => Object.freeze(candidate)),
  );
}

export interface PlanningResult {
  readonly dimensions: readonly CompiledQuery[];
  readonly generatedFacets: FacetSelection;
  readonly generatedNumeric: NumericFilters;
  readonly generatedTime: TimeWindow | null;
  readonly effectivePopulation: PopulationRequest;
  readonly selectorResponse: ClassifyResponse | null;
  readonly selectorError: string | null;
  readonly provenance: Readonly<Record<string, string>>;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly unsupportedReason: string | null;
  readonly emptyMatch: boolean;
  readonly modelCalls: readonly (Usage | null)[];
}
export type CandidateConfirmer = (
  client: Orq,
  name: FacetName,
  value: string,
  start: string,
  end: string,
  options?: { signal?: AbortSignal },
) => Promise<boolean>;
export interface PlanningOptions {
  client: OpenAI;
  orq: Orq;
  compilerModel: string;
  filterSelection?: "llm" | "llm+jev";
  classifierModel: string;
  fastFilterModel: string;
  withinResults?: boolean;
  now?: string | Date;
  catalogueLoader?: CachedFacetLoadOptions["loader"];
  candidateConfirmer?: CandidateConfirmer | null;
  signal?: AbortSignal;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function rethrowCancellation(error: unknown): void {
  checkRunActive();
  if (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  )
    throw error;
}
const emptyCatalogue = () => FacetCatalogueSchema.parse({});
const usageFields = (usage: Usage): Record<string, unknown> => ({
  ...Object.fromEntries(
    Object.entries(usage)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [
        key
          .replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
          .replace(/([a-z])(\d)/g, "$1_$2"),
        value,
      ]),
  ),
  prompt_tokens: usage.inputTokens,
  completion_tokens: usage.outputTokens,
  cost_usd: usage.totalCost,
});
function shiftDays(value: string, days: number): string {
  const shifted = fromMicroseconds(
    timeMicros(value) + BigInt(days) * 86400000000n,
  );
  if (shifted === null)
    throw new RangeError("datetime is outside years 1 to 9999");
  return shifted;
}
const sameTime = (a: string, b: string) => timeMicros(a) === timeMicros(b);
const sameWindow = (a: TimeWindow | null, b: TimeWindow | null) =>
  a === null || b === null
    ? a === b
    : sameTime(a[0], b[0]) && sameTime(a[1], b[1]);
export async function offerConfirmedCandidates(
  orq: Orq,
  catalogue: FacetCatalogue,
  candidates: readonly LiteralCandidate[],
  options: {
    start: string;
    end: string;
    facets?: FacetSelection;
    numeric?: NumericFilters;
    confirmer?: CandidateConfirmer | null;
  },
): Promise<FacetCatalogue> {
  if (timeMicros(options.start) > timeMicros(options.end)) return catalogue;
  const facets = options.facets ?? new FacetSelection(),
    numeric = options.numeric ?? new NumericFilters(),
    offered = Object.fromEntries(
      FACET_NAMES.map((name) => [name, [...catalogueValues(catalogue, name)]]),
    ) as Record<FacetName, string[]>,
    pending = candidates.filter(
      ([name, value]) => !offered[name].includes(value),
    ),
    confirmed = Object.fromEntries(
      FACET_NAMES.map((name) => [name, [] as string[]]),
    ) as Record<FacetName, string[]>,
    source = options.confirmer ? null : new OrqTraceSource(orq);
  try {
    for (const [name, value] of pending) {
      checkRunActive();
      let found: boolean;
      try {
        if (options.confirmer)
          found = await options.confirmer(
            orq,
            name,
            value,
            options.start,
            options.end,
            { signal: runAbortSignal() },
          );
        else if (source)
          found =
            (
              await source.search({
                start: options.start,
                end: options.end,
                limit: 1,
                facets: mergeFacets(
                  facets,
                  new FacetSelection({ [name]: new Set([value]) }),
                ),
                numeric,
                signal: runAbortSignal(),
              })
            ).length > 0;
        else
          throw new Error("candidate confirmation source was not initialized");
        checkRunActive();
      } catch (error) {
        rethrowCancellation(error);
        console.warn(
          `Could not confirm explicitly named ${name} facet value ${value}: ${errorText(error)}`,
        );
        continue;
      }
      if (found) confirmed[name].push(value);
      else
        console.error(
          `Ignoring unconfirmed explicitly named ${name} facet value ${value}`,
        );
    }
  } finally {
    source?.close();
  }
  return FacetCatalogueSchema.parse({
    ...catalogue,
    ...Object.fromEntries(
      FACET_NAMES.map((name) => [
        nativeFacet(name),
        [...offered[name], ...confirmed[name]],
      ]),
    ),
  });
}
export function selectionWithCandidate(
  selected: FilterSelectionResult,
  name: FacetName,
  value: string,
): FilterSelectionResult {
  const fields = Object.fromEntries(
    FACET_NAMES.map((facet) => [facet, selected.selection[nativeFacet(facet)]]),
  );
  fields[name] = new Set([...(fields[name] as ReadonlySet<string>), value]);
  return new FilterSelectionResult(new FacetSelection(fields), {
    response: selected.response,
    error: selected.error,
    numeric: selected.numeric,
    time: selected.time,
    usage: selected.usage,
  });
}
async function selectFromCatalogue(
  query: string,
  catalogue: FacetCatalogue,
  options: PlanningOptions,
  anchor: string,
): Promise<FilterSelectionResult> {
  const scoped = selectorQuery(
    query,
    literalCandidates(query, catalogue),
    catalogue,
  );
  return options.filterSelection === "llm"
    ? selectLlmFiltersWithResponse(
        options.client,
        options.fastFilterModel,
        catalogue,
        scoped,
        { now: anchor },
      )
    : selectFiltersWithResponse(
        options.client,
        options.classifierModel,
        catalogue,
        scoped,
      );
}
async function selectRecorded(
  modelCalls: (Usage | null)[],
  query: string,
  catalogue: FacetCatalogue,
  options: PlanningOptions,
  anchor: string,
): Promise<FilterSelectionResult> {
  let selected: FilterSelectionResult;
  try {
    selected = await selectFromCatalogue(query, catalogue, options, anchor);
  } catch (error) {
    rethrowCancellation(error);
    modelCalls.push(null);
    throw error;
  }
  if (options.filterSelection === "llm" || selected.response !== null)
    modelCalls.push(selected.usage);
  return selected;
}
async function resolveFinalSelection(
  query: string,
  population: PopulationRequest,
  catalogue: FacetCatalogue,
  selected: FilterSelectionResult,
  timeFilter: TimeFilters | null,
  initial: TimeWindow,
  options: PlanningOptions,
  anchor: string,
  selectorEvents: Record<string, unknown>[],
  modelCalls: (Usage | null)[],
  loader: (start: string, end: string) => Promise<FacetCatalogue>,
): Promise<
  readonly [
    FacetCatalogue,
    FilterSelectionResult,
    TimeFilters | null,
    TimeWindow | null,
    boolean,
  ]
> {
  const isLlm = options.filterSelection === "llm",
    normalize = (time: TimeFilters | null) =>
      normalizeGeneratedTime(time, {
        population,
        withinResults: options.withinResults ?? false,
        reference: anchor,
        selectorOutput: isLlm,
      }),
    generated = normalize(isLlm ? selected.time : timeFilter);
  if (generated && timeMicros(generated[0]) >= timeMicros(generated[1]))
    return [
      emptyCatalogue(),
      new FilterSelectionResult(new FacetSelection(), {
        error: "generated time window has no retained overlap",
      }),
      timeFilter,
      generated,
      false,
    ];
  const reselect =
    isLlm &&
    generated !== null &&
    population.timeOrigin === "default" &&
    !options.withinResults &&
    !sameWindow(generated, initial);
  if (!reselect) return [catalogue, selected, timeFilter, generated, true];
  try {
    if (generated === null)
      return [
        emptyCatalogue(),
        new FilterSelectionResult(new FacetSelection(), {
          error: "selector time disappeared before catalogue reload",
        }),
        null,
        null,
        false,
      ];
    catalogue = await loader(...generated);
    selected = await selectRecorded(
      modelCalls,
      query,
      catalogue,
      { ...options, filterSelection: "llm" },
      anchor,
    );
    if (selected.usage !== null)
      selectorEvents.push(usageFields(selected.usage));
    const second = normalize(selected.time);
    if (!sameWindow(second, generated))
      return [
        emptyCatalogue(),
        new FilterSelectionResult(new FacetSelection(), {
          error: "selector changed its time window after catalogue reselection",
        }),
        null,
        null,
        false,
      ];
    return [catalogue, selected, selected.time, second, true];
  } catch (error) {
    rethrowCancellation(error);
    console.warn(
      `Trace filter catalogue reselection failed: ${errorText(error)}`,
    );
    return [
      emptyCatalogue(),
      new FilterSelectionResult(new FacetSelection(), {
        error: `catalogue reselection failed: ${errorText(error)}`,
      }),
      null,
      null,
      false,
    ];
  }
}
export function aggregateSelectorUsage(
  events: readonly Record<string, unknown>[],
  selected: FilterSelectionResult,
): Record<string, unknown> {
  const usage: Record<string, unknown> = {};
  for (const event of events)
    for (const [key, value] of Object.entries(event)) {
      if (typeof value === "number") {
        const previous = Object.hasOwn(usage, key) ? usage[key] : 0;
        if (typeof previous !== "number" && typeof previous !== "boolean")
          throw new TypeError("selector usage values cannot be added");
        usage[key] = Number(previous) + value;
      } else usage[key] = value;
    }
  if (events.length) return usage;
  return selected.usage === null ? usage : usageFields(selected.usage);
}
export async function confirmLiteralCandidates(
  orq: Orq,
  selected: FilterSelectionResult,
  catalogue: FacetCatalogue,
  candidates: readonly LiteralCandidate[],
  options: {
    start: string;
    end: string;
    facets: FacetSelection;
    numeric: NumericFilters;
    confirmer?: CandidateConfirmer | null;
  },
): Promise<FilterSelectionResult> {
  const confirmed = await offerConfirmedCandidates(
    orq,
    catalogue,
    candidates,
    options,
  );
  for (const [name, value] of candidates)
    if (
      !catalogueValues(catalogue, name).includes(value) &&
      catalogueValues(confirmed, name).includes(value)
    )
      selected = selectionWithCandidate(selected, name, value);
  return selected;
}
export function planQuery(
  query: string,
  population: PopulationRequest,
  options: PlanningOptions,
): Promise<PlanningResult> {
  return withRunLifecycle(
    undefined,
    () => planQueryCore(query, population, options),
    options.signal,
  );
}
async function planQueryCore(
  query: string,
  population: PopulationRequest,
  options: PlanningOptions,
): Promise<PlanningResult> {
  const anchor = new TimeFilters({ start: options.now ?? new Date() })
      .start as string,
    mode = options.filterSelection ?? "llm+jev",
    scoped = { ...options, filterSelection: mode },
    compiled = await compileQuery(
      options.client,
      options.compilerModel,
      query,
      { now: anchor },
    ),
    defaultWindow = population.timeOrigin === "default",
    defaultEnd = population.end ?? anchor,
    defaults: TimeWindow = [
      population.start ?? shiftDays(defaultEnd, -30),
      defaultEnd,
    ],
    cacheEvents: Record<string, unknown>[] = [],
    selectorEvents: Record<string, unknown>[] = [],
    modelCalls = [...compiled.usages];
  let initialStart = defaults[0],
    initialEnd = defaults[1],
    catalogue = emptyCatalogue();
  const loadCatalogue = async (
    start: string,
    end: string,
  ): Promise<FacetCatalogue> => {
    checkRunActive();
    const rolling = defaultWindow && sameWindow([start, end], defaults),
      started = performance.now(),
      hit = options.catalogueLoader
        ? false
        : await facetCatalogueCacheHit(options.orq, {
            start,
            end,
            limit: 50,
            defaultWindow: rolling,
          });
    try {
      return await loadFacetCatalogueCached(options.orq, {
        start,
        end,
        limit: 50,
        defaultWindow: rolling,
        now: new Date(anchor),
        loader: options.catalogueLoader,
        signal: runAbortSignal(),
      });
    } finally {
      cacheEvents.push({
        start: start.replace(/Z$/, "+00:00"),
        end: end.replace(/Z$/, "+00:00"),
        hit,
        elapsed_seconds: (performance.now() - started) / 1000,
        source: options.catalogueLoader ? "injected" : "production",
      });
    }
  };
  let timeFilter = mode === "llm+jev" ? compiled.time : null;
  if (mode === "llm+jev") {
    const initialTime = normalizeGeneratedTime(compiled.time, {
      population,
      withinResults: options.withinResults ?? false,
      reference: anchor,
    });
    if (
      initialTime &&
      !(options.withinResults || population.timeOrigin === "within_results")
    )
      [initialStart, initialEnd] = initialTime;
  }
  let initialError: string | null = null;
  try {
    catalogue =
      timeMicros(initialStart) < timeMicros(initialEnd)
        ? await loadCatalogue(initialStart, initialEnd)
        : emptyCatalogue();
  } catch (error) {
    rethrowCancellation(error);
    console.warn(`Trace filter catalogue load failed: ${errorText(error)}`);
    catalogue = emptyCatalogue();
    initialError = errorText(error);
  }
  let selected: FilterSelectionResult;
  try {
    if (initialError !== null) throw new Error(initialError);
    selected = await selectRecorded(
      modelCalls,
      query,
      catalogue,
      scoped,
      anchor,
    );
    const value = selected.usage ?? selected.response?.usage;
    if (value !== null && value !== undefined)
      selectorEvents.push(
        selected.usage !== null
          ? usageFields(selected.usage)
          : { ...selected.response?.usage },
      );
    if (mode === "llm") timeFilter = selected.time;
  } catch (error) {
    rethrowCancellation(error);
    selected = new FilterSelectionResult(new FacetSelection(), {
      error: errorText(error),
    });
    timeFilter = mode === "llm+jev" ? compiled.time : null;
  }
  let effectiveTime: TimeWindow | null, catalogueValid: boolean;
  [catalogue, selected, timeFilter, effectiveTime, catalogueValid] =
    await resolveFinalSelection(
      query,
      population,
      catalogue,
      selected,
      timeFilter,
      [initialStart, initialEnd],
      scoped,
      anchor,
      selectorEvents,
      modelCalls,
      loadCatalogue,
    );
  const exclusive =
    effectiveTime !== null && timeFilter !== null && timeFilter.calendarDay
      ? canonicalGeneratedEnd(timeFilter, { selectorOutput: mode === "llm" })
      : null;
  if (initialError !== null) catalogueValid = false;
  const generatedNumeric =
      mode === "llm+jev"
        ? compiled.numeric
        : (selected.numeric ?? new NumericFilters()),
    candidates = catalogueValid ? literalCandidates(query, catalogue) : [],
    [finalStart, finalEnd] = candidateWindow(population, effectiveTime, {
      withinResults: options.withinResults ?? false,
      fallbackStart: shiftDays(anchor, -30),
      fallbackEnd: anchor,
    });
  selected = await confirmLiteralCandidates(
    options.orq,
    selected,
    catalogue,
    candidates,
    {
      start: finalStart,
      end: finalEnd,
      facets: population.facets,
      numeric: population.numeric,
      confirmer: options.candidateConfirmer,
    },
  );
  const facets = mergeFacets(population.facets, selected.selection),
    numeric = mergeNumeric(population.numeric, generatedNumeric),
    [start, end, origin, timeSource, emptyMatch] = effectiveTimeScope(
      population,
      effectiveTime,
      {
        withinResults: options.withinResults ?? false,
        forceEmpty: !catalogueValid,
      },
    ),
    endExclusive = Boolean(
      (exclusive !== null &&
        parseIso(exclusive).hour === 0 &&
        parseIso(exclusive).minute === 0 &&
        parseIso(exclusive).second === 0 &&
        parseIso(exclusive).microsecond === 0 &&
        end !== null &&
        sameTime(end, exclusive)) ||
        (population.endExclusive &&
          end !== null &&
          population.end !== null &&
          sameTime(end, population.end)),
    ),
    effective = new PopulationRequest({
      ...population,
      start,
      end,
      timeOrigin: origin,
      endExclusive,
      facets,
      numeric,
    }),
    usage = aggregateSelectorUsage(selectorEvents, selected),
    last = cacheEvents.at(-1) ?? {};
  usage.catalogue_cache = {
    hit: last.hit ?? false,
    elapsed_seconds: cacheEvents.reduce(
      (sum, event) => sum + Number(event.elapsed_seconds),
      0,
    ),
    source: options.catalogueLoader ? "injected" : "production",
    events: cacheEvents,
  };
  const provenance = {
    filter_mode: mode,
    dimensions: "compiler",
    facets: !isDeepStrictEqual(population.facets, new FacetSelection())
      ? "explicit"
      : mode === "llm"
        ? "llm"
        : "jev",
    numeric: !isDeepStrictEqual(population.numeric, new NumericFilters())
      ? "explicit"
      : mode === "llm+jev"
        ? "compiler"
        : "llm",
    time: timeSource,
  };
  checkRunActive();
  return Object.freeze({
    dimensions: compiled.dimensions,
    generatedFacets: selected.selection,
    generatedNumeric,
    generatedTime: effectiveTime,
    effectivePopulation: effective,
    selectorResponse: selected.response,
    selectorError: selected.error,
    provenance: Object.freeze(provenance),
    usage: Object.freeze(usage),
    unsupportedReason: compiled.unsupportedReason,
    emptyMatch,
    modelCalls: Object.freeze(modelCalls),
  });
}
