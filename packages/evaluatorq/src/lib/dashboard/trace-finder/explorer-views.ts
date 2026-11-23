import { esc } from "../../common/reports/html-helpers.js";
import {
  pyFixed,
  pyPercent,
  pyRound,
} from "../../common/reports/number-format.js";
import { pythonString } from "../../common/sanitize.js";
import {
  COLUMNS,
  type Column,
  fmtCost,
  fmtDuration,
  fmtTime,
  fmtTokens,
  MATCH,
} from "../../trace-finder/columns.js";
import {
  aiMatched,
  CONVERSATION_METRICS,
  conversationKey,
  type ExplorerView,
  matchesFirstView,
  PAGE_ROWS,
  TOP_METRICS,
  totals,
} from "../../trace-finder/explorer.js";
import type {
  DimensionAnswer,
  RunSnapshot,
  TraceClassification,
  TraceRecord,
} from "../../trace-finder/models.js";
import { MAX_LIVE_TRACES } from "../../trace-finder/orq-source-data.js";
import type { TraceRow } from "../../trace-finder/rows.js";
import {
  KIND_LABELS,
  type Kind,
  type Segment,
  segments,
} from "../../trace-finder/trajectory.js";
import { renderFacetChips } from "../facet-picker.js";
import { dateInput, dateRow } from "../native-dates.js";
import { csrfField } from "../security.js";
import { answerCells, reasonLine, resultColor } from "./views.js";

type Results = Readonly<Record<string, TraceClassification>>;
type Records = Readonly<Record<string, TraceRecord | null>>;

export const DEFAULT_EXPLORER_ROWS = 200;
export const TRAJECTORY_FALLBACK_SCALE = 1_000;
export const COLUMN_HELP: Readonly<Record<string, string>> = Object.freeze({
  cache_pct:
    "Share of input tokens the provider reused from an earlier request, which is cheaper and faster.",
  tokens_in: "Tokens sent to the model, including any served from the cache",
  tokens_out: "Tokens the model wrote back",
});
const TOTAL_HELP: Readonly<Record<string, string>> = Object.freeze({
  cost: "Unavailable when cost is missing or the shown traces use different currencies.",
  in: COLUMN_HELP.tokens_in as string,
  out: COLUMN_HELP.tokens_out as string,
  "cache read": COLUMN_HELP.cache_pct as string,
  p50: "Half of the shown traces finished faster than this",
  p95: "Nineteen in twenty of the shown traces finished faster than this",
});
const PRESETS: readonly (readonly [string, number])[] = [
  ["15m", 15 * 60],
  ["1h", 3600],
  ["24h", 86400],
  ["7d", 7 * 86400],
  ["30d", 30 * 86400],
];
export const TOP_QUICK_VIEW_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    slow: "Slowest traces",
    costly: "Costliest traces",
    tokens: "Token-heavy traces",
    context: "Largest context",
    conv_costly: "Costliest conversations",
    conv_tokens: "Token-heavy conversations",
    conv_longest: "Longest conversations",
  });
const DASH = "—";
const HX_RESULTS =
  'hx-target="#explorer-results" hx-swap="outerHTML" hx-sync="#explorer-results:replace"';

const grouped = (value: number) => value.toLocaleString("en-US");
const pyBool = (value: boolean) => (value ? "true" : "false");
const hasAny = (record: Results | null | undefined): record is Results =>
  record !== null && record !== undefined && Object.keys(record).length > 0;
const chars = (text: string) => [...text].length;

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function localValue(value: Date): string {
  return value.toISOString().slice(0, 19);
}

export function rangeInputs(
  start: string | Date | null,
  end: string | Date | null,
  windowDays: number,
  options: {
    includeLoad?: boolean;
    rowLimit?: number;
    timeOrigin?: string;
  } = {},
): string {
  const {
    includeLoad = true,
    rowLimit = DEFAULT_EXPLORER_ROWS,
    timeOrigin = "default",
  } = options;
  const endDate = end ? toDate(end) : new Date();
  const startDate = start
    ? toDate(start)
    : new Date(endDate.getTime() - windowDays * 86_400_000);
  const rangeSeconds = Math.max(
    1,
    Math.trunc((endDate.getTime() - startDate.getTime()) / 1000),
  );
  const initialOrigin = timeOrigin === "default" ? "default" : "explicit";
  const rangeMode = PRESETS.some(([, span]) => span === rangeSeconds)
    ? "relative"
    : "exact";
  const presets = PRESETS.map(
    ([label, span]) =>
      `<button type="button" class="xr-preset" data-explorer-preset="${span}" ` +
      `aria-pressed="${pyBool(span === rangeSeconds)}">${label}</button>`,
  ).join("");
  const startValue = localValue(startDate);
  const endValue = localValue(endDate);
  const row = (label: string, name: string, utc: string, timeLabel: string) =>
    dateRow(
      label,
      dateInput({
        controlId: `explorer-${name}`,
        name,
        label: `${label} date`,
        cssClass: "xr-date",
        required: true,
        preserve: true,
        form: "explorer-load-form",
        utc,
        value: utc.slice(0, 10),
      }) +
        `<input id="explorer-${name}-time" class="xr-time" aria-label="${timeLabel}" hx-preserve form="explorer-load-form" name="${name}_time" type="time" step="1" required data-utc="${utc}" value="${utc.slice(11)}">`,
      { cssClass: "xr-range" },
    );
  const fromRow = row("From", "from", startValue, "From time");
  const toRow = row("To", "to", endValue, "To time");
  const controls =
    `<form id="explorer-load-form" hidden hx-post="/find/load" hx-target="#explorer-results" hx-swap="outerHTML" hx-sync="#explorer-results:replace" hx-include="#finder-controls, #finder-scope">${csrfField()}</form>` +
    `<input id="explorer-range-mode" type="hidden" name="range_mode" value="${rangeMode}" form="explorer-load-form" hx-preserve data-explorer-range-mode>` +
    `<input id="explorer-range-seconds" type="hidden" name="range_seconds" value="${rangeSeconds}" form="explorer-load-form" hx-preserve data-explorer-range-seconds>` +
    `<input id="explorer-time-origin" type="hidden" name="time_origin" value="${initialOrigin}" form="explorer-load-form" hx-preserve data-explorer-time-origin>` +
    `<input type="hidden" name="window_days" value="${windowDays}" form="explorer-load-form">` +
    '<input type="hidden" name="tz_offset" form="explorer-load-form" data-explorer-tz>' +
    `<details class="xr-time-menu"><summary><span class="xr-time-label" data-explorer-range-label>Custom range</span></summary><div class="xr-time-options"><span class="xr-presets" role="group" aria-label="Relative range">${presets}</span>` +
    '<details class="xr-exact"><summary>Custom range</summary><div class="xr-range-fields">' +
    `${fromRow}${toRow}` +
    '<small class="xr-tz" data-explorer-tz-label>Local time</small>' +
    '<button type="button" class="xr-apply" data-explorer-apply>Apply range</button></div></details></div></details>' +
    `<label class="quiet"><b>Rows</b><input id="explorer-rows" hx-preserve form="explorer-load-form" name="rows" type="number" min="1" max="${MAX_LIVE_TRACES}" value="${rowLimit}" style="width:72px"></label>`;
  const load = includeLoad
    ? '<button class="btn-secondary" type="submit" form="explorer-load-form">Load</button>'
    : "";
  return controls + load;
}

const UNAVAILABLE_MARKERS = [
  "503",
  "no healthy upstream",
  "service unavailable",
];

function loadFailed(error: string | null): string {
  const raw = error || "unknown error";
  const unavailable = UNAVAILABLE_MARKERS.some((marker) =>
    raw.toLowerCase().includes(marker),
  );
  const message = unavailable
    ? "Orq is temporarily unavailable. Try again."
    : `Load failed: ${raw}`;
  const detail = unavailable
    ? `<small class="finder-error-detail">${esc(raw)}</small>`
    : "";
  return (
    `<div class="finder-review finder-form-error" role="alert" title="${esc(raw)}">${esc(message)} ${detail}` +
    '<button class="btn-secondary xr-retry" type="submit" form="explorer-load-form">Retry</button></div>'
  );
}

function empty(title: string, body: string): string {
  const paragraph = body ? `<p>${esc(body)}</p>` : "";
  return `<div class="xr-empty"><h4>${esc(title)}</h4>${paragraph}</div>`;
}

function matchNames(
  snapshot: RunSnapshot | null,
  fallback: string,
): readonly string[] {
  const names =
    snapshot !== null
      ? (snapshot.dimensions ?? []).map((dimension) => dimension.name)
      : [];
  return names.length ? names : [fallback];
}

function yesNoCell(answer: DimensionAnswer | null | undefined): string {
  if (!answer) return `<td>${DASH}</td>`;
  if (answer.error)
    return '<td><span class="verdict xr-yn failed">Judgment failed</span></td>';
  const title =
    answer.confidence !== null
      ? ` title="AI confidence ${pyPercent(answer.confidence)}"`
      : "";
  const text =
    answer.value === true
      ? "yes"
      : answer.value === false
        ? "no"
        : esc(pythonString(answer.value));
  return `<td><span class="verdict xr-yn ${answer.matched ? "yes" : "no"}"${title}>${text}</span>${reasonLine(answer)}</td>`;
}

function matchCells(row: TraceRow, snapshot: RunSnapshot | null): string {
  const result =
    snapshot !== null && Object.hasOwn(snapshot.results, row.traceId)
      ? snapshot.results[row.traceId]
      : undefined;
  const dimensions = snapshot !== null ? (snapshot.dimensions ?? []) : [];
  const repeat = (cell: string) => cell.repeat(Math.max(1, dimensions.length));
  if (result === undefined) {
    if (
      snapshot !== null &&
      (snapshot.state === "compiling" || snapshot.state === "classifying")
    )
      return repeat(
        '<td class="muted xr-pending" title="Waiting for the AI">…</td>',
      );
    if (
      snapshot !== null &&
      snapshot.state === "completed" &&
      dimensions.length
    )
      return '<td class="muted" title="Not judged: this trace has no conversation to read.">not judged</td>'.repeat(
        dimensions.length,
      );
    return repeat(`<td class="muted">${DASH}</td>`);
  }
  if (
    !result.error &&
    dimensions.length &&
    dimensions.every((d) => d.task.kind === "noul")
  )
    return dimensions
      .map((_, index) => yesNoCell(result.answers[index]))
      .join("");
  if (result.error || !dimensions.length) {
    const label = result.error
      ? "Judgment failed"
      : !dimensions.length && result.matched
        ? "Kept by filters"
        : result.matched
          ? "Included"
          : "Not included";
    return repeat(
      `<td><span class="verdict xr-match"><span class="sw" style="background:${esc(resultColor(result, dimensions))}"></span>${esc(label)}</span></td>`,
    );
  }
  return answerCells(result, dimensions);
}

function withinSnapshot(snapshot: RunSnapshot | null): RunSnapshot | null {
  return snapshot !== null && snapshot.withinResults ? snapshot : null;
}

function aiHasRun(snapshot: RunSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.withinResults &&
    (hasAny(snapshot.results) || snapshot.state === "classifying")
  );
}

function classified(snapshot: RunSnapshot | null): boolean {
  return snapshot !== null && Boolean(snapshot.dimensions?.length);
}

function visibleColumns(
  columns: readonly Column[],
  snapshot: RunSnapshot | null,
): readonly Column[] {
  return aiHasRun(snapshot)
    ? columns
    : columns.filter((column) => column.key !== MATCH);
}

const pyQuote = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function drawerAttrs(traceId: string, tracesLayout = false): string {
  const query = tracesLayout ? "?surface=traces" : "";
  return `hx-get="/find/trace/${pyQuote(traceId)}${query}" hx-target="#finder-drawer" hx-swap="innerHTML" hx-indicator="#finder-drawer-loading"`;
}

const MIN_COL_CH = 6;
const CELL_PAD_CH = 6;
const MAX_COL_CH = 48;
const HEADER_CHAR_FACTOR = 1.15;
const HEADER_ARROW_CH = 3;
const TAG_RE = /<[^>]+>/g;
const SMALL_SPLIT_RE = /<small[^>]*>|<\/small>/;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsaquo: "›",
  nbsp: " ",
};

function unescapeHtml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body[0] === "#")
        return String.fromCodePoint(
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10),
        );
      return NAMED_ENTITIES[body] ?? whole;
    },
  );
}

function visibleChars(cellHtml: string): number {
  return Math.max(
    0,
    ...cellHtml
      .split(SMALL_SPLIT_RE)
      .map((line) => chars(unescapeHtml(line.replace(TAG_RE, "")))),
  );
}

const clampCh = (value: number) =>
  Math.max(MIN_COL_CH, Math.min(MAX_COL_CH, pyRound(value)));

interface Measured {
  seen: Set<string>;
  chars: number[];
  labels: readonly string[] | null;
  key: string;
}

const MEASURED = new Map<string, Measured>();
const MEASURED_LOADS = 32;
const fresh = (): Measured => ({
  seen: new Set(),
  chars: [],
  labels: null,
  key: "",
});

function measured(generation: number, columnKey: string): Measured {
  if (!generation) return fresh();
  const id = `${generation}\u0000${columnKey}`;
  let entry = MEASURED.get(id);
  if (entry === undefined) {
    entry = fresh();
    MEASURED.set(id, entry);
    const generationOf = (key: string) => Number(key.split("\u0000")[0]);
    const live = [...new Set([...MEASURED.keys()].map(generationOf))].sort(
      (a, b) => a - b,
    );
    const stale = new Set(
      live.slice(0, Math.max(0, live.length - MEASURED_LOADS)),
    );
    for (const key of [...MEASURED.keys()])
      if (stale.has(generationOf(key))) MEASURED.delete(key);
  }
  return entry;
}

function headerWidths(
  columns: readonly Column[],
  rows: readonly TraceRow[],
  snapshot: RunSnapshot | null,
  generation = 0,
): number[] {
  const widths: number[] = [];
  for (const column of columns) {
    const labels =
      column.key === MATCH
        ? matchNames(snapshot, column.label)
        : [column.label];
    const entry = measured(generation, column.key);
    let cellChars: number[];
    if (column.key === MATCH) {
      const key = JSON.stringify([
        labels,
        rows.length,
        snapshot !== null ? Object.keys(snapshot.results).length : 0,
      ]);
      if (key !== entry.key) {
        const perLabel = labels.map(() => 0);
        for (const row of rows) {
          const cells = matchCells(row, snapshot)
            .split("</td>")
            .filter((cell) => cell.trim());
          for (let index = 0; index < labels.length; index++) {
            const cell =
              index < cells.length
                ? (cells[index] as string)
                : cells.length
                  ? (cells[cells.length - 1] as string)
                  : "";
            perLabel[index] = Math.max(
              perLabel[index] as number,
              visibleChars(cell),
            );
          }
        }
        const grow =
          entry.labels !== null &&
          JSON.stringify(entry.labels) === JSON.stringify(labels);
        entry.chars = grow
          ? perLabel.map((value, i) =>
              Math.max(value, entry.chars[i] as number),
            )
          : perLabel;
        entry.key = key;
        entry.labels = labels;
      }
      cellChars = entry.chars;
    } else {
      const unseen = rows.filter((row) => !entry.seen.has(row.traceId));
      const widest = Math.max(
        0,
        ...unseen.map((row) => visibleChars(column.render(row))),
      );
      entry.chars = [Math.max(widest, ...entry.chars)];
      for (const row of unseen) entry.seen.add(row.traceId);
      cellChars = labels.map(() => entry.chars[0] as number);
    }
    labels.forEach((label, index) => {
      const headerChars = chars(label) * HEADER_CHAR_FACTOR + HEADER_ARROW_CH;
      widths.push(
        clampCh(
          Math.max(headerChars, (cellChars[index] as number) + CELL_PAD_CH),
        ),
      );
    });
  }
  return widths;
}

function durationCell(
  value: number | null,
  scale: number,
  p95: number | null,
): string {
  const label = fmtDuration(value);
  if (value === null)
    return `<td class="num xr-duration"><span>${esc(label)}</span></td>`;
  const width = scale
    ? Math.min(100, Math.max(0, pyRound((value / scale) * 100)))
    : 0;
  const magnitude =
    `<span class="xr-duration-bar" role="img" aria-label="Duration magnitude: ${esc(label)}; ` +
    `${width}% of the longest visible trace" title="${esc(label)} relative to the longest visible trace">` +
    `<span style="width:${width}%"></span></span>`;
  const atP95 = p95 !== null && value >= p95;
  const p95Class = atP95 ? " xr-duration-p95" : "";
  const p95Title = atP95
    ? ` title="At or above visible-set p95 (${esc(fmtDuration(p95))})"`
    : "";
  const p95Cue = atP95
    ? '<span class="xr-duration-accessible">At or above p95</span>'
    : "";
  return `<td class="num xr-duration${p95Class}"${p95Title}><span>${esc(label)}</span>${p95Cue}${magnitude}</td>`;
}

export function table(
  view: ExplorerView,
  columns: readonly Column[],
  snapshotIn: RunSnapshot | null,
  options: { tracesLayout?: boolean } = {},
): string {
  const tracesLayout = options.tracesLayout ?? false;
  const snapshot = withinSnapshot(snapshotIn);
  const requested = columns;
  const shown = visibleColumns(columns, snapshot);
  const results =
    snapshot !== null && hasAny(snapshot.results) ? snapshot.results : null;
  const labelsOf = (column: Column) =>
    column.key === MATCH ? matchNames(snapshot, column.label) : [column.label];
  let heads = "";
  for (const column of shown) {
    const sortedHere = view.sort === column.key;
    const arrow = sortedHere
      ? `<span class="xr-sort-arrow" aria-hidden="true">${view.descending ? "↓" : "↑"}</span>`
      : "";
    const ariaSort = sortedHere
      ? ` aria-sort="${view.descending ? "descending" : "ascending"}"`
      : "";
    const direction = sortedHere && view.descending ? "asc" : "desc";
    const sparkle =
      column.key === MATCH
        ? '<span class="xr-ai-sparkle" aria-hidden="true">✦</span>'
        : "";
    const help = COLUMN_HELP[column.key];
    const title = help ? ` title="${esc(help)}"` : "";
    heads += labelsOf(column)
      .map(
        (label, index) =>
          `<th class="${column.numeric ? "num" : ""}"${index === 0 ? ariaSort : ""}><button type="button" class="link" data-xr-sort="${column.key}"${title} ` +
          `hx-get="/find/rows?sort=${column.key}&dir=${direction}" ${HX_RESULTS}>` +
          `${sparkle}${esc(label)}${index === 0 ? arrow : ""}</button></th>`,
      )
      .join("");
  }
  if (!shown.length) {
    if (requested.some((column) => column.key === MATCH) && !aiHasRun(snapshot))
      return empty(
        "AI columns are not ready yet.",
        "AI match columns appear after an AI classification starts.",
      );
    return empty(
      "No columns selected.",
      "Choose at least one column from Columns to show trace details.",
    );
  }
  const renderedKeys = shown.flatMap((column) =>
    labelsOf(column).map(() => column.key),
  );
  let widths = headerWidths(shown, view.rows, snapshot, view.generation);
  if (tracesLayout)
    widths = widths.map((width, i) =>
      renderedKeys[i] === "duration" ? Math.max(width, 16) : width,
    );
  const durationRows = tracesLayout ? view.visibleRows(results) : [];
  const durationTotals = tracesLayout ? totals(durationRows) : null;
  const durationScale = Math.max(
    0,
    ...durationRows.map((row) => row.durationMs || 0),
  );
  const durationP95 = durationTotals?.p95Ms ?? null;
  const flexKey =
    ["trace", "name", "agent"].find((key) => renderedKeys.includes(key)) ??
    null;
  const colgroup = renderedKeys
    .map((key, i) =>
      key === flexKey ? "<col>" : `<col style="width:${widths[i]}ch">`,
    )
    .join("");
  let conversation: string | null = null;
  let body = "";
  for (const row of view.pageRows(results)) {
    const key = conversationKey(row);
    const marker =
      Object.hasOwn(CONVERSATION_METRICS, view.quickView) &&
      view.sort === null &&
      key !== null &&
      key !== conversation
        ? ` data-conv="${esc(key)}"`
        : "";
    const rowClasses = [
      ...(row.isError ? ["xr-err"] : []),
      ...(results !== null &&
      classified(snapshot) &&
      aiMatched(results[row.traceId])
        ? ["xr-hit"]
        : []),
    ];
    const rowClass = rowClasses.length
      ? ` class="${rowClasses.join(" ")}"`
      : "";
    body +=
      `<tr data-tv-row="${esc(row.traceId)}"${marker}${rowClass} tabindex="0" ${drawerAttrs(row.traceId, tracesLayout)}>` +
      shown
        .map((c) =>
          c.key === MATCH
            ? matchCells(row, snapshot)
            : tracesLayout && c.key === "duration"
              ? durationCell(row.durationMs, durationScale, durationP95)
              : `<td class="${c.numeric ? "num" : ""}">${c.render(row)}</td>`,
        )
        .join("") +
      "</tr>";
    conversation = key;
  }
  if (view.state === "loading")
    body +=
      `<tr class="xr-skeleton" aria-hidden="true">${"<td><i></i></td>".repeat(renderedKeys.length)}</tr>`.repeat(
        4,
      );
  const total = widths.reduce((sum, width) => sum + width, 0);
  return (
    `<table class="finder-table xr-table" style="min-width:${total}ch"><colgroup>${colgroup}</colgroup>` +
    `<thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`
  );
}

function tipAttrs(segment: Segment, position: number, count: number): string {
  const label =
    segment.label && (segment.kind === "call" || segment.kind === "result")
      ? ` data-tv-tool="${esc(segment.label)}"`
      : "";
  return (
    `data-tv-msg="${segment.index}" data-tv-kind="${esc(KIND_LABELS[segment.kind])}" data-tv-n="${position} / ${count}" ` +
    `data-tv-tok="~${grouped(segment.tokens)} tokens" data-tv-p="${esc(segment.preview)}"${label}`
  );
}

const pyTitle = (text: string) =>
  text.replace(
    /\p{L}+/gu,
    (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
  );

function identity(row: TraceRow, snapshot: RunSnapshot | null): string {
  const rawStatus = (row.status || "unknown").toLowerCase();
  const status = row.isError
    ? "err"
    : rawStatus === "ok" || rawStatus === "success"
      ? "ok"
      : "other";
  const statusLabel = row.isError
    ? "Error"
    : status === "ok"
      ? "Success"
      : pyTitle((row.status || "Unknown").replaceAll("_", " "));
  const models = row.displayModels;
  const primary =
    row.agentName || models[0] || row.name || row.operation || DASH;
  const model =
    row.agentName && models.length
      ? `<span class="tv-model">${esc(models[0])}</span>`
      : "";
  const result =
    snapshot !== null && Object.hasOwn(snapshot.results, row.traceId)
      ? snapshot.results[row.traceId]
      : undefined;
  const tick =
    result !== undefined
      ? `<span class="tv-tick" style="background:${esc(resultColor(result, snapshot?.dimensions ?? null))}"></span>`
      : "";
  return (
    `<div class="tv-id"><span class="dot ${status}"></span>${tick}<div class="t">` +
    `<div class="a" title="${esc(primary)}">${esc(primary)}</div>${model}` +
    `<div class="s mono">${esc(fmtTime(row.startedAt))}</div></div></div>` +
    `<span class="tv-status ${status}">${esc(statusLabel)}</span>`
  );
}

function isEmbedding(row: TraceRow): boolean {
  return [row.product, row.operation, row.name].some(
    (value) =>
      value &&
      ["embedding", "embeddings"].includes(
        value.toLowerCase().split(".")[0] as string,
      ),
  );
}

function metrics(row: TraceRow): string {
  const pct = row.cachePct;
  const cache =
    pct !== null
      ? `<span class="cc" title="${grouped(row.cachedTokens as number)} cache-read tokens / ${grouped(row.tokensIn as number)} input tokens">` +
        `<b>${pyFixed(pct * 100, 0)}%</b><span class="cache-track"><i style="width:${pyFixed(pct * 100, 0)}%"></i></span></span>`
      : `<span class="cc muted">${DASH}</span>`;
  return (
    `<div class="tv-m"><span class="io"><span><b>${fmtTokens(row.tokensIn)}</b><small>in</small></span>` +
    `<span><b>${fmtTokens(row.tokensOut)}</b><small>out</small></span></span>` +
    `${cache}<span class="tv-cost">${fmtCost(row.costTotal, row.currency)}</span></div>`
  );
}

export function trajectories(
  view: ExplorerView,
  records: Records,
  snapshotIn: RunSnapshot | null,
  options: {
    loading?: boolean;
    summaryLoading?: boolean | null;
    tracesLayout?: boolean;
  } = {},
): string {
  const loading = options.loading ?? false;
  const summaryLoading = options.summaryLoading ?? loading;
  const tracesLayout = options.tracesLayout ?? false;
  const snapshot = withinSnapshot(snapshotIn);
  const page = view.pageRows(
    snapshot !== null && hasAny(snapshot.results) ? snapshot.results : null,
  );
  const recordOf = (id: string) =>
    Object.hasOwn(records, id) ? records[id] : null;
  const bars = new Map<string, Segment[] | null>();
  const toolSizes = new Map<string, number>();
  for (const row of page) {
    const record = recordOf(row.traceId);
    bars.set(
      row.traceId,
      !isEmbedding(row) && record ? segments(record.messages) : null,
    );
  }
  let other = 0;
  for (const segs of bars.values())
    for (const s of segs ?? []) if (s.kind === "other") other += 1;
  if (other)
    console.warn(
      `Trajectory view drew ${other} message part(s) of unknown type as "other"`,
    );
  for (const row of page) {
    const record = recordOf(row.traceId);
    toolSizes.set(
      row.traceId,
      view.showToolDefinitions && !isEmbedding(row) && record
        ? record.toolDefinitionTokens
        : 0,
    );
  }
  const segTokens = (segs: readonly Segment[] | null | undefined) =>
    (segs ?? []).reduce((sum, s) => sum + s.tokens, 0);
  const captured = page
    .filter(
      (row) => bars.get(row.traceId)?.length || toolSizes.get(row.traceId),
    )
    .map(
      (row) =>
        segTokens(bars.get(row.traceId)) +
        (toolSizes.get(row.traceId) as number),
    )
    .sort((a, b) => a - b);
  let scale = captured.length
    ? (captured[Math.max(0, Math.ceil(captured.length * 0.95) - 1)] as number)
    : TRAJECTORY_FALLBACK_SCALE;
  scale = Math.max(scale, 1);
  const kindTotals = new Map<Kind, number>();
  for (const segs of bars.values())
    for (const s of segs ?? [])
      kindTotals.set(s.kind, (kindTotals.get(s.kind) ?? 0) + s.tokens);
  const toolTotal = [...toolSizes.values()].reduce((a, b) => a + b, 0);
  const grand =
    [...kindTotals.values()].reduce((a, b) => a + b, 0) + toolTotal || 1;
  let legend = (Object.entries(KIND_LABELS) as [Kind, string][])
    .filter(([kind]) => kindTotals.has(kind))
    .map(
      ([kind, label]) =>
        `<span><i class="k-${kind}"></i>${esc(label.toLowerCase())} <em>${Math.floor(((kindTotals.get(kind) ?? 0) * 100) / grand)}%</em></span>`,
    )
    .join("");
  if (toolTotal)
    legend += `<span><i class="k-tools"></i>tool definitions <em>${Math.floor((toolTotal * 100) / grand)}%</em></span>`;
  const toggle =
    `<button type="button" class="tv-tool-toggle" aria-pressed="${pyBool(view.showToolDefinitions)}" ` +
    `hx-get="/find/rows?show_tool_definitions=${view.showToolDefinitions ? 0 : 1}" ` +
    'hx-target="#explorer-results" hx-swap="outerHTML" hx-sync="#explorer-results:replace">' +
    "Tool definitions</button>";
  let scaleTitle: string;
  if (captured.length) {
    const source = view.showToolDefinitions
      ? "captured messages and tool definitions"
      : "captured message estimates";
    scaleTitle = `Scale: p95 of ${source} on this page (${grouped(scale)} tokens)`;
  } else {
    const source = view.showToolDefinitions
      ? "captured messages or tool definitions"
      : "captured messages";
    scaleTitle = `No ${source} on this page; fixed ${grouped(scale)}-token scale`;
  }
  const contextLabel = view.showToolDefinitions
    ? "Captured context"
    : "Captured messages";
  const ticks = [0, 1, 2, 3, 4]
    .map(
      (q) =>
        `<b style="left:${q * 25}%">${q ? fmtTokens(Math.floor((scale * q) / 4)) : "0"}</b>`,
    )
    .join("");
  const isClassified =
    classified(snapshot) && snapshot !== null && hasAny(snapshot.results);
  let rowsHtml = "";
  for (const row of page) {
    const segs = bars.get(row.traceId) ?? null;
    const result =
      isClassified &&
      snapshot !== null &&
      Object.hasOwn(snapshot.results, row.traceId)
        ? snapshot.results[row.traceId]
        : undefined;
    let dim =
      result !== undefined ? (aiMatched(result) ? " hit" : " nomatch") : "";
    dim += row.isError ? " row-err" : "";
    if (isEmbedding(row)) {
      rowsHtml +=
        `<div class="tv-r${dim}" data-tv-row="${esc(row.traceId)}" tabindex="0" ` +
        `${drawerAttrs(row.traceId, tracesLayout)}>` +
        `${identity(row, snapshot)}<div class="tv-bar tv-embedding">Embedding call</div>${metrics(row)}</div>`;
      continue;
    }
    const hasConversation =
      Boolean(segs?.length) &&
      (segs ?? []).some((s) => s.preview.trim() || s.label);
    const toolTokens = toolSizes.get(row.traceId) as number;
    let bar: string;
    let rowTitle: string;
    let messageCount: string;
    if (hasConversation || toolTokens) {
      const estimated = segTokens(segs) + toolTokens;
      const width = Math.min((estimated / scale) * 100, 100);
      const record = recordOf(row.traceId);
      const toolBlock =
        toolTokens && record
          ? `<i class="k-tools" style="flex-grow:${toolTokens}" data-tv-tools="1" ` +
            `data-tv-kind="Tool definitions" data-tv-n="${grouped(record.toolDefinitionCount)} definitions" ` +
            `data-tv-tok="~${grouped(toolTokens)} tokens" data-tv-p="Estimated from captured tool schema JSON." ` +
            `role="img" aria-label="${grouped(record.toolDefinitionCount)} tool definitions, about ${grouped(toolTokens)} tokens"></i>`
          : "";
      const list = segs ?? [];
      const inner = list
        .map(
          (s, n) =>
            `<i class="k-${s.kind}" style="flex-grow:${s.tokens}" ${tipAttrs(s, n + 1, list.length)}></i>`,
        )
        .join("");
      const messageTokens = estimated - toolTokens;
      let accounting = `Estimated captured messages: ${grouped(messageTokens)} token${messageTokens !== 1 ? "s" : ""}.`;
      if (toolTokens)
        accounting += ` Tool definitions: ${grouped(toolTokens)} estimated tokens.`;
      const overflowMarker =
        estimated > scale
          ? `<span class="tv-overflow" title="Captured messages exceed the page p95 scale of ${grouped(scale)} tokens" aria-label="Bar exceeds scale">!</span>`
          : "";
      const count = new Set(list.map((s) => s.index)).size;
      bar = `<div class="tv-segs" style="width:${pyFixed(width, 2)}%">${toolBlock}${inner}${overflowMarker}</div>`;
      rowTitle = ` aria-description="${esc(accounting)}"`;
      messageCount = count ? `${count} msgs` : "No messages available";
    } else {
      bar = '<div class="tv-segs tv-nomsg" style="width:100%"></div>';
      rowTitle = "";
      messageCount =
        loading && !Object.hasOwn(records, row.traceId)
          ? "Loading messages…"
          : "No messages available";
    }
    const rowSummary = `<span>${esc(messageCount)}</span><span>${esc(fmtDuration(row.durationMs))}</span>`;
    rowsHtml +=
      `<div class="tv-r${dim}" data-tv-row="${esc(row.traceId)}" tabindex="0"${rowTitle} ${drawerAttrs(row.traceId, tracesLayout)}>` +
      `${identity(row, snapshot)}<div class="tv-bar"><div class="tv-plot"><div class="tv-track"></div>${bar}</div>` +
      `<span class="tv-end">${rowSummary}</span></div>${metrics(row)}</div>`;
  }
  if (summaryLoading)
    rowsHtml +=
      '<div class="tv-r tv-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'.repeat(
        4,
      );
  return (
    `<div class="tv"><div class="tv-lg">${legend}${toggle}</div>` +
    `<div class="tv-hd"><span>Model / agent</span><span>Status</span><div class="ax"><div class="tv-scale" title="${esc(scaleTitle)}">${ticks}</div><span>${contextLabel}</span></div>` +
    `<div class="tv-mh"><span title="${esc(COLUMN_HELP.tokens_in)}; and tokens the model wrote back">Input / output</span>` +
    `<span title="${esc(COLUMN_HELP.cache_pct)}">Cache reads</span><span>Cost</span></div></div>` +
    `<div class="tv-rows">${rowsHtml}</div><div class="tv-tip" role="tooltip" hidden></div></div>`
  );
}

const TABLE_ICON =
  '<svg viewBox="0 0 16 16" focusable="false"><rect x="1.5" y="2" width="13" height="12" rx="1"/><path d="M1.5 6h13M6 2v12"/></svg>';
const TRAJECTORIES_ICON =
  '<svg viewBox="0 0 16 16" focusable="false"><path d="M2 3h12M2 8h12M2 13h12"/><circle cx="5" cy="3" r="1.5"/><circle cx="10" cy="8" r="1.5"/><circle cx="7" cy="13" r="1.5"/></svg>';

function toolbar(
  view: ExplorerView,
  columns: readonly Column[],
  options: {
    hasResults: boolean;
    aiHasRun?: boolean;
    windowDays?: number;
    counts?: Readonly<Record<string, number>> | null;
    tracesLayout?: boolean;
  },
): string {
  const {
    hasResults,
    aiHasRun: ran = false,
    windowDays = 7,
    tracesLayout = false,
  } = options;
  const counts = options.counts ?? {};
  const chosen = new Set(columns.map((c) => c.key));
  const chipDefs: [string, string][] = [
    ["all", "All"],
    ["errors", "Errors"],
    ...(Object.hasOwn(counts, "matches")
      ? ([["matches", "AI matches"]] as [string, string][])
      : []),
  ];
  const pressed = (key: string) => pyBool(view.quickView === key);
  const topButton = (key: string, metric: string, scope: string) =>
    `<button type="button" class="${view.quickView === key ? "on" : ""}" aria-pressed="${pressed(key)}" title="Top 10% of ${scope} by ${metric}" hx-get="/find/rows?quick_view=${key}" ${HX_RESULTS}>${TOP_QUICK_VIEW_LABELS[key]}</button>`;
  const quickViews =
    chipDefs
      .map(
        ([key, label]) =>
          `<button type="button" class="xr-qv-${key}${key === "errors" && counts[key] ? " has-errors" : ""}${view.quickView === key ? " on" : ""}" aria-pressed="${pressed(key)}" ` +
          `hx-get="/find/rows?quick_view=${key}" ${HX_RESULTS}>` +
          `${label}${Object.hasOwn(counts, key) ? ` <span class="xr-count">${counts[key]}</span>` : ""}</button>`,
      )
      .join("") +
    '<span class="xr-qv-sep" aria-hidden="true"></span>' +
    '<details class="xr-top-menu"><summary class="' +
    (Object.hasOwn(TOP_METRICS, view.quickView) ||
    Object.hasOwn(CONVERSATION_METRICS, view.quickView)
      ? "on"
      : "") +
    '">' +
    `${TOP_QUICK_VIEW_LABELS[view.quickView] ?? "Views"} ▾` +
    '</summary><div class="xr-top-list" role="group" aria-label="Views">' +
    '<span class="xr-top-head">Traces</span>' +
    ["slow", "costly", "tokens", "context"]
      .map((key) =>
        topButton(
          key,
          (TOP_METRICS[key] as readonly [string, unknown])[0],
          "loaded traces",
        ),
      )
      .join("") +
    '<span class="xr-top-head">Conversations</span>' +
    ["conv_costly", "conv_tokens", "conv_longest"]
      .map((key) =>
        topButton(
          key,
          (CONVERSATION_METRICS[key] as readonly [string, unknown])[0],
          "conversations",
        ),
      )
      .join("") +
    "</div></details>";
  const boxes = Object.values(COLUMNS)
    .map(
      (c) =>
        `<label${ran || c.key !== MATCH ? "" : " hidden"}>` +
        `<input type="checkbox" name="columns" value="${c.key}"${chosen.has(c.key) ? " checked" : ""}>${esc(c.label)}</label>`,
    )
    .join("");
  const switchHtml = (
    [
      ["table", "Table", TABLE_ICON],
      ["trajectories", "Trajectories", TRAJECTORIES_ICON],
    ] as const
  )
    .map(
      ([mode, label, icon]) =>
        `<button type="button" class="${view.view === mode ? "on" : ""}" aria-pressed="${pyBool(view.view === mode)}" ` +
        `hx-get="/find/rows?view=${mode}" ${HX_RESULTS}>` +
        `<span class="xr-view-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`,
    )
    .join("");
  const sortOptions: [string, string][] = [
    ["started", "Time"],
    ["tokens_in", "Input tokens"],
    ...(hasResults ? ([["match", "Match"]] as [string, string][]) : []),
  ];
  const sort =
    view.view === "trajectories"
      ? '<details class="xr-sort"><summary>Sort ▾</summary><div class="xr-sort-options" role="group" aria-label="Sort trajectories">' +
        sortOptions
          .map(
            ([key, label]) =>
              `<button type="button" hx-get="/find/rows?sort=${key}&dir=desc" hx-target="#explorer-results" ` +
              `hx-swap="outerHTML" hx-sync="#explorer-results:replace">${label}</button>`,
          )
          .join("") +
        "</div></details>"
      : "";
  const columnsMenu =
    view.view === "table"
      ? '<details class="xr-cols" id="explorer-cols"><summary>Columns ▾</summary>' +
        `<form hx-post="/find/columns" hx-trigger="change" ${HX_RESULTS}>${csrfField()}${boxes}</form></details>`
      : "";
  const exportLink =
    tracesLayout && view.view === "table"
      ? '<a class="btn-secondary xr-export" href="/traces/export.csv">Export</a>'
      : "";
  const dateAndRows = rangeInputs(view.start, view.end, windowDays, {
    includeLoad: false,
    rowLimit: view.limit || DEFAULT_EXPLORER_ROWS,
    timeOrigin: view.initialLoad ? "default" : "explicit",
  });
  const contextMenu = view.view === "trajectories" ? sort : columnsMenu;
  const load =
    '<button class="btn-secondary xr-load" type="submit" form="explorer-load-form">Load</button>';
  const chips = renderFacetChips(view.facets, view.numeric, {
    removable: true,
  });
  const active = chips.split('class="chip ').length - 1;
  const label = active ? `Filters · ${active}` : "Filters";
  return (
    `<div class="xr-toolbar"><button type="button" class="xr-filter" data-explorer-filters aria-haspopup="true" aria-expanded="false">${label}</button>` +
    `<span class="xr-chips">${chips}</span>` +
    `<span class="xr-quickviews" role="group" aria-label="Quick views">${quickViews}</span>` +
    `<span class="spacer"></span><span class="xr-toolbar-right">${exportLink}${dateAndRows}${contextMenu}${load}` +
    `<span class="finder-seg xr-switch" role="group" aria-label="View">${switchHtml}</span></span></div>`
  );
}

function pager(view: ExplorerView, results: Results | null): string {
  const pages = view.pageCount(results);
  if (pages <= 1) return "";
  const page = Math.min(view.page, pages - 1);
  const prev = page
    ? `<button type="button" class="link" hx-get="/find/rows?page=${page - 1}" ${HX_RESULTS}>← Prev</button>`
    : "";
  const next =
    page < pages - 1
      ? `<button type="button" class="link" hx-get="/find/rows?page=${page + 1}" ${HX_RESULTS}>Next →</button>`
      : "";
  return `<div class="xr-pager">${prev}<span>Page ${page + 1} of ${pages} · ${PAGE_ROWS} per page</span>${next}</div>`;
}

function totalsStrip(rows: readonly TraceRow[]): string {
  const t = totals(rows);
  const share =
    t.cacheShare !== null ? pyPercent(t.cacheShare) : fmtTokens(null);
  const parts: [string, string, string, string, boolean][] = [
    ["traces", "Traces", "▦", grouped(t.traces), true],
    ["errors", "Errors", "!", grouped(t.errors), true],
    ["cost", "Cost", "$", fmtCost(t.cost, t.currency), t.cost !== null],
    ["in", "Input", "↓", fmtTokens(t.tokensIn), t.tokensIn !== null],
    ["out", "Output", "↑", fmtTokens(t.tokensOut), t.tokensOut !== null],
    ["cache read", "Cache read", "↻", share, t.cacheShare !== null],
    ["p50", "P50", "◷", fmtDuration(t.p50Ms), t.p50Ms !== null],
    ["p95", "P95", "◷", fmtDuration(t.p95Ms), t.p95Ms !== null],
  ];
  const cells = parts
    .map(
      ([label, display, icon, value, available]) =>
        `<span class="xr-total xr-total-${label.replaceAll(" ", "-")}` +
        `${label === "errors" && t.errors ? " has-errors" : ""}${available ? "" : " unavailable"}"` +
        `${Object.hasOwn(TOTAL_HELP, label) ? ` title="${esc(TOTAL_HELP[label])}"` : ""}>` +
        `<span class="xr-total-mark" aria-hidden="true">${icon}</span>` +
        `<span class="xr-total-copy"><span class="xr-total-label">${display}</span>` +
        `<b class="xr-total-value">${available ? value : "Unavailable"}</b></span></span>`,
    )
    .join("");
  return `<div class="xr-totals" aria-label="Totals for the traces shown">${cells}</div>`;
}

export const TOOLBAR_SLOT_ID = "explorer-toolbar";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function renderKey(markup: string): string {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(markup))
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export interface ResultsOptions {
  records: Records | null;
  snapshot: RunSnapshot | null;
  oob?: boolean;
  error?: string | null;
  windowDays?: number;
  tracesLayout?: boolean;
  poll?: boolean;
  pollSequence?: number | null;
}

export function results(
  viewIn: ExplorerView,
  columns: readonly Column[],
  options: ResultsOptions,
): string {
  const {
    records,
    oob = false,
    error = null,
    windowDays = 7,
    tracesLayout = false,
    poll = false,
    pollSequence = null,
  } = options;
  const snapshot = withinSnapshot(options.snapshot);
  const view = matchesFirstView(viewIn, snapshot);
  const oobAttr = oob ? ' hx-swap-oob="true"' : "";
  const pollAttrs =
    view.state === "loading" || view.trajectoryWarming || view.messageCounting
      ? ' hx-get="/find/rows" hx-trigger="every 1s" hx-swap="none"'
      : "";
  const judged =
    snapshot !== null && hasAny(snapshot.results) ? snapshot.results : null;
  const counts: Record<string, number> = view.rows.length
    ? { errors: view.rows.filter((row) => row.isError).length }
    : {};
  const isClassified = judged !== null && classified(snapshot);
  const matchedRows = (rows: readonly TraceRow[]) =>
    judged === null
      ? 0
      : rows.filter((row) =>
          aiMatched(
            Object.hasOwn(judged, row.traceId) ? judged[row.traceId] : null,
          ),
        ).length;
  if (judged !== null && isClassified) counts.matches = matchedRows(view.rows);
  const toolbarHtml = toolbar(view, columns, {
    hasResults: judged !== null,
    aiHasRun: aiHasRun(snapshot),
    windowDays,
    counts,
    tracesLayout,
  });
  const judgedCount =
    judged !== null
      ? view.rows.filter((row) => Object.hasOwn(judged, row.traceId)).length
      : 0;
  const matchedInView = matchedRows(view.rows);
  const judgedStatus =
    isClassified && view.quickView !== "matches" && view.state !== "loading"
      ? ` · ${judgedCount} judged, ${matchedInView} match`
      : "";
  const reason =
    '<span title="Possible reasons: outside the rows the question ran on, over the AI trace limit, ' +
    'or no conversation to read, such as embedding calls.">' +
    `${view.rows.length - judgedCount} not judged</span>`;
  const notJudged =
    isClassified &&
    snapshot !== null &&
    snapshot.state === "completed" &&
    judgedCount < view.rows.length
      ? ` · ${reason}`
      : "";
  const missingConversations =
    view.narrowedFrom !== null &&
    snapshot !== null &&
    snapshot.withinResults &&
    snapshot.state === "completed" &&
    snapshot.loaded < view.narrowedFrom
      ? ` · ${view.narrowedFrom - snapshot.loaded} of the ${view.narrowedFrom} have no conversation`
      : "";
  const visibleJudged = view.visibleRows(judged);
  const shown = visibleJudged.length;
  const atFetchCap = Boolean(view.limit && view.rows.length >= view.limit);
  const shownLoaded = atFetchCap
    ? `Showing ${shown} of ${view.rows.length} loaded traces · requested cap ${grouped(view.limit)}; ` +
      "more traces may exist, so raise Rows or narrow the range"
    : `Showing ${shown} of ${view.rows.length} loaded traces`;
  const statusDiv = (text: string) =>
    `<div class="xr-status" role="status">${text}</div>`;
  let status: string;
  if (view.state === "loading")
    status = statusDiv(`Loading traces · ${view.rows.length} / ${view.limit}`);
  else if (view.quickView === "conv_longest" && view.messageCounting)
    status = statusDiv("Counting messages…");
  else if (view.quickView === "conv_longest" && view.messageCountError)
    status = statusDiv(
      `Could not count messages: ${esc(view.messageCountError)}`,
    );
  else if (view.quickView === "matches" && Object.hasOwn(counts, "matches"))
    status = statusDiv(`${counts.matches} AI matches`);
  else if (Object.hasOwn(TOP_METRICS, view.quickView))
    status = statusDiv(
      `Top 10% by ${(TOP_METRICS[view.quickView] as readonly [string, unknown])[0]} · ` +
        `${shown} of ${view.rows.length} loaded traces, heaviest first`,
    );
  else if (Object.hasOwn(CONVERSATION_METRICS, view.quickView)) {
    const conversations = new Set(
      visibleJudged
        .map((row) => conversationKey(row))
        .filter((key) => key !== null),
    ).size;
    status = statusDiv(
      `Top 10% of conversations by ${(CONVERSATION_METRICS[view.quickView] as readonly [string, unknown])[0]} · ${conversations} conversation${conversations !== 1 ? "s" : ""}, ${shown} of ${view.rows.length} loaded traces`,
    );
  } else if (view.narrowedFrom !== null)
    status = statusDiv(
      `Showing ${view.rows.length} of ${view.narrowedFrom} loaded traces match the filters${judgedStatus}${missingConversations}${notJudged}` +
        (atFetchCap ? ` · ${grouped(view.limit)}-trace fetch cap reached` : ""),
    );
  else status = statusDiv(`${shownLoaded}${judgedStatus}${notJudged}`);

  let inner: string;
  if (view.state === "idle")
    inner = empty(
      "Load traces to start.",
      "Pick a time range and filters, then press Load. Loading uses no AI.",
    );
  else if (!view.rows.length && view.state === "loaded")
    inner =
      view.narrowedFrom !== null
        ? empty(
            "No loaded traces match.",
            `None of the ${view.narrowedFrom} loaded traces meet the filters. Remove a filter, or use New search to look beyond the loaded rows.`,
          )
        : empty(
            "No traces match.",
            "Nothing in this time range matches the filters. Widen the range or remove a filter.",
          );
  else if (!view.rows.length && view.state === "failed")
    inner = loadFailed(view.error);
  else {
    const banner =
      view.state === "failed"
        ? `<div class="finder-review finder-form-error" role="alert">Load stopped: ${esc(view.error || "unknown error")}. ${view.rows.length} rows loaded.</div>`
        : "";
    const within =
      snapshot !== null && snapshot.withinResults ? snapshot.results : null;
    const visibleRows = view.visibleRows(within);
    let body =
      view.view === "trajectories"
        ? trajectories(view, records ?? {}, snapshot, {
            loading: view.state === "loading" || view.trajectoryWarming,
            summaryLoading: view.state === "loading",
            tracesLayout,
          })
        : `<div class="xr-table-wrap">${table(view, columns, snapshot, { tracesLayout })}</div>`;
    const isConversationView = Object.hasOwn(
      CONVERSATION_METRICS,
      view.quickView,
    );
    const anyConversation = view.rows.some(
      (row) => row.threadId || row.sessionId,
    );
    if (
      view.quickView === "conv_longest" &&
      (view.messageCounting || view.messageCountError)
    )
      body = empty(
        view.messageCounting
          ? "Counting messages…"
          : "Message counts unavailable.",
        view.messageCountError
          ? "The loaded traces are still available. Choose another view or retry this view to count again."
          : "Message counts will appear here when loading finishes.",
      );
    else if (!visibleRows.length) {
      const label = Object.hasOwn(TOP_METRICS, view.quickView)
        ? `No loaded traces report ${(TOP_METRICS[view.quickView] as readonly [string, unknown])[0]}.`
        : isConversationView && anyConversation
          ? `No loaded conversations report ${(CONVERSATION_METRICS[view.quickView] as readonly [string, unknown])[0]}.`
          : isConversationView
            ? "No conversations in the loaded traces."
            : (
                {
                  errors: "No errors found.",
                  matches: "No AI matches found.",
                } as Record<string, string>
              )[view.quickView];
      if (
        view.quickView === "matches" &&
        snapshot !== null &&
        snapshot.state === "completed"
      )
        body =
          '<div class="xr-empty"><h4>No AI matches</h4>' +
          `<p>None of the ${judgedCount} judged traces match “${esc(snapshot.request ? snapshot.request.query : "")}”. ` +
          "Rephrase the question, or pick New search to look beyond the loaded rows.</p></div>";
      else if (label)
        body = empty(
          label,
          isConversationView && anyConversation
            ? ""
            : isConversationView
              ? "These views group traces by thread or session id, and none of the loaded traces carry one."
              : "Choose All to return to the full loaded trace population.",
        );
    }
    if (
      snapshot !== null &&
      snapshot.state === "completed" &&
      within !== null &&
      view.matchedOnly &&
      !view.visibleRows(within).length
    )
      body = empty("No matches.", "No loaded traces match this filter.");
    inner = `${banner}${body}${pager(view, within)}`;
  }
  const strip =
    view.rows.length || view.state === "loaded"
      ? totalsStrip(visibleJudged)
      : "";
  inner = `${status}${strip}${inner}`;
  const errorHtml = error
    ? `<div class="finder-review finder-form-error" role="alert">${esc(error)}</div>`
    : "";
  const sectionBody = `${errorHtml}${inner}`;
  let marks = ` data-view-version="${view.version}"${poll ? " data-poll" : ""}`;
  if (pollSequence !== null) marks += ` data-poll-sequence="${pollSequence}"`;
  const initialLoadMark =
    poll && view.initialLoad && view.state === "loaded"
      ? ' data-initial-load="ready"'
      : "";
  return (
    `<section id="explorer-results" class="xr" hx-sync="this:replace" hx-include="#finder-scope"${oobAttr}${pollAttrs}` +
    `${marks}${initialLoadMark} data-render-key="${renderKey(pollAttrs + sectionBody)}">${sectionBody}</section>` +
    `<div id="${TOOLBAR_SLOT_ID}" hx-swap-oob="true"${marks} data-render-key="${renderKey(toolbarHtml)}">${toolbarHtml}</div>`
  );
}

export function splitToolbar(html: string): [string, string] {
  const marker = `<div id="${TOOLBAR_SLOT_ID}" hx-swap-oob="true"`;
  const at = html.indexOf(marker);
  if (at < 0) return ["", html];
  return [
    `<div id="${TOOLBAR_SLOT_ID}"${html.slice(at + marker.length)}`,
    html.slice(0, at),
  ];
}
