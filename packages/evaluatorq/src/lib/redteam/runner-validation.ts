import type OpenAI from "openai";

import { envRaw } from "../common/env-config.js";
import { AgentTarget } from "../contracts.js";
import type { DataPoint } from "../types.js";
import { listAvailableCategories } from "./adaptive/strategy-registry.js";
import { validateAgentTarget } from "./backends/base.js";
import { LLMConfig } from "./config.js";
import {
  AttackSource,
  AttackTechnique,
  type AttackTechnique as AttackTechniqueType,
  DeliveryMethod,
  type Pipeline,
  PipelineSchema,
  parseTarget,
  SaveMode,
  SaveModeSchema,
  SUPPORTED_TARGET_KINDS,
  type Vulnerability,
} from "./contracts.js";
import { resolveDeliveryMethods } from "./delivery-method-registry.js";
import { CredentialError, RedTeamError } from "./exceptions.js";
import {
  ensureHuggingfaceAvailable,
  isHuggingfaceSource,
} from "./frameworks/owasp/evaluatorq-bridge.js";
import { getEvaluatorForVulnerability } from "./frameworks/owasp/evaluators.js";
import { loadRedteamReplay, type RedTeamReplay } from "./replay.js";
import type { RedTeamResult } from "./reports/models.js";
import {
  ensureTargetCanBacktrack,
  parseTraceSeed,
  TraceStart,
  targetHistoryMode,
} from "./traces.js";
import {
  getPrimaryCategory,
  resolveCategorySafe,
  resolveVulnerabilities,
} from "./vulnerability-registry.js";

export type RedTeamTarget = string | AgentTarget;
export interface DataSelectionOptions {
  previousRun?: string | null;
  mode?: Pipeline | null;
  dataset?: string | null;
  categories?: string[] | null;
  vulnerabilities?: string[] | null;
  strategies?: string[] | null;
  datapoints?: DataPoint[] | null;
  attackTechniques?: string[] | null;
  deliveryMethods?: string[] | null;
  maxPerCategory?: number | null;
  maxDynamicDatapoints?: number | null;
  maxStaticDatapoints?: number | null;
  maxTurns?: number | null;
  attackerInstructions?: string | null;
}
export function resolveSaveMode(save: SaveMode | boolean): SaveMode {
  if (typeof save === "boolean") {
    console.warn(
      "Passing save=true/false is deprecated. Use SaveMode.FINAL / SaveMode.NONE instead.",
    );
    return save ? SaveMode.FINAL : SaveMode.NONE;
  }
  return SaveModeSchema.parse(save);
}
export function resolveAttackTechniques(
  values?: readonly string[] | null,
): Set<AttackTechniqueType> | null {
  if (values == null) return null;
  const valid = new Set<string>(Object.values(AttackTechnique)),
    unknown = values.filter((value) => !valid.has(value));
  if (unknown.length)
    throw new RangeError(
      `Unknown attack technique(s) ${JSON.stringify(values)}; expected one of: ${[...valid].join(", ")}.`,
    );
  return new Set(values as AttackTechniqueType[]);
}
export function validateTraceDatapoints(
  options: DataSelectionOptions,
): DataPoint[] | null {
  if (options.mode === "static" && options.attackTechniques != null)
    throw new RangeError(
      "attackTechniques applies to dynamic strategies and cannot be used in static mode.",
    );
  if (options.datapoints == null) return null;
  if (!options.datapoints.length)
    throw new RangeError(
      "datapoints=[] selected no trace seeds; nothing to attack. Check the TraceInput search/filters that produced this list.",
    );
  if (options.dataset != null)
    throw new RangeError(
      "datapoints= trace seeds cannot be combined with dataset=.",
    );
  if (options.mode != null && options.mode !== "dynamic")
    throw new RangeError(
      "Trace seed datapoints require the dynamic red-team pipeline.",
    );
  for (const [index, data] of options.datapoints.entries())
    parseTraceSeed(data.inputs, { label: `datapoints[${index}]` });
  return [...options.datapoints];
}
export async function resolveRedteamReplay(
  options: DataSelectionOptions,
  runsDir: string,
): Promise<{
  replay: RedTeamReplay | null;
  mode: Pipeline;
  maxTurns: number | null;
  attackerInstructions: string | null;
}> {
  if (options.previousRun == null)
    return {
      replay: null,
      mode: PipelineSchema.parse(options.mode ?? "dynamic"),
      maxTurns: options.maxTurns ?? null,
      attackerInstructions: options.attackerInstructions ?? null,
    };
  const selectionFields = [
    "mode",
    "dataset",
    "categories",
    "vulnerabilities",
    "strategies",
    "datapoints",
    "attackTechniques",
    "deliveryMethods",
    "maxPerCategory",
    "maxDynamicDatapoints",
    "maxStaticDatapoints",
  ] as const;
  const conflicts = selectionFields.filter((key) => options[key] != null);
  if (conflicts.length)
    throw new RangeError(
      `previousRun replays a stored run and cannot be combined with data-selection arguments: ${conflicts.join(", ")}. Drop them, or drop previousRun.`,
    );
  const replay = await loadRedteamReplay(options.previousRun, runsDir);
  return {
    replay,
    mode: replay.pipeline,
    maxTurns: options.maxTurns ?? replay.maxTurns,
    attackerInstructions:
      options.attackerInstructions ?? replay.attackerInstructions,
  };
}
export function restoreReplayedBacktracks(
  config: LLMConfig | null | undefined,
  replay: RedTeamReplay | null,
): LLMConfig | null {
  if (!replay?.maxBacktracks || config?.fieldsSet.has("maxBacktracks"))
    return config ?? null;
  return new LLMConfig({
    ...(config ?? new LLMConfig()),
    maxBacktracks: replay.maxBacktracks,
  });
}
export function resolveOutputDirs(
  save: SaveMode,
  artifactsDir?: string | null,
): { userOutputDir: string | null; pipelineOutputDir: string | null } {
  if (save === "detail" && artifactsDir == null)
    throw new RangeError("save='detail' requires artifactsDir to be set.");
  return {
    userOutputDir: artifactsDir ?? null,
    pipelineOutputDir: save === "detail" ? (artifactsDir ?? null) : null,
  };
}
export function splitAndDedupeTargets(
  target: RedTeamTarget | RedTeamTarget[],
): { strings: string[]; agents: AgentTarget[]; raw: RedTeamTarget[] } {
  const raw = Array.isArray(target) ? [...target] : [target];
  if (!raw.length)
    throw new RangeError("redTeam() requires at least one target");
  const strings: string[] = [],
    agents: AgentTarget[] = [],
    seen = new Set<string>();
  for (const value of raw) {
    if (typeof value === "string") {
      if (seen.has(value))
        console.warn(
          `Duplicate target ${JSON.stringify(value)} - ignoring repeated occurrence.`,
        );
      else {
        seen.add(value);
        strings.push(value);
      }
    } else if (value instanceof AgentTarget) agents.push(value);
    else {
      validateAgentTarget(value);
      throw new TypeError(
        `Invalid target type: ${typeof value}. Expected string or AgentTarget.`,
      );
    }
  }
  return { strings, agents, raw };
}
export function deduplicateTargetLabels(
  strings: readonly string[],
  agents: readonly AgentTarget[],
): { labels: string[]; agentLabels: Map<AgentTarget, string> } {
  const seen = new Set(strings),
    agentLabels = new Map<AgentTarget, string>(),
    labels = [...strings];
  for (const target of agents) {
    const rawName = (target as AgentTarget & { name?: string }).name,
      base = rawName || target.constructor.name;
    let label = base,
      suffix = 1;
    while (seen.has(label)) label = `${base}-${suffix++}`;
    seen.add(label);
    agentLabels.set(target, label);
    labels.push(label);
  }
  return {
    labels,
    agentLabels,
  };
}
export function validateTraceReplayTargets(
  targets: readonly RedTeamTarget[],
  data: readonly DataPoint[] | null,
): void {
  if (
    !data?.some(
      (row) =>
        (Object.hasOwn(row.inputs, "traceStartFrom")
          ? row.inputs.traceStartFrom
          : row.inputs.trace_start_from) === TraceStart.LAST_ASSISTANT,
    )
  )
    return;
  for (const target of targets) {
    if (target instanceof AgentTarget) {
      if (
        targetHistoryMode(
          target,
          "last_assistant trace replay requires caller-owned history on the target",
        ) === "target"
      )
        throw new RedTeamError(
          "last_assistant trace replay requires caller-owned history; the supplied target owns the conversation history",
        );
    } else {
      const [kind] = parseTarget(target);
      throw new RedTeamError(
        `last_assistant trace replay requires caller-owned history on the target (e.g. OpenAIModelTarget or a custom AgentTarget); target ${JSON.stringify(target)} resolves to an Orq ${kind} target.`,
      );
    }
  }
}
export function rejectUnsupportedTargets(
  targets: readonly string[],
  mode: Pipeline,
): void {
  for (const target of targets) {
    const [kind] = parseTarget(target);
    if (SUPPORTED_TARGET_KINDS[mode].some((allowed) => allowed === kind))
      continue;
    const elsewhere = (
      Object.entries(SUPPORTED_TARGET_KINDS) as [Pipeline, readonly string[]][]
    )
      .filter(([, kinds]) => kinds.includes(kind))
      .map(([pipeline]) => pipeline);
    throw new RangeError(
      `Target ${JSON.stringify(target)} is an Orq ${kind}, which the ${mode} pipeline does not support: adaptive attacks need a conversational target. ${elsewhere.length ? `Run it with mode=${JSON.stringify(elsewhere[0])}, or use simulate() for a conversational run.` : "Pass an AgentTarget object instead."}`,
    );
  }
}
export function validateBacktrackingTargets(
  targets: readonly RedTeamTarget[],
  config: LLMConfig,
  mode: Pipeline,
): void {
  if (!config.maxBacktracks || mode === "static") return;
  for (const target of targets)
    if (target instanceof AgentTarget) ensureTargetCanBacktrack(target);
}
export function validateCredentialsAndDeps(options: {
  config: LLMConfig;
  llmClient?: OpenAI | null;
  replay: RedTeamReplay | null;
  mode: Pipeline;
  dataset?: string | null;
}): void {
  if (
    !options.llmClient &&
    !options.config.attacker.client &&
    !options.config.evaluator.client &&
    !envRaw("OPENAI_API_KEY") &&
    !envRaw("ORQ_API_KEY")
  )
    throw new CredentialError(
      "Missing LLM credentials for attack/evaluation models. Set OPENAI_API_KEY for direct OpenAI access, or ORQ_API_KEY to use the ORQ router.",
    );
  if (
    options.replay === null &&
    options.mode !== "dynamic" &&
    isHuggingfaceSource(options.dataset)
  )
    ensureHuggingfaceAvailable();
}
export interface ResolvedFilters {
  strategyNames: Set<string> | null;
  attackTechniques: Set<AttackTechniqueType> | null;
  deliveryMethods: Set<string> | null;
  filterSelection: [string, string[]] | null;
}
export function resolveFilterSets(
  options: DataSelectionOptions,
): ResolvedFilters {
  return {
    strategyNames:
      options.strategies == null ? null : new Set(options.strategies),
    attackTechniques: resolveAttackTechniques(options.attackTechniques),
    deliveryMethods:
      options.deliveryMethods == null
        ? null
        : new Set(resolveDeliveryMethods(options.deliveryMethods)),
    filterSelection:
      options.vulnerabilities != null
        ? ["vulnerabilities", [...options.vulnerabilities].sort()]
        : options.categories != null
          ? ["categories", [...options.categories].sort()]
          : null,
  };
}
export function resolveVulnsAndCategories(
  options: DataSelectionOptions,
  replay: RedTeamReplay | null,
): {
  vulnerabilities: Vulnerability[] | null;
  categories: string[];
  unevaluableCodes: string[];
} {
  if (replay)
    return {
      vulnerabilities: null,
      categories: [...replay.categories],
      unevaluableCodes: [],
    };
  const vulnerabilities =
    options.vulnerabilities != null
      ? resolveVulnerabilities(options.vulnerabilities)
      : resolveVulnerabilities(options.categories ?? listAvailableCategories());
  let categories =
    options.vulnerabilities != null
      ? vulnerabilities.map(getPrimaryCategory)
      : [...(options.categories ?? listAvailableCategories())];
  if (options.vulnerabilities == null && options.categories != null)
    for (const category of options.categories) {
      const vulnerability = resolveCategorySafe(category),
        primary = vulnerability ? getPrimaryCategory(vulnerability) : null;
      if (primary && primary !== category)
        console.info(
          `Category ${category} is scored by the ${vulnerability} evaluator and reported under ${primary}.`,
        );
    }
  const evaluable = vulnerabilities.filter(
      (value) => getEvaluatorForVulnerability(value) !== null,
    ),
    dropped = vulnerabilities.filter((value) => !evaluable.includes(value));
  const unevaluableCodes = dropped.map(getPrimaryCategory);
  if (dropped.length && !evaluable.length)
    throw new RangeError(
      `None of the requested categories/vulnerabilities have an automated evaluator: ${unevaluableCodes.join(", ")}. Pick evaluator-backed categories or test with a custom evaluator.`,
    );
  if (dropped.length) {
    categories = categories.filter(
      (category) =>
        !dropped.includes(resolveCategorySafe(category) as Vulnerability),
    );
    console.warn(
      `Skipping categories with no automated evaluator: ${unevaluableCodes.join(", ")}`,
    );
  }
  return { vulnerabilities: evaluable, categories, unevaluableCodes };
}
export function matchedFilterDimensions(data: readonly DataPoint[]): {
  names: Set<string>;
  methods: Set<string>;
  techniques: Set<string>;
} {
  const names = new Set<string>(),
    methods = new Set<string>(),
    techniques = new Set<string>();
  for (const row of data) {
    const strategy = row.inputs.strategy;
    if (
      strategy !== null &&
      typeof strategy === "object" &&
      !Array.isArray(strategy)
    ) {
      const raw = strategy as Record<string, unknown>;
      if (raw.name) names.add(String(raw.name));
      const deliveries = raw.deliveryMethods ?? raw.delivery_methods;
      if (Array.isArray(deliveries))
        for (const method of deliveries) methods.add(String(method));
      const technique = raw.attackTechnique ?? raw.attack_technique;
      if (technique) techniques.add(String(technique));
    }
    const method = row.inputs.deliveryMethod ?? row.inputs.delivery_method;
    if (method) methods.add(String(method));
  }
  return { names, methods, techniques };
}
export function checkFilterResults(
  data: readonly DataPoint[],
  filters: ResolvedFilters,
  options: { namesApply?: boolean; presentMethods?: string[] | null } = {},
): void {
  if (
    filters.strategyNames === null &&
    filters.deliveryMethods === null &&
    filters.attackTechniques === null &&
    filters.filterSelection === null
  )
    return;
  const matched = matchedFilterDimensions(data),
    unmatched = (requested: Set<string>, found: Set<string>) =>
      [...requested].filter((value) => !found.has(value)).sort();
  if (filters.strategyNames !== null && options.namesApply !== false) {
    const missing = unmatched(filters.strategyNames, matched.names);
    if (missing.length)
      console.warn(
        `Unmatched strategy name(s): ${JSON.stringify(missing)} - no datapoints matched.`,
      );
  }
  if (filters.deliveryMethods !== null) {
    const missing = unmatched(filters.deliveryMethods, matched.methods);
    if (missing.length)
      console.warn(
        `Unmatched delivery method(s): ${JSON.stringify(missing)} - no datapoints use them.${matched.methods.size ? ` Present: ${JSON.stringify([...matched.methods].sort())}.` : ""}`,
      );
  }
  if (filters.attackTechniques !== null) {
    const missing = unmatched(filters.attackTechniques, matched.techniques);
    if (missing.length)
      console.warn(
        `Unmatched attack technique(s): ${JSON.stringify(missing)} - no datapoints matched.`,
      );
  }
  if (!data.length)
    throw new RedTeamError(
      `Filter selection produced zero datapoints - nothing to run. (${filters.filterSelection ? `${filters.filterSelection[0]}=${JSON.stringify(filters.filterSelection[1])}, ` : ""}strategies=${JSON.stringify(filters.strategyNames === null ? null : [...filters.strategyNames].sort())}, deliveryMethods=${JSON.stringify(filters.deliveryMethods === null ? null : [...filters.deliveryMethods].sort())}, attackTechniques=${JSON.stringify(filters.attackTechniques === null ? null : [...filters.attackTechniques].sort())})${options.presentMethods?.length ? ` Delivery methods present in the dataset: ${JSON.stringify(options.presentMethods)}.` : ""}`,
    );
}
export function capDatapointsBalanced<T extends DataPoint>(
  data: readonly T[],
  cap: number,
): T[] {
  const groups = new Map<unknown, T[]>();
  for (const row of data) {
    const key = Object.hasOwn(row.inputs, "vulnerability")
        ? row.inputs.vulnerability
        : Object.hasOwn(row.inputs, "category")
          ? row.inputs.category
          : "",
      group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const result: T[] = [];
  let index = 0;
  while (result.length < cap) {
    let added = false;
    for (const group of groups.values()) {
      if (result.length >= cap) break;
      const row = group[index];
      if (row !== undefined) {
        result.push(row);
        added = true;
      }
    }
    if (!added) break;
    index++;
  }
  return result;
}
export function backtrackingWarnings(
  results: readonly RedTeamResult[],
  maxBacktracks: number,
): string[] {
  if (!maxBacktracks) return [];
  const dynamic = results.filter(
      (row) =>
        row.attack.source === AttackSource.TEMPLATE_DYNAMIC ||
        row.attack.source === AttackSource.GENERATED_DYNAMIC,
    ),
    warnings: string[] = [];
  if (
    !dynamic.some((row) =>
      row.attack.deliveryMethods.includes(DeliveryMethod.CRESCENDO),
    )
  )
    warnings.push(
      `maxBacktracks=${maxBacktracks} had no effect: no multi-turn attack in this run used the Crescendo delivery method.`,
    );
  const failures = dynamic.reduce(
    (sum, row) => sum + (row.execution?.refusalJudgeFailures ?? 0),
    0,
  );
  if (failures)
    warnings.push(
      `The refusal judge gave no usable verdict on ${failures} turn(s). Those turns were kept, so backtracking may have erased fewer refusals than it could. Check the fast-role model (task redteam.refusal_judge) and credentials.`,
    );
  return warnings;
}
