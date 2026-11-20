import { z } from "zod/v4";

import { pythonStrip } from "../../common/sanitize.js";
import { parseIso } from "../../formats/time.js";
import { signalInteger } from "../../signals/models.js";
import {
  type CompiledQuery,
  CompiledQuerySchema,
  FACET_NAMES,
  type PopulationRequest,
  type RunRequest,
  RunRequestSchema,
} from "../../trace-finder/models.js";
import {
  MAX_LIMIT,
  MAX_PARALLELISM,
  MAX_WINDOW_DAYS,
  MIN_LIMIT,
  MIN_PARALLELISM,
  MIN_WINDOW_DAYS,
} from "../../trace-finder/settings.js";

type Form = URLSearchParams;

const DAY_MICROS = 86_400_000_000n;
export const MAX_RANGE_MICROS = 30n * DAY_MICROS;

const bounded = (min: number, max: number) =>
  signalInteger.refine((value) => value >= min && value <= max);
const optionalCount = signalInteger
  .refine((value) => value >= 0)
  .nullable()
  .default(null);

export const FinderRunFormSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["immediate", "review"]).default("immediate"),
  windowDays: bounded(MIN_WINDOW_DAYS, MAX_WINDOW_DAYS),
  limit: bounded(MIN_LIMIT, MAX_LIMIT),
  parallelism: bounded(MIN_PARALLELISM, MAX_PARALLELISM),
  tokensMin: optionalCount,
  tokensMax: optionalCount,
  durationMsMin: optionalCount,
  durationMsMax: optionalCount,
});

export function formValues(form: Form, name: string): string[] {
  return form.getAll(name).filter((value) => value !== "");
}

function optionalValue(form: Form, name: string): string | null {
  const raw = form.get(name);
  return raw === null || raw === "" ? null : raw;
}

export function rangeValues(form: Form): [string, string] {
  const values = (["from", "to"] as const).map((name) => {
    const date = form.get(name) || "";
    const time = form.get(`${name}_time`);
    return time !== null && !date.includes("T") ? `${date}T${time}` : date;
  });
  return [values[0] as string, values[1] as string];
}

/** Minutes east of UTC for a browser `getTimezoneOffset()` value; throws if unusable. */
export function browserOffsetMinutes(value: string | null): number {
  const text = pythonStrip(value ?? "");
  if (!/^[+-]?\d(?:_?\d)*$/.test(text))
    throw new Error(`'${value ?? ""}' is not a usable timezone offset`);
  const minutes = -Number(text.replaceAll("_", ""));
  if (Math.abs(minutes) >= 24 * 60)
    throw new Error(`'${value}' is not a usable timezone offset`);
  return minutes;
}

function localMicros(value: string, offsetMinutes: number): bigint {
  const p = parseIso(value);
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, 0);
  return (
    BigInt(d.getTime()) * 1000n +
    BigInt(p.microsecond) -
    BigInt(offsetMinutes) * 60_000_000n
  );
}

export function utcIso(micros: bigint): string {
  const millis = micros / 1000n - (micros % 1000n < 0n ? 1n : 0n);
  const micro = Number(((micros % 1_000_000n) + 1_000_000n) % 1_000_000n);
  const base = new Date(Number(millis)).toISOString().slice(0, 19);
  return `${base}${micro ? `.${String(micro).padStart(6, "0")}` : ""}+00:00`;
}

/** Read an ISO local timestamp at a fixed offset (minutes east of UTC) as UTC microseconds. */
export function localToUtc(value: string, offsetMinutes: number): bigint {
  return localMicros(value, offsetMinutes);
}

export function parseRange(
  fromValue: string,
  toValue: string,
  tzOffset: string | null,
  fromTzOffset: string | null = null,
  toTzOffset: string | null = null,
): [bigint, bigint] {
  const zoneFor = (value: string | null) => {
    try {
      return browserOffsetMinutes(value);
    } catch {
      console.warn(
        `Explorer time range has no usable browser offset '${value}'; reading it as UTC`,
      );
      return 0;
    }
  };
  const startZone = zoneFor(fromTzOffset ?? tzOffset);
  const endZone = zoneFor(toTzOffset ?? tzOffset);
  let start: bigint;
  let end: bigint;
  try {
    if (!fromValue.includes("T") || !toValue.includes("T"))
      throw new Error("A time is required at each end.");
    start = localToUtc(fromValue, startZone);
    end = localToUtc(toValue, endZone);
  } catch {
    throw new Error("From and To must be full dates and times.");
  }
  if (start >= end) throw new Error("From must be before To.");
  if (end - start > MAX_RANGE_MICROS)
    throw new Error(
      "The time range can be at most 30 days, the API retention.",
    );
  return [start, end];
}

const nowMicros = () => BigInt(Date.now()) * 1000n;
const isoMicros = (value: string) => {
  const p = parseIso(value);
  return localMicros(value, (p.offsetSeconds ?? 0) / 60);
};

export function runRequest(
  form: Form,
  settings: {
    windowDays: number;
    limit: number;
    parallelism: number;
    orqProjectId: string | null;
  },
  options: {
    anchor?: PopulationRequest | null;
    queryFallback?: string | null;
  } = {},
): RunRequest {
  const { anchor = null, queryFallback = null } = options;
  const parsed = FinderRunFormSchema.parse({
    query: pythonStrip(form.get("query") || queryFallback || ""),
    mode: form.get("mode") || "immediate",
    windowDays: form.get("window_days") || settings.windowDays,
    limit: form.get("limit") || settings.limit,
    parallelism: form.get("parallelism") || settings.parallelism,
    tokensMin: optionalValue(form, "tokens_min"),
    tokensMax: optionalValue(form, "tokens_max"),
    durationMsMin: optionalValue(form, "duration_ms_min"),
    durationMsMax: optionalValue(form, "duration_ms_max"),
  });
  const windowMicros = BigInt(parsed.windowDays) * DAY_MICROS;
  let timeOrigin = form.get("time_origin") || "";
  let start: bigint;
  let end: bigint;
  if (anchor !== null && anchor.end !== null) {
    end = isoMicros(anchor.end);
    start =
      anchor.start !== null ? isoMicros(anchor.start) : end - windowMicros;
    timeOrigin = anchor.timeOrigin;
  } else if (timeOrigin === "within_results") {
    end = nowMicros();
    start = end - windowMicros;
  } else if (
    (form.get("new_from") && form.get("new_to")) ||
    (form.get("from") && form.get("to"))
  ) {
    if (form.get("new_from") && form.get("new_to"))
      [start, end] = parseRange(
        form.get("new_from") as string,
        form.get("new_to") as string,
        "0",
        form.get("new_from_tz_offset") || "0",
        form.get("new_to_tz_offset") || "0",
      );
    else
      [start, end] = parseRange(
        ...rangeValues(form),
        form.get("tz_offset") || "0",
        form.get("from_tz_offset") || null,
        form.get("to_tz_offset") || null,
      );
    if (timeOrigin !== "default") timeOrigin = "explicit";
  } else {
    end = nowMicros();
    start = end - windowMicros;
    timeOrigin = "default";
  }
  const facets: Record<string, unknown> = {
    project_id: settings.orqProjectId,
  };
  for (const name of FACET_NAMES)
    facets[name] = [...new Set(formValues(form, `facet_${name}`))];
  return RunRequestSchema.parse({
    query: parsed.query,
    mode: parsed.mode,
    population: {
      start: utcIso(start),
      end: utcIso(end),
      time_origin: ["default", "explicit", "within_results"].includes(
        timeOrigin,
      )
        ? timeOrigin
        : "explicit",
      facets,
      numeric: {
        tokens_min: parsed.tokensMin,
        tokens_max: parsed.tokensMax,
        duration_ms_min: parsed.durationMsMin,
        duration_ms_max: parsed.durationMsMax,
      },
      limit: parsed.limit,
    },
    parallelism: parsed.parallelism,
  });
}

const pyFloat = (raw: unknown): number => {
  if (typeof raw === "number") return raw;
  const text = pythonStrip(String(raw)).replaceAll("_", "");
  if (/^[+-]?inf(inity)?$/i.test(text))
    return text.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return Number.NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text))
    throw new Error(`could not convert string to float: '${raw}'`);
  return Number(text);
};

const casefold = (value: string) => value.toLowerCase();

export function compiledFromForm(
  current: CompiledQuery,
  form: Form,
  prefix: string,
): CompiledQuery {
  const currentTask = current.task;
  const kind = currentTask.kind;
  const field = (name: string) => form.get(`${prefix}${name}`);
  const instructions = pythonStrip(
    field("instructions") || currentTask.instructions,
  );
  const old = currentTask.criteria;
  let criteria: Record<string, string> | string[] | null;
  if (kind === "choice") {
    let pairs: [string, string][] = [];
    if (old !== null && !Array.isArray(old))
      Object.entries(old).forEach(([oldLabel, oldDescription], index) => {
        pairs.push([
          pythonStrip(field(`criteria_label_${index}`) || oldLabel),
          pythonStrip(
            field(`criteria_description_${index}`) || oldDescription || "",
          ),
        ]);
      });
    if (!pairs.length && Array.isArray(old))
      pairs = old.map((description, index) => [
        `option_${index + 1}`,
        String(description),
      ]);
    if (!pairs.length)
      pairs = [
        ["yes", "The request is satisfied."],
        ["no", "The request is not satisfied."],
      ];
    criteria = Object.fromEntries(pairs);
  } else if (kind === "score") {
    let existing: string[] = Array.isArray(old) ? old : [];
    if (!existing.length && old !== null && !Array.isArray(old))
      existing = Object.values(old).map((value) => value as string);
    criteria = existing.map((description, index) =>
      pythonStrip(
        field(`score_criteria_${index}`) ||
          field(`criteria_${index}`) ||
          String(description),
      ),
    );
    if (!criteria.length) criteria = ["Low match", "High match"];
  } else criteria = null;

  const rawNoul = field("noul_threshold");
  const threshold = pyFloat(
    rawNoul === null || rawNoul === "" ? currentTask.noulThreshold : rawNoul,
  );
  const values = formValues(form, `${prefix}selection_value`).length
    ? formValues(form, `${prefix}selection_value`)
    : formValues(form, `${prefix}selection_values`);
  const currentValues =
    current.selection.kind === "values" ? current.selection.values : [];
  let selection: Record<string, unknown>;
  if (kind === "choice") {
    const labels = Object.keys(criteria as Record<string, string>);
    let selected: (string | boolean)[] = values.filter((v) =>
      labels.includes(v),
    );
    if (!selected.length)
      selected = currentValues.filter(
        (v) => typeof v === "string" && labels.includes(v),
      );
    selection = {
      kind: "values",
      values: selected.length ? selected : [labels[0]],
    };
  } else if (kind === "noul") {
    let selected: boolean[] = values
      .filter((v) => ["true", "false"].includes(casefold(v)))
      .map((v) => casefold(v) === "true");
    if (!selected.length)
      selected = currentValues.filter(
        (v): v is boolean => typeof v === "boolean",
      );
    selection = {
      kind: "values",
      values: selected.length ? selected : [false],
    };
  } else {
    const rule = field("selection_rule") || "";
    let operator: string;
    let scoreThreshold: number;
    if (rule.includes(":")) {
      const at = rule.indexOf(":");
      operator = rule.slice(0, at);
      scoreThreshold = pyFloat(rule.slice(at + 1));
    } else {
      operator =
        field("selection_operator") ||
        (current.selection.kind === "threshold"
          ? current.selection.operator
          : "gte");
      let raw = field("selection_threshold");
      if (raw === null || raw === "") raw = field("selection_value");
      scoreThreshold =
        raw === null || raw === ""
          ? current.selection.kind === "threshold"
            ? current.selection.value
            : 0.5
          : pyFloat(raw);
    }
    selection = { operator, value: scoreThreshold, kind: "threshold" };
  }
  const name = pythonStrip(field("name") || current.name) || current.name;
  return CompiledQuerySchema.parse({
    name,
    task: {
      kind,
      instructions,
      criteria,
      noulThreshold: threshold,
      state: {},
    },
    selection,
  });
}
