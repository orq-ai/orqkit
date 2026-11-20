import type OpenAI from "openai";
import { z } from "zod/v4";

import { pyG } from "../common/reports/number-format.js";
import { pythonCasefold, pythonStrip } from "../common/sanitize.js";
import { generateStructured } from "../common/structured-output.js";
import { TraceTimestampSchema } from "../common/trace-document.js";
import { type LLMCallConfig, type Usage, UsageSchema } from "../contracts.js";
import {
  signalBoolean,
  signalFloat,
  signalInteger,
  signalModel,
} from "../signals/models.js";
import { pythonRegexEngine } from "../signals/python-regex.js";
import { enabled as debugEnabled } from "./debug.js";
import {
  type CompiledQuery,
  CompiledQuerySchema,
  type LegendItem,
  LegendItemSchema,
  MAX_DIMENSIONS,
  NumericFilters,
  NumericFiltersSchema,
  type PopulationRequest,
  timeMicros,
} from "./models.js";
import { fromMicroseconds } from "./rows.js";

export const CHOICE_PALETTE = Object.freeze([
  "var(--chart-5)",
  "var(--chart-2)",
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
]);
export class CompileError extends Error {
  override readonly name = "CompileError";
}
const DAY = 86400000000n;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
function utc(value: string | Date): string {
  const instant = TraceTimestampSchema.pipe(z.string()).parse(value);
  const result = fromMicroseconds(timeMicros(instant));
  if (result === null)
    throw new RangeError("datetime is outside years 1 to 9999");
  return result;
}
function shifted(value: string, delta: bigint): string {
  const result = fromMicroseconds(timeMicros(value) + delta);
  if (result === null)
    throw new RangeError("datetime is outside years 1 to 9999");
  return result;
}
function calendarBound(value: unknown, end: boolean): unknown {
  return typeof value === "string" && dateOnly.test(value)
    ? end
      ? shifted(utc(`${value}T00:00:00Z`), DAY)
      : `${value}T00:00:00Z`
    : value;
}
export const TimeFiltersSchema = z
  .preprocess(
    (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return value;
      const row = value as Record<string, unknown>;
      return {
        ...row,
        ...(typeof row.end === "string" && dateOnly.test(row.end)
          ? { calendarDay: true, calendar_day: true }
          : {}),
        ...(Object.hasOwn(row, "start")
          ? { start: calendarBound(row.start, false) }
          : {}),
        ...(Object.hasOwn(row, "end")
          ? { end: calendarBound(row.end, true) }
          : {}),
      };
    },
    signalModel(
      {
        start: TraceTimestampSchema.transform((value) =>
          value === null ? null : utc(value),
        ),
        end: TraceTimestampSchema.transform((value) =>
          value === null ? null : utc(value),
        ),
        calendarDay: signalBoolean.default(false),
      },
      true,
    ),
  )
  .superRefine((value, ctx) => {
    if (
      value.start !== null &&
      value.end !== null &&
      timeMicros(value.start) > timeMicros(value.end)
    )
      ctx.addIssue({
        code: "custom",
        message: "start must be less than or equal to end",
      });
  });
export type TimeFiltersFields = z.infer<typeof TimeFiltersSchema>;
export class TimeFilters implements TimeFiltersFields {
  declare readonly start: string | null;
  declare readonly end: string | null;
  declare readonly calendarDay: boolean;
  constructor(value: unknown = {}) {
    Object.assign(this, TimeFiltersSchema.parse(value));
    Object.freeze(this);
  }
}
export function canonicalGeneratedEnd(
  generated: TimeFilters,
  options: { selectorOutput?: boolean } = {},
): string | null {
  const { start, end } = generated;
  if (
    options.selectorOutput &&
    generated.calendarDay &&
    start !== null &&
    end !== null
  ) {
    const day = end.slice(0, 10),
      midnight = shifted(`${day}T00:00:00Z`, DAY),
      endTime = end.slice(11);
    if (
      start.slice(11) === "00:00:00Z" &&
      timeMicros(start) < timeMicros(midnight) &&
      ["23:59:59Z", "23:59:59.999999Z"].includes(endTime)
    )
      return midnight;
  }
  return end;
}
export function normalizeGeneratedTime(
  generated: TimeFilters | null,
  options: {
    population: PopulationRequest;
    withinResults: boolean;
    reference: string | Date;
    defaultWindowDays?: number;
    selectorOutput?: boolean;
  },
): readonly [string, string] | null {
  const reference = utc(options.reference);
  if (generated === null) return null;
  const retention = shifted(
      reference,
      -BigInt(Math.trunc((options.defaultWindowDays ?? 30) * 86400000000)),
    ),
    maximum = (a: string, b: string) => (timeMicros(a) > timeMicros(b) ? a : b),
    minimum = (a: string, b: string) => (timeMicros(a) < timeMicros(b) ? a : b),
    start = maximum(generated.start ?? retention, retention),
    end = minimum(
      canonicalGeneratedEnd(generated, options) ??
        options.population.end ??
        reference,
      reference,
    );
  if (
    options.withinResults ||
    options.population.timeOrigin === "within_results"
  )
    return Object.freeze([
      options.population.start === null
        ? start
        : maximum(options.population.start, start),
      options.population.end === null
        ? end
        : minimum(options.population.end, end),
    ]);
  if (options.population.timeOrigin === "explicit") return null;
  return Object.freeze([start, end]);
}
const nonempty = z.string().refine((value) => Array.from(value).length >= 1);
const probability = signalFloat.pipe(z.number().min(0).max(1));
export const WireCriterionSchema = z.strictObject({
  label: nonempty,
  description: nonempty,
});
export const WireNumericSchema = z.strictObject({
  tokens_min: signalInteger.pipe(z.number().int().min(0)).nullable(),
  tokens_max: signalInteger.pipe(z.number().int().min(0)).nullable(),
  duration_ms_min: signalInteger.pipe(z.number().int().min(0)).nullable(),
  duration_ms_max: signalInteger.pipe(z.number().int().min(0)).nullable(),
});
export const WireTaskSchema = z.strictObject({
  kind: z.enum(["choice", "noul", "score"]),
  instructions: nonempty,
  choice_criteria: z.array(WireCriterionSchema).nullable(),
  score_criteria: z.array(z.string()).nullable(),
  noul_threshold: probability,
});
export const WireValueSelectionSchema = z.strictObject({
  kind: z.literal("values"),
  values: z.array(z.union([z.string(), z.boolean()])).min(1),
});
export const WireThresholdSelectionSchema = z.strictObject({
  kind: z.literal("threshold"),
  operator: z.enum(["gte", "lte"]),
  value: probability,
});
export const WireDimensionSchema = z.strictObject({
  name: nonempty
    .refine((value) => Array.from(value).length <= 40)
    .transform(pythonStrip)
    .refine((value) => value.length > 0, "dimension name must not be blank"),
  task: WireTaskSchema,
  selection: z.union([WireValueSelectionSchema, WireThresholdSelectionSchema]),
});
export type WireDimension = z.infer<typeof WireDimensionSchema>;
export const CompilerWireQuerySchema = z.strictObject({
  dimensions: z.array(WireDimensionSchema),
  numeric: WireNumericSchema,
  calendar_day: z.boolean(),
  start: z.union([z.string(), z.number()]).nullable(),
  end: z.union([z.string(), z.number()]).nullable(),
  unsupported_reason: z
    .string()
    .refine((value) => Array.from(value).length <= 200)
    .nullable(),
});
const CompilerResponseSchema = CompilerWireQuerySchema.extend({
  dimensions: z.array(
    WireDimensionSchema.extend({
      name: z
        .string()
        .refine(
          (value) =>
            Array.from(value).length >= 1 &&
            Array.from(value).length <= 40 &&
            pythonStrip(value).length > 0,
        )
        .meta({ minLength: 1, maxLength: 40 }),
    }),
  ),
  start: z.iso.datetime({ offset: true }).nullable(),
  end: z.iso.datetime({ offset: true }).nullable(),
});
export type CompilerWireQuery = z.infer<typeof CompilerWireQuerySchema>;
export function dimensionToDomain(input: unknown): CompiledQuery {
  const wire = WireDimensionSchema.parse(input),
    task = wire.task;
  let criteria: Record<string, string> | readonly string[] | null = null;
  if (task.kind === "choice") {
    if (task.choice_criteria === null || task.score_criteria !== null)
      throw new TypeError(
        "choice requires choice_criteria and null score_criteria",
      );
    criteria = Object.fromEntries(
      task.choice_criteria.map((item) => [item.label, item.description]),
    );
    if (Object.keys(criteria).length !== task.choice_criteria.length)
      throw new TypeError("choice labels must be unique");
  } else if (task.kind === "score") {
    if (task.score_criteria === null || task.choice_criteria !== null)
      throw new TypeError(
        "score requires score_criteria and null choice_criteria",
      );
    criteria = task.score_criteria;
  } else if (task.choice_criteria !== null || task.score_criteria !== null)
    throw new TypeError(
      "noul requires null choice_criteria and score_criteria",
    );
  let selection = wire.selection;
  if (selection.kind === "values") {
    let values = selection.values;
    const booleans: Record<string, boolean> = {
      yes: true,
      true: true,
      no: false,
      false: false,
    };
    if (
      task.kind === "noul" &&
      values.every(
        (value) =>
          typeof value === "string" &&
          Object.hasOwn(booleans, pythonCasefold(value)),
      )
    ) {
      console.warn(
        "trace query compiler returned string boolean selections; converting them",
      );
      values = values.map(
        (value) => booleans[pythonCasefold(String(value))] as boolean,
      );
    }
    const selected = new Set(values);
    if (
      task.kind === "choice" &&
      criteria !== null &&
      Object.keys(criteria).length === selected.size &&
      Object.keys(criteria).every((key) => selected.has(key))
    )
      throw new TypeError(
        `dimension '${wire.name}': selection must list only the answers the user is looking for, not every label`,
      );
    if (
      task.kind === "noul" &&
      selected.size === 2 &&
      selected.has(true) &&
      selected.has(false)
    )
      throw new TypeError(
        `dimension '${wire.name}': selection must list only the answers the user is looking for, not both true and false`,
      );
    selection = { kind: "values", values };
  }
  return CompiledQuerySchema.parse({
    name: wire.name,
    task: {
      kind: task.kind,
      instructions: task.instructions,
      criteria,
      noulThreshold: task.noul_threshold,
      state: {},
    },
    selection,
  });
}
export function compilerToDomain(
  input: unknown,
): readonly [readonly CompiledQuery[], NumericFilters] {
  const wire = CompilerWireQuerySchema.parse(input);
  if (wire.dimensions.length > MAX_DIMENSIONS)
    throw new TypeError(
      `compiler returned ${wire.dimensions.length} dimensions; maximum is ${MAX_DIMENSIONS}`,
    );
  const names = wire.dimensions.map((d) => pythonCasefold(d.name));
  if (new Set(names).size !== names.length)
    throw new TypeError("dimension names must be unique");
  const numeric = new NumericFilters(wire.numeric);
  return Object.freeze([
    Object.freeze(wire.dimensions.map(dimensionToDomain)),
    numeric,
  ]);
}
export const CompiledPlanSchema = signalModel(
  {
    dimensions: z.array(CompiledQuerySchema).max(MAX_DIMENSIONS).readonly(),
    numeric: NumericFiltersSchema.transform(
      (value) => new NumericFilters(value),
    ),
    time: TimeFiltersSchema.transform((value) => new TimeFilters(value))
      .nullable()
      .default(null),
    unsupportedReason: z.string().nullable().default(null),
    usages: z
      .array(
        z
          .custom<Usage>((value) => UsageSchema.safeParse(value).success)
          .transform((value) => UsageSchema.parse(value))
          .nullable(),
      )
      .readonly()
      .default(() => []),
  },
  true,
);
export interface CompiledPlanFields {
  readonly dimensions: readonly CompiledQuery[];
  readonly numeric: NumericFilters;
  readonly time: TimeFilters | null;
  readonly unsupportedReason: string | null;
  readonly usages: readonly (Usage | null)[];
}
export class CompiledPlan implements CompiledPlanFields {
  declare readonly dimensions: readonly CompiledQuery[];
  declare readonly numeric: NumericFilters;
  declare readonly time: TimeFilters | null;
  declare readonly unsupportedReason: string | null;
  declare readonly usages: readonly (Usage | null)[];
  constructor(value: unknown) {
    Object.assign(this, CompiledPlanSchema.parse(value));
    Object.freeze(this);
  }
  toJSON() {
    return {
      dimensions: this.dimensions,
      numeric: this.numeric,
      time: this.time,
      unsupportedReason: this.unsupportedReason,
    };
  }
}
const STRICT_TOKEN_MIN =
    /\b(?:over|above|more than|greater than)\s+(\d[\d,]*(?:\.\d+)?)\s*([km]?)\s*(?:total\s+)?tokens?\b/gi,
  STRICT_TOKEN_MAX =
    /\b(?:under|below|less than|fewer than)\s+(\d[\d,]*(?:\.\d+)?)\s*([km]?)\s*(?:total\s+)?tokens?\b/gi,
  STRICT_DURATION_MIN =
    /\b(?:slower than|longer than|over|more than)\s+(\d[\d,]*(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s)\b/gi,
  STRICT_DURATION_MAX =
    /\b(?:faster than|shorter than|under|less than|below)\s+(\d[\d,]*(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s)\b/gi;
function decimalBoundary(
  text: string,
  multiplier: number,
  lower: boolean,
): number {
  const digits = Array.from(text, (char) => {
    if (!/\p{Decimal_Number}/u.test(char)) return char;
    const code = char.codePointAt(0) as number;
    let first = code;
    while (
      first > 0 &&
      /\p{Decimal_Number}/u.test(String.fromCodePoint(first - 1))
    )
      first--;
    return String((code - first) % 10);
  }).join("");
  const [whole, fraction = ""] = digits.replaceAll(",", "").split("."),
    scale = 10n ** BigInt(fraction.length),
    numerator = BigInt((whole ?? "") + fraction) * BigInt(multiplier),
    quotient = numerator / scale,
    remainder = numerator % scale;
  return Number(lower ? quotient + 1n : quotient + (remainder ? 1n : 0n) - 1n);
}
export function tightenStrictBounds(
  query: string,
  numeric: NumericFilters,
): NumericFilters {
  const updates: Partial<Record<keyof NumericFilters, number>> = {};
  for (const [pattern, key, lower, tokens] of [
    [STRICT_TOKEN_MIN, "tokensMin", true, true],
    [STRICT_TOKEN_MAX, "tokensMax", false, true],
    [STRICT_DURATION_MIN, "durationMsMin", true, false],
    [STRICT_DURATION_MAX, "durationMsMax", false, false],
  ] as const) {
    if (numeric[key] === null) continue;
    const expression = pythonRegexEngine(`(?i)${pattern.source}`);
    for (const match of query.matchAll(
      new RegExp(expression.source, `${expression.flags}g`),
    )) {
      const unit = (match[2] ?? "").toLowerCase(),
        multiplier = tokens
          ? unit === "k"
            ? 1000
            : unit === "m"
              ? 1000000
              : 1
          : unit === "ms" || unit.startsWith("milli") || unit.startsWith("msec")
            ? 1
            : 1000,
        boundary = decimalBoundary(match[1] as string, multiplier, lower),
        previous = updates[key] ?? numeric[key];
      updates[key] = lower
        ? Math.max(previous, boundary)
        : Math.min(previous, boundary);
    }
  }
  return Object.keys(updates).length
    ? new NumericFilters({ ...numeric, ...updates })
    : numeric;
}
export function classificationLegend(
  compiled: CompiledQuery,
): readonly LegendItem[] {
  if (compiled.task.kind === "choice") {
    if (!compiled.task.criteria || Array.isArray(compiled.task.criteria))
      throw new Error("validated choice tasks must have label criteria");
    return Object.freeze(
      Object.keys(compiled.task.criteria).map((label, index) =>
        LegendItemSchema.parse({ label, color: CHOICE_PALETTE[index] }),
      ),
    );
  }
  if (compiled.task.kind === "noul")
    return Object.freeze([
      LegendItemSchema.parse({ label: "false", color: "var(--chart-2)" }),
      LegendItemSchema.parse({ label: "true", color: "var(--chart-5)" }),
    ]);
  const threshold = compiled.selection;
  if (threshold.kind !== "threshold")
    throw new Error("validated score tasks must have threshold selections");
  return Object.freeze([
    LegendItemSchema.parse({
      label: "0.0 → 1.0",
      color: "linear-gradient(90deg, var(--chart-2), var(--chart-5))",
      kind: "gradient",
    }),
    LegendItemSchema.parse({
      label: `${threshold.operator} ${pyG(threshold.value)}`,
      color: "var(--text-strong)",
      kind: "threshold",
      threshold: threshold.value,
    }),
  ]);
}
export async function compileQuery(
  client: OpenAI,
  model: string,
  query: string,
  options: { config?: LLMCallConfig | null; now?: string | Date } = {},
): Promise<CompiledPlan> {
  const normalized = pythonStrip(query);
  if (!normalized)
    throw new TypeError("Enter a semantic trace query before compiling.");
  const current = utc(options.now ?? new Date()),
    usages: (Usage | null)[] = [],
    messages: { role: string; content: string }[] = [
      { role: "system", content: COMPILER_INSTRUCTIONS },
      {
        role: "user",
        content: `${normalized}\n\nCurrent UTC time: ${current.replace(/Z$/, "+00:00")}`,
      },
    ];
  if (debugEnabled())
    console.error(
      "Trace finder compiler request",
      model,
      JSON.stringify(messages),
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await generateStructured(client, {
      model,
      messages,
      responseFormat: {
        name: "CompilerWireQuery",
        schema: CompilerResponseSchema,
      },
      maxTokens: 2000,
      label: "trace_finder.compile",
      api: "responses",
      config: options.config,
    });
    usages.push(result.usage);
    if (result.parsed === null)
      throw new CompileError(
        `Compiler returned no structured task. Raw: ${Array.from(result.raw).slice(0, 300).join("")}`,
      );
    const wire = CompilerWireQuerySchema.parse(result.parsed);
    if (debugEnabled())
      console.error(
        "Trace finder compiler response",
        model,
        JSON.stringify(wire),
      );
    let error: unknown,
      errorKind = "an invalid plan";
    try {
      const [dimensions, extracted] = compilerToDomain(wire),
        time =
          wire.start !== null || wire.end !== null
            ? new TimeFilters({
                start: wire.start,
                end: wire.end,
                calendarDay: wire.calendar_day,
              })
            : null;
      let numeric: NumericFilters;
      try {
        numeric = tightenStrictBounds(normalized, extracted);
      } catch (cause) {
        errorKind = "contradictory numeric bounds";
        throw cause;
      }
      return new CompiledPlan({
        dimensions,
        numeric,
        time,
        unsupportedReason: pythonStrip(wire.unsupported_reason ?? "") || null,
        usages,
      });
    } catch (cause) {
      error = cause;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (attempt)
      throw new CompileError(`Compiler produced ${errorKind}: ${detail}`, {
        cause: error,
      });
    console.warn(
      `Trace query compiler returned an invalid plan; retrying: ${detail}`,
    );
    messages.push(
      { role: "assistant", content: result.raw || JSON.stringify(wire) },
      {
        role: "user",
        content: `Your plan was invalid: ${detail}. Correct it and return a valid plan.`,
      },
    );
  }
  throw new Error("unreachable compiler retry state");
}

export const COMPILER_INSTRUCTIONS =
  'Compile the user\'s request into zero to three semantic classification dimensions.\n\nEach dimension is one conversation judgment, shown to the user as its own table column, and a\ntrace matches only when every dimension matches. A separate filter step applies metadata filters\nunder the same rule you follow:\n\nMetadata filter or conversation judgment:\n- Use a metadata filter only for an exact value the user literally names (a project, model, provider, agent, tool, product or trace type) or for an explicit trace status request ("failed traces", "status error", "errored traces").\n- Anything that needs reading what happened in the conversation is a conversation judgment: a tool call failed or returned an error, the agent gave up, the user was frustrated, a hallucination, a refusal. Never also map it onto a status filter or any other metadata value.\n- When a word could be either ("errors", "issues"), make it a conversation judgment and add no status filter, unless the user says status, failed trace or errored trace.\n- Aggregate questions (totals, averages, counts, rankings) cannot be answered by finding traces: use no filter and no judgment.\nExamples:\n- "failed traces" -> status filter; no judgment.\n- "tool errors" -> judgment "a tool call returned an error"; no status filter.\n- "gpt-5 traces where the user is angry" -> model filter gpt-5 and judgment "the user is angry".\n- "which model costs the most?" -> nothing; it is an aggregate question.\n\nReturn an empty dimensions list only when every part of the request is a metadata filter, a token\nor duration bound (extracted below), or an aggregate question. Any descriptive phrase about what\nthe trace is or does needs a dimension, even when it sounds like a category:\n"coding agents over 50k tokens" needs a dimension for "coding agent" plus tokens_min 50001,\nbecause no metadata field says which traces are coding agents. Use one dimension for one\njudgment and never split a single judgment across several; use two or three only when the\nrequest combines separate judgments. Never add more than three.\n\nSet unsupported_reason to one short sentence naming what cannot be answered when the request asks\nfor an aggregate (a total, average, count or ranking); otherwise null.\n\nGive each dimension a name of one to three words for its column header, such as "Frustrated" or\n"Unsupported claim". Generate only its semantic task and matching selection rule. Never generate,\ninfer, or filter by metadata facets inside a dimension.\nEach task judges one complete conversation; do not generate state. The adapter supplies it later.\nUse choice_criteria as a list of label/description objects for choice, otherwise null.\nUse score_criteria as a list of ordered descriptions for score, otherwise null.\nSet noul_threshold to a probability in [0, 1] (0.5 unless another cutoff is needed).\n\nChoose exactly one task kind per dimension:\n- choice: provide two to five meaningful, unique labels with exhaustive, non-overlapping\n  descriptions; selection.kind is values and every selected value is one of those labels.\n- noul: provide a binary semantic judgment; selection.kind is values and its values are booleans.\n- score: provide two to ten exhaustive, ordered criterion descriptions from least to most matching;\n  selection.kind is threshold with an inclusive gte or lte value from 0.0 to 1.0.\n\nWrite precise task instructions and criteria that directly answer the user\'s semantic request.\nThe selection lists only answers that satisfy the request: the traces the user is searching for.\nNever select a neutral, none, neither, other, normal, or appropriate label, or every label. For\nnegated requests such as "does not behave", "fails to", or "without X", select the failure or\nabsence label, not the healthy one. For noul, select [true] when true means the requested thing.\n\nExtract numeric constraints on total tokens and duration into numeric. Bounds are inclusive integer\ncounts, so strict phrases must move by one unit: "over 20k tokens" \u2192 tokens_min: 20001 and\n"slower than 30 seconds" \u2192 duration_ms_min: 30001. Likewise "under 20k tokens" \u2192 tokens_max:\n19999. A bare count with no unit ("above 50k") means total tokens. Keep all four numeric fields\nnull when the query does not mention a token or duration constraint. Extract explicit and relative\nperiods; leave both bounds null when no calendar-time constraint is requested. For whole-calendar-day\nrequests, set calendar_day true and use an exclusive next-day UTC midnight end, even when the\nunderlying date was expressed as a relative day. Set it false for any request with explicit clock-time\nsemantics; preserve those exact instants. A date-only bound is a whole calendar day, not a time-of-day.\nUse the supplied current UTC time to resolve relative periods; leave both bounds null when no\ncalendar-time constraint is requested and set calendar_day false when no calendar-time constraint\nis requested. Time bounds do not create semantic dimensions; descriptive language still does.';
