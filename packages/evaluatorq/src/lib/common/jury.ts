import type { Span } from "@opentelemetry/api";

import {
  addUsage,
  EVAL_ERROR_RAW_OUTPUT_KEY,
  JURY_RAW_OUTPUT_KEY,
  type JuryRepetition,
  type JuryResult,
  JuryResultSchema,
  type JuryStats,
  type JuryVote,
  type JuryVoteInput,
  JuryVoteSchema,
  type Usage,
  type UsageInput,
  UsageSchema,
} from "../contracts.js";
import { captureParentContext } from "../tracing/context.js";
import {
  setSpanAttrs,
  setSpanError,
  truncateForSpan,
  withSpan,
} from "./tracing.js";

export type VerdictValue = boolean | number | string;
export type TieBreak = (values: VerdictValue[]) => VerdictValue | null;
export type Aggregator = (votes: JuryVote[]) => VerdictValue | null;
export type NumericAggName = "mean_std" | "median" | "min" | "max";
export type AggregatorName = "mode" | "majority" | NumericAggName;
export type AggregatorSpec = AggregatorName | Aggregator;
export type VerdictKind = "categorical" | "numeric";

export interface Prediction {
  value?: VerdictValue | null;
  explanation?: string;
  tokenUsage?: UsageInput | null;
  rawOutput?: Record<string, unknown> | null;
  error?: string | null;
  abstained?: boolean;
}

type NormalizedPrediction = Omit<Prediction, "tokenUsage"> & {
  tokenUsage: Usage | null;
};

export type JudgeFn = (model: string) => Promise<Prediction>;

export interface JuryDeliberation {
  verdict: VerdictValue | null;
  explanation: string;
  jury: JuryResult;
  tokenUsage: Usage | null;
}

export function isDecisive(prediction: Prediction): boolean {
  return (
    (prediction.error ?? null) === null &&
    !prediction.abstained &&
    (prediction.value ?? null) !== null
  );
}

export function unswap(value: VerdictValue | null): VerdictValue | null {
  if (value === "A") {
    return "B";
  }
  return value === "B" ? "A" : value;
}

/**
 * Neumaier summation, what Python's sum() does since 3.12. A plain reduce lands a mean
 * one bit off (0.6000000000000001), enough to flip a verdict sitting on its threshold.
 */
export function compensatedSum(values: readonly number[]): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const next = total + value;
    compensation +=
      Math.abs(total) >= Math.abs(value)
        ? total - next + value
        : value - next + total;
    total = next;
  }
  return total + compensation;
}

/** Python's math.fsum: the correctly rounded sum (Shewchuk partials, CPython's half-even step). */
export function exactSum(values: readonly number[]): number {
  const partials: number[] = [];
  for (let x of values) {
    let kept = 0;
    for (let index = 0; index < partials.length; index += 1) {
      let y = partials[index] as number;
      if (Math.abs(x) < Math.abs(y)) {
        [x, y] = [y, x];
      }
      const high = x + y;
      const low = y - (high - x);
      if (low !== 0) {
        partials[kept] = low;
        kept += 1;
      }
      x = high;
    }
    partials.length = kept;
    partials.push(x);
  }
  let index = partials.length - 1;
  if (index < 0) {
    return 0;
  }
  let high = partials[index] as number;
  let low = 0;
  while (index > 0) {
    index -= 1;
    const x = high;
    const y = partials[index] as number;
    high = x + y;
    low = y - (high - x);
    if (low !== 0) {
      break;
    }
  }
  const next = index > 0 ? (partials[index - 1] as number) : 0;
  if ((low < 0 && next < 0) || (low > 0 && next > 0)) {
    const doubled = low * 2;
    const candidate = high + doubled;
    if (doubled === candidate - high) {
      high = candidate;
    }
  }
  return high;
}

/** Python's f"{value:.{places}f}": toFixed except that exact ties round to even. */
export function pythonFixed(value: number, places: number): string {
  const rendered = value.toFixed(places);
  const [whole = "0", fraction = ""] = value.toFixed(100).split(".");
  if (!/^50*$/.test(fraction.slice(places))) {
    return rendered;
  }
  // An exact tie: toFixed rounds it up and Python rounds it to even.
  const kept = fraction.slice(0, places);
  if (BigInt(`${whole}${kept}`) % BigInt(2) !== BigInt(0)) {
    return rendered;
  }
  return places === 0 ? whole : `${whole}.${kept}`;
}

export function sumUsage(usages: Usage[]): Usage | null {
  const [first, ...rest] = usages;
  return first ? rest.reduce((total, u) => addUsage(total, u), first) : null;
}

function counts(values: VerdictValue[]): Map<VerdictValue, number> {
  const tally = new Map<VerdictValue, number>();
  for (const value of values) {
    tally.set(value, (tally.get(value) ?? 0) + 1);
  }
  return tally;
}

export function pluralityVote(values: VerdictValue[]): {
  verdict: VerdictValue | null;
  tie: boolean;
} {
  if (values.length === 0) {
    return { verdict: null, tie: false };
  }
  const tally = counts(values);
  const top = Math.max(...tally.values());
  const winners = [...tally].filter(([, n]) => n === top).map(([v]) => v);
  return winners.length > 1
    ? { verdict: null, tie: true }
    : { verdict: winners[0] as VerdictValue, tie: false };
}

function numericReduce(
  values: VerdictValue[],
  how: NumericAggName,
): number | null {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) {
    return null;
  }
  if (how === "median") {
    const ordered = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? (ordered[mid] as number)
      : ((ordered[mid - 1] as number) + (ordered[mid] as number)) / 2;
  }
  if (how === "min") {
    return Math.min(...nums);
  }
  if (how === "max") {
    return Math.max(...nums);
  }
  return compensatedSum(nums) / nums.length;
}

function strictMajority(values: VerdictValue[]): VerdictValue | null {
  for (const [value, n] of counts(values)) {
    if (n * 2 > values.length) {
      return value;
    }
  }
  return null;
}

function decisiveValues(votes: JuryVote[]): VerdictValue[] {
  return votes
    .filter((v) => v.value !== null && !v.abstained && v.success)
    .map((v) => v.value as VerdictValue);
}

const numericAggregator =
  (how: NumericAggName): Aggregator =>
  (votes) =>
    numericReduce(decisiveValues(votes), how);

const AGGREGATORS: Record<AggregatorName, Aggregator> = {
  mode: (votes) => pluralityVote(decisiveValues(votes)).verdict,
  majority: (votes) => strictMajority(decisiveValues(votes)),
  mean_std: numericAggregator("mean_std"),
  median: numericAggregator("median"),
  min: numericAggregator("min"),
  max: numericAggregator("max"),
};

const AGG_KIND: Record<AggregatorName, VerdictKind> = {
  mode: "categorical",
  majority: "categorical",
  mean_std: "numeric",
  median: "numeric",
  min: "numeric",
  max: "numeric",
};

function isAggregatorName(value: string): value is AggregatorName {
  return Object.hasOwn(AGG_KIND, value);
}

export function validateAggregator(
  aggregator: AggregatorSpec | null | undefined,
  verdictKind: VerdictKind,
): void {
  if (
    aggregator === null ||
    aggregator === undefined ||
    typeof aggregator === "function"
  ) {
    return;
  }
  if (!isAggregatorName(aggregator)) {
    throw new Error(
      `Unknown aggregator '${aggregator}'; expected one of ${Object.keys(AGG_KIND).sort().join(", ")} or a function.`,
    );
  }
  if (AGG_KIND[aggregator] !== verdictKind) {
    const allowed = (Object.keys(AGG_KIND) as AggregatorName[])
      .filter((name) => AGG_KIND[name] === verdictKind)
      .sort();
    throw new Error(
      `aggregator='${aggregator}' is ${AGG_KIND[aggregator]}-only; verdictKind='${verdictKind}' needs one of ${allowed.join(", ")}.`,
    );
  }
}

function juryStats(values: VerdictValue[]): JuryStats | null {
  if (values.length === 0) {
    return null;
  }
  let nums: number[];
  if (values.every((v) => typeof v === "boolean")) {
    nums = values.map((v) => (v ? 1 : 0));
  } else if (values.every((v) => typeof v === "number")) {
    nums = values as number[];
  } else {
    return null;
  }
  const mean = compensatedSum(nums) / nums.length;
  const variance =
    compensatedSum(nums.map((n) => (n - mean) ** 2)) / nums.length;
  return { mean, std: variance ** 0.5 };
}

export function agreementRate(values: VerdictValue[]): number | null {
  if (values.length === 0 || values.every((v) => typeof v === "number")) {
    return null;
  }
  return Math.max(...counts(values).values()) / values.length;
}

function juryExplanation(votes: JuryVote[]): string {
  for (const vote of [...votes].reverse()) {
    if (vote.error) {
      return `No judge produced a usable verdict; last error: ${vote.error}`;
    }
  }
  return votes.some((v) => v.abstained)
    ? "No judge produced a usable verdict; all decisive judges abstained."
    : "No judge produced a usable verdict.";
}

export function appendJurySummary(
  explanation: string | null | undefined,
  jury: JuryResult | null | undefined,
): string {
  const base = explanation ?? "";
  if (!jury) {
    return base;
  }
  const parts = [`${jury.judgesSucceeded}/${jury.judgesConfigured} judges`];
  if (jury.rawAgreement !== null) {
    parts.push(`raw agreement ${pythonFixed(jury.rawAgreement * 100, 0)}%`);
  }
  if (jury.tie) {
    parts.push("TIE (tie-break applied)");
  }
  if (jury.inconclusive) {
    parts.push("INCONCLUSIVE");
  }
  const summary = `[jury: ${parts.join(", ")}]`;
  return base ? `${base} ${summary}` : summary;
}

export function attachJuryRawOutput(
  rawOutput: Record<string, unknown> | null | undefined,
  jury: JuryResult | null | undefined,
  errorPayload?: Record<string, unknown> | null,
): Record<string, unknown> | null | undefined {
  if (!jury) {
    if (errorPayload) {
      console.warn(
        "attachJuryRawOutput: no jury to attach, dropping the judge error payload with it",
      );
    }
    return rawOutput;
  }
  const merged: Record<string, unknown> = {
    ...rawOutput,
    [JURY_RAW_OUTPUT_KEY]: jury,
  };
  if (errorPayload) {
    merged[EVAL_ERROR_RAW_OUTPUT_KEY] = errorPayload;
  }
  return merged;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Python's str() spelling, so TS and Python spans group under one value.
function verdictAttr(value: VerdictValue | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

interface JudgeVoteOptions {
  model: string;
  judgeFn: JudgeFn;
  repetitions: number;
  verdictKind: VerdictKind;
  tieBreak: TieBreak | undefined;
  replacement: boolean;
  numericHow: NumericAggName;
  propagateErrors: boolean;
  parentContext?: unknown;
  labelSwapped?: boolean;
}

interface JudgeVoteResult {
  vote: JuryVote;
  usages: Usage[];
}

async function callPrediction(
  judgeFn: JudgeFn,
  model: string,
  propagateErrors: boolean,
): Promise<NormalizedPrediction> {
  try {
    const prediction = await judgeFn(model);
    return {
      ...prediction,
      tokenUsage: prediction.tokenUsage
        ? UsageSchema.parse(prediction.tokenUsage)
        : null,
    };
  } catch (error) {
    if (propagateErrors) {
      throw error;
    }
    console.warn(`jury judgeFn raised: ${errorMessage(error)}`);
    return { error: errorMessage(error), tokenUsage: null };
  }
}

async function judgeVote(options: JudgeVoteOptions): Promise<JudgeVoteResult> {
  const { model, replacement, labelSwapped, parentContext } = options;
  return withSpan("orq.judge", { parentContext }, async (span) => {
    const start = performance.now();
    setSpanAttrs(span, {
      "judge.name": model,
      "judge.model": model,
      "judge.replacement": replacement,
      "judge.label_swapped": labelSwapped,
    });
    const result = await computeJudgeVote(options);
    recordJudgeSpan(span, result.vote, performance.now() - start, labelSwapped);
    return result;
  });
}

function recordJudgeSpan(
  span: Span | undefined,
  vote: JuryVote,
  latencyMs: number,
  labelSwapped: boolean | undefined,
): void {
  const canonical = labelSwapped ? unswap(vote.value) : vote.value;
  setSpanAttrs(span, {
    "judge.verdict": verdictAttr(canonical),
    "judge.success": vote.success,
    "judge.abstained": vote.abstained,
    "judge.latency_ms": Math.round(latencyMs * 1000) / 1000,
    "judge.error": vote.error === null ? null : truncateForSpan(vote.error),
    "judge.repetitions_failed": vote.repetitionsFailed,
  });
  if (!vote.success) {
    setSpanError(
      span,
      vote.error || `judge ${vote.model} produced no usable verdict`,
    );
  }
}

async function computeJudgeVote(
  options: JudgeVoteOptions,
): Promise<JudgeVoteResult> {
  const { model, judgeFn, repetitions, verdictKind, tieBreak, replacement } =
    options;
  const predictions = await Promise.all(
    Array.from({ length: Math.max(1, repetitions) }, () =>
      callPrediction(judgeFn, model, options.propagateErrors),
    ),
  );
  const usages = predictions.flatMap((p) => p.tokenUsage ?? []);
  const decisive = predictions.filter(isDecisive);
  const abstained =
    decisive.length === 0 && predictions.some((p) => p.abstained);
  const repetitionsRaw: JuryRepetition[] = predictions.map((p) => ({
    value: isDecisive(p) ? (p.value as VerdictValue) : null,
    explanation: p.explanation || null,
    rawOutput: p.rawOutput ?? null,
  }));
  // A pass that both errored and abstained is a failure, not a clean abstention.
  const failedCount = predictions.filter(
    (p) => !isDecisive(p) && (!p.abstained || (p.error ?? null) !== null),
  ).length;

  if (failedCount > 0 && failedCount < predictions.length) {
    console.warn(
      `judge ${model} had ${failedCount}/${predictions.length} repetitions fail`,
    );
  }

  const build = (fields: Omit<JuryVoteInput, "model">): JudgeVoteResult => ({
    vote: JuryVoteSchema.parse({
      model,
      replacement,
      repetitions: repetitionsRaw,
      repetitionsFailed: failedCount,
      ...fields,
    }),
    usages,
  });

  if (decisive.length === 0) {
    if (abstained) {
      const explanation =
        predictions.find((p) => p.abstained && p.explanation)?.explanation ??
        "";
      return build({ success: true, abstained: true, explanation });
    }
    const error =
      predictions.find((p) => p.error)?.error ?? "no successful prediction";
    return build({ success: false, error });
  }

  const values = decisive.map((p) => p.value as VerdictValue);
  let value: VerdictValue | null;
  if (verdictKind === "numeric") {
    value = numericReduce(values, options.numericHow);
  } else {
    const plurality = pluralityVote(values);
    value = plurality.tie && tieBreak ? tieBreak(values) : plurality.verdict;
  }
  if (value === null) {
    return build({
      success: true,
      abstained: true,
      explanation: "Judge repetitions tied without a decisive tie-break.",
    });
  }
  const explanation =
    decisive.find((p) => p.value === value && p.explanation)?.explanation ??
    decisive[0]?.explanation ??
    "";
  return build({ success: true, value, explanation });
}

export interface RunJuryOptions {
  judgeFn: JudgeFn;
  panel: readonly string[];
  repetitions?: number;
  replacementJudges?: readonly string[] | null;
  minSuccessfulJudges?: number;
  verdictKind?: VerdictKind;
  tieBreak?: TieBreak;
  aggregator?: AggregatorSpec | null;
  tieBreakLabel?: string;
  propagateErrors?: boolean;
}

export interface RunJuryCoreOptions extends RunJuryOptions {
  parentContext?: unknown;
  labelSwapped?: boolean;
  replacement?: boolean;
}

/**
 * Runs a panel of judges and aggregates their verdicts. A custom judgeFn that
 * calls a provider directly must wrap that call in llmSlot; no slot is held
 * around the callback because a built-in judge may make several nested calls.
 */
export async function runJury(
  options: RunJuryOptions,
): Promise<JuryDeliberation> {
  return withSpan("orq.jury", {}, async (span) => {
    const deliberation = await runJuryCore({
      ...options,
      parentContext: await captureParentContext(),
    });
    recordJurySpan(span, deliberation, {
      aggregator: options.aggregator,
      verdictKind: options.verdictKind ?? "categorical",
      minSuccessfulJudges: options.minSuccessfulJudges ?? 1,
    });
    return deliberation;
  });
}

function defaultAggregator(verdictKind: VerdictKind): AggregatorName {
  return verdictKind === "numeric" ? "mean_std" : "mode";
}

function aggregatorName(
  aggregator: AggregatorSpec | null | undefined,
  verdictKind: VerdictKind,
): string {
  if (typeof aggregator === "string") {
    return aggregator;
  }
  return aggregator ? "custom" : defaultAggregator(verdictKind);
}

export function recordJurySpan(
  span: Span | undefined,
  deliberation: JuryDeliberation,
  options: {
    aggregator: AggregatorSpec | null | undefined;
    verdictKind: VerdictKind;
    minSuccessfulJudges: number;
  },
): void {
  const j = deliberation.jury;
  setSpanAttrs(span, {
    "jury.verdict": verdictAttr(deliberation.verdict),
    "jury.aggregator": aggregatorName(options.aggregator, options.verdictKind),
    "jury.min_successful_judges": options.minSuccessfulJudges,
    "jury.raw_agreement": j.rawAgreement,
    "jury.judges_succeeded": j.judgesSucceeded,
    "jury.judges_configured": j.judgesConfigured,
    "jury.judges_failed": j.judgesFailed,
    "jury.replacements_used": j.replacementsUsed,
    "jury.tie": j.tie,
    "jury.inconclusive": j.inconclusive,
  });
}

function aggregatePanelVerdict(
  aggregator: AggregatorSpec,
  values: VerdictValue[],
  votes: JuryVote[],
  tieBreak: TieBreak | undefined,
): { verdict: VerdictValue | null; tie: boolean } {
  if (aggregator === "mode") {
    const { verdict, tie } = pluralityVote(values);
    return { verdict: tie && tieBreak ? tieBreak(values) : verdict, tie };
  }
  const fn =
    typeof aggregator === "function" ? aggregator : AGGREGATORS[aggregator];
  if (!fn) {
    throw new Error(`Unknown aggregator '${String(aggregator)}'`);
  }
  // All votes: a custom function may want abstained or failed ones for quorum.
  return { verdict: fn(votes), tie: false };
}

/** Panel deliberation without the jury span; comparative mode drives it directly. */
export async function runJuryCore(
  options: RunJuryCoreOptions,
): Promise<JuryDeliberation> {
  const {
    judgeFn,
    panel,
    repetitions = 1,
    replacementJudges,
    minSuccessfulJudges = 1,
    verdictKind = "categorical",
    tieBreak,
    tieBreakLabel,
    propagateErrors = false,
    parentContext,
    labelSwapped,
    replacement = false,
  } = options;
  const aggregator = options.aggregator ?? defaultAggregator(verdictKind);
  const numericHow: NumericAggName =
    typeof aggregator === "string" && AGG_KIND[aggregator] === "numeric"
      ? (aggregator as NumericAggName)
      : "mean_std";

  const resolvedPanel = resolvePanel(panel);
  // A repeated stand-in would cast two votes from one model and could
  // manufacture a false consensus.
  const seen = new Set(resolvedPanel);
  const replacementPool: string[] = [];
  for (const candidate of replacementJudges ?? []) {
    if (candidate && !seen.has(candidate)) {
      replacementPool.push(candidate);
      seen.add(candidate);
    }
  }

  const shared = {
    judgeFn,
    repetitions,
    verdictKind,
    tieBreak,
    numericHow,
    parentContext,
    labelSwapped,
  };
  const judgeResults = await Promise.all(
    resolvedPanel.map((model) =>
      judgeVote({ ...shared, model, replacement, propagateErrors }),
    ),
  );
  const votes = judgeResults.map((r) => r.vote);
  const usages = judgeResults.flatMap((r) => r.usages);

  const failures = votes.filter((v) => !v.success).length;
  const standIns = replacementPool.slice(0, failures);
  if (standIns.length > 0) {
    const replacementResults = await Promise.all(
      standIns.map((model) =>
        judgeVote({
          ...shared,
          model,
          replacement: true,
          propagateErrors: false,
        }),
      ),
    );
    votes.push(...replacementResults.map((r) => r.vote));
    usages.push(...replacementResults.flatMap((r) => r.usages));
  }

  const decisiveVotes = votes.filter(
    (v) => v.success && !v.abstained && v.value !== null,
  );
  const values = decisiveVotes.map((v) => v.value as VerdictValue);
  const required = Math.max(1, minSuccessfulJudges);
  let inconclusive = decisiveVotes.length < required;
  let tie = false;
  let verdict: VerdictValue | null = null;

  if (!inconclusive) {
    ({ verdict, tie } = aggregatePanelVerdict(
      aggregator,
      values,
      votes,
      tieBreak,
    ));
    if (verdict === null) {
      inconclusive = true;
      tie = false;
    }
  }

  if (decisiveVotes.length === 0) {
    console.error(
      `jury collapsed: 0/${resolvedPanel.length} judges produced a usable verdict (${failures} failed)`,
    );
  } else if (inconclusive) {
    console.warn(
      `jury inconclusive: ${decisiveVotes.length}/${resolvedPanel.length} decisive, need ${required}`,
    );
  }

  let explanation: string;
  if (inconclusive) {
    explanation =
      decisiveVotes.length > 0
        ? `Inconclusive: only ${decisiveVotes.length} of ${required} required judges returned a usable verdict.`
        : juryExplanation(votes);
  } else {
    explanation =
      decisiveVotes.find((v) => v.value === verdict)?.explanation ?? "";
    if (tie) {
      explanation = `[TIE: ${tieBreakLabel ?? "tie-break applied"}] ${explanation}`;
    }
  }

  const jury = JuryResultSchema.parse({
    judgesConfigured: replacement ? 0 : resolvedPanel.length,
    judgesSucceeded: decisiveVotes.length,
    judgesFailed: replacement ? 0 : failures,
    replacementsUsed:
      standIns.length + (replacement ? resolvedPanel.length : 0),
    tie,
    inconclusive,
    votes,
    stats: inconclusive ? null : juryStats(values),
    rawAgreement: inconclusive ? null : agreementRate(values),
  });
  return { verdict, explanation, jury, tokenUsage: sumUsage(usages) };
}

const FAMILY_MARKERS: readonly (readonly [string, string])[] = [
  ["claude", "anthropic"],
  ["chatgpt", "openai"],
  ["gpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["gemini", "google"],
  ["palm", "google"],
  ["llama", "meta"],
  ["mixtral", "mistral"],
  ["mistral", "mistral"],
  ["command", "cohere"],
  ["grok", "xai"],
  ["deepseek", "deepseek"],
  ["qwen", "alibaba"],
  ["glm", "zhipu"],
  ["minimax", "minimax"],
  ["kimi", "moonshot"],
];
const KNOWN_FAMILIES = new Set(FAMILY_MARKERS.map(([, family]) => family));

export function providerFamily(modelId: string): string {
  const tokens = (modelId ?? "")
    .trim()
    .toLowerCase()
    .split(/[/\-_.: ]+/)
    .filter(Boolean);
  const [first] = tokens;
  if (first === undefined) {
    return "unknown";
  }
  // Tokens are the outer loop so the earliest lineage in the id wins: a distill
  // is named for its base model after its own lineage. The digit guard keeps
  // "palmyra" from reading as "palm".
  for (const token of tokens) {
    for (const [marker, family] of FAMILY_MARKERS) {
      if (
        token === marker ||
        (token.startsWith(marker) && /^\d/.test(token.slice(marker.length)))
      ) {
        return family;
      }
    }
  }
  return KNOWN_FAMILIES.has(first) ? first : "unknown";
}

export function duplicateJudgesMessage(
  panel: readonly string[],
): string | null {
  const tally = new Map<string, number>();
  for (const model of panel) {
    if (model) {
      tally.set(model, (tally.get(model) ?? 0) + 1);
    }
  }
  const repeated = [...tally].filter(([, n]) => n > 1).map(([model]) => model);
  if (repeated.length === 0) {
    return null;
  }
  return `Judge(s) ${repeated.join(", ")} appear more than once in the panel ${panel.join(", ")}. Each judge votes once, so the repeats are dropped; list each judge once.`;
}

export const TIE_LOSES_VERDICT = "no verdict";

export function evenPanelTieOutcome(
  aggregator: AggregatorSpec | null | undefined,
  verdictKind: VerdictKind,
  tieBreak?: TieBreak | null,
  tieBreakLabel?: string | null,
): string | null {
  const resolved = aggregator ?? defaultAggregator(verdictKind);
  if (typeof resolved === "function" || resolved === "majority") {
    return TIE_LOSES_VERDICT;
  }
  if (resolved !== "mode") {
    return null;
  }
  return tieBreak ? (tieBreakLabel ?? null) : TIE_LOSES_VERDICT;
}

export function panelCompositionMessages(
  configuredPanel: readonly string[],
  targetModels: readonly string[],
  options: { strict?: boolean; tieOutcome?: string | null } = {},
): string[] {
  const { strict = false } = options;
  const tieOutcome =
    options.tieOutcome === undefined ? TIE_LOSES_VERDICT : options.tieOutcome;
  const messages: string[] = [];
  const duplicates = duplicateJudgesMessage(configuredPanel);
  if (duplicates !== null) {
    messages.push(duplicates);
  }
  const panel = [...new Set(configuredPanel.filter(Boolean))];
  if (panel.length > 0 && panel.length % 2 === 0 && tieOutcome !== null) {
    const consequence =
      tieOutcome === TIE_LOSES_VERDICT
        ? "Even panels can split with no majority"
        : `A split vote resolves as ${tieOutcome}`;
    messages.push(
      `Panel has an even number of judges (${panel.length}): ${panel.join(", ")}. ${consequence}; prefer an odd panel size.`,
    );
  }
  const families = new Set(panel.map(providerFamily));
  const known = [...families].filter((f) => f !== "unknown");
  if (panel.length > 1 && !families.has("unknown") && known.length === 1) {
    messages.push(
      `Panel judges are all from a single provider family (${known[0]}): ${panel.join(", ")}. Correlated judges do not add the diversity a jury is meant to provide; prefer an odd, mixed-provider panel.`,
    );
  }
  const targetFamilies = new Set(targetModels.map(providerFamily));
  const shared = known.filter((f) => targetFamilies.has(f));
  // A lone judge has no diversity decision to act on unless the user opted
  // into strict panels, where self-judging is a configuration error.
  if (shared.length > 0 && (panel.length > 1 || strict)) {
    const offenders = panel.filter((m) => shared.includes(providerFamily(m)));
    messages.push(
      `Judge(s) ${offenders.join(", ")} share the target provider family (${[...shared].sort().join(", ")}). Same-family self-judging may bias verdicts toward the target's own provider; prefer judges from a different provider than the target.`,
    );
  }
  return messages;
}

export function resolvePanel(panel: readonly string[]): string[] {
  const resolved = [...new Set(panel.filter(Boolean))];
  if (resolved.length === 0) {
    throw new Error("judge panel must contain at least one model");
  }
  return resolved;
}
