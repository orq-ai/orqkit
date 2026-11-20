import { loadSurface, resolve } from "../common/dashboard/library.js";
import { esc } from "../common/reports/html-helpers.js";
import type {
  RedTeamReport,
  RedTeamResult,
} from "../redteam/reports/models.js";
import { applyOrAll, parseSelections } from "./filters.js";
import { pyInt } from "./pairwise-views.js";
import { renderAgentHeatmap, renderBreakdown } from "./redteam-charts.js";
import {
  renderAttackFragment,
  renderDisagreement,
} from "./redteam-transcripts.js";
import { ADAPTERS } from "./surfaces.js";

export async function loadReport(
  rid: string,
  roots: readonly string[],
): Promise<RedTeamReport | null> {
  const path = await resolve(rid, [...roots]);
  if (path === null) return null;
  const [surface] = await loadSurface(path);
  if (surface !== "redteam") return null;
  try {
    return (await ADAPTERS.redteam?.load(path)) as unknown as RedTeamReport;
  } catch (error) {
    console.warn(`redteam_views: failed to load ${path}: ${error}`);
    return null;
  }
}

export const notFoundFragment = (message: string): string =>
  `<div class="rt-view-error"><p>${esc(message)}</p></div>`;

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const missing = (rid: string) =>
  htmlResponse(notFoundFragment(`Report ${rid} not found`), 404);

function filteredResults(
  report: RedTeamReport,
  query: URLSearchParams,
): RedTeamResult[] {
  return applyOrAll(
    report,
    "redteam",
    parseSelections(query, "redteam"),
  ) as RedTeamResult[];
}

function withResults(
  report: RedTeamReport,
  results: RedTeamResult[],
): RedTeamReport {
  return Object.assign(Object.create(Object.getPrototypeOf(report)), report, {
    results,
  });
}

export async function redteamBreakdownRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const groupBy = query.get("group_by") ?? "vulnerability";
  const stackRaw = query.get("stack_by") ?? "none";
  const report = await loadReport(rid, roots);
  if (report === null) return missing(rid);
  return htmlResponse(
    renderBreakdown({
      report: withResults(report, filteredResults(report, query)),
      groupBy,
      stackBy: stackRaw === "none" || stackRaw === "" ? null : stackRaw,
      rid,
    }),
  );
}

export async function redteamAgentHeatmapRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const dim = query.get("dim") ?? "vulnerability";
  const report = await loadReport(rid, roots);
  if (report === null) return missing(rid);
  return htmlResponse(
    renderAgentHeatmap({
      report: withResults(report, filteredResults(report, query)),
      dim,
      rid,
    }),
  );
}

export async function redteamAttackRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const idx = pyInt(query.get("idx") ?? "0");
  const report = await loadReport(rid, roots);
  if (report === null) return missing(rid);
  const filtered = filteredResults(report, query);
  const result = idx !== null && idx >= 0 ? filtered[idx] : undefined;
  if (result === undefined)
    return htmlResponse(
      '<p class="rt-view-empty">No attack at that index.</p>',
    );
  return htmlResponse(await renderAttackFragment(result));
}

export async function redteamDisagreementRoute(
  rid: string,
  query: URLSearchParams,
  roots: readonly string[],
): Promise<Response> {
  const agentA = query.get("a") ?? "";
  const agentB = query.get("b") ?? "";
  const page = pyInt(query.get("page") ?? "1") ?? 1;
  const report = await loadReport(rid, roots);
  if (report === null) return missing(rid);
  return htmlResponse(
    renderDisagreement({
      report: withResults(report, filteredResults(report, query)),
      agentA,
      agentB,
      page,
      rid,
    }),
  );
}
