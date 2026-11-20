import { randomBytes } from "node:crypto";

import { esc } from "../common/reports/html-helpers.js";
import type { TraceDocument } from "../common/trace-document.js";
import {
  loadSessionDocument,
  resolveSessionRef,
  SESSION_SOURCES,
  type SessionSearchResult,
  type SessionSource,
  searchSessions,
} from "../local-sessions/index.js";
import { sessionRoots } from "../local-sessions/roots.js";
import type { OrqSourceClient } from "../trace-finder/orq-source.js";
import {
  effectiveDashboardSettings,
  loadDashboardSettings,
} from "../trace-finder/settings.js";
import { buildOrqClient, resolveDashboardAuth } from "./auth.js";
import {
  CompressionKnobs,
  type CompressionPreview,
  fetchOrqDocument,
  InspectorSourceError,
  jevReductionPercent,
  KnobError,
  ORIGINAL_VIEW_LABELS,
  previewDocument,
  readableReductionPercent,
} from "./compression-inspector-data.js";
import {
  grouped,
  knobsFormHtml,
  PREVIEW_ROUTE,
} from "./compression-inspector-knobs.js";
import { csrfField, requestRejected } from "./security.js";
import { page } from "./shell.js";

const BASE = "/compression-inspector";
export const TRACE_ID_MAX_LENGTH = 512;
export const SESSION_REF_MAX_LENGTH = 4096;

const SOURCE_LABELS: Partial<Record<SessionSource, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude desktop",
  codex: "Codex",
};
const LOCAL_SOURCES = SESSION_SOURCES.filter(
  (source) => source in SOURCE_LABELS,
);

const SESSION_SEARCH_ERROR = "The local-session search could not be completed.";
const ORQ_ERROR =
  "The Orq trace could not be loaded. Check the ID, selected dates, and dashboard access.";
const SESSION_ERROR =
  "That local session could not be loaded from the configured session folders.";
const EXPIRED_ERROR = "Load the trace again to adjust it.";
const MAX_CACHED_DOCUMENTS = 8;
const LOADING_SCRIPT =
  "this.querySelector('button').disabled=true;this.querySelector('button').textContent='Loading...';";

type Form = Pick<FormData, "get">;

interface Cached {
  document: TraceDocument;
  sourcePath: string | null;
}

export class DocumentCache {
  private readonly entries = new Map<string, Cached>();

  put(document: TraceDocument, sourcePath: string | null): string {
    const token = randomBytes(16).toString("base64url");
    this.entries.set(token, { document, sourcePath });
    while (this.entries.size > MAX_CACHED_DOCUMENTS)
      this.entries.delete(this.entries.keys().next().value as string);
    return token;
  }

  get(token: string): Cached | null {
    const entry = this.entries.get(token);
    if (entry === undefined) return null;
    this.entries.delete(token);
    this.entries.set(token, entry);
    return entry;
  }
}

interface Loaded {
  preview: CompressionPreview;
  knobs: CompressionKnobs;
  token: string;
  hasSource: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function parseDay(text: string): Date {
  const day = new Date(`${text}T00:00:00Z`);
  if (
    !ISO_DAY.test(text) ||
    Number.isNaN(day.getTime()) ||
    day.toISOString().slice(0, 10) !== text
  )
    throw new RangeError("invalid date");
  return day;
}

export function dateBounds(form: Form): [Date | null, Date | null] {
  const startText = String(form.get("start_date") ?? "").trim();
  const endText = String(form.get("end_date") ?? "").trim();
  if (!startText && !endText) return [null, null];
  if (!startText || !endText) throw new RangeError("both dates required");
  const start = parseDay(startText),
    last = parseDay(endText);
  if (start > last) throw new RangeError("start after end");
  return [start, new Date(last.getTime() + 86_400_000)];
}

const status = (text: string) =>
  `<p class="compression-count-note" role="status">${text}</p>`;

export function outputHtml(
  options: {
    preview?: CompressionPreview | null;
    notice?: string | null;
    wrapped?: boolean;
  } = {},
): string {
  const { preview = null, notice = null, wrapped = false } = options;
  const opening = `<div id="compression-output" class="compression-output${wrapped ? " is-wrapped" : ""}">`;
  if (notice !== null || preview === null)
    return `${opening}<p class="compression-notice" role="alert">${esc(notice ?? "")}</p></div>`;
  const state = JSON.stringify(preview.compressed, null, 2);
  const noBody = status(
    "No readable input or output is available for this source.",
  );
  let originalHtml = preview.original
    ? `<pre>${esc(preview.original)}</pre>`
    : preview.original_view === "readable"
      ? noBody
      : status("The original is empty.");
  if (
    preview.original_view === "readable" &&
    preview.original &&
    !preview.readable_body_present
  )
    originalHtml += noBody;
  const noteHtml = preview.original_note
    ? status(esc(preview.original_note))
    : "";
  const label = esc(ORIGINAL_VIEW_LABELS[preview.original_view]);
  const metric = (name: string, value: string) =>
    `<div><dt>${name}</dt><dd>${value}</dd></div>`;
  return (
    opening +
    '<dl class="compression-metrics">' +
    metric("Original characters", grouped(preview.original_chars)) +
    metric("Full trace JSON characters", grouped(preview.full_json_chars)) +
    metric("Readable source characters", grouped(preview.transcript_chars)) +
    metric("Readable view characters", grouped(preview.readable_chars)) +
    metric(
      "Plaintext reduction vs JSON",
      `${readableReductionPercent(preview).toFixed(1)}%`,
    ) +
    metric("Source messages", grouped(preview.message_count)) +
    metric(
      "Serialized Jev state characters",
      grouped(preview.compressed_chars),
    ) +
    metric(
      "Jev reduction vs JSON",
      `${jevReductionPercent(preview).toFixed(1)}%`,
    ) +
    metric(
      "Messages omitted from Jev state",
      grouped(preview.omitted_messages),
    ) +
    metric("Global character cap", grouped(preview.global_cap)) +
    "</dl>" +
    '<p class="compression-count-note">Reduction compares character counts with the full uncapped trace document ' +
    "as compact JSON, including metadata and null fields. Display whitespace is excluded for Jev; " +
    "negative reduction means a larger output. These are not token savings.</p>" +
    '<div class="compression-panels">' +
    '<section class="compression-panel" aria-labelledby="compression-original-title">' +
    `<h3 id="compression-original-title">Original, ${label}</h3>` +
    originalHtml +
    noteHtml +
    "</section>" +
    '<section class="compression-panel" aria-labelledby="compression-jev-title">' +
    '<h3 id="compression-jev-title">Output (Jev state)</h3>' +
    `<pre>${esc(state)}</pre>` +
    '<p class="compression-count-note">The state character count uses compact serialization; this readable display adds formatting whitespace.</p>' +
    "</section>" +
    "</div></div>"
  );
}

function previewHtml(loaded: Loaded, globalCap: number): string {
  const defaults = CompressionKnobs.defaults(globalCap);
  return (
    '<section class="compression-preview" aria-labelledby="compression-preview-title">' +
    '<div class="compression-preview-heading"><div>' +
    '<h2 id="compression-preview-title">Preview</h2>' +
    "<p>The original and its Jev state, with known sensitive values scrubbed; the canonical ATIF source is unchanged.</p>" +
    '</div><p class="compression-question-note">No question included.</p></div>' +
    knobsFormHtml(loaded.knobs, defaults, loaded.token, {
      hasSource: loaded.hasSource,
    }) +
    outputHtml({ preview: loaded.preview, wrapped: loaded.knobs.wrap }) +
    "</section>"
  );
}

const utcMinute = (date: Date) =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const pythonIso = (date: Date) => {
  const iso = date.toISOString().slice(0, -1);
  const fraction = date.getUTCMilliseconds()
    ? iso.replace(/\.(\d{3})$/, ".$1000")
    : iso.slice(0, -4);
  return `${fraction}+00:00`;
};

async function sessionResultsHtml(
  result: SessionSearchResult,
): Promise<string> {
  if (!result.sessions.length) {
    let empty: string;
    if (!result.complete)
      empty =
        "The search stopped before finding a local session. Its empty result may be incomplete. " +
        "Try again or narrow the configured session roots.";
    else {
      const roots = [
        ...(await sessionRoots("claude")),
        ...(await sessionRoots("codex")),
      ];
      empty = roots.length
        ? "No local sessions matched the available source folders."
        : "No local sessions were found. Sessions are looked for in the configured Claude Code, " +
          "Claude desktop, and Codex session folders.";
    }
    return `<p class="compression-empty" role="status">${empty}</p>`;
  }
  const items = result.sessions.map((session) => {
    const title = session.title || session.firstPrompt || "Untitled session";
    const ref = `${session.source}:${session.path}`;
    return (
      '<li class="compression-session">' +
      '<div class="compression-session-description">' +
      `<strong>${esc(SOURCE_LABELS[session.source] ?? session.source)}</strong>` +
      `<span>${esc(title)}</span>` +
      `<time datetime="${esc(pythonIso(session.updatedAt))}">${esc(utcMinute(session.updatedAt))}</time>` +
      "</div>" +
      `<form method="post" action="${BASE}/sessions/load" autocomplete="off" ` +
      `onsubmit="${LOADING_SCRIPT}">` +
      `${csrfField()}<input type="hidden" name="session" value="${esc(ref)}">` +
      '<button type="submit">Preview session</button></form>' +
      "</li>"
    );
  });
  const note = result.complete
    ? '<p class="compression-search-note">Showing at most 50 matches. Session files remain on this computer.</p>'
    : '<p class="compression-search-note">Search stopped before completion; these are the matches found so far.</p>';
  return (
    `<p class="compression-result-count" role="status">${result.sessions.length} local sessions</p>` +
    `${note}<ul class="compression-session-list">${items.join("")}</ul>`
  );
}

interface BodyOptions {
  notice?: string | null;
  loaded?: Loaded | null;
  sessions?: SessionSearchResult | null;
}

async function bodyHtml(
  options: BodyOptions,
  globalCap: number,
): Promise<string> {
  const noticeHtml = options.notice
    ? `<p class="compression-notice" role="alert">${esc(options.notice)}</p>`
    : "";
  const sessionsHtml = options.sessions
    ? await sessionResultsHtml(options.sessions)
    : "";
  const loadedHtml = options.loaded
    ? previewHtml(options.loaded, globalCap)
    : "";
  return (
    '<div class="dash-wrap compression-inspector">' +
    '<header class="compression-intro">' +
    "<h2>Inspect trace compression</h2>" +
    "<p>Compare the readable conversation with the structured Jev state " +
    "without sending a question or calling a model.</p>" +
    "</header>" +
    noticeHtml +
    '<div class="compression-sources">' +
    '<section class="compression-source" aria-labelledby="compression-orq-title">' +
    '<h3 id="compression-orq-title">Orq trace ID</h3>' +
    "<p>Search the most recent 7 days by default. Set both dates to find an older trace; " +
    "the end date includes that full day.</p>" +
    `<form method="post" action="${BASE}/source/orq" autocomplete="off" ` +
    `onsubmit="${LOADING_SCRIPT}">` +
    csrfField() +
    '<label for="compression-trace-id">Trace ID</label>' +
    '<input id="compression-trace-id" name="trace_id" type="text" ' +
    `maxlength="${TRACE_ID_MAX_LENGTH}" autocomplete="off" required>` +
    '<div class="compression-date-fields">' +
    '<div><label for="compression-start-date">Start date (optional)</label>' +
    '<input id="compression-start-date" name="start_date" type="date"></div>' +
    '<div><label for="compression-end-date">End date (optional)</label>' +
    '<input id="compression-end-date" name="end_date" type="date"></div>' +
    "</div>" +
    '<button type="submit">Load Orq trace</button>' +
    "</form></section>" +
    '<section class="compression-source" aria-labelledby="compression-local-title">' +
    '<h3 id="compression-local-title">Local sessions</h3>' +
    "<p>Search up to 50 sessions from Claude Code, Claude desktop, and Codex. " +
    "The selected session is validated under its configured local session roots before reading.</p>" +
    `<form method="post" action="${BASE}/sessions/search" autocomplete="off" ` +
    `onsubmit="${LOADING_SCRIPT}">` +
    `${csrfField()}<button type="submit">Search local sessions</button></form>` +
    `${sessionsHtml}</section>` +
    "</div>" +
    '<section class="compression-limits" aria-labelledby="compression-limits-title">' +
    '<h3 id="compression-limits-title">Character limits</h3>' +
    `<p>Global cap: <strong>${grouped(globalCap)}</strong> ` +
    "characters (500,000 by default). " +
    "Jev state is capped at 112,000 characters; question-aware ceilings are " +
    "128,000 or 256,000 characters. " +
    "This preview includes no question, so its state count is not fitted to a question payload.</p>" +
    "</section>" +
    loadedHtml +
    "</div>"
  );
}

const NO_STORE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
};

async function globalCharCap(): Promise<number> {
  return (await effectiveDashboardSettings()).traceInputChars;
}

async function pageResponse(
  options: BodyOptions = {},
  statusCode = 200,
): Promise<Response> {
  const body = await page(
    "Compression inspector",
    await bodyHtml(options, await globalCharCap()),
    { activeNav: "compression-inspector" },
  );
  return new Response(body, { status: statusCode, headers: NO_STORE });
}

const disabled = () =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });

const isRenderLimit = (error: unknown) =>
  error instanceof KnobError ||
  error?.constructor?.name === "ModelInputCapError" ||
  (error instanceof Error && error.constructor === Error && !("code" in error));

export async function defaultOrqClient(): Promise<OrqSourceClient> {
  const settings = await effectiveDashboardSettings();
  const auth = await resolveDashboardAuth(settings);
  return (await buildOrqClient(auth, {
    workspace: settings.orqWorkspace,
    project: settings.orqProjectId,
  })) as unknown as OrqSourceClient;
}

export interface CompressionInspectorOptions {
  buildClient?: () => Promise<OrqSourceClient>;
  documents?: DocumentCache;
}

/** Handle a compression inspector request, or return null when the path is not one of its routes. */
export function compressionInspectorRoutes(
  options: CompressionInspectorOptions = {},
): (req: Request, url: URL) => Promise<Response | null> {
  const buildClient = options.buildClient ?? defaultOrqClient;
  const documents = options.documents ?? new DocumentCache();

  async function load(
    document: TraceDocument,
    sourcePath: string | null = null,
  ): Promise<Loaded> {
    const knobs = CompressionKnobs.defaults(await globalCharCap());
    const preview = await previewDocument(document, { knobs, sourcePath });
    const token = documents.put(document, sourcePath);
    return { preview, knobs, token, hasSource: sourcePath !== null };
  }

  async function checked(req: Request): Promise<Form | Response> {
    const form = (await req.formData()) as unknown as Form;
    const rejected = requestRejected(req, form);
    if (rejected) return pageResponse({ notice: rejected }, 403);
    return form;
  }

  async function orq(form: Form): Promise<Response> {
    const traceId = String(form.get("trace_id") ?? "").trim();
    if (!traceId || traceId.length > TRACE_ID_MAX_LENGTH)
      return pageResponse({ notice: "Enter a valid Orq trace ID." }, 422);
    let start: Date | null;
    let end: Date | null;
    try {
      [start, end] = dateBounds(form);
    } catch {
      return pageResponse(
        {
          notice:
            "Enter both valid dates, with the start date on or before the end date.",
        },
        422,
      );
    }
    let loaded: Loaded;
    try {
      const document = await fetchOrqDocument(buildClient, traceId, {
        start,
        end,
      });
      if (document === null)
        return pageResponse({
          notice: "No Orq trace matched that ID in the selected date range.",
        });
      loaded = await load(document);
    } catch {
      return pageResponse({ notice: ORQ_ERROR });
    }
    return pageResponse({ loaded });
  }

  async function sessionsSearch(): Promise<Response> {
    let result: SessionSearchResult;
    try {
      result = await searchSessions({
        sources: LOCAL_SOURCES,
        start: null,
        end: null,
        projectDir: null,
        text: null,
        limit: 50,
      });
    } catch {
      return pageResponse({ notice: SESSION_SEARCH_ERROR });
    }
    return pageResponse({ sessions: result });
  }

  async function sessionsLoad(form: Form): Promise<Response> {
    const rawRef = String(form.get("session") ?? "");
    if (rawRef.length > SESSION_REF_MAX_LENGTH)
      return pageResponse({ notice: SESSION_ERROR }, 422);
    const separator = rawRef.indexOf(":");
    const source = separator < 0 ? "" : rawRef.slice(0, separator);
    const rawPath = separator < 0 ? "" : rawRef.slice(separator + 1);
    if (
      separator < 0 ||
      !LOCAL_SOURCES.includes(source as SessionSource) ||
      !rawPath
    )
      return pageResponse({ notice: SESSION_ERROR }, 422);
    let loaded: Loaded;
    try {
      const ref = { source: source as SessionSource, path: rawPath };
      const sourcePath = (await resolveSessionRef(ref)).path;
      loaded = await load(await loadSessionDocument(ref), sourcePath);
    } catch {
      return pageResponse({ notice: SESSION_ERROR });
    }
    return pageResponse({ loaded });
  }

  async function preview(req: Request, form: Form): Promise<Response> {
    const token = String(form.get("token") ?? "");
    const cached = documents.get(token);
    let loaded: Loaded | null = null;
    let notice: string | null = null;
    if (cached === null) notice = EXPIRED_ERROR;
    else
      try {
        const knobs = CompressionKnobs.fromForm(
          form as unknown as URLSearchParams,
        );
        const rendered = await previewDocument(cached.document, {
          knobs,
          sourcePath: cached.sourcePath,
        });
        loaded = {
          preview: rendered,
          knobs,
          token,
          hasSource: cached.sourcePath !== null,
        };
      } catch (error) {
        if (!isRenderLimit(error) || error instanceof InspectorSourceError)
          throw error;
        notice = (error as Error).message;
      }
    if ((req.headers.get("hx-request") ?? "").toLowerCase() === "true")
      return new Response(
        outputHtml({
          preview: loaded?.preview ?? null,
          notice,
          wrapped: form.get("wrap") !== null,
        }),
        { headers: NO_STORE },
      );
    return pageResponse({ notice, loaded });
  }

  const posts: Record<string, (req: Request, form: Form) => Promise<Response>> =
    {
      [`${BASE}/source/orq`]: (_req, form) => orq(form),
      [`${BASE}/sessions/search`]: () => sessionsSearch(),
      [`${BASE}/sessions/load`]: (_req, form) => sessionsLoad(form),
      [PREVIEW_ROUTE]: preview,
    };

  return async (req, url) => {
    const path = url.pathname;
    const isPage = req.method === "GET" && path === BASE;
    const post = req.method === "POST" ? posts[path] : undefined;
    if (!isPage && !post) return null;
    if (!(await loadDashboardSettings()).compressionInspectorEnabled)
      return disabled();
    if (isPage) return pageResponse();
    const form = await checked(req);
    if (form instanceof Response) return form;
    return (post as NonNullable<typeof post>)(req, form);
  };
}
