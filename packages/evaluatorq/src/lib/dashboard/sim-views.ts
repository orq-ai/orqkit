import { loadSurface, resolve } from "../common/dashboard/library.js";
import {
  entryOutcome,
  esc,
  statusBadge,
} from "../common/reports/html-helpers.js";
import { pyFixed } from "../common/reports/number-format.js";
import {
  renderTranscriptFragment,
  type SimulationEntryView,
} from "../common/reports/sim-detail.js";
import { codepointCompare, pythonStrip } from "../common/sanitize.js";
import {
  simulationCohortId,
  simulationIndividualEntries,
} from "../integrations/simulation/reports/sections.js";
import type { SimulationRun } from "../integrations/simulation/run-store.js";
import { applyOrAll, parseSelections } from "./filters.js";
import { cliSlugRenderScope } from "./orq-workspace.js";
import { pyInt } from "./pairwise-views.js";
import { stableSimulationEntries } from "./report-tabs.js";
import type { SimulationDashboardEntry } from "./simulation-entities.js";
import { ADAPTERS } from "./surfaces.js";
import {
  singleTraceUrl,
  threadTraceUrl,
  traceLinkButton,
} from "./trace-links.js";

type Entry = SimulationDashboardEntry & {
  last_trace_id?: string | null;
  thread_id?: string | null;
};
const COLUMNS = [
  ["index", "#"],
  ["persona", "Persona"],
  ["scenario", "Scenario"],
  ["turn_count", "Turns"],
  ["goal_completion_score", "Score"],
  ["terminated_by", "Terminated by"],
] as const;
type Sort = (typeof COLUMNS)[number][0];
const SIZES = [5, 10, 25];
export function coerceSimulationPageSize(
  raw: string | number | null | undefined,
): number {
  let n: number;
  if (typeof raw === "number") n = Math.trunc(raw);
  else if (
    typeof raw === "string" &&
    /^[+-]?\d(?:_?\d)*$/.test(pythonStrip(raw))
  )
    n = Number(pythonStrip(raw).replaceAll("_", ""));
  else return 5;
  return SIZES.includes(n) ? n : 5;
}
function hxControl(
  rid: string,
  sort: string,
  direction: string,
  page: number,
  size: number,
): string {
  return `hx-get="/r/${esc(rid)}/sim/row-list?sort=${esc(sort)}&dir=${esc(direction)}&page=${page}&size=${size}" hx-include="#filter-form" hx-target="#sim-row-list-${esc(rid)}" hx-swap="outerHTML"`;
}
function headerRow(
  rid: string,
  sort: string,
  direction: string,
  size: number,
): string {
  const cells = COLUMNS.map(([param, label]) => {
    const active = param === sort,
      next = active && direction === "asc" ? "desc" : "asc",
      aria = active
        ? direction === "asc"
          ? "ascending"
          : "descending"
        : "none",
      caret = active
        ? direction === "asc"
          ? "&#x25B2;"
          : "&#x25BC;"
        : "&#x21C5;",
      cls = active ? "sim-th-caret sim-th-caret-active" : "sim-th-caret",
      num =
        param === "turn_count" || param === "goal_completion_score"
          ? ' class="num"'
          : "";
    return `<th scope="col" aria-sort="${aria}"${num}><button type="button" class="sim-th-sort" ${hxControl(rid, param, next, 1, size)}>${esc(label)}<span class="${cls}">${caret}</span></button></th>`;
  });
  return `<thead><tr>${cells.join("")}<th scope="col">Status</th><th scope="col">Traces</th></tr></thead>`;
}
function sizeSelector(
  rid: string,
  sort: string,
  direction: string,
  size: number,
): string {
  const options = SIZES.map((n) =>
    n === size
      ? `<button type="button" class="sim-size-btn" disabled aria-current="true">${n}</button>`
      : `<button type="button" class="sim-size-btn" ${hxControl(rid, sort, direction, 1, n)}>${n}</button>`,
  ).join("");
  return `<div class="sim-size" role="group" aria-label="Rows per page"><span class="sim-size-label">Show</span>${options}</div>`;
}
function pager(
  rid: string,
  sort: string,
  direction: string,
  page: number,
  pages: number,
  total: number,
  size: number,
): string {
  const selector = sizeSelector(rid, sort, direction, size);
  if (pages <= 1)
    return `<nav class="sim-pager"><div class="sim-pager-nav"><span class="sim-pager-info">${total} conversations</span></div>${selector}</nav>`;
  const button = (label: string, target: number, disabled: boolean) =>
    disabled
      ? `<button type="button" class="sim-pager-btn" disabled>${label}</button>`
      : `<button type="button" class="sim-pager-btn" ${hxControl(rid, sort, direction, target, size)}>${label}</button>`;
  return `<nav class="sim-pager"><div class="sim-pager-nav">${button("&#x2039; Prev", page - 1, page <= 1)}<span class="sim-pager-info">Page ${page} of ${pages} &middot; ${total} conversations</span>${button("Next &#x203A;", page + 1, page >= pages)}</div>${selector}</nav>`;
}
export async function renderSimulationRowList(
  rid: string,
  entries: readonly Entry[],
  options: {
    sort?: string;
    direction?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<string> {
  if (!entries.length)
    return '<section class="sim-row-list"><p class="sim-empty">No conversations found.</p></section>';
  const sort = COLUMNS.some(([name]) => name === options.sort)
      ? (options.sort as Sort)
      : "index",
    direction = options.direction === "desc" ? "desc" : "asc",
    size = SIZES.includes(options.pageSize ?? 5) ? (options.pageSize ?? 5) : 5;
  const key = (entry: Entry): string | number =>
    sort === "persona" || sort === "scenario"
      ? entry[sort].toLowerCase()
      : entry[sort];
  const ordered = [...entries].sort((a, b) => {
    const left = key(a),
      right = key(b),
      result =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : codepointCompare(String(left), String(right));
    return direction === "desc" ? -result : result;
  });
  const total = ordered.length,
    pages = Math.max(1, Math.ceil(total / size)),
    page = Math.max(1, Math.min(options.page ?? 1, pages)),
    visible = ordered.slice((page - 1) * size, page * size),
    rows: string[] = [];
  for (const entry of visible) {
    const outcome = entryOutcome(entry),
      badge = statusBadge(outcome.label, outcome.status),
      status = outcome.status === "warn" ? "error" : outcome.status,
      trace = await singleTraceUrl(entry.last_trace_id),
      button = traceLinkButton(
        trace || (await threadTraceUrl(entry.thread_id)),
        trace ? "View Trace" : "View Traces",
        { extraAttributes: { "data-no-drawer": null } },
      );
    rows.push(
      `<tr class="sim-conv-row sim-conv-row--${status}" role="button" tabindex="0" data-sim-entity-trigger data-entity-kind="conversation" data-drawer-url="/r/${esc(rid)}/sim/transcript?idx=${entry.index}"><td class="sim-conv-idx">#${entry.index + 1}</td><td class="sim-conv-persona">${esc(entry.persona)}</td><td class="sim-conv-scenario">${esc(entry.scenario)}</td><td class="sim-conv-turns num">${entry.turn_count}</td><td class="sim-conv-score num">${pyFixed(entry.goal_completion_score, 2)}</td><td class="sim-conv-term">${esc(entry.terminated_by)}</td><td class="sim-conv-status">${badge}</td><td class="sim-conv-trace">${button}</td></tr>`,
    );
  }
  return `<section class="sim-row-list"><div class="sim-conv-table-shell"><table class="sim-conv-table">${headerRow(rid, sort, direction, size)}<tbody>${rows.join("")}</tbody></table></div>${pager(rid, sort, direction, page, pages, total, size)}</section>`;
}
export async function simulationInteractivePanels(
  rid: string,
  entries: readonly Entry[],
): Promise<string> {
  return `<section class="sim-interactive-panels"><h2 class="sim-panels-title">Conversations</h2><div id="sim-row-list-${esc(rid)}">${await renderSimulationRowList(rid, entries)}</div></section>`;
}

export async function loadRun(
  rid: string,
  roots: readonly string[],
): Promise<SimulationRun | null> {
  const path = await resolve(rid, [...roots]);
  if (path === null) return null;
  const [surface] = await loadSurface(path);
  if (surface !== "sim") return null;
  try {
    return (await ADAPTERS.sim?.load(path)) as unknown as SimulationRun;
  } catch (error) {
    console.warn(`sim_views: failed to load ${path}: ${error}`);
    return null;
  }
}

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const missing = () => htmlResponse("Report not found.", 404);

export const simRowListWrapper = (rid: string, inner: string): string =>
  `<div id="sim-row-list-${esc(rid)}">${inner}</div>`;

export async function simRowListRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const run = await loadRun(rid, roots);
  if (run === null) return missing();
  const filtered = applyOrAll(
    run,
    "sim",
    parseSelections(query, "sim"),
  ) as SimulationRun["results"];
  const entries = stableSimulationEntries(run, filtered) as unknown as Entry[];
  const html = await cliSlugRenderScope(() =>
    renderSimulationRowList(rid, entries, {
      sort: query.get("sort") ?? "index",
      direction: query.get("dir") ?? "asc",
      page: pyInt(query.get("page") ?? "1") ?? 1,
      pageSize: coerceSimulationPageSize(query.get("size")),
    }),
  );
  return htmlResponse(simRowListWrapper(rid, html));
}

function entityDomIds(
  results: SimulationRun["results"],
  idx: number,
): [string | null, string | null] {
  const domId = (kind: "persona" | "scenario"): string | null => {
    const order = new Map<string, number>();
    for (const result of results) {
      const id = simulationCohortId(result, kind);
      if (!order.has(id)) order.set(id, order.size);
    }
    const target = order.get(
      simulationCohortId(
        results[idx] as SimulationRun["results"][number],
        kind,
      ),
    );
    return target === undefined ? null : `${kind}-${target}`;
  };
  return [domId("persona"), domId("scenario")];
}

export async function simTranscriptRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const raw = query.get("idx");
  const idx = raw === null ? 0 : (pyInt(raw) ?? -1);
  const run = await loadRun(rid, roots);
  if (run === null) return missing();
  const entries = simulationIndividualEntries(run.results);
  if (!entries.length || idx < 0 || idx >= entries.length) {
    return htmlResponse(
      '<p class="sim-empty">No conversation at that index.</p>',
    );
  }
  const [personaEntityId, scenarioEntityId] = entityDomIds(run.results, idx);
  return htmlResponse(
    cliSlugRenderScope(() =>
      renderTranscriptFragment(entries[idx] as unknown as SimulationEntryView, {
        personaEntityId,
        scenarioEntityId,
      }),
    ),
  );
}
