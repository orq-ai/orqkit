import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { loadSurface, scan } from "../common/dashboard/library.js";
import { listManifests } from "../common/run-manifest.js";
import { getSimulationRunsDir } from "../integrations/simulation/run-store.js";
import { getPairwiseRunsDir } from "../pairwise-run.js";
import { rebuildFilteredReport } from "../redteam/reports/summary.js";
import { getRedteamRunsDir } from "../redteam/run-store.js";
import { compressionInspectorRoutes } from "./compression-inspector.js";
import { applyOrAll, FILTERS, parseSelections } from "./filters.js";
import { landing, redteamOverview, runRows, simOverview } from "./metrics.js";
import { redteamReportTabs } from "./redteam-report-tabs.js";
import { dashboardCss, dashboardCssVersion, page } from "./shell.js";
import {
  simulationAgentCardFragment,
  simulationReportTabs,
} from "./simulation-report-tabs.js";
import { STATIC_DIR } from "./static-assets.js";
import { ADAPTERS } from "./surfaces.js";
import {
  filterFragment,
  landingBody,
  RUN_PAGE_SIZES,
  redteamOverviewBody,
  renderFilterForm,
  reportActions,
  reportBackLink,
  reportBroken,
  reportInFlight,
  reportNotFound,
  reportViewWithFilters,
  runCompareControl,
  runsScreenBody,
  SURFACE_LABELS,
  searchResults,
  simOverviewBody,
} from "./view.js";

export function defaultRoots(): string[] {
  return [getRedteamRunsDir(), getSimulationRunsDir(), getPairwiseRunsDir()];
}

const html = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const attachment = (body: string, type: string, filename: string) =>
  new Response(body, {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });

export function paging(query: URLSearchParams): [number, number] {
  const int = (raw: string | null, fallback: number) =>
    raw !== null && /^\s*[+-]?\d+\s*$/.test(raw)
      ? Number.parseInt(raw, 10)
      : fallback;
  const pg = int(query.get("page"), 1);
  let perPage = int(query.get("per_page"), RUN_PAGE_SIZES[0] as number);
  if (!RUN_PAGE_SIZES.includes(perPage)) perPage = RUN_PAGE_SIZES[0] as number;
  return [pg, perPage];
}

const CSV_FORMULA_LEAD = ["=", "+", "-", "@", "\t", "\r"];

export function csvSafe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!CSV_FORMULA_LEAD.some((lead) => value.startsWith(lead))) return value;
  if (value === "-") return value;
  return isPyFloat(value) ? value : `'${value}`;
}

function isPyFloat(value: string): boolean {
  const s = value.trim().replaceAll("_", "");
  return /^[+-]?((\d+\.?\d*|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i.test(s);
}

function csvCell(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ""
      : typeof value === "boolean"
        ? value
          ? "True"
          : "False"
        : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "";
  const keys = Object.keys(first);
  const lines = [keys.map((k) => csvCell(csvSafe(k))).join(",")];
  for (const row of rows)
    lines.push(keys.map((k) => csvCell(csvSafe(row[k]))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const asciiJson = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

async function resolvePath(rid: string, roots: string[]) {
  const card = (await scan(roots)).find((c) => c.id === rid && c.path);
  return card?.path ?? null;
}

async function resolveManifest(rid: string, roots: string[]) {
  const card = (await scan(roots)).find((c) => c.id === rid && !c.path);
  if (!card) return null;
  for (const root of roots)
    for (const m of await listManifests(root))
      if (!m.reportPath && card.name === m.runName) return m;
  return null;
}

async function loadReport(rid: string, roots: string[]) {
  const path = await resolvePath(rid, roots);
  if (!path) return { path: null } as const;
  const [surface] = await loadSurface(path);
  const adapter = surface ? ADAPTERS[surface] : undefined;
  return { path, surface: surface ?? "", adapter } as const;
}

const filename = (path: string) => path.split(sep).pop() ?? path;

async function compareChoices(
  roots: string[],
  surface: string,
): Promise<Array<[string, string]>> {
  return (await scan(roots))
    .filter((c) => c.surface === surface && !c.error)
    .slice(0, 100)
    .map((c) => [c.id, c.name]);
}

async function surfaceBody(
  rid: string,
  surface: string,
  // biome-ignore lint/suspicious/noExplicitAny: each surface passes its own run type
  report: any,
  roots: string[],
  // biome-ignore lint/suspicious/noExplicitAny: filtered rows of that surface
  filtered?: any[],
): Promise<string | null> {
  if (surface === "sim") {
    const compareHtml = runCompareControl(
      rid,
      await compareChoices(roots, "sim"),
      "/compare/sim",
    );
    return simulationReportTabs(rid, report, {
      results: filtered,
      compareHtml: filtered ? undefined : compareHtml,
    });
  }
  if (surface === "redteam") {
    if (filtered) {
      return redteamReportTabs(rid, rebuildFilteredReport(report, filtered));
    }
    return redteamReportTabs(rid, report);
  }
  return null;
}

async function index(url: URL, roots: string[]): Promise<Response> {
  const surface = url.searchParams.get("surface") || null;
  if (surface === null)
    return html(
      await page("Dashboard", landingBody(await landing(roots)), {
        activeNav: "dashboard",
      }),
    );
  const label = SURFACE_LABELS[surface] ?? "Reports";
  const [pg, perPage] = paging(url.searchParams);
  let body: string;
  if (surface === "sim")
    body = simOverviewBody(await simOverview(roots, { page: pg, perPage }));
  else if (surface === "redteam")
    body = redteamOverviewBody(
      await redteamOverview(roots, { page: pg, perPage }),
    );
  else
    body = runsScreenBody(
      (await runRows(roots)).filter((r) => r.surface === surface),
      surface,
    );
  return html(await page(label, body, { activeSurface: surface }));
}

function cssResponse(url: URL): Response {
  const cache =
    url.searchParams.get("v") === dashboardCssVersion()
      ? "public, max-age=31536000, immutable"
      : "no-cache";
  return new Response(dashboardCss(), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": cache,
    },
  });
}

async function staticFile(path: string): Promise<Response> {
  const root = resolve(STATIC_DIR);
  const full = resolve(root, path);
  if (!full.startsWith(root + sep)) return text("404 Not Found", 404);
  try {
    if (!(await stat(full)).isFile()) return text("404 Not Found", 404);
  } catch {
    return text("404 Not Found", 404);
  }
  const type = STATIC_TYPES[full.slice(full.lastIndexOf(".") + 1)];
  return new Response(
    Readable.toWeb(createReadStream(full)) as ReadableStream,
    { headers: type ? { "content-type": type } : {} },
  );
}

const STATIC_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  json: "application/json",
};

async function reportView(rid: string, roots: string[]) {
  const loaded = await loadReport(rid, roots);
  if (!loaded.path) {
    const manifest = await resolveManifest(rid, roots);
    if (manifest)
      return html(
        await page(manifest.runName, reportInFlight(manifest), {
          activeSurface: String(manifest.surface),
        }),
      );
    return html(await page("Not found", reportNotFound(rid)), 404);
  }
  const { path, surface, adapter } = loaded;
  const filterDef = FILTERS[surface];
  if (!adapter || !filterDef)
    return html(await page("Not found", reportNotFound(rid)), 404);
  let report: never;
  try {
    report = await adapter.load(path);
  } catch (exc) {
    const name = filename(path);
    return html(
      await page(
        `Error — ${name}`,
        reportBroken(rid, name, (exc as Error).message),
        { activeSurface: surface },
      ),
    );
  }
  const body = await surfaceBody(rid, surface, report, roots);
  if (body === null)
    return text(
      "This report view is not available in the TypeScript dashboard yet",
      501,
    );
  const total = filterDef.results(report).length;
  const form = renderFilterForm(
    rid,
    surface,
    filterDef.options(report),
    {},
    { shown: total, total },
  );
  return html(
    await page(
      adapter.name(report),
      reportViewWithFilters(rid, surface, body, form),
      {
        activeSurface: surface,
        actionsHtml: reportActions(rid),
        backHtml: reportBackLink(surface),
      },
    ),
  );
}

async function simAgentCard(rid: string, roots: string[]) {
  const loaded = await loadReport(rid, roots);
  if (!loaded.path || loaded.surface !== "sim" || !loaded.adapter)
    return text("404 Not Found", 404);
  try {
    const run = await loaded.adapter.load(loaded.path);
    return html(await simulationAgentCardFragment(run));
  } catch {
    return text("Error loading report", 422);
  }
}

async function reportFilter(rid: string, req: Request, roots: string[]) {
  const loaded = await loadReport(rid, roots);
  if (!loaded.path) return text("404 Not Found", 404);
  const { path, surface, adapter } = loaded;
  const filterDef = FILTERS[surface];
  if (!adapter || !filterDef) return text("404 Not Found", 404);
  let report: never;
  try {
    report = await adapter.load(path);
  } catch (exc) {
    return text(`Error loading report: ${(exc as Error).message}`, 422);
  }
  const selections: Record<string, string[]> = {};
  for (const [key, value] of (await req.formData()).entries())
    selections[key] = [...(selections[key] ?? []), String(value)];
  const filtered = filterDef.apply(report, selections);
  const body = await surfaceBody(rid, surface, report, roots, filtered);
  if (body === null)
    return text(
      "This report view is not available in the TypeScript dashboard yet",
      501,
    );
  const form = renderFilterForm(
    rid,
    surface,
    filterDef.options(report),
    selections,
    {
      shown: filtered.length,
      total: filterDef.results(report).length,
    },
  );
  return html(filterFragment(rid, surface, body, form), 200, {
    "HX-Trigger": "orq:filter-changed",
  });
}

async function exportRoute(
  rid: string,
  kind: "html" | "md" | "csv" | "json",
  url: URL,
  roots: string[],
): Promise<Response> {
  const loaded = await loadReport(rid, roots);
  if (!loaded.path || !loaded.adapter) return text("404 Not Found", 404);
  const { path, surface, adapter } = loaded;
  if (kind === "md" && !adapter.exportMarkdown)
    return text("no markdown export for this surface", 404);
  if (kind === "csv" && surface === "sim")
    return text("no CSV export for simulation runs", 404);
  if ((kind === "csv" || kind === "json") && !adapter.rows)
    return text(
      `${kind === "csv" ? "CSV" : "JSON"} export not supported for this surface`,
      404,
    );
  let report: never;
  try {
    report = await adapter.load(path);
  } catch (exc) {
    return text(
      `Error loading report ${filename(path)}: ${(exc as Error).message}`,
      422,
    );
  }
  if (kind === "html")
    return attachment(
      await adapter.export(report),
      "text/html; charset=utf-8",
      `${rid}.html`,
    );
  if (kind === "md")
    return attachment(
      await (adapter.exportMarkdown as (r: never) => Promise<string>)(report),
      "text/markdown; charset=utf-8",
      `${rid}.md`,
    );
  const filtered = applyOrAll(
    report,
    surface,
    parseSelections(url.searchParams, surface),
  );
  const rows = (
    adapter.rows as (r: never, f: never[]) => Record<string, unknown>[]
  )(report, filtered as never[]);
  if (kind === "csv")
    return attachment(toCsv(rows), "text/csv; charset=utf-8", `${rid}.csv`);
  return attachment(asciiJson(rows), "application/json", `${rid}.json`);
}

export function createDashboardHandler(
  options: {
    roots?: string[] | null;
    compressionInspector?: Parameters<typeof compressionInspectorRoutes>[0];
  } = {},
): (req: Request) => Promise<Response> {
  const roots = () => options.roots ?? defaultRoots();
  const compression = compressionInspectorRoutes(options.compressionInspector);
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const inspected = await compression(req, url);
    if (inspected) return inspected;
    if (method === "GET" && path === "/") return index(url, roots());
    if (method === "GET" && path === "/static/dashboard.css")
      return cssResponse(url);
    if (method === "GET" && path === "/search")
      return html(
        searchResults(await scan(roots()), url.searchParams.get("q") ?? ""),
      );
    if (method === "GET" && path.startsWith("/static/"))
      return staticFile(decodeURIComponent(path.slice("/static/".length)));
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const rid = decodeURIComponent(m[1] as string);
      const rest = m[2] ?? "";
      if (method === "GET" && rest === "") return reportView(rid, roots());
      if (method === "GET" && rest === "/sim/agent-card")
        return simAgentCard(rid, roots());
      if (method === "POST" && rest === "/filter")
        return reportFilter(rid, req, roots());
      if (method === "GET" && (rest === "/export" || rest === "/export.html"))
        return exportRoute(rid, "html", url, roots());
      if (method === "GET" && rest === "/export.md")
        return exportRoute(rid, "md", url, roots());
      if (method === "GET" && rest === "/export.csv")
        return exportRoute(rid, "csv", url, roots());
      if (method === "GET" && rest === "/export.json")
        return exportRoute(rid, "json", url, roots());
    }
    return text("404 Not Found", 404);
  };
}

export function serveDashboard(options: {
  roots?: string[] | null;
  host?: string;
  port?: number;
}) {
  const handle = createDashboardHandler({ roots: options.roots });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? "127.0.0.1";
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        body: hasBody
          ? (Readable.toWeb(incoming) as ReadableStream)
          : undefined,
        duplex: "half",
      });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (exc) {
      console.error("dashboard request failed", exc);
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end("Internal Server Error");
    }
  });
  server.listen(options.port ?? 8765, options.host ?? "127.0.0.1");
  return server;
}
