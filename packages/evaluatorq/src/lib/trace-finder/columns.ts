import { esc } from "../common/reports/html-helpers.js";
import { fmtCost as sharedFmtCost } from "../common/reports/md-helpers.js";
import {
  groupThousands,
  pyFixed,
  pyFloat,
} from "../common/reports/number-format.js";
import { codepointCompare, pythonString } from "../common/sanitize.js";
import { parseIso } from "../formats/time.js";
import type { TraceClassification } from "./models.js";
import type { TraceRow } from "./rows.js";

export const DASH = "\u2014",
  MATCH = "match";
export function fmtTokens(value: number | null): string {
  return value === null
    ? DASH
    : value >= 1000000
      ? `${pyFixed(value / 1000000, 1)}M`
      : value >= 1000
        ? `${pyFixed(value / 1000, 1)}k`
        : String(value);
}
export function fmtCost(value: number | null, currency: string | null): string {
  return value === null
    ? DASH
    : currency && currency.toUpperCase() !== "USD"
      ? `${groupThousands(pyFixed(value, 4))} ${esc(currency)}`
      : sharedFmtCost(value);
}
export function fmtDuration(value: number | null): string {
  return value === null
    ? DASH
    : value >= 1000
      ? `${pyFixed(value / 1000, 1)}s`
      : `${value}ms`;
}
const pad = (value: number) => String(value).padStart(2, "0");
export function fmtTime(value: string | Date | null): string {
  if (value === null) return DASH;
  const time = parseIso(value instanceof Date ? value.toISOString() : value);
  return `${String(time.year).padStart(4, "0")}-${pad(time.month)}-${pad(time.day)} ${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
}
const text = (value: string | null): string => (value ? esc(value) : DASH);
function status(row: TraceRow): string {
  if (row.status === null) return DASH;
  const kind = row.isError ? "err" : "ok",
    label = row.isError
      ? "Error"
      : ["ok", "success"].includes(row.status.toLowerCase())
        ? "Success"
        : row.status;
  return `<span class="status-label ${kind}"><span class="dot ${kind}" aria-hidden="true"></span>${esc(label)}</span>`;
}
function time(row: TraceRow): string {
  if (row.startedAt === null) return DASH;
  const value = parseIso(row.startedAt),
    month = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ][value.month - 1];
  return `${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}<small>${pad(value.day)} ${month} ${String(value.year).padStart(4, "0")}</small>`;
}
function trace(row: TraceRow): string {
  const name = row.name || row.traceId,
    agent = row.agentName ? `${esc(row.agentName)} · ` : "";
  return `<span class="trace-name">${esc(name)}</span><small>${agent}${esc([...row.traceId].slice(0, 8).join(""))}</small>`;
}
function cache(row: TraceRow): string {
  const pct = row.cachePct;
  if (pct === null) return DASH;
  const percentage = pyFixed(pct * 100, 0);
  return `<span class="cache-value" title="${groupThousands(String(row.cachedTokens))} cache-read tokens / ${groupThousands(String(row.tokensIn))} input tokens"><span class="cachebar"><i style="width:${percentage}%"></i></span><span class="cache-percent">${percentage}%</span></span>`;
}
export interface Column {
  readonly key: string;
  readonly label: string;
  readonly value: (row: TraceRow) => unknown;
  readonly render: (row: TraceRow) => string;
  readonly numeric: boolean;
  readonly default: boolean;
}
function column(
  key: string,
  label: string,
  value: Column["value"],
  render: Column["render"],
  options: { numeric?: boolean; default?: boolean } = {},
): Column {
  return Object.freeze({
    key,
    label,
    value,
    render,
    numeric: options.numeric ?? false,
    default: options.default ?? false,
  });
}
const entries = [
  column("started", "Time", (row) => row.startedAt, time, { default: true }),
  column("status", "Status", (row) => row.status, status, { default: true }),
  column("trace", "Trace / agent", (row) => row.name || row.traceId, trace, {
    default: true,
  }),
  column(
    "error_message",
    "Error details",
    () => null,
    (row) =>
      row.isError
        ? '<span title="Open this trace, then choose Spans">Open Spans for details</span>'
        : DASH,
  ),
  column(
    "name",
    "Name",
    (row) => row.name,
    (row) => text(row.name),
  ),
  column(
    "agent",
    "Agent",
    (row) => row.agentName,
    (row) => text(row.agentName),
  ),
  column(
    "model",
    "Model",
    (row) => row.displayModels.join(", ") || null,
    (row) => text(row.displayModels.join(", ")),
    { default: true },
  ),
  column(
    "tokens_in",
    "Tokens in",
    (row) => row.tokensIn,
    (row) => fmtTokens(row.tokensIn),
    { numeric: true, default: true },
  ),
  column(
    "tokens_out",
    "Tokens out",
    (row) => row.tokensOut,
    (row) => fmtTokens(row.tokensOut),
    { numeric: true, default: true },
  ),
  column("cache_pct", "Cache read %", (row) => row.cachePct, cache, {
    numeric: true,
    default: true,
  }),
  column(
    "cost",
    "Cost",
    (row) => row.costTotal,
    (row) => fmtCost(row.costTotal, row.currency),
    { numeric: true, default: true },
  ),
  column(
    "duration",
    "Duration",
    (row) => row.durationMs,
    (row) => fmtDuration(row.durationMs),
    { numeric: true, default: true },
  ),
  column(
    "provider",
    "Provider",
    (row) => row.displayProviders.join(", ") || null,
    (row) => text(row.displayProviders.join(", ")),
  ),
  column(
    "product",
    "Product",
    (row) => row.product,
    (row) => text(row.product),
  ),
  column(
    "operation",
    "Operation",
    (row) => row.operation,
    (row) => text(row.operation),
  ),
  column(
    "reasoning_tokens",
    "Reasoning tokens",
    (row) => row.reasoningTokens,
    (row) => fmtTokens(row.reasoningTokens),
    { numeric: true },
  ),
  column(
    "cache_write_tokens",
    "Cache writes",
    (row) => row.cacheWriteTokens,
    (row) => fmtTokens(row.cacheWriteTokens),
    { numeric: true },
  ),
  column(
    "session",
    "Session",
    (row) => row.sessionId,
    (row) => text(row.sessionId),
  ),
  column(
    "thread",
    "Thread",
    (row) => row.threadId,
    (row) => text(row.threadId),
  ),
  column(
    "trace_id",
    "Trace ID",
    (row) => row.traceId,
    (row) => `<span class="mono">${esc(row.traceId)}</span>`,
  ),
  column(
    MATCH,
    "AI match",
    () => null,
    () => DASH,
    { default: true },
  ),
];
export const COLUMNS: Readonly<Record<string, Column>> = Object.freeze(
  Object.fromEntries(entries.map((entry) => [entry.key, entry])),
);
export const DEFAULT_COLUMNS: readonly string[] = Object.freeze(
  entries.filter((entry) => entry.default).map((entry) => entry.key),
);
if (Object.keys(COLUMNS).length !== entries.length)
  throw new Error("explorer column keys must be unique");
export function resolveColumns(
  keys: readonly string[] | null = null,
): readonly Column[] {
  const chosen = keys ?? DEFAULT_COLUMNS,
    unknown = chosen.filter((key) => !Object.hasOwn(COLUMNS, key));
  if (unknown.length)
    console.warn(`Ignoring unknown explorer column(s) ${unknown.join(", ")}`);
  return chosen.flatMap((key) =>
    Object.hasOwn(COLUMNS, key) ? [COLUMNS[key] as Column] : [],
  );
}
function matchValue(result: TraceClassification | undefined): unknown {
  return !result || result.error
    ? null
    : [
        result.matched,
        result.answers.map((answer) =>
          typeof answer.value === "number"
            ? pyFloat(answer.value)
            : pythonString(answer.value),
        ),
      ];
}
function compare(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = compare(a[i], b[i]);
      if (order) return order;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string")
    return codepointCompare(a, b);
  return Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0;
}
export function sortRows(
  rows: readonly TraceRow[],
  key: string,
  options: {
    descending: boolean;
    results?: Readonly<Record<string, TraceClassification>> | null;
  },
): readonly TraceRow[] {
  const col = Object.hasOwn(COLUMNS, key) ? COLUMNS[key] : null,
    results = options.results;
  if (!col || (key === MATCH && (!results || !Object.keys(results).length)))
    return [...rows];
  const value = (row: TraceRow): unknown =>
      key === MATCH
        ? matchValue(results?.[row.traceId])
        : key === "started" && row.startedAt !== null
          ? row.startedAt.replace(
              /(?:\.(\d+))?Z$/,
              (_, fraction: string | undefined) =>
                `.${(fraction ?? "").padEnd(6, "0")}Z`,
            )
          : col.value(row),
    present = rows.filter((row) => value(row) !== null),
    missing = rows.filter((row) => value(row) === null);
  present.sort(
    (a, b) => compare(value(a), value(b)) * (options.descending ? -1 : 1),
  );
  return [...present, ...missing];
}
