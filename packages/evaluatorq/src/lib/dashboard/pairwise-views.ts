import { esc } from "../common/reports/html-helpers.js";
import type { PairwiseVote } from "../pairwise.js";
import { classifyDetails } from "../pairwise-reports/export-html.js";
import {
  classifyObservations,
  judgeOrder,
  type VoteCell,
} from "../pairwise-reports/sections.js";
import { comparisonFlags } from "../pairwise-reports/stats.js";
import type { PairwiseEntry, PairwiseRun } from "../pairwise-run.js";
import { applyOrAll, parseSelections } from "./filters.js";
import { cliSlugRenderScope } from "./orq-workspace.js";
import { pwSideColour, pwSideLabel } from "./pairwise-palette.js";
import { panel, shortModel } from "./report-kit.js";
import { resolveRun } from "./sim-compare.js";
import { singleTraceUrl, traceLinkButton } from "./trace-links.js";

const PAGE_SIZE = 25;
const SORTS = ["index", "winner"];
const WINNER_ORDER: Record<string, number> = {
  A: 0,
  B: 1,
  tie: 2,
  inconclusive: 3,
};
const SORT_NAMES: Record<string, string> = {
  index: "number",
  winner: "winner",
};

function chips(
  entry: PairwiseEntry,
  run: PairwiseRun,
  judges: readonly string[],
): string {
  const byModel = new Map(entry.comparison.votes.map((v) => [v.model, v]));
  return judges
    .map((judge) => {
      const value = byModel.get(judge)?.vote ?? null;
      const cls = value === null ? "pw-vchip is-none" : "pw-vchip";
      return (
        `<span class="${cls}" style="--c:${pwSideColour(value)}" title="${esc(judge)}">` +
        `${esc(shortModel(judge))} → ${esc(pwSideLabel(value, run))}</span>`
      );
    })
    .join("");
}

function hx(rid: string, sort: string, direction: string, page: number) {
  return (
    `hx-get="/r/${esc(rid)}/pairwise/row-list?sort=${sort}&amp;dir=${direction}&amp;page=${page}"` +
    ` hx-include="#filter-form" hx-target="#pw-row-list-${esc(rid)}" hx-swap="outerHTML"`
  );
}

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function sortButton(
  rid: string,
  label: string,
  key: string,
  sort: string,
  direction: string,
): string {
  const active = sort === key;
  const nextDir = active && direction === "asc" ? "desc" : "asc";
  const arrow = active
    ? direction === "asc"
      ? " ▴"
      : " ▾"
    : '<span class="pw-sort-hint" aria-hidden="true">↕</span>';
  const name = SORT_NAMES[key] ?? label.toLowerCase();
  let aria: string;
  if (active) {
    const current = direction === "asc" ? "ascending" : "descending";
    const next = nextDir === "asc" ? "ascending" : "descending";
    aria = `${capitalize(name)}, sorted ${current}. Activate to sort ${next}.`;
  } else aria = `Sort by ${name}`;
  return (
    `<button type="button" id="pw-sort-${esc(key)}-${esc(rid)}" class="pw-th-sort" aria-label="${esc(aria)}" ` +
    `${hx(rid, key, nextDir, 1)}>${esc(label)}${arrow}</button>`
  );
}

const pagerHx = (rid: string, sort: string, direction: string, page: number) =>
  hx(rid, sort, direction, page).replace(
    'hx-swap="outerHTML"',
    `hx-swap="outerHTML show:#pw-row-list-${esc(rid)}:top"`,
  );

function pager(
  rid: string,
  sort: string,
  direction: string,
  page: number,
  pages: number,
  total: number,
): string {
  if (pages <= 1)
    return `<nav class="pw-pager"><span>${total} comparisons</span></nav>`;
  const prev =
    page <= 1
      ? 'aria-disabled="true"'
      : pagerHx(rid, sort, direction, page - 1);
  const next =
    page >= pages
      ? 'aria-disabled="true"'
      : pagerHx(rid, sort, direction, page + 1);
  return (
    '<nav class="pw-pager" aria-label="Comparison pages">' +
    `<button type="button" id="pw-prev-${esc(rid)}" class="pw-pager-btn" ${prev}>‹ Prev</button>` +
    `<span>Page ${page} of ${pages} · ${total} comparisons</span>` +
    `<button type="button" id="pw-next-${esc(rid)}" class="pw-pager-btn" ${next}>Next ›</button>` +
    "</nav>"
  );
}

function row(
  rid: string,
  run: PairwiseRun,
  judges: readonly string[],
  n: number,
  entry: PairwiseEntry,
  trace: string | null,
  isOpen: boolean,
): string {
  const winner = entry.comparison.winner;
  const traceCell =
    trace === null
      ? ""
      : `<span class="pw-cmp-trace">${traceLinkButton(trace || null, "Trace ↗", { onclick: "event.stopPropagation()" })}</span>`;
  const summary =
    '<summary class="pw-cmp-summary">' +
    `<span class="pw-cmp-n">${n}</span>` +
    `<span class="pw-cmp-q">${esc(entry.question)}</span>` +
    `<span class="pw-cmp-win"><span class="pw-vchip" style="--c:${pwSideColour(winner)}">` +
    `${esc(pwSideLabel(winner, run))}</span></span>` +
    `<span class="pw-chiprow">${chips(entry, run, judges)}</span>` +
    `${traceCell}</summary>`;
  if (isOpen)
    return (
      `<tbody class="pw-cmp-group" id="cmp-${n}"><tr><td><details class="pw-cmp-row" open>` +
      `${summary}<div class="pw-cmp-detail">${renderPairwiseComparisonDetail(run, n - 1)}</div>` +
      "</details></td></tr></tbody>"
    );
  return (
    `<tbody class="pw-cmp-group" id="cmp-${n}"><tr><td>` +
    '<details class="pw-cmp-row"' +
    ` hx-get="/r/${esc(rid)}/pairwise/comparison?idx=${n - 1}"` +
    ' hx-trigger="toggle once" hx-target="find .pw-cmp-detail" hx-swap="innerHTML">' +
    `${summary}<div class="pw-cmp-detail"></div></details></td></tr></tbody>`
  );
}

function numbers(
  run: PairwiseRun,
  entries: readonly PairwiseEntry[],
): [number, PairwiseEntry][] {
  const position = new Map<PairwiseEntry, number>();
  run.entries.forEach((e, i) => {
    if (!position.has(e)) position.set(e, i + 1);
  });
  return entries.map((e, i) => [position.get(e) ?? i + 1, e]);
}

export function validFocus(
  run: PairwiseRun,
  entries: readonly PairwiseEntry[],
  focus: number | null | undefined,
): number | null {
  if (focus === null || focus === undefined) return null;
  return numbers(run, entries).some(([n]) => n === focus) ? focus : null;
}

export async function renderPairwiseRowList(
  rid: string,
  run: PairwiseRun,
  entries: readonly PairwiseEntry[],
  options: {
    sort?: string;
    direction?: string;
    page?: number;
    pageSize?: number;
    focus?: number | null;
  } = {},
): Promise<string> {
  const sort = SORTS.includes(options.sort ?? "")
    ? (options.sort as string)
    : "index";
  const direction =
    options.direction === "asc" || options.direction === "desc"
      ? options.direction
      : "asc";
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const focus = options.focus ?? null;
  const wrapper = `<section class="pw-row-list" id="pw-row-list-${esc(rid)}">`;
  if (!entries.length)
    return `${wrapper}<p class="sim-empty">No comparisons match the current filter.</p></section>`;
  const numbered = numbers(run, entries);
  const reverse = direction === "desc" ? -1 : 1;
  if (sort === "winner")
    numbered.sort(
      (x, y) =>
        reverse *
        ((WINNER_ORDER[x[1].comparison.winner] ?? 4) -
          (WINNER_ORDER[y[1].comparison.winner] ?? 4) || x[0] - y[0]),
    );
  else numbered.sort((x, y) => reverse * (x[0] - y[0]));
  const total = numbered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const focused =
    focus === null ? -1 : numbered.findIndex(([n]) => n === focus);
  let page = options.page ?? 1;
  if (focused >= 0) page = Math.floor(focused / pageSize) + 1;
  page = Math.min(Math.max(page, 1), pages);
  const shown = numbered.slice((page - 1) * pageSize, page * pageSize);
  const judges = judgeOrder(run);
  const urls = await Promise.all(
    shown.map(([, e]) => singleTraceUrl(e.comparison.traceId)),
  );
  const withTrace = urls.some(Boolean);
  const head =
    '<thead><tr><th><div class="pw-cmp-head">' +
    sortButton(rid, "#", "index", sort, direction) +
    "<span>Question</span>" +
    sortButton(rid, "Winner", "winner", sort, direction) +
    `<span>Judges</span>${withTrace ? "<span>Trace</span>" : ""}` +
    "</div></th></tr></thead>";
  const body = shown
    .map(([n, e], i) =>
      row(
        rid,
        run,
        judges,
        n,
        e,
        withTrace ? (urls[i] ?? "") : null,
        focused >= 0 && n === focus,
      ),
    )
    .join("");
  const tableClass = withTrace ? "pw-cmp-list has-trace" : "pw-cmp-list";
  return (
    `${wrapper}<table class="${tableClass}">${head}${body}</table>` +
    `${pager(rid, sort, direction, page, pages, total)}</section>`
  );
}

function dotStrip(
  rid: string,
  run: PairwiseRun,
  entries: readonly PairwiseEntry[],
): string {
  const judges = judgeOrder(run);
  const dots = numbers(run, entries).map(([n, entry]) => {
    const winner = entry.comparison.winner;
    const split = comparisonFlags(entry, judges).split ? " is-split" : "";
    const colour = pwSideColour(winner);
    return (
      `<a class="pw-dot${split}" href="/r/${esc(rid)}?cmp=${n}#cmp-${n}" title="#${n} · ${esc(pwSideLabel(winner, run))}"` +
      ` hx-get="/r/${esc(rid)}/pairwise/row-list?focus=${n}" hx-include="#filter-form"` +
      ` hx-target="#pw-row-list-${esc(rid)}" hx-swap="outerHTML show:#cmp-${n}:top"` +
      ` style="background:${colour};color:${colour}"></a>`
    );
  });
  const legend =
    '<div class="pw-legend">' +
    `<span><span class="pw-swatch" style="background:var(--pw-a)"></span>${esc(run.labelA)} won</span>` +
    `<span><span class="pw-swatch" style="background:var(--pw-b)"></span>${esc(run.labelB)} won</span>` +
    '<span><span class="pw-swatch" style="background:var(--pw-tie)"></span>tie</span>' +
    '<span><span class="pw-swatch" style="background:var(--pw-none)"></span>inconclusive</span>' +
    "<span>ringed = judges split · click to jump</span></div>";
  return panel(
    "Every comparison",
    `<div class="pw-strip">${dots.join("")}</div>${legend}`,
  );
}

export async function renderPairwiseComparisons(
  rid: string,
  run: PairwiseRun,
  entries: readonly PairwiseEntry[],
  options: { focus?: number | null } = {},
): Promise<string> {
  return (
    dotStrip(rid, run, entries) +
    (await renderPairwiseRowList(rid, run, entries, { focus: options.focus }))
  );
}

function voteItem(
  vote: PairwiseVote | undefined,
  model: string,
  run: PairwiseRun,
): string {
  const value = vote?.vote ?? null;
  const head = `${esc(shortModel(model))} → ${esc(pwSideLabel(value, run))}`;
  let tags = "";
  let body = "";
  if (!vote) tags = '<span class="pw-standin">did not vote</span>';
  else {
    if (vote.replacement) tags += '<span class="pw-standin">stand-in</span>';
    if (vote.flipped)
      tags +=
        '<span class="pw-flip">⚖ flipped when sides swapped, vote thrown out</span>';
    const multi = vote.observations.some((o) => o.repetition > 0);
    const lines = vote.observations.map((o) => {
      let order = o.ordering === "ab" ? "original order" : "swapped order";
      if (multi) order += ` · pass ${o.repetition + 1}`;
      return `<div><b>${order}</b> ${esc(pwSideLabel(o.verdict, run))} · ${esc(o.explanation || "")}</div>`;
    });
    if (!lines.length && vote.explanation)
      lines.push(`<div>${esc(vote.explanation)}</div>`);
    body = lines.length ? `<div class="pw-passes">${lines.join("")}</div>` : "";
    body += classifyDetails({
      classifyObservations: classifyObservations(vote, run),
    } as VoteCell);
  }
  return `<li class="pw-vote"><div class="pw-vote-head" style="--c:${pwSideColour(value)}">${head}${tags}</div>${body}</li>`;
}

export function renderPairwiseComparisonDetail(
  run: PairwiseRun,
  idx: number,
): string {
  const entry = run.entries[idx] as PairwiseEntry;
  const byModel = new Map(entry.comparison.votes.map((v) => [v.model, v]));
  const panes =
    '<div class="pw-panes">' +
    `<div class="pw-pane" style="--c:var(--pw-a)"><h4>${esc(run.labelA)}</h4>` +
    `<div class="pw-pane-body">${esc(entry.responseA)}</div></div>` +
    `<div class="pw-pane" style="--c:var(--pw-b)"><h4>${esc(run.labelB)}</h4>` +
    `<div class="pw-pane-body">${esc(entry.responseB)}</div></div></div>`;
  const votes = judgeOrder(run)
    .map((j) => voteItem(byModel.get(j), j, run))
    .join("");
  return `${panes}<ul class="pw-votes">${votes}</ul>`;
}

const PY_INT = /^\s*[+-]?\d(?:_?\d)*\s*$/;

export function pyInt(raw: string | null | undefined): number | null {
  return raw !== null && raw !== undefined && PY_INT.test(raw)
    ? Number(raw.trim().replaceAll("_", ""))
    : null;
}

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const notFound = () =>
  new Response("404 Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export async function pairwiseRowListRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const [status, run] = await resolveRun<PairwiseRun>(rid, roots, "pairwise");
  if (run === null)
    return status === "error"
      ? htmlResponse("Report could not be loaded.", 422)
      : notFound();
  const entries = applyOrAll(
    run,
    "pairwise",
    parseSelections(query, "pairwise"),
  ) as PairwiseEntry[];
  const html = await cliSlugRenderScope(() =>
    renderPairwiseRowList(rid, run, entries, {
      sort: query.get("sort") ?? "index",
      direction: query.get("dir") ?? "asc",
      page: pyInt(query.get("page") ?? "1") ?? 1,
      focus: pyInt(query.get("focus")),
    }),
  );
  return htmlResponse(html);
}

export async function pairwiseComparisonRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const [status, run] = await resolveRun<PairwiseRun>(rid, roots, "pairwise");
  if (run === null)
    return status === "error"
      ? htmlResponse("Report could not be loaded.", 422)
      : notFound();
  const idx = pyInt(query.get("idx")) ?? -1;
  if (!(idx >= 0 && idx < run.entries.length))
    return htmlResponse(
      '<p class="sim-empty">No comparison at that index.</p>',
    );
  return htmlResponse(renderPairwiseComparisonDetail(run, idx));
}
