import { esc } from "../common/reports/html-helpers.js";
import { formatSize } from "../insights/population.js";
import {
  SEARCH_DEADLINE_MS,
  type SessionSearchResult,
  type SessionSummary,
} from "../local-sessions/models.js";

const NO_MATCH = "No local sessions match these filters.";
const NO_ROOTS =
  "No Claude Code, Claude desktop, Codex or omp session folders were found on this computer.";

/** The form value that names one session: `{source}:{path}`, split on the first colon. */
export function encodeRef(summary: Pick<SessionSummary, "source" | "path">) {
  return `${summary.source}:${summary.path}`;
}

function row(summary: SessionSummary, selected: ReadonlySet<string>): string {
  const ref = encodeRef(summary);
  const stamp = summary.updatedAt.toISOString().slice(0, 19);
  const shown = `${stamp.slice(0, 10)} ${stamp.slice(11, 16)}`;
  const title = summary.title || summary.firstPrompt || "(untitled)";
  return (
    `<tr><td><input type="checkbox" name="session" value="${esc(ref)}"` +
    `${selected.has(ref) ? " checked" : ""} aria-label="Select session ${esc(title)}"></td>` +
    `<td><time data-utc="${stamp}">${shown} UTC</time></td>` +
    `<td>${esc(summary.source)}</td>` +
    `<td class="irf-sessions-project">${esc(summary.projectDir)}</td>` +
    `<td class="irf-sessions-title">${esc(title)}</td>` +
    `<td>${esc(formatSize(summary.sizeBytes))}</td></tr>`
  );
}

/** The search results as a selectable table, with an empty state and a note when the scan was cut short. */
export function renderSessionResults(
  result: SessionSearchResult,
  options: { selected: ReadonlySet<string>; rootsFound: boolean },
): string {
  const note = result.complete
    ? ""
    : `<p class="irf-hint" role="status">Searched ${result.scannedFiles} of ${result.candidateFiles} ` +
      `session files before the ${SEARCH_DEADLINE_MS / 1000}-second limit. Narrow the dates or text to see the rest.</p>`;
  if (result.sessions.length === 0)
    return `<p class="irf-hint" role="status">${esc(options.rootsFound ? NO_MATCH : NO_ROOTS)}</p>${note}`;
  const refs = new Set(result.sessions.map(encodeRef));
  const chosen = [...refs].filter((ref) => options.selected.has(ref)).length;
  const rows = result.sessions
    .map((summary) => row(summary, options.selected))
    .join("");
  const count = result.sessions.length;
  return (
    `<p class="irf-hint" role="status"><span data-sessions-count>${count} session${count === 1 ? "" : "s"}</span> · ` +
    `<span data-sessions-selected>${chosen} selected</span></p>${note}` +
    '<div class="irf-sessions-scroll"><table class="irf-sessions-table"><thead><tr>' +
    '<th><input type="checkbox" data-sessions-all aria-label="Select all sessions"></th>' +
    "<th>Updated</th><th>Source</th><th>Project</th><th>Title</th><th>Size</th></tr></thead>" +
    `<tbody>${rows}</tbody></table></div>`
  );
}
