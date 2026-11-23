import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type Fingerprint,
  fingerprint,
  type ReportCard,
  scan,
} from "../common/dashboard/library.js";
import { exactSum } from "../common/jury.js";
import { pyRound } from "../common/reports/number-format.js";
import { SEVERITY_ORDER } from "../common/reports/palette.js";
import { isErroredResult } from "../integrations/simulation/metrics.js";

export const UNKNOWN_SEVERITY = "unknown";

type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Coercion helpers (mirror the defensive float/int readers in metrics.py)
// ---------------------------------------------------------------------------

const isNone = (value: unknown): boolean =>
  value === null || value === undefined;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asFloat(value: unknown, def = 0): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return def;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? def : parsed;
  }
  return def;
}

function asFloatOrNone(value: unknown): number | null {
  if (isNone(value)) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asInt(value: unknown, def = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : def;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return def;
    }
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) ? parsed : def;
  }
  return def;
}

function tokensTotal(usage: unknown): number {
  if (!isRecord(usage)) {
    return 0;
  }
  if (Object.hasOwn(usage, "total_tokens")) {
    return asInt(usage.total_tokens);
  }
  if (Object.hasOwn(usage, "total")) {
    return asInt(usage.total);
  }
  return asInt(usage.prompt_tokens) + asInt(usage.completion_tokens);
}

function costUsd(usage: unknown): number | null {
  if (!isRecord(usage)) {
    return null;
  }
  return asFloatOrNone(usage.cost_usd);
}

function inputCost(usage: unknown): number | null {
  if (!isRecord(usage)) {
    return null;
  }
  return asFloatOrNone(usage.input_cost);
}

function outputCost(usage: unknown): number | null {
  if (!isRecord(usage)) {
    return null;
  }
  return asFloatOrNone(usage.output_cost);
}

function costCalls(usage: unknown): [number, number, number] {
  if (!isRecord(usage)) {
    return [0, 0, 0];
  }
  if (isNone(usage.priced_calls)) {
    if (costUsd(usage) === null) {
      return [0, 0, 0];
    }
    return [0, 0, asInt(usage.calls) || 1];
  }
  return [asInt(usage.priced_calls), asInt(usage.calls), 0];
}

export function zeroEvaluatedAttacks(summary: JsonObject): boolean {
  if (isNone(summary.evaluated_attacks)) {
    return false;
  }
  if (!isNone(summary.total_attacks) && asInt(summary.total_attacks) === 0) {
    return false;
  }
  return asInt(summary.evaluated_attacks) === 0;
}

// ---------------------------------------------------------------------------
// Report data access
// ---------------------------------------------------------------------------

const jsonCache = new Map<string, JsonObject>();

async function readJsonCached(path: string): Promise<JsonObject | null> {
  try {
    const resolved = resolve(path);
    const stats = await stat(resolved, { bigint: true });
    const key = `${resolved}|${stats.mtimeNs}`;
    const cached = jsonCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const parsed: unknown = JSON.parse(await readFile(resolved, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    jsonCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function iterReportData(
  manifests: ReportCard[],
): Promise<Array<[ReportCard, JsonObject]>> {
  const out: Array<[ReportCard, JsonObject]> = [];
  for (const card of manifests) {
    if (card.path === null) {
      continue;
    }
    const data = await readJsonCached(card.path);
    if (data !== null) {
      out.push([card, data]);
    }
  }
  return out;
}

function results(data: JsonObject): JsonObject[] {
  const raw = data.results;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function entries(data: JsonObject): JsonObject[] {
  const raw = data.entries;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function comparisonUsage(entry: JsonObject): unknown {
  const comparison = entry.comparison;
  return isRecord(comparison) ? comparison.token_usage : null;
}

function resultTokens(res: JsonObject): number {
  return asInt(res.total_tokens) || tokensTotal(res.token_usage);
}

export function resultOutcome(res: JsonObject): boolean | null {
  const evaluation = res.evaluation;
  if (isRecord(evaluation)) {
    const passed = evaluation.passed;
    return typeof passed === "boolean" ? passed : null;
  }
  if (Object.hasOwn(res, "evaluation") || res.error) {
    return null;
  }
  if (Object.hasOwn(res, "vulnerable")) {
    return !res.vulnerable;
  }
  return null;
}

function resultUsage(res: JsonObject): [number, number | null] {
  let tokens = 0;
  let cost: number | null = null;
  for (const holder of ["execution", "evaluation"]) {
    const parent = res[holder];
    const usage = isRecord(parent) ? parent.token_usage : null;
    tokens += tokensTotal(usage);
    const holderCost = costUsd(usage);
    if (holderCost !== null) {
      cost = (cost ?? 0) + holderCost;
    }
  }
  return [tokens, cost];
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  surface: string;
  name: string;
  when: string;
  headline: string;
  score: number | null;
  status: string;
  error: boolean;
  evaluated: number;
  attacks: number;
  storedScore: number | null;
}

export function RunRow(input: {
  id: string;
  surface: string;
  name: string;
  when: string;
  headline: string;
  score: number | null;
  status: string;
  error: boolean;
  evaluated?: number;
  attacks?: number;
  storedScore?: number | null;
}): RunRow {
  return {
    evaluated: 0,
    attacks: 0,
    storedScore: null,
    ...input,
  };
}

function formatWhen(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function lifecycleStatus(options: {
  broken: boolean;
  allErrored?: boolean;
}): string {
  return options.broken || (options.allErrored ?? false) ? "error" : "finished";
}

export interface RedteamCounts {
  attacks: number;
  evaluated: number;
  vulnerable: number;
  errors: number;
  tokens: number;
  cost: number | null;
  bySeverity: JsonObject;
}

export function redteamCounts(data: JsonObject): RedteamCounts {
  let attacks = 0;
  let evaluated = 0;
  let vulnerable = 0;
  let errors = 0;
  let tokens = 0;
  let cost: number | null = null;
  const bySeverity: JsonObject = {};
  for (const res of results(data)) {
    attacks += 1;
    if (res.error) {
      errors += 1;
    }
    const [tok, c] = resultUsage(res);
    tokens += tok;
    if (c !== null) {
      cost = (cost ?? 0) + c;
    }
    const outcome = resultOutcome(res);
    if (outcome === null) {
      continue;
    }
    evaluated += 1;
    if (!outcome) {
      vulnerable += 1;
      const attack = isRecord(res.attack) ? res.attack : {};
      let severity = String(attack.severity || UNKNOWN_SEVERITY).toLowerCase();
      if (!(SEVERITY_ORDER as readonly string[]).includes(severity)) {
        severity = UNKNOWN_SEVERITY;
      }
      bySeverity[severity] = asInt(bySeverity[severity]) + 1;
    }
  }
  return { attacks, evaluated, vulnerable, errors, tokens, cost, bySeverity };
}

function legacyResistance(counts: RedteamCounts): number | null {
  if (!counts.evaluated) {
    return null;
  }
  return (counts.evaluated - counts.vulnerable) / counts.evaluated;
}

export function summarySeverity(summary: JsonObject): JsonObject {
  const bySev = summary.by_severity;
  if (!isRecord(bySev)) {
    return {};
  }
  const out: JsonObject = {};
  for (const [sev, entryRaw] of Object.entries(bySev)) {
    if (!isRecord(entryRaw)) {
      continue;
    }
    const n = asInt(entryRaw.vulnerabilities_found || entryRaw.count);
    if (n) {
      let key = String(sev).toLowerCase();
      if (!(SEVERITY_ORDER as readonly string[]).includes(key)) {
        key = UNKNOWN_SEVERITY;
      }
      out[key] = asInt(out[key]) + n;
    }
  }
  return out;
}

function redteamRow(card: ReportCard, data: JsonObject): RunRow {
  const rawSummary = data.summary;
  const summary = isRecord(rawSummary) ? rawSummary : {};
  const hasSummary = Object.keys(summary).length > 0;
  let resistance: number | null;
  if (Object.hasOwn(summary, "resistance_rate")) {
    resistance = asFloatOrNone(summary.resistance_rate);
  } else {
    resistance = hasSummary ? 1.0 : null;
  }
  let evaluated = hasSummary ? asInt(summary.evaluated_attacks) : 0;
  const errors = hasSummary ? asInt(summary.total_errors) : 0;
  const total = hasSummary ? asInt(summary.total_attacks) : 0;
  if (zeroEvaluatedAttacks(summary)) {
    resistance = null;
  }
  let storedScore: number | null = null;
  let attacks = total;
  if (isNone(summary.evaluated_attacks)) {
    const counts = redteamCounts(data);
    evaluated = counts.evaluated;
    attacks = counts.attacks;
    const derived = legacyResistance(counts);
    if (derived !== null) {
      if (resistance === null || Math.abs(derived - resistance) > 0.005) {
        storedScore = resistance;
      }
      resistance = derived;
    }
  }
  return RunRow({
    id: card.id,
    surface: "redteam",
    name: card.name,
    when: formatWhen(card.createdAt),
    headline: card.headline,
    score: resistance,
    status: lifecycleStatus({
      broken: Boolean(card.error),
      allErrored: total > 0 && evaluated === 0 && errors >= total,
    }),
    error: Boolean(card.error),
    evaluated,
    attacks,
    storedScore,
  });
}

function simRow(card: ReportCard, data: JsonObject): RunRow {
  const rawAverages = data.scorer_averages;
  const averages = isRecord(rawAverages) ? rawAverages : {};
  const vals = Object.values(averages).map((v) => asFloat(v));
  const score = vals.length
    ? vals.reduce((acc, v) => acc + v, 0) / vals.length
    : null;
  return RunRow({
    id: card.id,
    surface: "sim",
    name: card.name,
    when: formatWhen(card.createdAt),
    headline: card.headline,
    score,
    status: lifecycleStatus({ broken: Boolean(card.error) }),
    error: Boolean(card.error),
  });
}

function pairwiseRow(card: ReportCard, data: JsonObject): RunRow {
  const rawReport = data.report;
  const report = isRecord(rawReport) ? rawReport : {};
  const inconclusive = report.inconclusive_rate;
  const decided = !isNone(inconclusive) ? 1 - asFloat(inconclusive) : null;
  return RunRow({
    id: card.id,
    surface: "pairwise",
    name: card.name,
    when: formatWhen(card.createdAt),
    headline: card.headline,
    score: decided,
    status: lifecycleStatus({ broken: Boolean(card.error) }),
    error: Boolean(card.error),
  });
}

function cardStatusRow(card: ReportCard): RunRow {
  const status = card.status ?? "error";
  const lifecycle = status === "completed" ? "finished" : status;
  return RunRow({
    id: card.id,
    surface: card.surface,
    name: card.name,
    when: formatWhen(card.createdAt),
    headline: card.headline,
    score: null,
    status: lifecycle,
    error: status === "error",
  });
}

export async function runRows(roots: string[]): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  for (const card of await scan(roots)) {
    if (
      card.surface !== "redteam" &&
      card.surface !== "sim" &&
      card.surface !== "pairwise"
    ) {
      continue;
    }
    if (
      card.status === "running" ||
      card.status === "error" ||
      card.status === "cancelled" ||
      card.path === null
    ) {
      rows.push(cardStatusRow(card));
      continue;
    }
    const data = (await readJsonCached(card.path)) ?? {};
    if (card.surface === "redteam") {
      rows.push(redteamRow(card, data));
    } else if (card.surface === "sim") {
      rows.push(simRow(card, data));
    } else if (card.surface === "pairwise") {
      rows.push(pairwiseRow(card, data));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Landing aggregates
// ---------------------------------------------------------------------------

export interface TileStats {
  tokens: number;
  cost: number;
  costedRuns: number;
  inputCost: number;
  outputCost: number;
  hasInputCost: boolean;
  hasOutputCost: boolean;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
}

export interface RedteamTiles {
  stats: TileStats;
  resistant: number;
  vulnerable: number;
  bySeverity: JsonObject;
}

export async function redteamTiles(
  manifests: ReportCard[],
): Promise<RedteamTiles> {
  const severityCounts: JsonObject = {};
  let tokens = 0;
  const costs: number[] = [];
  let costedRuns = 0;
  const inputCosts: number[] = [];
  const outputCosts: number[] = [];
  let hasInputCost = false;
  let hasOutputCost = false;
  let pricedCalls = 0;
  let costCallsTotal = 0;
  let unknownCalls = 0;
  let resistant = 0;
  let vulnerable = 0;
  for (const [, data] of await iterReportData(manifests)) {
    const rawSummary = data.summary;
    const summary = isRecord(rawSummary) ? rawSummary : {};
    let bySev: JsonObject;
    if (isNone(summary.evaluated_attacks)) {
      const counts = redteamCounts(data);
      const legacy = legacyResistance(counts);
      if (legacy !== null) {
        resistant += pyRound(legacy * counts.evaluated);
      }
      vulnerable += counts.vulnerable;
      tokens += counts.tokens;
      if (counts.cost !== null) {
        costs.push(counts.cost);
        costedRuns += 1;
      }
      bySev = counts.bySeverity;
    } else {
      resistant +=
        asInt(summary.evaluated_attacks) - asInt(summary.vulnerabilities_found);
      vulnerable += asInt(summary.vulnerabilities_found);
      const usage = summary.token_usage_total;
      tokens += tokensTotal(usage);
      const runCost = costUsd(usage);
      if (runCost !== null) {
        costs.push(runCost);
        costedRuns += 1;
      }
      const runInput = inputCost(usage);
      if (runInput !== null) {
        inputCosts.push(runInput);
        hasInputCost = true;
      }
      const runOutput = outputCost(usage);
      if (runOutput !== null) {
        outputCosts.push(runOutput);
        hasOutputCost = true;
      }
      const [runPriced, runCalls, runUnknown] = costCalls(usage);
      pricedCalls += runPriced;
      costCallsTotal += runCalls;
      unknownCalls += runUnknown;
      bySev = summarySeverity(summary);
    }
    for (const [sev, n] of Object.entries(bySev)) {
      severityCounts[sev] = asInt(severityCounts[sev]) + asInt(n);
    }
  }
  return {
    stats: {
      tokens,
      cost: exactSum(costs),
      costedRuns,
      inputCost: exactSum(inputCosts),
      outputCost: exactSum(outputCosts),
      hasInputCost,
      hasOutputCost,
      pricedCalls,
      costCalls: costCallsTotal,
      unknownCalls,
    },
    resistant,
    vulnerable,
    bySeverity: severityCounts,
  };
}

export interface SimSpend {
  total: number | null;
  tokens: number;
  inputCost: number | null;
  outputCost: number | null;
  resultTotal: number | null;
  resultCosted: number;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
}

export function simSpend(data: JsonObject, results: JsonObject[]): SimSpend {
  const resultUsages = results.map((res) => res.token_usage);
  const resultCosts = resultUsages
    .map((usage) => costUsd(usage))
    .filter((c): c is number => c !== null);
  const resultTotal = resultCosts.length ? exactSum(resultCosts) : null;
  const resultTokensTotal = results.reduce(
    (acc, res) => acc + resultTokens(res),
    0,
  );
  const resultInputCosts = resultUsages
    .map((usage) => inputCost(usage))
    .filter((c): c is number => c !== null);
  const resultOutputCosts = resultUsages
    .map((usage) => outputCost(usage))
    .filter((c): c is number => c !== null);
  const runUsage = data.token_usage_total;
  let total: number | null;
  let tokens: number;
  let inputCostValue: number | null;
  let outputCostValue: number | null;
  let priced: number;
  let calls: number;
  let unknown: number;
  if (!isNone(runUsage)) {
    total = costUsd(runUsage);
    tokens = tokensTotal(runUsage);
    inputCostValue = inputCost(runUsage);
    outputCostValue = outputCost(runUsage);
    [priced, calls, unknown] = costCalls(runUsage);
  } else {
    total = resultTotal;
    tokens = resultTokensTotal;
    inputCostValue = resultInputCosts.length
      ? exactSum(resultInputCosts)
      : null;
    outputCostValue = resultOutputCosts.length
      ? exactSum(resultOutputCosts)
      : null;
    priced = 0;
    calls = 0;
    unknown = 0;
    for (const usage of resultUsages) {
      const [resultPriced, resultCalls, resultUnknown] = costCalls(usage);
      priced += resultPriced;
      calls += resultCalls;
      unknown += resultUnknown;
    }
  }
  return {
    total,
    tokens,
    inputCost: inputCostValue,
    outputCost: outputCostValue,
    resultTotal,
    resultCosted: resultCosts.length,
    pricedCalls: priced,
    costCalls: calls,
    unknownCalls: unknown,
  };
}

export async function simTiles(manifests: ReportCard[]): Promise<TileStats> {
  let tokens = 0;
  const allCosts: number[] = [];
  let costedRuns = 0;
  const allInputCosts: number[] = [];
  const allOutputCosts: number[] = [];
  let hasInputCost = false;
  let hasOutputCost = false;
  let pricedCalls = 0;
  let costCallsTotal = 0;
  let unknownCalls = 0;
  for (const [, data] of await iterReportData(manifests)) {
    const spend = simSpend(data, results(data));
    tokens += spend.tokens;
    if (spend.total !== null) {
      allCosts.push(spend.total);
      costedRuns += 1;
    }
    if (spend.inputCost !== null) {
      allInputCosts.push(spend.inputCost);
      hasInputCost = true;
    }
    if (spend.outputCost !== null) {
      allOutputCosts.push(spend.outputCost);
      hasOutputCost = true;
    }
    pricedCalls += spend.pricedCalls;
    costCallsTotal += spend.costCalls;
    unknownCalls += spend.unknownCalls;
  }
  return {
    tokens,
    cost: exactSum(allCosts),
    costedRuns,
    inputCost: exactSum(allInputCosts),
    outputCost: exactSum(allOutputCosts),
    hasInputCost,
    hasOutputCost,
    pricedCalls,
    costCalls: costCallsTotal,
    unknownCalls,
  };
}

export interface Landing {
  totalRuns: number;
  redteamRuns: number;
  simRuns: number;
  resistanceRate: number | null;
  totalTokens: number;
  byKind: Array<[string, number]>;
  severity: Array<[string, number]>;
  tokensByKind: Array<[string, number]>;
  resistant: number;
  vulnerable: number;
  totalCost: number | null;
  costedRuns: number;
  costByKind: Array<[string, number]>;
  totalInputCost: number | null;
  totalOutputCost: number | null;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
  recent: RunRow[];
}

export function Landing(input: {
  totalRuns: number;
  redteamRuns: number;
  simRuns: number;
  resistanceRate: number | null;
  totalTokens: number;
  byKind: Array<[string, number]>;
  severity: Array<[string, number]>;
  tokensByKind: Array<[string, number]>;
  resistant: number;
  vulnerable: number;
  totalCost?: number | null;
  costedRuns?: number;
  costByKind?: Array<[string, number]>;
  totalInputCost?: number | null;
  totalOutputCost?: number | null;
  pricedCalls?: number;
  costCalls?: number;
  unknownCalls?: number;
  recent?: RunRow[];
}): Landing {
  return {
    totalCost: null,
    costedRuns: 0,
    costByKind: [],
    totalInputCost: null,
    totalOutputCost: null,
    pricedCalls: 0,
    costCalls: 0,
    unknownCalls: 0,
    recent: [],
    ...input,
  };
}

export async function landing(roots: string[]): Promise<Landing> {
  const rows = await runRows(roots);
  const redteam = rows.filter((r) => r.surface === "redteam");
  const sim = rows.filter((r) => r.surface === "sim");
  const pairwise = rows.filter((r) => r.surface === "pairwise");
  const manifests = await scan(roots);
  const redteamTilesResult = await redteamTiles(
    manifests.filter((card) => card.surface === "redteam"),
  );
  const simTilesResult = await simTiles(
    manifests.filter((card) => card.surface === "sim"),
  );
  const pairwiseManifests = manifests.filter(
    (card) => card.surface === "pairwise",
  );
  const rt = redteamTilesResult.stats;

  const severityCounts = redteamTilesResult.bySeverity;
  let totalTokens = rt.tokens + simTilesResult.tokens;
  const rtTokens = rt.tokens;
  const simTokens = simTilesResult.tokens;
  const rtCost = rt.cost;
  const simCost = simTilesResult.cost;
  let costedRuns = rt.costedRuns + simTilesResult.costedRuns;
  let pwTokens = 0;
  const pwCosts: number[] = [];
  const pwInputCosts: number[] = [];
  const pwOutputCosts: number[] = [];
  let pricedCallsTotal = rt.pricedCalls + simTilesResult.pricedCalls;
  let costCallsTotal = rt.costCalls + simTilesResult.costCalls;
  let unknownCallsTotal = rt.unknownCalls + simTilesResult.unknownCalls;
  let hasInputCost = rt.hasInputCost || simTilesResult.hasInputCost;
  let hasOutputCost = rt.hasOutputCost || simTilesResult.hasOutputCost;
  const resistant = redteamTilesResult.resistant;
  const vulnerable = redteamTilesResult.vulnerable;
  for (const [, data] of await iterReportData(pairwiseManifests)) {
    const usages = entries(data).map((entry) => comparisonUsage(entry));
    const tok = usages.reduce<number>((acc, u) => acc + tokensTotal(u), 0);
    pwTokens += tok;
    totalTokens += tok;
    const costs = usages
      .map((u) => costUsd(u))
      .filter((c): c is number => c !== null);
    if (costs.length) {
      pwCosts.push(...costs);
      costedRuns += 1;
    }
    const inputs = usages
      .map((u) => inputCost(u))
      .filter((c): c is number => c !== null);
    if (inputs.length) {
      pwInputCosts.push(...inputs);
      hasInputCost = true;
    }
    const outputs = usages
      .map((u) => outputCost(u))
      .filter((c): c is number => c !== null);
    if (outputs.length) {
      pwOutputCosts.push(...outputs);
      hasOutputCost = true;
    }
    for (const u of usages) {
      const [resPriced, resCalls, resUnknown] = costCalls(u);
      pricedCallsTotal += resPriced;
      costCallsTotal += resCalls;
      unknownCallsTotal += resUnknown;
    }
  }
  const pwCost = exactSum(pwCosts);
  const inputCostTotal = exactSum([
    rt.inputCost,
    simTilesResult.inputCost,
    ...pwInputCosts,
  ]);
  const outputCostTotal = exactSum([
    rt.outputCost,
    simTilesResult.outputCost,
    ...pwOutputCosts,
  ]);

  const severity: Array<[string, number]> = [
    ...SEVERITY_ORDER,
    UNKNOWN_SEVERITY,
  ]
    .filter((sev) => asInt(severityCounts[sev]))
    .map((sev) => [sev, asInt(severityCounts[sev])]);
  const byKind: Array<[string, number]> = [];
  for (const [k, n] of [
    ["Red team", redteam.length],
    ["Agent sim", sim.length],
    ["Pairwise", pairwise.length],
  ] as Array<[string, number]>) {
    if (n) {
      byKind.push([k, n]);
    }
  }
  const tokensByKind: Array<[string, number]> = [];
  for (const [k, n] of [
    ["Red team", rtTokens],
    ["Agent sim", simTokens],
    ["Pairwise", pwTokens],
  ] as Array<[string, number]>) {
    if (n) {
      tokensByKind.push([k, n]);
    }
  }
  const costByKind: Array<[string, number]> = [];
  for (const [k, c] of [
    ["Red team", rtCost],
    ["Agent sim", simCost],
    ["Pairwise", pwCost],
  ] as Array<[string, number]>) {
    if (c > 0) {
      costByKind.push([k, c]);
    }
  }

  const evaluated = resistant + vulnerable;
  const resistanceRate = evaluated ? resistant / evaluated : null;

  return Landing({
    totalRuns: rows.length,
    redteamRuns: redteam.length,
    simRuns: sim.length,
    resistanceRate,
    totalTokens,
    byKind,
    severity,
    tokensByKind,
    resistant: Math.max(resistant, 0),
    vulnerable: Math.max(vulnerable, 0),
    totalCost: costedRuns ? rtCost + simCost + pwCost : null,
    costedRuns,
    costByKind,
    totalInputCost: hasInputCost ? inputCostTotal : null,
    totalOutputCost: hasOutputCost ? outputCostTotal : null,
    pricedCalls: pricedCallsTotal,
    costCalls: costCallsTotal,
    unknownCalls: unknownCallsTotal,
    recent: rows.slice(0, 5),
  });
}

// ---------------------------------------------------------------------------
// Agent Sim overview (RES-1022)
// ---------------------------------------------------------------------------

const TARGET_LABELS: Record<string, string> = {
  orq_agent: "Orq agent",
  orq_deployment: "Orq deployment",
  openai_model: "OpenAI model",
  vercel: "Vercel",
  callback: "Callback",
};

const TARGET_KIND_CATEGORY: Record<string, string> = {
  orq_agent: "agent",
  orq_deployment: "deployment",
  vercel: "deployment",
  openai_model: "llm",
  callback: "other",
};

function splitTarget(raw: string): [string, string] | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const index = trimmed.indexOf(":");
  const prefix = index === -1 ? trimmed : trimmed.slice(0, index);
  const rest = index === -1 ? "" : trimmed.slice(index + 1);
  const kindMap: Record<string, string> = {
    agent: "agent",
    deployment: "deployment",
    callback: "other",
  };
  const kind = kindMap[prefix] ?? "";
  if (kind) {
    const label = TARGET_LABELS[`orq_${prefix}`] ?? prefix;
    return [rest || label, kind];
  }
  return [trimmed, ""];
}

function simTarget(data: JsonObject): [string, string] {
  const kindCat =
    TARGET_KIND_CATEGORY[String(data.target_kind || "")] ?? "other";
  const target = data.target;
  const targetModel = data.target_model;
  if (typeof target === "string" && target) {
    const parsed = splitTarget(target);
    let name: string;
    let kind: string;
    if (parsed !== null) {
      name = parsed[0];
      kind = parsed[1];
    } else {
      name = target;
      kind = "";
    }
    if (
      typeof targetModel === "string" &&
      targetModel &&
      targetModel !== name
    ) {
      name = `${name} · ${targetModel}`;
    }
    return [name, kind || kindCat];
  }
  const model = data.model;
  if (typeof model === "string" && model) {
    return [model, "llm"];
  }
  for (const res of results(data)) {
    const meta = res.metadata;
    const tgt = isRecord(meta) ? meta.target : null;
    if (typeof tgt === "string") {
      const parsed = splitTarget(tgt);
      if (parsed !== null) {
        return [parsed[0], parsed[1] || kindCat];
      }
    }
  }
  const runName = String(data.run_name || "");
  if (runName) {
    let name: string;
    if (runName.startsWith("sim:") && runName.slice(4).includes(":")) {
      name = runName.split(":").slice(1, 2)[0] ?? "";
    } else {
      name = runName;
    }
    return [name || runName, kindCat];
  }
  const kind = String(data.target_kind || "");
  return [TARGET_LABELS[kind] ?? (kind || "unknown"), kindCat];
}

export interface SimRunRow {
  rid: string;
  name: string;
  when: Date;
  targets: Array<[string, string]>;
  status: string;
  score: number | null;
  cases: number;
  cost: number | null;
  error: boolean;
  achieved: number;
  errors: number;
}

export function SimRunRow(input: {
  rid: string;
  name: string;
  when: Date;
  targets: Array<[string, string]>;
  status: string;
  score: number | null;
  cases: number;
  cost: number | null;
  error: boolean;
  achieved?: number;
  errors?: number;
}): SimRunRow {
  return { achieved: 0, errors: 0, ...input };
}

export interface SimOverview {
  simulationsRun: number;
  goalCompletion: number | null;
  avgTurns: number | null;
  avgTokens: number | null;
  avgCost: number | null;
  avgInputCost: number | null;
  avgOutputCost: number | null;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
  achieved: number;
  notAchieved: number;
  errors: number;
  totalCost: number | null;
  recent: SimRunRow[];
  totalRuns: number;
  page: number;
  perPage: number;
}

export function SimOverview(input: {
  simulationsRun: number;
  goalCompletion: number | null;
  avgTurns: number | null;
  avgTokens: number | null;
  avgCost: number | null;
  avgInputCost: number | null;
  avgOutputCost: number | null;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
  achieved: number;
  notAchieved: number;
  errors: number;
  totalCost?: number | null;
  recent?: SimRunRow[];
  totalRuns?: number;
  page?: number;
  perPage?: number;
}): SimOverview {
  return {
    totalCost: null,
    recent: [],
    totalRuns: 0,
    page: 1,
    perPage: 8,
    ...input,
  };
}

function simRunScore(data: JsonObject): number | null {
  const rawAverages = data.scorer_averages;
  const averages = isRecord(rawAverages) ? rawAverages : {};
  const vals = Object.values(averages).map((v) => asFloat(v));
  return vals.length ? vals.reduce((acc, v) => acc + v, 0) / vals.length : null;
}

function isErrored(res: JsonObject): boolean {
  return isErroredResult({
    metadata: isRecord(res.metadata) ? res.metadata : {},
    terminated_by:
      typeof res.terminated_by === "string" ? res.terminated_by : undefined,
  });
}

export interface SimRunStats {
  cases: number;
  errors: number;
  achieved: number;
  notAchieved: number;
  turns: number;
  tokens: number;
  cost: number | null;
  resultCostTotal: number | null;
  costed: number;
  inputCost: number;
  inputCosted: number;
  outputCost: number;
  outputCosted: number;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
  score: number | null;
  target: [string, string];
}

const simRunStatsCache = new Map<string, Promise<SimRunStats | null>>();

export function simRunStats(
  pathStr: string,
  mtimeNs: bigint,
): Promise<SimRunStats | null> {
  const key = `${pathStr}|${mtimeNs}`;
  const cached = simRunStatsCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const promise = computeSimRunStats(pathStr);
  simRunStatsCache.set(key, promise);
  return promise;
}

async function computeSimRunStats(
  pathStr: string,
): Promise<SimRunStats | null> {
  const data = await readJsonCached(pathStr);
  if (data === null) {
    return null;
  }
  let cases = 0;
  let errors = 0;
  let achieved = 0;
  let notAchieved = 0;
  let turns = 0;
  let tokens = 0;
  let inputCosted = 0;
  let outputCosted = 0;
  let inputCostTotal = 0;
  let outputCostTotal = 0;
  const reportResults = results(data);
  for (const res of reportResults) {
    cases += 1;
    turns += asInt(res.turn_count);
    tokens += resultTokens(res);
    const usage = res.token_usage;
    const input = inputCost(usage);
    if (input !== null) {
      inputCostTotal += input;
      inputCosted += 1;
    }
    const output = outputCost(usage);
    if (output !== null) {
      outputCostTotal += output;
      outputCosted += 1;
    }
    if (isErrored(res)) {
      errors += 1;
    } else if (res.goal_achieved) {
      achieved += 1;
    } else {
      notAchieved += 1;
    }
  }
  const spend = simSpend(data, reportResults);
  return {
    cases,
    errors,
    achieved,
    notAchieved,
    turns,
    tokens,
    cost: spend.total,
    resultCostTotal: spend.resultTotal,
    costed: spend.resultCosted,
    inputCost: inputCostTotal,
    inputCosted,
    outputCost: outputCostTotal,
    outputCosted,
    pricedCalls: spend.pricedCalls,
    costCalls: spend.costCalls,
    unknownCalls: spend.unknownCalls,
    score: simRunScore(data),
    target: simTarget(data),
  };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function cachedStats<T>(
  path: string,
  distil: (pathStr: string, mtimeNs: bigint) => Promise<T | null>,
): Promise<T | null> {
  try {
    const stats = await stat(path, { bigint: true });
    return await distil(canonicalPath(path), stats.mtimeNs);
  } catch {
    return null;
  }
}

const simAggregateCache = new Map<string, SimOverview>();

export async function simOverview(
  roots: string[],
  options: { page?: number; perPage?: number } = {},
): Promise<SimOverview> {
  const agg = await simAggregate(roots, await fingerprint(roots));
  const perPage = options.perPage ?? 8;
  const page = Math.min(
    Math.max(1, options.page ?? 1),
    Math.max(1, Math.ceil(agg.totalRuns / perPage)),
  );
  return {
    ...agg,
    recent: agg.recent.slice((page - 1) * perPage, page * perPage),
    page,
    perPage,
  };
}

async function simAggregate(
  roots: string[],
  finger: Fingerprint,
): Promise<SimOverview> {
  const key = `${JSON.stringify(roots)}|${finger.count}|${finger.newestMtimeNs}|${finger.identity}`;
  const cached = simAggregateCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = await computeSimAggregate(roots);
  simAggregateCache.set(key, result);
  return result;
}

async function computeSimAggregate(roots: string[]): Promise<SimOverview> {
  const runs: SimRunRow[] = [];
  let turnsTotal = 0;
  let tokensTotal = 0;
  let costTotal = 0;
  let runCosted = 0;
  let resultCostTotal = 0;
  let costed = 0;
  let inputCostTotal = 0;
  let inputCosted = 0;
  let outputCostTotal = 0;
  let outputCosted = 0;
  let pricedCallsTotal = 0;
  let costCallsTotal = 0;
  let unknownCallsTotal = 0;
  let achieved = 0;
  let notAchieved = 0;
  let errors = 0;
  let total = 0;

  for (const card of await scan(roots)) {
    if (card.surface !== "sim" || card.path === null) {
      continue;
    }
    const stats = await cachedStats(card.path, simRunStats);
    if (stats === null) {
      continue;
    }

    total += stats.cases;
    turnsTotal += stats.turns;
    tokensTotal += stats.tokens;
    costed += stats.costed;
    if (stats.resultCostTotal !== null) {
      resultCostTotal += stats.resultCostTotal;
    }
    inputCostTotal += stats.inputCost;
    inputCosted += stats.inputCosted;
    outputCostTotal += stats.outputCost;
    outputCosted += stats.outputCosted;
    pricedCallsTotal += stats.pricedCalls;
    costCallsTotal += stats.costCalls;
    unknownCallsTotal += stats.unknownCalls;
    achieved += stats.achieved;
    notAchieved += stats.notAchieved;
    errors += stats.errors;
    if (stats.cost !== null) {
      costTotal += stats.cost;
      runCosted += 1;
    }

    runs.push(
      SimRunRow({
        rid: card.id,
        name: card.name,
        when: card.createdAt,
        targets: [stats.target],
        status: lifecycleStatus({
          broken: Boolean(card.error),
          allErrored: stats.cases > 0 && stats.errors === stats.cases,
        }),
        score: stats.score,
        cases: stats.cases,
        cost: stats.cost,
        error: Boolean(card.error),
        achieved: stats.achieved,
        errors: stats.errors,
      }),
    );
  }

  runs.sort((a, b) => b.when.getTime() - a.when.getTime());
  return SimOverview({
    simulationsRun: total,
    goalCompletion: total > errors ? achieved / total : null,
    avgTurns: total ? turnsTotal / total : null,
    avgTokens: total ? tokensTotal / total : null,
    totalCost: runCosted ? costTotal : null,
    avgCost: costed ? resultCostTotal / costed : null,
    avgInputCost: inputCosted ? inputCostTotal / inputCosted : null,
    avgOutputCost: outputCosted ? outputCostTotal / outputCosted : null,
    pricedCalls: pricedCallsTotal,
    costCalls: costCallsTotal,
    unknownCalls: unknownCallsTotal,
    achieved,
    notAchieved,
    errors,
    recent: runs,
    totalRuns: runs.length,
  });
}

// ---------------------------------------------------------------------------
// Red Team overview (RES-1021)
// ---------------------------------------------------------------------------

export interface RedTeamRunRow {
  rid: string;
  name: string;
  when: Date;
  targets: Array<[string, string]>;
  status: string;
  score: number | null;
  cases: number;
  cost: number | null;
  error: boolean;
  vulnerable: number;
  evaluated: number;
}

export function RedTeamRunRow(input: {
  rid: string;
  name: string;
  when: Date;
  targets: Array<[string, string]>;
  status: string;
  score: number | null;
  cases: number;
  cost: number | null;
  error: boolean;
  vulnerable?: number;
  evaluated?: number;
}): RedTeamRunRow {
  return { vulnerable: 0, evaluated: 0, ...input };
}

export interface RedTeamOverview {
  attacksRun: number;
  breakRate: number | null;
  criticalFindings: number;
  avgRobustness: number | null;
  totalCost: number | null;
  totalInputCost: number | null;
  totalOutputCost: number | null;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
  recent: RedTeamRunRow[];
  totalRuns: number;
  page: number;
  perPage: number;
}

export function RedTeamOverview(input: {
  attacksRun: number;
  breakRate: number | null;
  criticalFindings: number;
  avgRobustness: number | null;
  totalCost: number | null;
  totalInputCost?: number | null;
  totalOutputCost?: number | null;
  pricedCalls?: number;
  costCalls?: number;
  unknownCalls?: number;
  recent?: RedTeamRunRow[];
  totalRuns?: number;
  page?: number;
  perPage?: number;
}): RedTeamOverview {
  return {
    totalInputCost: null,
    totalOutputCost: null,
    pricedCalls: 0,
    costCalls: 0,
    unknownCalls: 0,
    recent: [],
    totalRuns: 0,
    page: 1,
    perPage: 8,
    ...input,
  };
}

function redteamTargets(data: JsonObject): Array<[string, string]> {
  const seen = new Map<string, [string, string]>();
  const order: string[] = [];
  for (const res of results(data)) {
    const agent = isRecord(res.agent) ? res.agent : {};
    const rawIdent = agent.key || agent.model;
    const label = agent.display_name || agent.key || agent.model;
    if (typeof label !== "string" || !label) {
      continue;
    }
    const ident = typeof rawIdent === "string" && rawIdent ? rawIdent : label;
    const kind = agent.key ? "agent" : agent.model ? "llm" : "other";
    if (!seen.has(ident)) {
      order.push(ident);
      seen.set(ident, [label, kind]);
    } else if (agent.display_name) {
      const current = seen.get(ident) as [string, string];
      seen.set(ident, [String(agent.display_name), current[1]]);
    }
  }
  if (order.length) {
    return order.map((i) => seen.get(i) as [string, string]);
  }
  const out: Array<[string, string]> = [];
  const tested = data.tested_agents;
  if (Array.isArray(tested)) {
    for (const t of tested) {
      if (typeof t === "string" && t) {
        const name =
          t.startsWith("agent:") || t.startsWith("deployment:")
            ? t.slice(t.indexOf(":") + 1)
            : t;
        out.push([name, t.startsWith("deployment:") ? "deployment" : "agent"]);
      } else if (isRecord(t)) {
        const val = t.display_name || t.key;
        if (typeof val === "string" && val) {
          out.push([val, "agent"]);
        }
      }
    }
  }
  return out.length ? out : [["unknown", "other"]];
}

export interface RedTeamRunStats {
  attacks: number;
  evaluated: number;
  vulnerable: number;
  critical: number;
  errors: number;
  cost: number | null;
  inputCost: number | null;
  outputCost: number | null;
  pricedCalls: number;
  costCalls: number;
  unknownCalls: number;
  resistance: number | null;
  cases: number;
  targets: Array<[string, string]>;
}

const redteamRunStatsCache = new Map<string, Promise<RedTeamRunStats | null>>();

export function redteamRunStats(
  pathStr: string,
  mtimeNs: bigint,
): Promise<RedTeamRunStats | null> {
  const key = `${pathStr}|${mtimeNs}`;
  const cached = redteamRunStatsCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const promise = computeRedteamRunStats(pathStr);
  redteamRunStatsCache.set(key, promise);
  return promise;
}

async function computeRedteamRunStats(
  pathStr: string,
): Promise<RedTeamRunStats | null> {
  const data = await readJsonCached(pathStr);
  if (data === null) {
    return null;
  }
  const rawSummary = data.summary;
  const summary = isRecord(rawSummary) ? rawSummary : {};
  const usage = summary.token_usage_total;
  const [priced, calls, unknown] = costCalls(usage);
  const counts = redteamCounts(data);
  let resistance = Object.hasOwn(summary, "resistance_rate")
    ? asFloatOrNone(summary.resistance_rate)
    : null;
  if (resistance === null) {
    resistance = legacyResistance(counts);
  }
  if (zeroEvaluatedAttacks(summary)) {
    resistance = null;
  }
  let cost = costUsd(usage);
  if (cost === null) {
    if (usage === undefined || usage === null) {
      console.warn(
        `redteam run ${pathStr} has no summary token_usage_total; falling back to legacy per-result cost`,
      );
    } else {
      console.warn(
        `redteam run ${pathStr} has unreadable summary token_usage_total; falling back to legacy per-result cost`,
      );
    }
    cost = counts.cost;
  }
  return {
    attacks: counts.attacks,
    evaluated: counts.evaluated,
    vulnerable: counts.vulnerable,
    critical: asInt(counts.bySeverity.critical),
    errors: counts.errors,
    cost,
    inputCost: inputCost(usage),
    outputCost: outputCost(usage),
    pricedCalls: priced,
    costCalls: calls,
    unknownCalls: unknown,
    resistance,
    cases: asInt(summary.total_attacks) || counts.attacks,
    targets: redteamTargets(data),
  };
}

const redteamAggregateCache = new Map<string, RedTeamOverview>();

export async function redteamOverview(
  roots: string[],
  options: { page?: number; perPage?: number } = {},
): Promise<RedTeamOverview> {
  const agg = await redteamAggregate(roots, await fingerprint(roots));
  const perPage = options.perPage ?? 8;
  const page = Math.min(
    Math.max(1, options.page ?? 1),
    Math.max(1, Math.ceil(agg.totalRuns / perPage)),
  );
  return {
    ...agg,
    recent: agg.recent.slice((page - 1) * perPage, page * perPage),
    page,
    perPage,
  };
}

async function redteamAggregate(
  roots: string[],
  finger: Fingerprint,
): Promise<RedTeamOverview> {
  const key = `${JSON.stringify(roots)}|${finger.count}|${finger.newestMtimeNs}|${finger.identity}`;
  const cached = redteamAggregateCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = await computeRedteamAggregate(roots);
  redteamAggregateCache.set(key, result);
  return result;
}

async function computeRedteamAggregate(
  roots: string[],
): Promise<RedTeamOverview> {
  const runs: RedTeamRunRow[] = [];
  let evaluated = 0;
  let vulnerable = 0;
  let critical = 0;
  let resistant = 0;
  let costTotal = 0;
  let hasCost = false;
  let inputCostTotal = 0;
  let hasInputCost = false;
  let outputCostTotal = 0;
  let hasOutputCost = false;
  let pricedCallsTotal = 0;
  let costCallsTotal = 0;
  let unknownCallsTotal = 0;
  let totalAttacks = 0;

  for (const card of await scan(roots)) {
    if (card.surface !== "redteam" || card.path === null) {
      continue;
    }
    const stats = await cachedStats(card.path, redteamRunStats);
    if (stats === null) {
      continue;
    }

    if (stats.cost !== null) {
      costTotal += stats.cost;
      hasCost = true;
    }
    if (stats.inputCost !== null) {
      inputCostTotal += stats.inputCost;
      hasInputCost = true;
    }
    if (stats.outputCost !== null) {
      outputCostTotal += stats.outputCost;
      hasOutputCost = true;
    }
    pricedCallsTotal += stats.pricedCalls;
    costCallsTotal += stats.costCalls;
    unknownCallsTotal += stats.unknownCalls;

    totalAttacks += stats.attacks;
    evaluated += stats.evaluated;
    vulnerable += stats.vulnerable;
    resistant += stats.evaluated - stats.vulnerable;
    critical += stats.critical;

    runs.push(
      RedTeamRunRow({
        rid: card.id,
        name: card.name,
        when: card.createdAt,
        targets: stats.targets,
        status: lifecycleStatus({
          broken: Boolean(card.error),
          allErrored: stats.attacks > 0 && stats.errors === stats.attacks,
        }),
        score: stats.resistance,
        cases: stats.cases,
        cost: stats.cost,
        error: Boolean(card.error),
        vulnerable: stats.vulnerable,
        evaluated: stats.evaluated,
      }),
    );
  }

  runs.sort((a, b) => b.when.getTime() - a.when.getTime());
  return RedTeamOverview({
    attacksRun: totalAttacks,
    breakRate: evaluated ? vulnerable / evaluated : null,
    criticalFindings: critical,
    avgRobustness: evaluated ? resistant / evaluated : null,
    totalCost: hasCost ? costTotal : null,
    totalInputCost: hasInputCost ? inputCostTotal : null,
    totalOutputCost: hasOutputCost ? outputCostTotal : null,
    pricedCalls: pricedCallsTotal,
    costCalls: costCallsTotal,
    unknownCalls: unknownCallsTotal,
    recent: runs,
    totalRuns: runs.length,
  });
}
