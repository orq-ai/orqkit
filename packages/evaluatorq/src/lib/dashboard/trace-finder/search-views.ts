import { esc } from "../../common/reports/html-helpers.js";
import {
  FACET_NAMES,
  type FacetCatalogue,
  type RunSnapshot,
} from "../../trace-finder/models.js";
import type { DashboardSettings } from "../../trace-finder/settings.js";
import { renderFacetChips, selectedValues } from "../facet-picker.js";
import { csrfField } from "../security.js";
import { page } from "../shell.js";
import {
  facetMenu,
  field,
  filterOutputPanel,
  iconSearch,
  SAMPLES,
  statusIndicator,
  table,
  taskPanel,
} from "./views.js";

const pySorted = (values: Iterable<string>) =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function hero(
  snapshot: RunSnapshot,
  apiAvailable: boolean,
  error: string | null,
): string {
  const request = snapshot.request;
  const query = request ? request.query : "";
  const mode = request ? request.mode : "immediate";
  const disabled = apiAvailable ? "" : " disabled";
  const errorHtml = error
    ? `<div class="finder-form-error" role="alert">${esc(error)}</div>`
    : "";
  const examples = SAMPLES.map(
    (sample) =>
      `<button type="button" data-finder-example="${esc(sample)}">${esc(sample)}</button>`,
  ).join("");
  return (
    '<section class="finder-hero"><div class="finder-hero-bg"></div>' +
    '<h2 class="finder-title">Find the signal.</h2>' +
    '<p class="finder-sub">Ask a question of your traces. Inspect every judgment.</p>' +
    '<form id="finder-query-form" class="finder-query" hx-post="/find/run" hx-target="#finder-body" ' +
    'hx-swap="innerHTML" hx-include="#finder-controls" hx-disabled-elt="find button">' +
    `${csrfField()}${iconSearch()}<div class="col"><textarea name="query" rows="1" required${disabled} ` +
    `placeholder="Describe the traces you want to find…">${esc(query)}</textarea></div>` +
    `<button class="finder-go" type="submit"${disabled}><span class="finder-go-idle">Find traces <span aria-hidden="true">↗</span></span>` +
    '<span class="finder-go-working" role="status">Starting search…</span></button></form>' +
    '<div class="finder-below"><div class="finder-seg" role="radiogroup" aria-label="Mode">' +
    `<label><input type="radio" name="mode" value="immediate" form="finder-query-form"${mode !== "review" ? " checked" : ""} ` +
    'hx-post="/find/reset" hx-trigger="change[document.getElementById(\'finder-start-form\')]" ' +
    'hx-include="#finder-query-form" hx-target="#finder-body" hx-swap="innerHTML" hx-indicator="#finder-mode-working"><span>Immediate</span></label>' +
    `<label><input type="radio" name="mode" value="review" form="finder-query-form"${mode === "review" ? " checked" : ""}><span>Review first</span></label>` +
    `</div><span id="finder-mode-working" role="status">Resetting review…</span><span class="ex"><button type="button" class="link">Examples ▾</button><span class="finder-examples"><span class="hd">Examples</span>${examples}</span></span>` +
    `<span class="spacer"></span><span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> to run</span></div>${errorHtml}</section>`
  );
}

function controls(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  catalogue: FacetCatalogue | null,
  pending: boolean,
): string {
  const request = snapshot.request;
  const population = request ? request.population : null;
  const review = snapshot.state === "awaiting_review";
  const formId = review ? "finder-start-form" : "finder-query-form";
  const facets = population ? population.facets : snapshot.explicitFilters;
  const numeric = population ? population.numeric : snapshot.explicitNumeric;
  let windowDays = settings.windowDays;
  if (population?.start && population.end)
    windowDays = Math.max(
      1,
      Math.round(
        (new Date(population.end).getTime() -
          new Date(population.start).getTime()) /
          86_400_000,
      ),
    );
  const limit = population ? population.limit : settings.limit;
  const parallelism = request ? request.parallelism : settings.parallelism;
  const carriedFacets = review ? facets : snapshot.explicitFilters;
  const carriedNumeric = review ? numeric : snapshot.explicitNumeric;
  const hidden = FACET_NAMES.flatMap((name) =>
    pySorted(selectedValues(carriedFacets, name)).map(
      (value) =>
        `<input type="hidden" form="${formId}" name="facet_${name}" value="${esc(value)}">`,
    ),
  ).join("");
  const keep = (name: string) => `id="finder-${name}-${formId}" hx-preserve`;
  const count = snapshot.total
    ? `<span class="count">${snapshot.total} traces selected</span>`
    : "";
  const scope = settings.orqProjectId
    ? `<span class="quiet"><b>Project</b><a href="/settings">${esc(settings.orqProjectName || settings.orqProjectId)}</a></span>`
    : "";
  const removable =
    snapshot.state !== "compiling" && snapshot.state !== "classifying";
  return (
    `<div class="finder-controls" id="finder-controls">${hidden}${scope}` +
    renderFacetChips(facets, numeric, { removable }) +
    '<span class="addwrap"><button class="add" type="button" aria-haspopup="true">+ Filter</button>' +
    facetMenu(catalogue, {
      numeric: carriedNumeric,
      formId,
      selection: carriedFacets,
      pending,
      windowDays,
    }) +
    '<span class="finder-facet-loading" role="status">Loading filters…</span></span><span class="spacer"></span>' +
    `<span class="quiet"><b>Window</b><input ${keep("window_days")} form="${formId}" name="window_days" type="number" min="1" max="90" value="${windowDays}" style="width:64px" ` +
    `hx-get="/find/facets?form_id=${formId}" hx-trigger="change" hx-include="#finder-controls" hx-target=".finder-facets" hx-swap="outerHTML" hx-indicator=".finder-facet-loading"></span>` +
    `<span class="quiet"><b>Limit</b><input ${keep("limit")} form="${formId}" name="limit" type="number" min="1" max="5000" value="${limit}" style="width:72px"></span>` +
    `<span class="quiet"><b>Parallel</b><input ${keep("parallelism")} form="${formId}" name="parallelism" type="number" min="1" max="200" value="${parallelism}" style="width:64px"></span>${count}</div>`
  );
}

function body(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  apiAvailable: boolean,
  catalogue: FacetCatalogue | null,
  pending: boolean,
): string {
  const status = statusIndicator(snapshot);
  const controlsHtml = controls(snapshot, settings, catalogue, pending);
  if (snapshot.state === "awaiting_review" && snapshot.dimensions !== null)
    return (
      `${status}${controlsHtml}<div class="finder-review"><span>⏸</span><span><b>Review the plan before running per-trace classification.</b> Edit the task, criteria or filters, then start.</span></div>` +
      taskPanel(snapshot.dimensions, {
        editable: true,
        open: true,
        request: snapshot.request,
      }) +
      filterOutputPanel(snapshot)
    );
  let result = `${status}${controlsHtml}${field(snapshot, { apiAvailable, exportUrl: "/find/export.json?surface=search" })}`;
  if (snapshot.state !== "idle" && snapshot.state !== "awaiting_review") {
    result += table(snapshot);
    if (snapshot.dimensions !== null)
      result +=
        taskPanel(snapshot.dimensions, { editable: false }) +
        filterOutputPanel(snapshot);
  }
  return result;
}

export interface SearchOptions {
  error?: string | null;
  apiAvailable?: boolean;
  catalogue?: FacetCatalogue | null;
  pending?: boolean;
}

export function searchFragment(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  options: SearchOptions = {},
): string {
  const {
    error = null,
    apiAvailable = true,
    catalogue = null,
    pending = false,
  } = options;
  const polling =
    snapshot.state === "compiling" || snapshot.state === "classifying"
      ? ' hx-get="/find/poll?surface=search" hx-trigger="every 1s" hx-target="#finder-body" hx-swap="innerHTML"'
      : "";
  const errorHtml = error
    ? `<div class="finder-review finder-form-error" role="alert">${esc(error)}</div>`
    : "";
  return `<div class="finder-body-fragment"${polling}>${errorHtml}${body(snapshot, settings, apiAvailable, catalogue, pending)}</div>`;
}

export async function searchPageHtml(
  snapshot: RunSnapshot,
  settings: DashboardSettings,
  options: SearchOptions & { apiAvailable: boolean },
): Promise<string> {
  const {
    error = null,
    apiAvailable,
    catalogue = null,
    pending = false,
  } = options;
  const html =
    `<div class="finder" hx-vals='{"surface":"search"}'>${hero(snapshot, apiAvailable, error)}` +
    `<div id="finder-body">${searchFragment(snapshot, settings, { apiAvailable, catalogue, pending })}</div>` +
    '<div id="finder-drawer"></div><div id="finder-drawer-loading" role="status">Loading trace…</div></div>';
  return page("Trace search", html, { activeNav: "find" });
}
