import { esc } from "../../common/reports/html-helpers.js";
import { pyFixed, pyG, pyPercent } from "../../common/reports/number-format.js";
import { pythonString } from "../../common/sanitize.js";
import { pythonJson } from "../../formats/json.js";
import { parseIso } from "../../formats/time.js";
import {
  fmtCost,
  fmtDuration,
  fmtTime,
  fmtTokens,
  resolveColumns,
} from "../../trace-finder/columns.js";
import { classificationLegend } from "../../trace-finder/compiler.js";
import { ExplorerView } from "../../trace-finder/explorer.js";
import { exportFilename } from "../../trace-finder/export.js";
import {
  type CompiledQuery,
  type DimensionAnswer,
  FACET_NAMES,
  type FacetCatalogue,
  FacetSelection,
  type NumericFilters,
  type RunRequest,
  type RunSnapshot,
  selectionRuleText,
  type TraceClassification,
  type TraceDetail,
  type TraceRecord,
} from "../../trace-finder/models.js";
import type { TraceRow } from "../../trace-finder/rows.js";
import type { DashboardSettings } from "../../trace-finder/settings.js";
import { isErrorSpan, spanStatusText } from "../../trace-finder/span-status.js";
import {
  KIND_LABELS,
  type Kind,
  type Segment,
  segments,
} from "../../trace-finder/trajectory.js";
import { drawer as drawerShell } from "../apply-ui.js";
import {
  camel,
  renderFacetChips,
  renderFacetMenu,
  selectedValues,
  windowCountNote,
} from "../facet-picker.js";
import { cliSlugRenderScope } from "../orq-workspace.js";
import { csrfField } from "../security.js";
import { page } from "../shell.js";
import {
  singleTraceUrl,
  traceLinkButton,
  traceSpanUrl,
} from "../trace-links.js";
import { results as explorerResults, splitToolbar } from "./explorer-views.js";

export const SAMPLES = [
  "Frustrated customers in the support agent on production this week.",
  "Errored traces on claude-sonnet-5 where the user was blocked by a failed tool.",
  "Conversations over 20k tokens that should have been escalated to a human.",
  "Responses from the docs agent that make unsupported claims.",
] as const;
export const COMMAND_LEDE =
  "Recent traces from your agents, newest first: ask a question in plain words, or filter the list below.";
export const COMMAND_EXAMPLES = [
  "Did any customers get frustrated?",
  "Which conversations mention refunds?",
  "Where did the agent fail to help someone?",
] as const;
export const SCOPE_HELP_WITHIN =
  "Within results reads every loaded trace, including rows outside the current tab or page.";
export const SCOPE_HELP_NEW =
  "New search searches the chosen time range up to the Rows limit, then loads the matches.";
export const ASK_AI_COST_NOTE =
  "Each question is answered by an AI model, so it takes a few seconds and costs a little.";
export const RUN_STATUS_ID = "finder-run-status";

const grouped = (value: number) => value.toLocaleString("en-US");
const pySorted = (values: Iterable<string>) =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const quote = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function iconSearch(): string {
  return (
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/>' +
    '<path d="m20 20-3.5-3.5"/></svg>'
  );
}

export function examples(): string {
  const items = SAMPLES.map(
    (sample) =>
      `<button type="button" data-finder-example="${esc(sample)}">${esc(sample)}</button>`,
  ).join("");
  return `<div class="finder-examples"><div class="hd">Examples</div>${items}</div>`;
}

export function hero(
  query: string,
  mode: string,
  options: { apiAvailable: boolean; error?: string | null; hasRows?: boolean },
): string {
  const { apiAvailable, error, hasRows = false } = options;
  const disabled = apiAvailable ? "" : " disabled";
  const errorHtml = error
    ? `<div class="finder-form-error" role="alert">${esc(error)}</div>`
    : "";
  const checkedImmediate = mode !== "review" ? " checked" : "";
  const checkedReview = mode === "review" ? " checked" : "";
  return (
    '<section class="finder-hero"><div class="finder-hero-bg"></div>' +
    '<h2 class="finder-title">Traces</h2>' +
    '<p class="finder-sub">Ask AI about your traces. Inspect every judgment.</p>' +
    '<form id="finder-query-form" class="finder-query" hx-post="/find/run" hx-target="#finder-body" ' +
    'hx-swap="innerHTML" hx-include="#finder-controls" hx-disabled-elt="find button">' +
    `${csrfField()}${iconSearch()}<div class="col"><textarea name="query" rows="1" placeholder="Ask AI about these traces…" ` +
    `required${disabled}>${esc(query)}</textarea></div>` +
    `<button class="finder-go" type="submit"${disabled}><span class="finder-go-idle">Ask AI <span aria-hidden="true">↗</span></span>` +
    '<span class="finder-go-working" role="status">Starting search…</span></button>' +
    "</form>" +
    '<div id="finder-scope" class="finder-seg" role="radiogroup" aria-label="Ask AI scope">' +
    `<label><input type="radio" name="scope" value="within" form="finder-query-form"${hasRows ? " checked" : ""}${hasRows ? "" : " disabled"}><span>Within results</span></label>` +
    `<label><input type="radio" name="scope" value="new" form="finder-query-form"${hasRows ? "" : " checked"}><span>New search</span></label></div>` +
    '<div class="finder-below">' +
    '<p class="finder-hint-line">Within results reads all loaded traces, even when a tab or page hides some rows.</p>' +
    '<div class="finder-seg" role="radiogroup" aria-label="Mode">' +
    `<label><input type="radio" name="mode" value="immediate" form="finder-query-form"${checkedImmediate} ` +
    'hx-post="/find/reset" hx-trigger="change[document.getElementById(\'finder-start-form\')]" ' +
    'hx-include="#finder-query-form" hx-target="#finder-body" hx-swap="innerHTML" hx-indicator="#finder-mode-working"><span>Immediate</span></label>' +
    `<label><input type="radio" name="mode" value="review" form="finder-query-form"${checkedReview}><span>Review first</span></label></div>` +
    '<span id="finder-mode-working" role="status">Resetting review…</span>' +
    `<span class="ex"><button type="button" class="link">Examples ▾</button>${examples()}</span>` +
    '<span class="spacer"></span><span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> to run</span></div>' +
    `${errorHtml}</section>`
  );
}

export function scopeToggle(options: {
  hasRows: boolean;
  selected?: string | null;
}): string {
  const { hasRows } = options;
  let selected =
    options.selected === "within" || options.selected === "new"
      ? options.selected
      : hasRows
        ? "within"
        : "new";
  if (selected === "within" && !hasRows) selected = "new";
  const within = hasRows ? "" : " disabled";
  return (
    '<label><input type="radio" name="scope" value="within" form="finder-query-form"' +
    (selected === "within" ? " checked" : "") +
    within +
    "><span>Within results</span></label>" +
    '<label><input type="radio" name="scope" value="new" form="finder-query-form"' +
    (selected === "new" ? " checked" : "") +
    "><span>New search</span></label>"
  );
}

export function tracesCommandStrip(
  query: string,
  options: {
    apiAvailable: boolean;
    error?: string | null;
    hasRows?: boolean;
    mode?: string;
    autoScopePending?: boolean;
  },
): string {
  const {
    apiAvailable,
    error,
    hasRows = false,
    mode = "immediate",
    autoScopePending = false,
  } = options;
  const disabled = apiAvailable ? "" : " disabled";
  const errorHtml = error
    ? `<div class="finder-form-error" role="alert">${esc(error)}</div>`
    : "";
  const labels = [
    "Frustrated customers?",
    "Refund requests?",
    "Unhelpful replies?",
  ];
  const chips = COMMAND_EXAMPLES.map(
    (sample, index) =>
      `<button type="button" data-finder-example="${esc(sample)}" title="${esc(sample)}">${esc(labels[index])}</button>`,
  ).join("");
  const autoScopeAttr = autoScopePending ? ' data-auto-scope="pending"' : "";
  return (
    '<section class="finder-hero finder-command">' +
    `<p class="finder-command-lede">${esc(COMMAND_LEDE)}</p>` +
    '<form id="finder-query-form" class="finder-query finder-command-query" hx-post="/find/run" hx-target="#finder-body" ' +
    'hx-swap="innerHTML" hx-include="#finder-controls, #explorer-load-form" hx-disabled-elt="find button">' +
    `${csrfField()}<span class="finder-ai-icon" aria-hidden="true">✦</span><span class="finder-ai-label">Ask AI</span>` +
    `<div class="col"><textarea class="finder-command-textarea" name="query" aria-label="Ask AI a question about your traces" rows="1" placeholder="Ask a question about your traces…" required${disabled}>` +
    `${esc(query)}</textarea><div class="finder-command-examples" aria-label="Example questions">${chips}</div></div>` +
    `<input type="hidden" name="mode" value="${esc(mode)}">` +
    '<span class="finder-scope-label" id="finder-scope-label">Search in</span>' +
    '<div id="finder-scope" class="finder-seg" role="radiogroup" aria-labelledby="finder-scope-label"' +
    `${autoScopeAttr}>` +
    `${scopeToggle({ hasRows })}</div><a href="/settings" title="Choose the models Ask AI uses" ` +
    'class="finder-command-gear" aria-label="AI settings"><span aria-hidden="true">⚙</span></a>' +
    `<button class="finder-go finder-command-search" type="submit"${disabled}><span class="finder-go-idle">Search</span>` +
    '<span class="finder-go-working" role="status">Searching…</span></button>' +
    "</form>" +
    `<p class="finder-command-help"><span class="scope-within">${esc(SCOPE_HELP_WITHIN)}</span>` +
    `<span class="scope-new">${esc(SCOPE_HELP_NEW)}</span> ${esc(ASK_AI_COST_NOTE)}</p>` +
    `${errorHtml}</section>`
  );
}

function loadedTallies(
  rows: readonly TraceRow[],
): Record<string, Map<string, [string, number]>> {
  const single = {
    agent_name: "agentName",
    status: "status",
    product: "product",
  } as const;
  const multi = { model: "models", provider: "providers" } as const;
  const tallies: Record<string, Map<string, [string, number]>> = {};
  for (const name of [...Object.keys(single), ...Object.keys(multi)])
    tallies[name] = new Map();
  const bump = (facet: string, value: string) => {
    const tally = tallies[facet] as Map<string, [string, number]>;
    const [shown, count] = tally.get(value.toLowerCase()) ?? [value, 0];
    tally.set(value.toLowerCase(), [shown, count + 1]);
  };
  for (const row of rows) {
    for (const [facet, attr] of Object.entries(single)) {
      const value = (row as unknown as Record<string, unknown>)[attr];
      if (value) bump(facet, String(value));
    }
    for (const [facet, attr] of Object.entries(multi))
      for (const value of new Set(
        (row as unknown as Record<string, readonly string[]>)[attr],
      ))
        bump(facet, value);
  }
  return tallies;
}

export function facetMenu(
  catalogue: FacetCatalogue | null = null,
  options: {
    numeric?: NumericFilters | null;
    open?: boolean;
    formId?: string;
    selection?: FacetSelection | null;
    pending?: boolean;
    loadedRows?: readonly TraceRow[] | null;
    rowScoped?: boolean;
    windowDays?: number | null;
  } = {},
): string {
  const {
    numeric,
    open = false,
    formId = "finder-query-form",
    selection,
    pending = false,
    loadedRows = null,
    rowScoped = false,
    windowDays = null,
  } = options;
  let counts: Record<string, Record<string, number>> | null = null;
  let countNote = "";
  let countTitle = "";
  if (loadedRows !== null) {
    counts = {};
    for (const [facet, tally] of Object.entries(loadedTallies(loadedRows))) {
      const entry: Record<string, number> = {};
      for (const [shown, count] of tally.values()) entry[shown] = count;
      counts[facet] = entry;
    }
    countNote = `Counts are of the ${grouped(loadedRows.length)} rows currently loaded, so they change as you filter.`;
    countTitle = "Loaded traces";
  } else if (catalogue !== null) {
    counts = catalogue.valueCounts as Record<string, Record<string, number>>;
    countNote = windowCountNote(windowDays);
  }
  let note: string;
  let attrs: string;
  if (pending || rowScoped) {
    note =
      rowScoped && loadedRows !== null
        ? ""
        : '<p class="finder-empty">Loading facet values…</p>';
    const countsParam =
      loadedRows !== null || rowScoped ? "&counts=loaded" : "";
    const triggers = pending ? "load, refreshFacets" : "refreshFacets";
    attrs =
      `${rowScoped ? " data-refresh-on-open" : ""}` +
      ` hx-get="/find/facets?form_id=${formId}${countsParam}" hx-trigger="${triggers}" ` +
      'hx-include="#finder-controls" hx-swap="outerHTML" hx-indicator=".finder-facet-loading" ' +
      `hx-sync="#finder-controls:replace"${pending ? " data-pending" : ""}`;
  } else {
    note =
      catalogue === null && loadedRows === null
        ? '<p class="finder-empty">Facet values are unavailable; check the Orq connection and reopen.</p>'
        : catalogue === null
          ? '<p class="facet-note">Orq\'s full value list is unavailable; showing values from the loaded traces.</p>'
          : "";
    attrs = "";
  }
  return renderFacetMenu(catalogue, {
    formId,
    selection,
    numeric,
    counts,
    countNote,
    countTitle,
    listNoteHtml: note,
    containerAttrs: attrs,
    open,
  });
}

const daysBetween = (start: string | Date, end: string | Date) =>
  Math.max(
    1,
    Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
    ),
  );

export function controls(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  catalogue: FacetCatalogue | null = null,
  options: {
    pending?: boolean;
    explorerFacets?: FacetSelection | null;
    explorerNumeric?: NumericFilters | null;
    explorerView?: ExplorerView | null;
  } = {},
): string {
  const {
    pending = false,
    explorerFacets = null,
    explorerNumeric = null,
    explorerView = null,
  } = options;
  const request = snapshot.request;
  const population = request?.population ?? null;
  const selection = population?.facets ?? null;
  let facets: FacetSelection = selection ?? new FacetSelection();
  const review = snapshot.state === "awaiting_review";
  const formId = review
    ? "finder-start-form"
    : explorerView !== null
      ? "explorer-load-form"
      : "finder-query-form";
  let windowDays = settings.windowDays;
  if (population?.start && population.end)
    windowDays = daysBetween(population.start, population.end);
  else if (explorerView?.start && explorerView.end)
    windowDays = daysBetween(explorerView.start, explorerView.end);
  const values = {
    window_days: windowDays,
    limit:
      population !== null
        ? population.limit
        : explorerView?.limit
          ? explorerView.limit
          : settings.limit,
    parallelism: request !== null ? request.parallelism : settings.parallelism,
  };
  let numeric: NumericFilters | null = population?.numeric ?? null;
  const keep = (name: string) => `id="finder-${name}-${formId}" hx-preserve`;
  const carriedFacets = review
    ? facets
    : (explorerFacets ?? explorerView?.facets ?? snapshot.explicitFilters);
  const carriedNumeric = review
    ? numeric
    : (explorerNumeric ?? explorerView?.numeric ?? snapshot.explicitNumeric);
  if (
    !review &&
    population === null &&
    (explorerFacets !== null || explorerView !== null)
  ) {
    facets = carriedFacets;
    numeric = carriedNumeric;
  }
  let generatedOnly: FacetSelection | null = null;
  if (review) {
    const update: Record<string, unknown> = {
      projectId: snapshot.generatedFilters.projectId,
    };
    for (const name of FACET_NAMES) {
      const explicit = selectedValues(snapshot.explicitFilters, name);
      update[camel(name)] = [
        ...selectedValues(snapshot.generatedFilters, name),
      ].filter((value) => !explicit.has(value));
    }
    generatedOnly = new FacetSelection(update);
  }
  const countHtml = snapshot.total
    ? `<span class="count">${esc(String(snapshot.total))} traces selected</span>`
    : "";
  const scopeHtml = settings.orqProjectId
    ? `<span class="quiet"><b>Project</b><a href="/settings">${esc(settings.orqProjectName || settings.orqProjectId)}</a></span>`
    : "";
  const hiddenFacets = FACET_NAMES.flatMap((name) =>
    pySorted(selectedValues(carriedFacets, name)).map(
      (value) =>
        `<input type="hidden" form="${formId}" name="facet_${name}" value="${esc(value)}">`,
    ),
  ).join("");
  const removable =
    snapshot.state !== "compiling" && snapshot.state !== "classifying";
  return (
    '<div class="finder-controls" id="finder-controls">' +
    `${hiddenFacets}${scopeHtml}${renderFacetChips(facets, numeric, { removable, generated: generatedOnly })}` +
    '<span class="addwrap"><button class="add" type="button" aria-haspopup="true">+ Filter</button>' +
    facetMenu(catalogue, {
      numeric: carriedNumeric,
      formId,
      selection: carriedFacets,
      pending,
      loadedRows: explorerView !== null ? explorerView.rows : null,
      rowScoped: explorerView !== null,
      windowDays,
    }) +
    '<span class="finder-facet-loading" role="status">Loading filters…</span></span><span class="spacer"></span>' +
    `<input ${keep("window_days")} type="hidden" form="${formId}" name="window_days" value="${values.window_days}">` +
    `<input id="finder-limit-query" type="hidden" form="${formId}" name="limit" value="${values.limit}">` +
    `<input ${keep("parallelism")} type="hidden" form="${formId}" name="parallelism" value="${values.parallelism}">` +
    (explorerView !== null
      ? '<input type="hidden" data-new-range name="new_from" value="">' +
        '<input type="hidden" data-new-range name="new_to" value="">' +
        '<input type="hidden" data-new-range name="new_from_tz_offset" value="0">' +
        '<input type="hidden" data-new-range name="new_to_tz_offset" value="0">'
      : "") +
    `${countHtml}</div>`
  );
}

export function valueText(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : pyG(value);
  return String(value);
}

function answerColor(
  answer: DimensionAnswer,
  dimension: CompiledQuery,
): string {
  if (answer.error) return "var(--red-600)";
  if (dimension.task.kind === "score" && typeof answer.value === "number") {
    const score = Math.max(0, Math.min(1, answer.value));
    return `color-mix(in srgb, var(--chart-5) ${pyG(score * 100)}%, var(--chart-2))`;
  }
  for (const item of classificationLegend(dimension))
    if (item.label === valueText(answer.value)) return item.color;
  return answer.matched ? "var(--chart-5)" : "var(--chart-2)";
}

export function resultColor(
  result: TraceClassification | null | undefined,
  dimensions: readonly CompiledQuery[] | null,
): string {
  if (!result || result.error)
    return result?.error ? "var(--red-600)" : "#3d3c4a";
  if (
    dimensions !== null &&
    dimensions.length === 1 &&
    result.answers.length === 1
  )
    return answerColor(
      result.answers[0] as DimensionAnswer,
      dimensions[0] as CompiledQuery,
    );
  return result.matched ? "var(--chart-5)" : "var(--chart-2)";
}

export function answersText(
  result: TraceClassification,
  dimensions: readonly CompiledQuery[] | null,
): string {
  if (!result.answers.length) return "kept by filters, not judged by the AI";
  const names = (dimensions ?? []).map((dimension) => dimension.name);
  return result.answers
    .map(
      (answer, index) =>
        `${index < names.length ? `${names[index]}: ` : ""}${valueText(answer.value)}` +
        (answer.confidence !== null
          ? ` (${pyFixed(answer.confidence, 2)})`
          : ""),
    )
    .join(" · ");
}

const QUESTION_CAP = 80;

export function reasonLine(answer: DimensionAnswer): string {
  if (answer.error || !answer.matched || answer.confidence === null) return "";
  return `<div class="xr-reason">Classifier score ${pyPercent(answer.confidence)}</div>`;
}

function capped(question: string, limit = QUESTION_CAP): string {
  const chars = [...question];
  return chars.length <= limit
    ? question
    : `${chars
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}

export function drawerReason(answer: DimensionAnswer): string {
  if (answer.error || !answer.matched || answer.confidence === null) return "";
  return `<p class="fd-reason">${esc(`Classifier score ${pyPercent(answer.confidence)}`)}</p>`;
}

export function answerCells(
  result: TraceClassification,
  dimensions: readonly CompiledQuery[],
): string {
  return dimensions
    .map((dimension, index) => {
      const answer = result.answers[index];
      if (!answer) return "<td>—</td>";
      const label = answer.error ? "Judgment failed" : valueText(answer.value);
      const confidence =
        answer.confidence !== null && !answer.matched && !answer.error
          ? ` <span class="conf">${pyFixed(answer.confidence, 2)}</span>`
          : "";
      return (
        `<td><span class="verdict"><span class="sw" style="background:${esc(answerColor(answer, dimension))}"></span>` +
        `${esc(label)}</span>${confidence}${reasonLine(answer)}</td>`
      );
    })
    .join("");
}

export function matrix(snapshot: RunSnapshot): string {
  const traces = snapshot.traces;
  if (!traces.length)
    return '<div class="finder-matrix idle" aria-hidden="true"></div>';
  const unresolved = traces
    .map((trace) => trace.traceId)
    .filter((id) => !(id in snapshot.results));
  const active = new Set(
    snapshot.state === "classifying"
      ? unresolved.slice(0, snapshot.active)
      : [],
  );
  const dots = traces.map((trace) => {
    const result = snapshot.results[trace.traceId];
    let state: string;
    let title: string;
    if (result) {
      state = result.error ? "failed" : result.matched ? "match" : "unmatched";
      title = result.error || answersText(result, snapshot.dimensions);
    } else if (active.has(trace.traceId))
      [state, title] = ["active", "classifying"];
    else [state, title] = ["pending", "pending"];
    const color = resultColor(result, snapshot.dimensions);
    return (
      `<i class="${state}" style="--c:${esc(color)}" title="${esc(title)}" ` +
      `hx-get="/find/trace/${quote(trace.traceId)}" hx-target="#finder-drawer" hx-swap="innerHTML" hx-indicator="#finder-drawer-loading"></i>`
    );
  });
  return `<div class="finder-matrix">${dots.join("")}</div>`;
}

export function legend(snapshot: RunSnapshot): string {
  let items = "";
  if (snapshot.dimensions !== null && snapshot.dimensions.length === 1) {
    const dimension = snapshot.dimensions[0] as CompiledQuery;
    const counts = new Map<string, number>();
    const results = Object.values(snapshot.results);
    for (const result of results)
      if (result.error === null && result.answers.length) {
        const label = valueText(result.answers[0]?.value);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    const entries = classificationLegend(dimension);
    if (dimension.task.kind === "score") {
      counts.set(
        entries[0]?.label as string,
        results.filter((result) => result.error === null).length,
      );
      counts.set(entries[1]?.label as string, snapshot.matched);
    }
    items =
      '<span class="muted">|</span>' +
      entries
        .map(
          (item) =>
            `<span><span class="sw" style="background:${esc(item.color)}"></span>${esc(item.label)} ` +
            `<b>${counts.get(item.label) ?? 0}</b></span>`,
        )
        .join("");
  }
  return (
    '<div class="finder-legend">' +
    `<span><span class="sw match"></span><span class="num hot">${snapshot.matched}</span> included</span>` +
    items +
    `<span><span class="sw failed"></span>failed <b>${snapshot.failed}</b></span>` +
    `<span class="muted">|</span><span class="muted">${snapshot.completed} judged</span></div>`
  );
}

export function cannotAnswer(snapshot: RunSnapshot): boolean {
  return (
    snapshot.state === "cancelled" &&
    snapshot.error === null &&
    Boolean(snapshot.planWarning)
  );
}

function questionAddedFilters(snapshot: RunSnapshot): boolean {
  const facets = FACET_NAMES.some(
    (name) => selectedValues(snapshot.generatedFilters, name).size > 0,
  );
  const n = snapshot.generatedNumeric;
  const numeric = [
    n.tokensMin,
    n.tokensMax,
    n.durationMsMin,
    n.durationMsMax,
  ].some((value) => value !== null);
  return facets || numeric;
}

function judgingText(
  snapshot: RunSnapshot,
  classifierModel: string | null,
  showOnlyUrl: string | null,
): string {
  const done = snapshot.state === "completed";
  const question = snapshot.request?.query ?? "";
  const quoted = question
    ? ` <span class="finder-progress-q" title="${esc(question)}">“${esc(capped(question))}”</span>`
    : "";
  const showOnly =
    showOnlyUrl && snapshot.matched
      ? `<button type="button" class="btn-secondary finder-show-only" hx-get="${esc(showOnlyUrl)}" ` +
        'hx-target="#explorer-results" hx-swap="outerHTML" hx-sync="#explorer-results:replace">Show only these</button>'
      : "";
  const parts = [
    done
      ? `<span class="finder-progress-answer"><b>${snapshot.matched}</b> of ${snapshot.total} traces match${quoted}</span>${showOnly}`
      : `<span>Reading <b>${snapshot.completed}</b> of ${snapshot.total}</span><span class="sep">·</span>` +
        `<span><b>${snapshot.matched}</b> matching so far</span>`,
  ];
  if (snapshot.failed)
    parts.push(
      `<span class="finder-progress-failed"><b>${snapshot.failed}</b> failed</span>`,
    );
  parts.push(
    snapshot.withinResults
      ? '<span class="nw">within the loaded rows</span>'
      : '<span class="nw">new search</span>',
  );
  if (classifierModel)
    parts.push(
      `<span class="nw" title="Ask AI reads each trace with this model">Uses ${esc(classifierModel)}</span>`,
    );
  if (!done) parts.push(`<span>${pyFixed(snapshot.rate, 1)}/s</span>`);
  return parts
    .map(
      (part) => `<span class="part"><span class="sep">·</span>${part}</span>`,
    )
    .join("");
}

function compilingText(snapshot: RunSnapshot): string {
  if (snapshot.phase === "loading_traces" && snapshot.toLoad) {
    if (snapshot.withinResults)
      return `fetching conversations <b>${snapshot.loaded} / ${snapshot.toLoad}</b>`;
    return `<b>${snapshot.loaded}</b> traces loaded, up to ${snapshot.toLoad}`;
  }
  if (snapshot.phase === "planning" && snapshot.withinResults)
    return "turning your question into a yes/no check";
  return (
    {
      planning: "compiling the question and selecting metadata filters",
      loading_traces: "loading selected traces",
      starting_classification: "preparing the reviewed task",
    }[(snapshot.phase ?? "") as "planning"] ?? "preparing the search"
  );
}

function progressBar(snapshot: RunSnapshot): string {
  let fraction: number;
  if (
    snapshot.state === "compiling" &&
    snapshot.phase === "loading_traces" &&
    snapshot.toLoad
  )
    fraction = snapshot.loaded / snapshot.toLoad;
  else if (snapshot.state === "classifying" && snapshot.total)
    fraction = snapshot.completed / snapshot.total;
  else return "";
  return `<span class="finder-progress-bar" aria-hidden="true"><i style="width:${pyFixed(Math.min(fraction, 1) * 100, 1)}%"></i></span>`;
}

const noDimensions = (snapshot: RunSnapshot) =>
  snapshot.dimensions !== null && snapshot.dimensions.length === 0;

export function progress(
  snapshot: RunSnapshot,
  options: {
    exportUrl?: string;
    classifierModel?: string | null;
    showOnlyUrl?: string | null;
  } = {},
): string {
  const {
    exportUrl = "/find/export.json",
    classifierModel = null,
    showOnlyUrl = null,
  } = options;
  const cannot = cannotAnswer(snapshot);
  const running =
    snapshot.state === "compiling" || snapshot.state === "classifying";
  const state =
    {
      planning: "planning search",
      loading_traces: "loading traces",
      starting_classification: "starting classification",
    }[(snapshot.phase ?? "") as "planning"] ??
    (cannot ? "can't answer" : snapshot.state.replaceAll("_", " "));
  const reset =
    snapshot.state !== "idle"
      ? `<form class="finder-progress-action" hx-post="/find/reset" hx-target="#finder-body" hx-swap="innerHTML" hx-disabled-elt="find button">${csrfField()}<button class="btn-secondary" type="submit">Clear AI results</button><span role="status">Clearing…</span></form>`
      : "";
  const action = running
    ? `<form class="finder-progress-action" hx-post="/find/cancel" hx-target="#finder-body" hx-swap="innerHTML" hx-disabled-elt="find button">${csrfField()}<button class="btn-secondary" type="submit">Cancel</button><span role="status">Cancelling…</span></form>`
    : snapshot.state === "completed"
      ? (snapshot.total
          ? `<a class="btn-secondary" href="${esc(exportUrl)}" title="Every judged trace with its answers, as JSON">Download results</a>`
          : "") + reset
      : reset;
  const liveHtml = running ? '<span class="live"></span>' : "";
  const errorHtml = snapshot.error
    ? `<span class="finder-progress-error finder-review" role="alert">${esc(snapshot.error)}</span>`
    : cannot
      ? `<span class="sep">·</span><span class="finder-progress-answer" role="status">${esc(snapshot.planWarning)}</span>`
      : snapshot.planWarning
        ? `<span class="finder-progress-error finder-progress-warning finder-review" role="status">${esc(snapshot.planWarning)}</span>`
        : "";
  const counts = cannot
    ? ""
    : snapshot.state === "compiling"
      ? `<span class="sep">·</span><span>${compilingText(snapshot)}</span>`
      : snapshot.total === 0 && snapshot.loaded
        ? `<span class="sep">·</span><span><b>${snapshot.loaded}</b> traces loaded, none kept</span>`
        : snapshot.total === 0
          ? '<span class="sep">·</span><span>Stopped before traces were loaded</span>'
          : noDimensions(snapshot) && !questionAddedFilters(snapshot)
            ? '<span class="sep">·</span><span class="finder-progress-answer">This question did not map to any filter or AI check. ' +
              "Try asking which traces show something.</span>"
            : noDimensions(snapshot)
              ? `<span class="sep">·</span><span><b>${snapshot.matched}</b> kept by filters</span>` +
                '<span class="sep">·</span><span>no AI classification needed</span>'
              : judgingText(snapshot, classifierModel, showOnlyUrl);
  const elapsedHtml =
    snapshot.state !== "compiling" && snapshot.total && !noDimensions(snapshot)
      ? `<span class="sep">·</span><span>${pyFixed(snapshot.elapsed, 1)}s</span>`
      : "";
  return (
    `<div class="finder-progress" data-state="${esc(snapshot.state)}">${liveHtml}<span class="state">${esc(state)}</span>${counts}` +
    `${elapsedHtml}${errorHtml}${action}${progressBar(snapshot)}</div>`
  );
}

export function field(
  snapshot: RunSnapshot,
  options: { apiAvailable?: boolean; exportUrl?: string } = {},
): string {
  const { apiAvailable = true, exportUrl = "/find/export.json" } = options;
  let body = matrix(snapshot);
  if (snapshot.state === "idle") {
    body += apiAvailable
      ? '<div class="finder-hint"><div class="inner"><h4>Every dot is a trace. Ask a question to light them up.</h4>' +
        "<p>The classifier picks filters from your wording, judges recent traces, and marks the ones that match.</p></div></div>"
      : '<div class="finder-hint"><div class="inner"><h4>Set ORQ_API_KEY to load traces</h4>' +
        "<p>Trace finding is unavailable until the Orq API key is configured.</p></div></div>";
  } else if (snapshot.state === "compiling") {
    const [heading, description] = {
      planning: [
        "Planning the search…",
        "Compiling your question and selecting metadata filters.",
      ],
      loading_traces: [
        "Loading traces…",
        "Fetching the trace population selected by your filters.",
      ],
      starting_classification: [
        "Starting classification…",
        "Preparing the reviewed task and selected traces.",
      ],
    }[(snapshot.phase ?? "") as "planning"] ?? [
      "Preparing the search…",
      "Getting the next step ready.",
    ];
    body +=
      '<div class="finder-hint finder-compiling" role="status" aria-live="polite"><div class="inner">' +
      '<span class="finder-pulse" aria-hidden="true"><i></i><i></i><i></i></span>' +
      `<h4>${esc(heading)}</h4><p>${esc(description)}</p></div></div>`;
  } else if (!snapshot.traces.length)
    body +=
      '<div class="finder-hint"><div class="inner"><h4>No traces loaded.</h4><p>No traces match the current window and filters.</p></div></div>';
  const unavailable =
    snapshot.state === "idle" && !apiAvailable ? " unavailable" : "";
  return `<div class="finder-field${unavailable}">${snapshot.state !== "idle" ? progress(snapshot, { exportUrl }) : ""}${body}${snapshot.dimensions !== null ? legend(snapshot) : ""}</div>`;
}

export const minuteTime = (iso: string) =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

export function table(snapshot: RunSnapshot): string {
  const tracesById = new Map(
    snapshot.traces.map((trace) => [trace.traceId, trace]),
  );
  const matches = snapshot.traceIds
    .filter((id) => {
      const result = snapshot.results[id];
      return tracesById.has(id) && result && result.matched && !result.error;
    })
    .map(
      (id) =>
        [tracesById.get(id), snapshot.results[id]] as [
          NonNullable<ReturnType<typeof tracesById.get>>,
          TraceClassification,
        ],
    );
  matches.sort(
    (a, b) =>
      new Date(b[0].timestamp).getTime() - new Date(a[0].timestamp).getTime(),
  );
  const dimensions = snapshot.dimensions ?? [];
  const rows = matches
    .map(
      ([trace, result]) =>
        `<tr hx-get="/find/trace/${quote(trace.traceId)}" hx-target="#finder-drawer" hx-swap="innerHTML" hx-indicator="#finder-drawer-loading">` +
        `<td class="id">${esc(trace.traceId)}</td>${answerCells(result, dimensions)}` +
        `<td>${esc(trace.project)}</td><td>${esc(trace.model)}</td><td>${esc(trace.status)}</td><td>${esc(minuteTime(trace.timestamp))}</td></tr>`,
    )
    .join("");
  const empty = rows ? "" : '<p class="finder-empty">No matches yet.</p>';
  return (
    '<section class="finder-section"><h3 class="finder-section-title">Included traces</h3>' +
    `<p class="finder-section-sub">${snapshot.matched} of ${snapshot.total || 0} judged as included, newest first. Click a row to inspect.</p>` +
    '<table class="finder-table"><thead><tr><th>Trace</th>' +
    dimensions.map((dimension) => `<th>${esc(dimension.name)}</th>`).join("") +
    "<th>Project</th><th>Model</th><th>Status</th><th>Time</th></tr></thead>" +
    `<tbody>${rows}</tbody></table>${empty}</section>`
  );
}

const PRESETS = [
  ["gte", 0.5],
  ["gte", 0.7],
  ["gte", 0.8],
  ["lte", 0.3],
  ["lte", 0.5],
] as const;

function selectionRuleHtml(
  compiled: CompiledQuery,
  editable: boolean,
  prefix = "",
): string {
  if (!editable) {
    const [lead, value] = selectionRuleText(compiled);
    return `<p>${esc(lead)} <b>${esc(value)}</b></p>`;
  }
  const { task, selection } = compiled;
  const values: readonly unknown[] =
    selection.kind === "values" ? selection.values : [];
  if (task.kind === "choice") {
    const labels =
      task.criteria && !Array.isArray(task.criteria)
        ? Object.keys(task.criteria)
        : [];
    const selected =
      (values.find((value) => labels.includes(value as string)) as
        | string
        | undefined) ??
      labels[0] ??
      "";
    const options = labels
      .map(
        (label) =>
          `<option value="${esc(label)}"${label === selected ? " selected" : ""}>${esc(label)}</option>`,
      )
      .join("");
    return `<select name="${prefix}selection_value">${options}</select>`;
  }
  if (task.kind === "noul") {
    const selectedBool =
      (values.find((value) => typeof value === "boolean") as
        | boolean
        | undefined) ?? false;
    const options = ["true", "false"]
      .map(
        (value) =>
          `<option value="${value}"${selectedBool === (value === "true") ? " selected" : ""}>${value}</option>`,
      )
      .join("");
    return `<select name="${prefix}selection_value">${options}</select>`;
  }
  const [operator, threshold] =
    selection.kind === "threshold"
      ? [selection.operator, selection.value]
      : ["gte", 0.5];
  let options = PRESETS.some(([op, v]) => op === operator && v === threshold)
    ? ""
    : `<option value="${operator}:${pyG(threshold)}" selected>${operator} ${pyG(threshold)}</option>`;
  options += PRESETS.map(
    ([op, value]) =>
      `<option value="${op}:${pyG(value)}"${operator === op && threshold === value ? " selected" : ""}>${op} ${pyG(value)}</option>`,
  ).join("");
  return `<select name="${prefix}selection_rule">${options}</select>`;
}

function criterionHtml(
  compiled: CompiledQuery,
  editable: boolean,
  prefix = "",
): [string, number] {
  const task = compiled.task;
  if (
    task.kind === "choice" &&
    task.criteria &&
    !Array.isArray(task.criteria)
  ) {
    const pairs = Object.entries(task.criteria);
    if (editable)
      return [
        pairs
          .map(
            ([label, description], index) =>
              `<div class="finder-crit-row"><input name="${prefix}criteria_label_${index}" value="${esc(label)}" required>` +
              `<input name="${prefix}criteria_description_${index}" value="${esc(description ?? "")}" required></div>`,
          )
          .join(""),
        pairs.length,
      ];
    return [
      pairs
        .map(
          ([label, description], index) =>
            `<span class="lab"><span class="sw" style="background:var(--chart-${index + 1})"></span>${esc(label)}</span>` +
            `<span class="desc">${esc(description ?? "")}</span>`,
        )
        .join(""),
      pairs.length,
    ];
  }
  if (task.kind === "score" && Array.isArray(task.criteria)) {
    const criteria = task.criteria;
    if (editable)
      return [
        criteria
          .map(
            (description, index) =>
              `<div class="finder-crit-row"><span class="lab">Level ${index + 1}</span>` +
              `<input name="${prefix}score_criteria_${index}" value="${esc(description)}" required></div>`,
          )
          .join(""),
        criteria.length,
      ];
    return [
      criteria
        .map(
          (description, index) =>
            `<span class="lab">Level ${index + 1}</span><span class="desc">${esc(description)}</span>`,
        )
        .join(""),
      criteria.length,
    ];
  }
  return ["<p>Binary true / false judgment.</p>", 0];
}

function dimensionCard(
  compiled: CompiledQuery,
  editable: boolean,
  open: boolean,
  prefix: string,
): string {
  const task = compiled.task;
  const [criterion, criterionCount] = criterionHtml(compiled, editable, prefix);
  const kindLabel = { noul: "Yes / no", choice: "Choice", score: "Score" }[
    task.kind
  ];
  const instruction = editable
    ? `<textarea name="${prefix}instructions" required>${esc(task.instructions)}</textarea>`
    : `<p>${esc(task.instructions)}</p>`;
  const title = editable
    ? `<input class="finder-task-name" name="${prefix}name" value="${esc(compiled.name)}" maxlength="40" required aria-label="Dimension name">`
    : `<span class="finder-task-title">${esc(compiled.name)}</span>`;
  let threshold = "";
  if (task.kind === "noul") {
    const value = editable
      ? `<input name="${prefix}noul_threshold" type="number" min="0" max="1" step="0.01" value="${pyG(task.noulThreshold)}">`
      : `<p>${pyPercent(task.noulThreshold)}</p>`;
    threshold = `<div class="finder-task-stage"><h5>Confidence needed for yes</h5>${value}</div>`;
  }
  const criteria = criterionCount
    ? `<div class="finder-task-criteria"><h5>Verdict labels</h5><div class="finder-crit">${criterion}</div></div>`
    : "";
  const countHtml = criterionCount
    ? `<span class="finder-task-count">${criterionCount} labels</span>`
    : "";
  const question = editable
    ? ""
    : `<span class=finder-task-q title="${esc(task.instructions)}">${esc(task.instructions)}</span>`;
  return (
    `<details class="finder-task"${open ? " open" : ""}><summary><span class="chev" aria-hidden="true">▸</span>` +
    `${title}<span class="kind">${kindLabel}</span>${countHtml}${question}</summary>` +
    `<div class="finder-task-body"><div class="finder-task-question"><h5>Question asked of each trace</h5>${instruction}</div>` +
    `<div class="finder-task-flow"><div class="finder-task-stage"><h5>Model returns</h5><strong>${kindLabel}</strong></div>` +
    '<span class="finder-task-arrow" aria-hidden="true">→</span>' +
    `<div class="finder-task-stage"><h5>Include when</h5>${selectionRuleHtml(compiled, editable, prefix)}</div>` +
    `${threshold}</div>${criteria}</div></details>`
  );
}

export function taskPanel(
  dimensions: readonly CompiledQuery[],
  options: {
    editable: boolean;
    open?: boolean;
    request?: RunRequest | null;
    total?: number;
  },
): string {
  const { editable, open = false, request = null, total = 0 } = options;
  let cards = dimensions
    .map((dimension, index) =>
      dimensionCard(dimension, editable, open, `d${index}_`),
    )
    .join("");
  if (!dimensions.length)
    cards =
      '<p class="finder-task-none">Filters answer this question, so no per-trace AI classification runs. Every trace the filters keep is included.</p>';
  else if (dimensions.length > 1)
    cards = `<p class="finder-task-none">A trace is included only when it matches all ${dimensions.length} dimensions.</p>${cards}`;
  if (!editable) return `<div class="finder-tasks">${cards}</div>`;
  const hiddenRequest =
    request !== null
      ? `<input type="hidden" name="query" value="${esc(request.query)}">` +
        '<input type="hidden" name="mode" value="review">'
      : "";
  const action = dimensions.length
    ? `Apply + classify ${total}`
    : `Apply + include ${total}`;
  return (
    '<form id="finder-start-form" class="finder-tasks" hx-post="/find/start" hx-target="#finder-body" hx-swap="innerHTML" hx-disabled-elt="find button">' +
    `${hiddenRequest}${csrfField()}${cards}` +
    `<button class="rt-apply-btn" type="submit">${action}</button><span class="finder-start-working" role="status">Starting classification…</span></form>`
  );
}

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value instanceof Set) return [...value].map(dropNulls);
  if (value && typeof value === "object") {
    const plain =
      typeof (value as { toJSON?: () => unknown }).toJSON === "function"
        ? (value as { toJSON: () => unknown }).toJSON()
        : value;
    if (plain !== value) return dropNulls(plain);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

export function filterOutputPanel(snapshot: RunSnapshot): string {
  const selected = FACET_NAMES.flatMap((name) =>
    pySorted(selectedValues(snapshot.generatedFilters, name)).map(
      (value) => [name.replaceAll("_", " "), value] as const,
    ),
  );
  const chips = selected
    .map(
      ([name, value]) =>
        `<span class="finder-filter-chip"><b>${esc(name)}</b>${esc(value)}</span>`,
    )
    .join("");
  const chipsHtml =
    chips ||
    '<span class="finder-filter-none">No metadata filters selected.</span>';
  const warning = snapshot.planWarning
    ? `<p class="finder-filter-note" role="status">${esc(snapshot.planWarning)}</p>`
    : "";
  let response: string;
  if (snapshot.filterSelectionError)
    response = `<p class="finder-filter-note" role="alert">Filter selection was unavailable: ${esc(snapshot.filterSelectionError)}</p>`;
  else if (snapshot.filterResponse === null)
    response =
      '<p class="finder-filter-note">No structured filter response was produced.</p>';
  else
    response =
      '<details class="finder-filter-json"><summary>View structured LLM output</summary>' +
      `<pre>${esc(JSON.stringify(dropNulls(snapshot.filterResponse), null, 2))}</pre></details>`;
  return (
    '<section class="finder-filter-output"><div class="finder-filter-heading"><div>' +
    "<h3>Filter selection</h3><p>The model proposes metadata filters before your choices take precedence.</p>" +
    `</div><span class="finder-filter-count">${selected.length} chosen</span></div>` +
    `<div class="finder-filter-chips">${chipsHtml}</div>` +
    `${warning}${response}</section>`
  );
}

export function statusIndicator(snapshot: RunSnapshot): string {
  const state = snapshot.state;
  let kind: string;
  let label: string;
  if (state === "compiling") {
    kind = "busy";
    label =
      {
        planning: "Planning search",
        loading_traces: "Loading traces",
        starting_classification: "Starting classification",
      }[(snapshot.phase ?? "") as "planning"] ?? "Preparing search";
  } else if (state === "classifying") {
    kind = "busy";
    label = `Labelling data · ${snapshot.completed}/${snapshot.total}`;
  } else
    [kind, label] = {
      idle: ["idle", "Idle"],
      awaiting_review: ["paused", "Waiting for review"],
      completed: ["done", "Done"],
      failed: ["failed", "Failed"],
      cancelled: [
        "idle",
        cannotAnswer(snapshot) ? "Can't answer" : "Cancelled",
      ],
    }[state] as [string, string];
  const icon =
    (
      {
        busy: '<span class="spin"></span>',
        done: "✓",
        failed: "✕",
        paused: "⏸",
      } as Record<string, string>
    )[kind] ?? "";
  return (
    `<div class="finder-status ${kind}" role="status" aria-live="polite">` +
    `<span class="icon" aria-hidden="true">${icon}</span>${esc(label)}</div>`
  );
}

export interface BodyOptions {
  catalogue?: FacetCatalogue | null;
  pending?: boolean;
  apiAvailable?: boolean;
  explorerFacets?: FacetSelection | null;
  explorerNumeric?: NumericFilters | null;
  explorerView?: ExplorerView | null;
}

const shellQuote = (value: string) =>
  value === ""
    ? "''"
    : /^[\w@%+=:,./-]+$/.test(value)
      ? value
      : `'${value.replaceAll("'", "'\"'\"'")}'`;
const pyRepr = (value: string) =>
  value.includes("'") && !value.includes('"')
    ? `"${value.replaceAll("\\", "\\\\")}"`
    : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function runStatus(
  snapshot: RunSnapshot,
  options: { hasExplorer: boolean },
): string {
  const details =
    snapshot.dimensions !== null && !cannotAnswer(snapshot)
      ? taskPanel(snapshot.dimensions, { editable: false })
      : "";
  const running =
    snapshot.state === "compiling" || snapshot.state === "classifying";
  const indicator = running ? "" : statusIndicator(snapshot);
  const showOnlyUrl = options.hasExplorer
    ? "/find/rows?quick_view=matches"
    : null;
  return (
    `<div id="${RUN_STATUS_ID}">${indicator}` +
    `${progress(snapshot, { classifierModel: snapshot.classifierModel, showOnlyUrl })}${details}</div>`
  );
}

export function body(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  options: BodyOptions = {},
): string {
  const {
    catalogue = null,
    pending = false,
    explorerFacets = null,
    explorerNumeric = null,
    explorerView = null,
  } = options;
  const indicator = statusIndicator(snapshot);
  if (snapshot.state === "awaiting_review" && snapshot.dimensions !== null)
    return (
      `${indicator}${controls(snapshot, settings, catalogue, { pending })}<div class="finder-review"><span>⏸</span><span><b>Review the plan before running per-trace classification.</b> ` +
      "Edit the task, criteria or filters, then start.</span></div>" +
      taskPanel(snapshot.dimensions, {
        editable: true,
        open: true,
        request: snapshot.request,
        total: snapshot.total,
      }) +
      filterOutputPanel(snapshot) +
      '<div class="finder-review-actions"><button class="btn-secondary" type="submit" form="explorer-load-form" ' +
      'hx-post="/find/load" hx-include="#finder-start-form, #finder-controls, #finder-scope" hx-target="#explorer-results" hx-swap="outerHTML">' +
      "Apply filters only</button></div>"
    );
  const controlsHtml = controls(snapshot, settings, catalogue, {
    pending,
    explorerFacets,
    explorerNumeric,
    explorerView,
  });
  if (snapshot.state === "idle") return `${indicator}${controlsHtml}`;
  let analyze = "";
  if (snapshot.state === "completed" && snapshot.dimensions !== null) {
    const exportName = exportFilename(snapshot);
    const localFilename = shellQuote(exportName);
    const powershellFilename = `'${exportName.replaceAll("'", "''")}'`;
    const python =
      "from pathlib import Path\n" +
      "from evaluatorq.insights import InsightsPopulation, insights_sync\n\n" +
      `population = InsightsPopulation.from_finder_export(Path(${pyRepr(exportName)}))\n` +
      "run = insights_sync(population)";
    analyze =
      '<section class="finder-analyze-matches"><h3>Analyze matches</h3>' +
      "<p>Download the completed export to use it with the CLI or Python. A server-side copy is also saved for " +
      "the Insights wizard; enter the filename there. The examples below expect the downloaded file in your " +
      "current directory.</p>" +
      `<p><a class="btn-secondary" href="/find/export.json?export=${quote(exportName)}">Download and save ${esc(exportName)}</a></p>` +
      `<label>CLI (macOS/Linux)</label><pre><code>eq insights --from-finder ${esc(localFilename)}</code></pre>` +
      `<label>CLI (Windows PowerShell)</label><pre><code>eq insights --from-finder ${esc(powershellFilename)}</code></pre>` +
      `<label>Python</label><pre><code>${esc(python)}</code></pre></section>`;
  }
  return `${controlsHtml}${runStatus(snapshot, { hasExplorer: explorerView !== null })}${analyze}`;
}

export function fragment(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  options: BodyOptions & { error?: string | null } = {},
): string {
  const attrs =
    snapshot.state === "compiling" || snapshot.state === "classifying"
      ? ` hx-get="/find/poll" hx-trigger="every 1s" hx-target="#${RUN_STATUS_ID}" hx-swap="outerHTML"`
      : "";
  const errorHtml = options.error
    ? `<div class="finder-review finder-form-error" role="alert">${esc(options.error)}</div>`
    : "";
  return `<div class="finder-body-fragment"${attrs}>${errorHtml}${body(snapshot, settings, options)}</div>`;
}

const prettyJson = (value: unknown) =>
  pythonJson(value, { indent: 2, ensureAscii: false });

const findSpansUrl = (traceId: string) =>
  `/find/trace-spans?trace_id=${quote(traceId)}`;

const copyTraceButton = (traceId: string) =>
  `<button class="btn-secondary" type="button" data-trace-id="${esc(traceId)}" onclick="navigator.clipboard.writeText(this.dataset.traceId)">Copy trace id</button>`;

function blockText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map(blockText)
      .filter((text) => text)
      .join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const kind = record.type;
    const fn = record.function;
    const call =
      fn !== null && typeof fn === "object" && !Array.isArray(fn)
        ? (fn as Record<string, unknown>)
        : record;
    if (
      kind === "tool_call" ||
      kind === "function_call" ||
      kind === "function"
    ) {
      let args = call.arguments;
      if (typeof args !== "string")
        args = pythonJson(args ?? null, {
          ensureAscii: false,
          defaultString: true,
        });
      return `→ ${pythonString(call.name ?? null)}(${args})`;
    }
    if (kind === "reasoning") return "";
    for (const key of ["content", "text", "result", "response", "output"])
      if (Object.hasOwn(record, key)) return blockText(record[key]);
  }
  return pythonJson(value, { ensureAscii: false, defaultString: true });
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  const blocks = [
    content !== null && content !== undefined && content !== ""
      ? content
      : message.parts,
    message.tool_calls,
  ];
  return blocks
    .map(blockText)
    .filter((text) => text)
    .join("\n");
}

function threadMessage(
  message: Record<string, unknown>,
  index: number,
  options: {
    selected: boolean;
    kind: Kind;
    label: string | null;
    tokens: number;
  },
): string {
  const { selected, kind, label, tokens } = options;
  const role = pythonString(message.role ?? "unknown");
  const content = messageText(message);
  let preview = content.split(/\s+/).filter(Boolean).join(" ");
  if ([...preview].length > 100)
    preview = `${[...preview].slice(0, 100).join("").trimEnd()}…`;
  const name = KIND_LABELS[kind] ?? role;
  const tool = label ? ` · <span class="mono">${esc(label)}</span>` : "";
  const open = selected && [...content].length <= 10_000 ? " open" : "";
  return (
    `<details class="fd-msg k-${esc(kind)}${selected ? " on" : ""}" id="msg-${index}" data-msg="${index}"${open}>` +
    `<summary><span class="role"><b>${esc(name)}</b>${tool}</span><em class="fd-msg-meta">#${index} · ~${tokens.toLocaleString("en-US")} tok</em>` +
    `<span class="fd-msg-preview">${esc(preview)}</span></summary>` +
    `<div class="fd-msg-content">${esc(content)}</div></details>`
  );
}

function threadParts(
  trace: TraceRecord,
  msg: number | null,
): [string, string, boolean] {
  const segs = segments(trace.messages as Record<string, unknown>[]);
  const byMessage = new Map<number, Segment[]>();
  for (const segment of segs) {
    const list = byMessage.get(segment.index) ?? [];
    list.push(segment);
    byMessage.set(segment.index, list);
  }
  const selected =
    msg !== null && msg >= 1 && msg <= trace.messages.length ? msg : 1;
  const messages = trace.messages
    .map((message, position) => {
      const index = position + 1;
      const own = byMessage.get(index) ?? [];
      return threadMessage(message as Record<string, unknown>, index, {
        selected: index === selected,
        kind: own[0]?.kind ?? "other",
        label: own.find((s) => s.label)?.label ?? null,
        tokens: own.reduce((sum, s) => sum + s.tokens, 0),
      });
    })
    .join("");
  const mini = segs
    .map(
      (s) =>
        `<i class="k-${s.kind}${s.index === selected ? " on" : ""}" style="flex-grow:${s.tokens}" data-mini-msg="${s.index}"></i>`,
    )
    .join("");
  const miniHtml = segs.length ? `<div class="fd-mini">${mini}</div>` : "";
  const hasConversation = segs.some((s) => s.preview.trim() || s.label);
  return [messages, miniHtml, hasConversation];
}

function traceTabs(threadHtml: string, spansUrl: string | null): string {
  const spansButton =
    spansUrl !== null
      ? `<button type="button" hx-get="${esc(spansUrl)}" hx-target="#fd-spans" hx-swap="innerHTML" ` +
        `onclick="eqFinderTraceTab(this,'fd-spans')">Spans</button>`
      : "";
  const spansPanel =
    spansUrl !== null
      ? '<div id="fd-spans" class="fd-panel" hidden><p class="finder-empty">Open Spans to load span details.</p></div>'
      : "";
  return (
    `<div class="fd-tabs"><button type="button" class="on" onclick="eqFinderTraceTab(this,'fd-thread')">` +
    `Conversation</button>${spansButton}</div>` +
    `<div id="fd-thread" class="fd-panel">${threadHtml}</div>${spansPanel}`
  );
}

export function traceConversation(
  trace: TraceRecord,
  options: { spansUrl: string | null; msg?: number | null },
): string {
  const [messages, miniHtml, hasConversation] = threadParts(
    trace,
    options.msg ?? null,
  );
  const threadHtml = hasConversation
    ? messages
    : '<div class="fd-no-messages" role="status"><b>No messages available</b><span>This trace has no conversation text to display.</span></div>';
  return miniHtml + traceTabs(threadHtml, options.spansUrl);
}

export function unavailableConversation(options: {
  reason: string;
  spansUrl: string | null;
}): string {
  return (
    '<div class="fd-no-messages" role="status"><b>Conversation unavailable</b>' +
    `<span>${esc(options.reason)}</span></div>` +
    traceTabs(
      '<p class="fd-no-messages">Conversation content is unavailable.</p>',
      options.spansUrl,
    )
  );
}

function rowParts(row: TraceRow): [string, string] {
  const models = row.displayModels
    .map((model) => `<span class="tv pill">${esc(model)}</span>`)
    .join("");
  const reasoning = row.reasoningTokens
    ? ` (${esc(fmtTokens(row.reasoningTokens))} reasoning)`
    : "";
  const head =
    `<div class="fd-row-head"><span class="tv dot ${row.isError ? "err" : "ok"}"></span>` +
    `<b>${esc(row.agentName || row.name || "Unknown agent")}</b>${models}</div>`;
  const meta =
    `<div class="fd-row-meta">Started ${esc(fmtTime(row.startedAt))} · ${esc(fmtTokens(row.tokensIn))} in → ` +
    `${esc(fmtTokens(row.tokensOut))} out${reasoning} · ${esc(fmtTokens(row.cachedTokens))} cache · ` +
    `Duration ${esc(fmtDuration(row.durationMs))} · ${fmtCost(row.costTotal, row.currency)}</div>`;
  return [head, meta];
}

const metaList = (trace: TraceRecord) =>
  `<dl class="fd-meta"><dt>trace</dt><dd>${esc(trace.traceId)}</dd><dt>span</dt><dd>${esc(trace.spanId)}</dd>` +
  `<dt>project</dt><dd>${esc(trace.project)}</dd><dt>model</dt><dd>${esc(trace.model)}</dd><dt>time</dt><dd>${esc(parseIso(trace.timestamp).iso)}</dd></dl>`;

export async function drawer(
  detail: TraceDetail,
  options: {
    experimentUrl?: string | null;
    msg?: number | null;
    row?: TraceRow | null;
    tracesLayout?: boolean;
  } = {},
): Promise<string> {
  const { experimentUrl = null, msg = null, row = null } = options;
  const trace = detail.trace;
  const result = detail.classification;
  const resultHtml =
    result === null
      ? "<p>Not classified yet.</p>"
      : !result.error
        ? `<p><b>${!result.matched ? "Not included" : result.answers.length ? "Included" : "Kept by filters"}</b> · ${esc(answersText(result, detail.dimensions))}</p>` +
          result.answers.map(drawerReason).join("")
        : `<p role="alert">Failed: ${esc(result.error)}</p>`;
  const verdict = `<div class="fd-verdict"><span class="sw" style="background:${esc(resultColor(result, detail.dimensions))}"></span>${resultHtml}</div>`;
  const payload = prettyJson(
    detail.projection ? detail.projection.payload : {},
  );
  let bodyHtml: string;
  let title: string;
  if (options.tracesLayout) {
    const [rowHeader, rowMeta] = row ? rowParts(row) : ["", ""];
    const technicalHtml =
      `${rowHeader}${metaList(trace)}${copyTraceButton(trace.traceId)}` +
      '<div class="fd-tabs">' +
      `<button type="button" data-panel="fd-input" onclick="eqFinderTab(this,'fd-input')">Classifier input</button>` +
      "</div>" +
      `<div id="fd-input" class="fd-panel" hidden><div class="fd-panel-title">Classifier input</div><pre>${esc(payload)}</pre></div>`;
    bodyHtml =
      `<div class="fd-traces">${rowHeader}${rowMeta}${verdict}` +
      traceConversation(trace, { spansUrl: findSpansUrl(trace.traceId), msg }) +
      `<details class="fd-technical"><summary>Technical details</summary>${technicalHtml}</details></div>`;
    title = "Trace conversation";
  } else {
    const [messages, miniHtml, hasConversation] = threadParts(trace, msg);
    const raw = prettyJson(result ? result.rawResult : {});
    const threadHtml = hasConversation
      ? messages
      : '<p class="finder-empty">No messages.</p>';
    const rowHeader = row ? rowParts(row).join("") : "";
    bodyHtml =
      `${rowHeader}${miniHtml}${metaList(trace)}${verdict}` +
      `<div class="fd-tabs"><button type="button" class="on" data-panel="fd-thread" onclick="eqFinderTab(this,'fd-thread')">Full thread</button>` +
      `<button type="button" data-panel="fd-input" onclick="eqFinderTab(this,'fd-input')">Classifier input</button>` +
      `<button type="button" data-panel="fd-raw" onclick="eqFinderTab(this,'fd-raw')">Raw result</button></div>` +
      `<div id="fd-thread" class="fd-panel"><div class="fd-panel-title">Full thread</div>${threadHtml}</div>` +
      `<div id="fd-input" class="fd-panel" hidden><div class="fd-panel-title">Classifier input</div><pre>${esc(payload)}</pre></div>` +
      `<div id="fd-raw" class="fd-panel" hidden><div class="fd-panel-title">Raw result</div><pre>${esc(raw)}</pre></div>`;
    title = `Trace ${esc(trace.traceId)}`;
  }
  const footer =
    traceLinkButton(
      await traceSpanUrl(trace.traceId, trace.spanId, experimentUrl),
      "Open in Orq ↗",
    ) + copyTraceButton(trace.traceId);
  return drawerShell(title, bodyHtml, footer, {
    dismissRoute: "/find/dismiss",
    drawerId: "finder-drawer",
  });
}

export async function missingTraceDrawer(
  traceId: string,
  options: { reason?: string | null; tracesLayout?: boolean } = {},
): Promise<string> {
  const { reason = null } = options;
  const shell = { dismissRoute: "/find/dismiss", drawerId: "finder-drawer" };
  if (options.tracesLayout) {
    const failureReason =
      reason || "The conversation could not be loaded for this trace.";
    const footer =
      traceLinkButton(await singleTraceUrl(traceId), "Open in Orq ↗") +
      copyTraceButton(traceId);
    return drawerShell(
      "Trace conversation",
      `<div class="fd-traces">${unavailableConversation({ reason: failureReason, spansUrl: findSpansUrl(traceId) })}</div>`,
      footer,
      shell,
    );
  }
  const body = reason
    ? `<p class="finder-empty">${esc(reason)}</p>`
    : '<p class="finder-empty">This trace is not part of the current run. Results live in memory only, so a ' +
      "dashboard restart or a new search clears them. Run the search again to reopen it.</p>";
  return drawerShell(`Trace ${esc(traceId)}`, body, "", shell);
}

const spanValue = (span: unknown, key: string): unknown =>
  span !== null && typeof span === "object"
    ? (span as Record<string, unknown>)[key]
    : undefined;

const isNum = (value: unknown): value is number => typeof value === "number";

export async function spanTree(
  traceId: string,
  spans: readonly unknown[],
  experimentUrl: string | null = null,
  options: { firstErrorMessage?: string | null } = {},
): Promise<string> {
  const text = (span: unknown, key: string) => {
    const raw = spanValue(span, key);
    return raw !== null && raw !== undefined ? pythonString(raw) : "";
  };
  const entries = new Map<string, unknown>();
  const order: string[] = [];
  const spanIds = new Map<string, string>();
  const firstNodeBySpanId = new Map<string, string>();
  for (const [index, span] of spans.entries()) {
    const spanId =
      text(span, "span_id") || text(span, "id") || `unknown-${index}`;
    const nodeId = `node-${index}`;
    entries.set(nodeId, span);
    order.push(nodeId);
    spanIds.set(nodeId, spanId);
    if (!firstNodeBySpanId.has(spanId)) firstNodeBySpanId.set(spanId, nodeId);
  }
  const children = new Map<string, string[]>(order.map((id) => [id, []]));
  const roots: string[] = [];
  for (const nodeId of order) {
    const span = entries.get(nodeId);
    const parent = text(span, "parent_span_id") || text(span, "parent_id");
    const parentNode = firstNodeBySpanId.get(parent);
    if (parentNode !== undefined && parentNode !== nodeId)
      children.get(parentNode)?.push(nodeId);
    else roots.push(nodeId);
  }
  const firstError = order.find((id) => isErrorSpan(entries.get(id))) ?? null;
  const ancestors = new Set<string>();
  if (firstError !== null) {
    const parentByChild = new Map<string, string>();
    for (const [parent, ids] of children)
      for (const child of ids) parentByChild.set(child, parent);
    let current = firstError;
    while (parentByChild.has(current) && !ancestors.has(current)) {
      current = parentByChild.get(current) as string;
      ancestors.add(current);
    }
  }
  const durations = spans
    .map((span) => spanValue(span, "duration_ms"))
    .filter((d): d is number => isNum(d) && d >= 0);
  const maxDuration = durations.length ? Math.max(...durations) : 0;

  const urls = new Map<string, string | null>();
  const row = (nodeId: string): string => {
    const span = entries.get(nodeId);
    const status = spanStatusText(span) || "unknown";
    const failed = isErrorSpan(span);
    const kind =
      text(span, "type") || text(span, "operation") || "unknown kind";
    const name =
      text(span, "name") || text(span, "operation") || "Unnamed span";
    const duration = spanValue(span, "duration_ms");
    const durationLabel = isNum(duration)
      ? `${pyG(duration)} ms`
      : "duration unknown";
    const width =
      isNum(duration) && maxDuration
        ? Math.max(2, Math.min(100, Math.trunc((duration / maxDuration) * 100)))
        : 2;
    const usage = spanValue(span, "usage");
    const tokens =
      usage !== null && usage !== undefined
        ? spanValue(usage, "total_tokens")
        : spanValue(span, "total_tokens");
    const tokenLabel = isNum(tokens)
      ? `${pythonString(tokens)} tokens`
      : "tokens unknown";
    const statusObj = spanValue(span, "status");
    let message: unknown =
      spanValue(span, "status_message") ||
      spanValue(span, "statusMessage") ||
      spanValue(span, "error_message");
    if (
      typeof message !== "string" &&
      statusObj !== null &&
      statusObj !== undefined &&
      typeof statusObj !== "string"
    )
      message =
        spanValue(statusObj, "message") || spanValue(statusObj, "description");
    const override = options.firstErrorMessage;
    if (
      nodeId === firstError &&
      typeof override === "string" &&
      override.trim()
    )
      message = override;
    if (failed && typeof message !== "string")
      message = "No status message available.";
    const link = traceLinkButton(urls.get(nodeId), "Orq ↗", {
      onclick: "event.stopPropagation()",
    });
    return (
      `<div class="fd-span-row${failed ? " fd-span-error" : ""}${nodeId === firstError ? " fd-span-first-error" : ""}">` +
      `<span class="fd-span-kind" title="${esc(kind)}">${esc(kind)}</span><b title="${esc(name)}">${esc(name)}</b>` +
      `<span class="fd-span-duration"><i style="width:${width}%"></i>${esc(durationLabel)}</span>` +
      `<span>${esc(tokenLabel)}</span><span class="fd-span-status">${esc(status)}</span>${link}</div>` +
      (failed ? `<p class="fd-span-message">${esc(String(message))}</p>` : "")
    );
  };

  if (!spans.length)
    return '<p class="finder-empty">No spans are available for this trace.</p>';
  return cliSlugRenderScope(async () => {
    for (const nodeId of order)
      urls.set(
        nodeId,
        await traceSpanUrl(traceId, spanIds.get(nodeId), experimentUrl),
      );
    const rendered = new Set<string>();
    const output: string[] = [];
    for (const start of [...roots, ...order]) {
      if (rendered.has(start)) continue;
      const stack: [string, string][] = [["node", start]];
      while (stack.length) {
        const [action, nodeId] = stack.pop() as [string, string];
        if (action === "close") {
          output.push("</div></details>");
          continue;
        }
        if (rendered.has(nodeId)) continue;
        rendered.add(nodeId);
        const descendants = (children.get(nodeId) ?? []).filter(
          (child) => !rendered.has(child),
        );
        const rowHtml = row(nodeId);
        if (descendants.length) {
          const opened =
            ancestors.has(nodeId) ||
            nodeId === firstError ||
            (firstError === null && roots.includes(nodeId))
              ? " open"
              : "";
          output.push(
            `<details class="fd-span-node"${opened}><summary>${rowHtml}</summary><div class="fd-span-children">`,
          );
          stack.push(["close", nodeId]);
          for (const child of [...descendants].reverse())
            stack.push(["node", child]);
        } else output.push(`<div class="fd-span-node">${rowHtml}</div>`);
      }
    }
    return `<div class="fd-span-tree">${output.join("")}</div>`;
  });
}

export interface PageHtmlOptions {
  apiAvailable: boolean;
  error?: string | null;
  catalogue?: FacetCatalogue | null;
  pending?: boolean;
  explorerHtml?: string;
  explorerView?: ExplorerView | null;
  hasRows?: boolean;
  autoScopePending?: boolean;
}

export async function pageHtml(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  options: PageHtmlOptions,
): Promise<string> {
  const query = snapshot.request !== null ? snapshot.request.query : "";
  const bodyHtml = fragment(snapshot, settings, {
    catalogue: options.catalogue ?? null,
    pending: options.pending ?? false,
    apiAvailable: options.apiAvailable,
    explorerView: options.explorerView ?? null,
  });
  const [toolbarHtml, explorerHtml] = splitToolbar(
    options.explorerHtml ||
      explorerResults(new ExplorerView(), resolveColumns(null), {
        records: null,
        snapshot: null,
      }),
  );
  const strip = tracesCommandStrip(query, {
    apiAvailable: options.apiAvailable,
    error: options.error ?? null,
    hasRows: options.hasRows ?? false,
    mode: settings.askAiMode,
    autoScopePending: options.autoScopePending ?? false,
  });
  const html =
    `<div class="finder">${strip}${toolbarHtml}<div id="finder-body">${bodyHtml}</div>` +
    `<div id="explorer-results-slot">${explorerHtml}</div><div id="finder-drawer"></div>` +
    '<div id="finder-drawer-loading" role="status">Loading trace\u2026</div></div>';
  return page("Traces", html, { activeNav: "traces" });
}
