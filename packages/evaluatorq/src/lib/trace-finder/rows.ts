import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { getField } from "../common/fields.js";
import { pyRound } from "../common/reports/number-format.js";
import { pythonString, pythonStrip } from "../common/sanitize.js";
import { isoFromEpoch } from "../formats/otel.js";
import { parseIso } from "../formats/time.js";
import {
  signalBoolean,
  signalDictionary,
  signalFloat,
} from "../signals/models.js";

export interface TokenUsage {
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cached: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
  readonly exclusive: boolean;
}
const int = (value: unknown): number | null => {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value))
    throw new RangeError("Cannot convert non-finite value to an integer");
  return Math.trunc(value) || 0;
};
const float = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
const str = (value: unknown): string | null =>
  value == null || value === "" ? null : pythonString(value);
const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === "object"
      ? Object.keys(value).length > 0
      : Boolean(value));
const strs = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(truth).map(pythonString) : [];
export function summaryModels(summary: unknown, raw: unknown): string[] {
  const sources = [raw, summary];
  for (const source of sources) {
    const values = strs(getField(source, "models"));
    if (values.length) return values;
  }
  for (const source of sources) {
    const model = getField(source, "model");
    if (model != null && model !== "") {
      const values = strs(model);
      return values.length
        ? values
        : [str(model)].filter((v): v is string => v !== null && Boolean(v));
    }
    const attributes = getField(source, "attributes"),
      genAi = getField(attributes, "gen_ai"),
      request = getField(genAi, "request"),
      response = getField(genAi, "response");
    for (const value of [
      getField(request, "model"),
      getField(response, "model"),
      getField(genAi, "model"),
      getField(attributes, "gen_ai.request.model"),
      getField(attributes, "gen_ai.response.model"),
      getField(attributes, "model"),
    ])
      if (value != null && value !== "") {
        const values = strs(value);
        return values.length
          ? values
          : [str(value)].filter((v): v is string => v !== null && Boolean(v));
      }
  }
  return [];
}
export function responseModels(summary: unknown, raw: unknown): string[] {
  for (const source of [raw, summary]) {
    const attributes = getField(source, "attributes"),
      response = getField(getField(attributes, "gen_ai"), "response");
    for (const model of [
      getField(response, "model"),
      getField(attributes, "gen_ai.response.model"),
    ])
      if (model != null && model !== "") {
        const values = strs(model);
        return values.length
          ? values
          : [str(model)].filter((v): v is string => v !== null && Boolean(v));
      }
  }
  return [];
}
export function fromMicroseconds(epoch: bigint): string | null {
  const remainder = ((epoch % 1000000n) + 1000000n) % 1000000n,
    whole = (epoch - remainder) / 1000000n,
    date = new Date(Number(whole) * 1000),
    year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < 1 || year > 9999) return null;
  return (
    date.toISOString().slice(0, 19) +
    (remainder ? `.${String(remainder).padStart(6, "0")}` : "") +
    "Z"
  );
}
export function parseSummaryTime(value: unknown): string | null {
  try {
    if (value instanceof Date) return parseSummaryTime(value.toISOString());
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      const epoch = value > 10000000000 ? value / 1000 : value,
        whole = Math.floor(epoch),
        micro = pyRound((epoch - whole) * 1e6);
      return fromMicroseconds(BigInt(whole) * 1000000n + BigInt(micro));
    }
    if (
      typeof value !== "string" ||
      pythonStrip(value) !== value ||
      value.endsWith("z")
    )
      return null;
    const parsed = parseIso(value.replaceAll("Z", "+00:00")),
      date = new Date(0);
    date.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
    date.setUTCHours(parsed.hour, parsed.minute, parsed.second, 0);
    return fromMicroseconds(
      BigInt(date.getTime()) * 1000n +
        BigInt(parsed.microsecond) -
        BigInt(Math.round((parsed.offsetSeconds ?? 0) * 1e6)),
    );
  } catch {
    return null;
  }
}
export function normaliseUsage(usage: unknown): TokenUsage {
  const prompt = int(getField(usage, "prompt_tokens")),
    output = int(getField(usage, "completion_tokens")),
    cached = int(getField(usage, "prompt_cached_tokens")),
    write = int(getField(usage, "prompt_cache_creation_tokens")),
    reasoning = int(getField(usage, "completion_reasoning_tokens")),
    extra = (cached || 0) + (write || 0),
    exclusive = prompt !== null && extra > prompt;
  return Object.freeze({
    tokensIn: prompt === null ? null : exclusive ? prompt + extra : prompt,
    tokensOut: output,
    cached,
    cacheWrite: write,
    reasoning,
    exclusive,
  });
}
const integer = z.preprocess(
  (value) =>
    typeof value === "boolean"
      ? Number(value)
      : typeof value === "string" &&
          /^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(pythonStrip(value))
        ? Number(pythonStrip(value).replaceAll("_", ""))
        : value,
  z.number().int(),
);
const nullableInt = integer.nullable().default(null),
  nullableString = z.string().nullable().default(null),
  strings = z.array(z.string()).readonly().default([]);
const time = z
  .unknown()
  .transform((value, ctx) => {
    if (value == null) return null;
    let parsed: string | null = null;
    if (
      typeof value === "number" ||
      (typeof value === "string" &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(pythonStrip(value)))
    ) {
      const n = Number(value),
        adjusted =
          typeof value === "number" && n < 0 && !Number.isInteger(n)
            ? Math.floor(n) + Math.abs(n - Math.trunc(n))
            : n;
      try {
        parsed = isoFromEpoch(
          Math.abs(n) > 20000000000 ? adjusted / 1000 : adjusted,
        ).replace(/\+00:00$/, "Z");
      } catch {}
    } else parsed = parseSummaryTime(value);
    if (parsed !== null) return parsed;
    ctx.addIssue({ code: "custom", message: "Invalid trace row timestamp" });
    return z.NEVER;
  })
  .default(null);
const shape = {
  traceId: z.string(),
  name: nullableString,
  operation: nullableString,
  status: nullableString,
  startedAt: time,
  endedAt: time,
  durationMs: nullableInt,
  projectId: nullableString,
  sessionId: nullableString,
  threadId: nullableString,
  product: nullableString,
  providers: strings,
  models: strings,
  responseModels: strings,
  agentName: nullableString,
  tokensIn: nullableInt,
  tokensOut: nullableInt,
  cachedTokens: nullableInt,
  cacheWriteTokens: nullableInt,
  reasoningTokens: nullableInt,
  contextTokens: nullableInt,
  usageExclusive: signalBoolean.default(false),
  costTotal: signalFloat.nullable().default(null),
  currency: nullableString,
  raw: signalDictionary.default({}),
};
export const TraceRowSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const input = { ...value } as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    const legacy = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    if (legacy === key || !Object.hasOwn(input, legacy)) continue;
    if (
      Object.hasOwn(input, key) &&
      !isDeepStrictEqual(input[key], input[legacy])
    )
      throw new TypeError(`Conflicting ${key} and ${legacy}`);
    input[key] = input[legacy];
    delete input[legacy];
  }
  return input;
}, z.object(shape).readonly());
export type TraceRowFields = z.infer<typeof TraceRowSchema>;
export class TraceRow implements TraceRowFields {
  declare readonly traceId: TraceRowFields["traceId"];
  declare readonly name: TraceRowFields["name"];
  declare readonly operation: TraceRowFields["operation"];
  declare readonly status: TraceRowFields["status"];
  declare readonly startedAt: TraceRowFields["startedAt"];
  declare readonly endedAt: TraceRowFields["endedAt"];
  declare readonly durationMs: TraceRowFields["durationMs"];
  declare readonly projectId: TraceRowFields["projectId"];
  declare readonly sessionId: TraceRowFields["sessionId"];
  declare readonly threadId: TraceRowFields["threadId"];
  declare readonly product: TraceRowFields["product"];
  declare readonly providers: TraceRowFields["providers"];
  declare readonly models: TraceRowFields["models"];
  declare readonly responseModels: TraceRowFields["responseModels"];
  declare readonly agentName: TraceRowFields["agentName"];
  declare readonly tokensIn: TraceRowFields["tokensIn"];
  declare readonly tokensOut: TraceRowFields["tokensOut"];
  declare readonly cachedTokens: TraceRowFields["cachedTokens"];
  declare readonly cacheWriteTokens: TraceRowFields["cacheWriteTokens"];
  declare readonly reasoningTokens: TraceRowFields["reasoningTokens"];
  declare readonly contextTokens: TraceRowFields["contextTokens"];
  declare readonly usageExclusive: TraceRowFields["usageExclusive"];
  declare readonly costTotal: TraceRowFields["costTotal"];
  declare readonly currency: TraceRowFields["currency"];
  declare readonly raw: TraceRowFields["raw"];
  constructor(input: unknown) {
    Object.assign(this, TraceRowSchema.parse(input));
    Object.freeze(this);
  }
  get displayModels(): readonly string[] {
    return [
      ...this.responseModels,
      ...this.models.filter(
        (model) =>
          !this.responseModels.some(
            (served) => served === model || served.endsWith(`/${model}`),
          ),
      ),
    ];
  }
  get displayProviders(): readonly string[] {
    return this.providers.length
      ? this.providers
      : [
          ...new Set(
            this.displayModels
              .filter((model) => model.includes("/"))
              .map((model) => model.split("/")[0] as string),
          ),
        ];
  }
  get cachePct(): number | null {
    return !this.tokensIn || this.cachedTokens === null
      ? null
      : this.cachedTokens / this.tokensIn;
  }
  get isError(): boolean {
    return ["error", "failed"].includes((this.status ?? "").toLowerCase());
  }
}
export function rowFromSummary(
  summary: unknown,
  raw: Record<string, unknown> | null = null,
): TraceRow | null {
  const pick = (name: string): unknown =>
      getField(raw, name) ?? getField(summary, name),
    traceId = pick("trace_id") || pick("id");
  if (!truth(traceId)) return null;
  const usage = normaliseUsage(pick("usage")),
    attributes = getField(raw, "attributes"),
    genAi = getField(attributes, "gen_ai"),
    contextTokens =
      int(getField(getField(genAi, "usage"), "prompt_tokens")) ??
      int(getField(attributes, "gen_ai.usage.prompt_tokens")),
    cost = pick("cost"),
    agent = pick("agent");
  return new TraceRow({
    traceId: pythonString(traceId),
    name: str(pick("name")),
    operation: str(pick("operation")),
    status: str(pick("status")),
    startedAt: parseSummaryTime(pick("started_at")),
    endedAt: parseSummaryTime(pick("ended_at")),
    durationMs: int(pick("duration_ms")),
    projectId: str(pick("project_id")),
    sessionId: str(pick("session_id")),
    threadId: str(pick("thread_id")),
    product: str(pick("product")),
    providers: strs(pick("providers")),
    models: summaryModels(summary, raw),
    responseModels: responseModels(summary, raw),
    agentName:
      agent != null ? str(getField(agent, "name")) : str(pick("agent_name")),
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    cachedTokens: usage.cached,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning,
    contextTokens,
    usageExclusive: usage.exclusive,
    costTotal: cost != null ? float(getField(cost, "total")) : null,
    currency: cost != null ? str(getField(cost, "currency")) : null,
    raw: raw === null ? {} : { ...raw },
  });
}
