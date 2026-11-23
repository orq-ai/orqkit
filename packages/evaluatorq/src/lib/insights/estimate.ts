import type { ModelInfo } from "../common/model-catalogue.js";
import {
  CHARS_PER_ESTIMATED_TOKEN,
  effectiveTraceInputChars,
  isJevModel,
  JEV_STATE_ALL_QUESTIONS_CHARS,
} from "../common/model-input.js";
import { listManifests } from "../common/run-manifest.js";
import type { FacetCatalogue, FacetSelection } from "../trace-finder/models.js";
import {
  MAX_TRACE_INPUT_CHARS,
  MIN_TRACE_INPUT_CHARS,
} from "../trace-finder/settings.js";
import type { DimensionName } from "./models.js";
import { SUMMARY_MAX_TOKENS } from "./summarize.js";

export interface TraceBound {
  n: number | null;
  exact: boolean;
  basis: string;
}
export interface StageTiming {
  seconds: number;
  parallelism: number | null;
  runs: number;
}
export interface StageEstimate {
  name: string;
  tracesLow: number;
  tracesHigh: number;
  tokensIn: number;
  tokensOut: number;
  costLow: number | null;
  costHigh: number | null;
  secondsLow: number | null;
  secondsHigh: number | null;
  basis: string;
}
export interface RunEstimate {
  bound: TraceBound;
  rows: StageEstimate[];
  costLow: number | null;
  costHigh: number | null;
  costPartial: boolean;
  secondsLow: number | null;
  secondsHigh: number | null;
  timePartial: boolean;
  timeNote: string | null;
  timeBasis: string;
  unknowns: string[];
  excluded: readonly string[];
}
export function traceBound(
  source: "recent" | "query" | "finder" | "snapshot",
  options: {
    catalogue: FacetCatalogue;
    facets: FacetSelection;
    limit: number;
    finderCount: number | null;
    snapshotCount: number | null;
  },
): TraceBound {
  if (source === "finder" || source === "snapshot") {
    const n = source === "finder" ? options.finderCount : options.snapshotCount,
      what =
        source === "finder"
          ? "matched traces in the export"
          : "traces in the local file";
    return {
      n,
      exact: n !== null,
      basis: n === null ? `${what} unknown` : what,
    };
  }
  const fields = [
    ["project", "project"],
    ["model", "model"],
    ["provider", "provider"],
    ["status", "status"],
    ["product", "product"],
    ["trace_type", "traceType"],
    ["agent_name", "agentName"],
    ["tool_name", "toolName"],
  ] as const;
  const selected = fields.filter(([, key]) => options.facets[key].size > 0),
    capped = `the trace limit of ${options.limit}`;
  if (
    options.facets.projectId !== null &&
    !selected.some(([name]) => name === "project")
  )
    return {
      n: options.limit,
      exact: false,
      basis: `${capped}; a project id filter has no count`,
    };
  for (const name of selected.length
    ? selected.map(([value]) => value)
    : ["status"])
    if (
      options.catalogue.truncatedFacets.has(name as never) ||
      !options.catalogue.valueCounts[name]
    )
      return {
        n: options.limit,
        exact: false,
        basis: `${capped}; ${name} counts are incomplete`,
      };
  if (!selected.length)
    return {
      n: Math.min(
        Object.values(options.catalogue.valueCounts.status ?? {}).reduce(
          (sum, value) => sum + value,
          0,
        ),
        options.limit,
      ),
      exact: false,
      basis: `status counts, up to ${capped}`,
    };
  const sums = selected
    .map(
      ([name, key]) =>
        [
          name,
          [...options.facets[key]].reduce(
            (sum, value) =>
              sum + (options.catalogue.valueCounts[name]?.[value] ?? 0),
            0,
          ),
        ] as const,
    )
    .sort((a, b) => a[1] - b[1]);
  const [name, n] = sums[0] as readonly [string, number];
  return {
    n: Math.min(n, options.limit),
    exact: false,
    basis:
      selected.length === 1
        ? `selected ${name} values, up to ${capped}`
        : `smallest of the selected facet sums (${name}), up to ${capped}`,
  };
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    i = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[i] as number)
    : ((sorted[i - 1] as number) + (sorted[i] as number)) / 2;
};
export async function stageSeconds(
  directory: string,
): Promise<Record<string, StageTiming>> {
  const samples = new Map<string, [number, number | null][]>();
  for (const manifest of await listManifests(directory))
    if (manifest.surface === "insights")
      for (const stage of manifest.stages) {
        if (
          stage.status !== "completed" ||
          stage.endedAt === null ||
          !stage.total ||
          stage.startedAt === null
        )
          continue;
        const elapsed =
          (stage.endedAt.getTime() - stage.startedAt.getTime()) / 1000;
        if (elapsed < 0) continue;
        const items = samples.get(stage.name) ?? [];
        items.push([elapsed / stage.total, manifest.parallelism]);
        samples.set(stage.name, items);
      }
  return Object.fromEntries(
    [...samples].map(([name, values]) => {
      const normalized = values.flatMap(([seconds, parallelism]) =>
        parallelism ? [seconds * parallelism] : [],
      );
      return [
        name,
        normalized.length
          ? {
              seconds: median(normalized),
              parallelism: 1,
              runs: normalized.length,
            }
          : {
              seconds: median(values.map(([seconds]) => seconds)),
              parallelism: null,
              runs: values.length,
            },
      ];
    }),
  );
}
export async function estimateRun(options: {
  bound: TraceBound;
  dimensions: readonly DimensionName[];
  questionCount: number;
  coding: boolean;
  models: { summary: string; classifier: string; embedding: string };
  prices: Readonly<Record<string, ModelInfo | null>>;
  seconds: Readonly<Record<string, StageTiming>>;
  parallelism: number;
  query: boolean;
  sentimentSelected?: boolean;
  traceInputChars?: number;
}): Promise<RunEstimate> {
  const cap = options.traceInputChars ?? (await effectiveTraceInputChars());
  if (cap < MIN_TRACE_INPUT_CHARS || cap > MAX_TRACE_INPUT_CHARS)
    throw new RangeError(
      `trace_input_chars must be between ${MIN_TRACE_INPUT_CHARS} and ${MAX_TRACE_INPUT_CHARS} characters`,
    );
  const n = options.bound.n,
    unknowns: string[] = [];
  if (n === null) unknowns.push(`traces: ${options.bound.basis}`);
  const high = n ?? 0,
    laterLow = options.query ? 0 : high,
    labelIn = Math.floor(
      (isJevModel(options.models.classifier)
        ? Math.min(cap, JEV_STATE_ALL_QUESTIONS_CHARS)
        : cap) / CHARS_PER_ESTIMATED_TOKEN,
    ),
    summaryIn = Math.floor(cap / CHARS_PER_ESTIMATED_TOKEN),
    answers =
      options.questionCount +
      Number(
        options.dimensions.includes("sentiment") && !options.sentimentSelected,
      ) +
      Number(options.query),
    num = (value: number) => value.toLocaleString("en-US");
  if (options.coding)
    unknowns.push(
      "cost: coding tool activity may require additional classifier chunks",
    );
  const plan: [string, string, number, number, number, string][] = [];
  if (answers)
    plan.push([
      "label",
      options.models.classifier,
      labelIn,
      4 * answers,
      high,
      `one classify call per trace: up to ${num(labelIn)} estimated input tokens at four characters per token for combined state and serialized questions, and ${answers} answer${answers === 1 ? "" : "s"} of 4 output tokens${options.query ? ", including the population-match answer" : ""}`,
    ]);
  if (options.coding)
    plan.push([
      "label_coding",
      options.models.classifier,
      labelIn,
      4,
      high,
      `baseline: one tool-activity classify request per coding trace (${num(labelIn)} input tokens, 4 output tokens); long activity can split into additional chunks`,
    ]);
  plan.push([
    "summary",
    options.models.summary,
    summaryIn,
    SUMMARY_MAX_TOKENS,
    laterLow,
    `up to ${num(summaryIn)} estimated input tokens at four characters per token, and up to ${num(SUMMARY_MAX_TOKENS)} output tokens (max_tokens)`,
  ]);
  for (const dimension of options.dimensions)
    plan.push([
      `dimension:${dimension}`,
      options.models.embedding,
      SUMMARY_MAX_TOKENS,
      0,
      laterLow,
      `one embedding per trace, up to ${num(SUMMARY_MAX_TOKENS)} tokens (summary length cap)`,
    ]);
  let unscaled = false;
  const rows = plan.map(([name, model, tokensIn, tokensOut, low, basis]) => {
    const price = options.prices[model],
      unit =
        n === null ||
        !price ||
        price.inputCostPer1k === null ||
        price.outputCostPer1k === null
          ? null
          : (price.inputCostPer1k * tokensIn +
              price.outputCostPer1k * tokensOut) /
            1000;
    if (n !== null && unit === null)
      unknowns.push(`cost: ${name} has no price for ${model}`);
    const timing = options.seconds[name === "label_coding" ? "label" : name];
    if (n !== null && !timing && Object.keys(options.seconds).length)
      unknowns.push(`time: ${name} has no earlier timing`);
    if (timing?.parallelism === null) unscaled = true;
    const scale =
      timing?.parallelism == null
        ? 1
        : timing.parallelism / Math.max(options.parallelism, 1);
    return {
      name,
      tracesLow: low,
      tracesHigh: high,
      tokensIn,
      tokensOut,
      costLow: unit === null ? null : unit * low,
      costHigh: unit === null ? null : unit * high,
      secondsLow: !timing || n === null ? null : timing.seconds * low * scale,
      secondsHigh: !timing || n === null ? null : timing.seconds * high * scale,
      basis,
    };
  });
  const priced = rows.filter((row) => row.costHigh !== null),
    timed = rows.filter((row) => row.secondsHigh !== null),
    earlier = Math.max(
      0,
      ...Object.values(options.seconds).map((timing) => timing.runs),
    );
  const firstNote = "estimated after your first run",
    parallelNote =
      "an earlier run did not record its parallelism, so its time is not scaled to the chosen parallelism",
    runs = `median per-trace time of up to ${earlier} earlier run${earlier === 1 ? "" : "s"}`,
    hasTimes = Object.keys(options.seconds).length > 0;
  return {
    bound: options.bound,
    rows,
    costLow: priced.length
      ? priced.reduce((sum, row) => sum + (row.costLow ?? 0), 0)
      : null,
    costHigh: priced.length
      ? priced.reduce((sum, row) => sum + (row.costHigh ?? 0), 0)
      : null,
    costPartial: priced.length !== rows.length,
    secondsLow: timed.length
      ? timed.reduce((sum, row) => sum + (row.secondsLow ?? 0), 0)
      : null,
    secondsHigh: timed.length
      ? timed.reduce((sum, row) => sum + (row.secondsHigh ?? 0), 0)
      : null,
    timePartial: Boolean(timed.length) && timed.length !== rows.length,
    timeNote: !hasTimes ? firstNote : unscaled ? parallelNote : null,
    timeBasis: !hasTimes
      ? firstNote
      : unscaled
        ? `${runs}, at the parallelism they used; rough`
        : `${runs}, assuming time falls in proportion to the ${options.parallelism} parallel requests; rough`,
    unknowns,
    excluded: [
      "trace selection (question compiling and filter choice)",
      "cluster naming and merging",
    ],
  };
}
