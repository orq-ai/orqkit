import { envRaw } from "../common/env-config.js";
import { esc, parseHttpUrl } from "../common/reports/html-helpers.js";
import { pythonStrip } from "../common/sanitize.js";
import { parseExperimentUrl } from "./orq-links.js";
import { resolveBaseUrl, resolveSlug } from "./orq-workspace.js";

const quote = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export async function uiBaseUrl(): Promise<string> {
  return (envRaw("ORQ_UI_BASE_URL") || (await resolveBaseUrl())).replace(
    /\/+$/,
    "",
  );
}
export async function workspaceSlug(): Promise<string | null> {
  return (
    pythonStrip((await resolveSlug()) || "").replace(/^\/+|\/+$/g, "") || null
  );
}
async function tracesBaseUrl(
  experimentUrl?: string | null,
): Promise<string | null> {
  let [host, slug] = parseExperimentUrl(experimentUrl);
  if (!host || !slug) {
    host = await uiBaseUrl();
    slug = await workspaceSlug();
  }
  return slug ? `${host?.replace(/\/+$/, "")}/${quote(slug)}/traces` : null;
}
async function tracesUrl(
  query: string,
  experimentUrl?: string | null,
): Promise<string | null> {
  const base = await tracesBaseUrl(experimentUrl);
  return base ? `${base}?query=${quote(query)}` : null;
}
export async function threadTraceUrl(
  threadId: string | null | undefined,
  experimentUrl?: string | null,
): Promise<string | null> {
  return threadId ? tracesUrl(`thread_id:is:${threadId}`, experimentUrl) : null;
}
export async function singleTraceUrl(
  traceId: string | null | undefined,
  experimentUrl?: string | null,
): Promise<string | null> {
  if (!traceId) return null;
  const base = await tracesBaseUrl(experimentUrl);
  return base ? `${base}/(trace:${quote(traceId)})` : null;
}
export async function traceSpanUrl(
  traceId: string | null | undefined,
  spanId: string | null | undefined,
  experimentUrl?: string | null,
): Promise<string | null> {
  if (
    !traceId ||
    !spanId ||
    !/^[A-Za-z0-9._~-]+$/.test(traceId) ||
    !/^[A-Za-z0-9._~-]+$/.test(spanId) ||
    /[\r\n]$/.test(traceId) ||
    /[\r\n]$/.test(spanId)
  )
    return null;
  const base = await tracesBaseUrl(experimentUrl);
  return base ? `${base}/(trace:${traceId}//span:${spanId})` : null;
}
export async function runTraceUrl(
  runId: string | null | undefined,
  experimentUrl?: string | null,
): Promise<string | null> {
  return runId ? tracesUrl(`thread_id:contains:${runId}`, experimentUrl) : null;
}
export function traceLinkButton(
  url: string | null | undefined,
  label: string,
  options: {
    onclick?: string | null;
    extraAttributes?: Record<string, string | null>;
  } = {},
): string {
  if (!parseHttpUrl(url)) return "";
  const onclick = options.onclick ? ` onclick="${esc(options.onclick)}"` : "";
  const extra = Object.entries(options.extraAttributes ?? {})
    .map(([name, value]) =>
      value === null ? ` ${esc(name)}` : ` ${esc(name)}="${esc(value)}"`,
    )
    .join("");
  return `<a class="btn-secondary trace-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"${extra}${onclick}>${esc(label)}</a>`;
}
