import { readFile } from "node:fs/promises";

import {
  type ApplyRecommendationsResult,
  collectRecommendations,
} from "../common/apply.js";
import { writePrivateAtomic } from "../common/private-files.js";
import { pythonJsonDumps } from "../common/python-json.js";
import { esc } from "../common/reports/html-helpers.js";
import { pyFixed } from "../common/reports/number-format.js";
import { pythonStrip } from "../common/sanitize.js";
import type {
  SimulationRecommendation,
  SimulationRun,
} from "../integrations/simulation/run-store.js";
import type {
  FocusAreaRecommendation,
  RedTeamReport,
} from "../redteam/reports/models.js";
import { focusTier } from "./report-kit.js";
import { csrfField } from "./security.js";

export const DRAWER_ID = "rt-apply-drawer",
  AGENT_FIELD_ID = "rt-apply-agent-field";
export function pendingRecommendations(report: RedTeamReport): string[] {
  return collectRecommendations(
    report.focusAreaRecommendations ?? [],
    10000,
    report.appliedRecommendations,
  );
}
export function isApplyEnabled(report: RedTeamReport): boolean {
  return (
    Boolean(report.focusAreaRecommendations?.length) &&
    report.testedAgents.length === 1
  );
}
export function applyPanelHtml(
  rid: string,
  surface: string,
  agentKey: string,
  pending: string[],
  applied: number,
): string {
  if (!pending.length) {
    const status = applied
      ? `<span class="rt-apply-count rt-apply-count--done">✓ all ${applied} recommendation(s) applied</span>`
      : '<span class="rt-apply-count">no recommendations to apply</span>';
    return `<div class="rt-apply-bar">${status}</div><div id="${DRAWER_ID}"></div>`;
  }
  const agent = `<input type="hidden" id="${AGENT_FIELD_ID}" name="agent_key" value="${esc(agentKey)}">`,
    note = applied ? ` · ${applied} already applied` : "";
  return `<div class="rt-apply-bar"><div class="rt-apply-bar-text"><span class="rt-apply-count">${pending.length} recommendation(s) ready to apply${esc(note)}</span><span class="rt-apply-hint">Apply one from its card below, or all at once here. Preview folds them into the agent instructions; nothing is written until you approve the diff.</span></div><form class="rt-apply-form" hx-post="/r/${esc(rid)}/${surface}/apply/preview" hx-target="#${DRAWER_ID}" hx-swap="innerHTML">${agent}${csrfField()}<button type="submit" class="rt-apply-btn">Preview &amp; apply all ${pending.length} recommendation${pending.length !== 1 ? "s" : ""}</button></form></div><div id="${DRAWER_ID}"></div>`;
}
export function renderApplyPanel(rid: string, report: RedTeamReport): string {
  return isApplyEnabled(report)
    ? applyPanelHtml(
        rid,
        "redteam",
        report.testedAgents[0] ?? "",
        pendingRecommendations(report),
        report.appliedRecommendations.length,
      )
    : "";
}
export function isSimApplyEnabled(run: SimulationRun): boolean {
  return (
    Boolean(run.recommendations?.length) &&
    run.targetKind === "orq_agent" &&
    Boolean(run.target)
  );
}
export function pendingSimSuggestions(run: SimulationRun): string[] {
  return collectRecommendations(
    (run.recommendations ?? []).map((item) => ({
      recommendations: item.suggestions,
    })),
    10000,
    run.appliedSuggestions,
  );
}
export function renderSimApplyPanel(rid: string, run: SimulationRun): string {
  return isSimApplyEnabled(run)
    ? applyPanelHtml(
        rid,
        "sim",
        run.target ?? "",
        pendingSimSuggestions(run),
        run.appliedSuggestions.length,
      )
    : "";
}
function recApplyButton(
  rid: string,
  surface: string,
  narrowField: string,
  narrowValue: string,
  rec: string,
): string {
  return `<form class="rt-focus-rec-apply" hx-post="/r/${esc(rid)}/${surface}/apply/preview" hx-target="#${DRAWER_ID}" hx-swap="innerHTML" hx-include="#${AGENT_FIELD_ID}"><input type="hidden" name="rec" value="${esc(rec)}">${csrfField()}<input type="hidden" name="${narrowField}" value="${esc(narrowValue)}"><button type="submit" class="rt-apply-btn rt-apply-btn--sm">Apply</button></form>`;
}
export function renderRecApplyButton(
  rid: string,
  category: string,
  rec: string,
): string {
  return recApplyButton(rid, "redteam", "category", category, rec);
}
export function renderSimRecApplyButton(
  rid: string,
  resultIndex: number,
  rec: string,
): string {
  return recApplyButton(rid, "sim", "result_index", String(resultIndex), rec);
}

export function drawer(
  title: string,
  body: string,
  footer = "",
  options: { dismissRoute?: string; drawerId?: string } = {},
): string {
  const { dismissRoute = "/apply/dismiss", drawerId = DRAWER_ID } = options;
  const close =
    `<button class="rt-drawer-close" aria-label="Close" ` +
    `hx-get="${dismissRoute}" hx-target="#${drawerId}" hx-swap="innerHTML">&times;</button>`;
  const overlay = `<div class="rt-drawer-overlay" hx-get="${dismissRoute}" hx-target="#${drawerId}" hx-swap="innerHTML"></div>`;
  const footerHtml = footer
    ? `<div class="rt-drawer-footer">${footer}</div>`
    : "";
  return (
    `${overlay}` +
    `<aside class="rt-drawer" role="dialog" aria-modal="true" aria-labelledby="${drawerId}-title" tabindex="-1">` +
    `<div class="rt-drawer-head"><h3 class="rt-drawer-title" id="${drawerId}-title">${title}</h3>${close}</div>` +
    `<div class="rt-drawer-body">${body}</div>` +
    `${footerHtml}</aside>`
  );
}

export function renderErrorDrawer(message: string): string {
  return drawer(
    "Apply recommendations",
    `<p class="rt-drawer-error">${esc(message)}</p>`,
  );
}

function diffHtml(diff: string): string {
  const lines = diff.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  const out = lines.map((line) => {
    let cls = "ctx";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+++") || line.startsWith("---")) cls = "file";
    return `<span class="rt-diff-line rt-diff-${cls}">${esc(line)}</span>`;
  });
  return `<pre class="rt-diff">${out.join("")}</pre>`;
}

function areaBreakdownHtml(area: FocusAreaRecommendation): string {
  const [code, label, color] = focusTier(area.riskScore);
  const patterns = area.patternsObserved
    ? `<div class="rt-drawer-patterns">${esc(area.patternsObserved)}</div>`
    : "";
  return (
    '<div class="rt-drawer-section-label">Focus area</div><div class="rt-drawer-area">' +
    `<span class="rt-drawer-area-tier" style="color:${color}">${esc(`${code} · ${label}`)}</span>` +
    `<span class="rt-drawer-area-name">${esc(area.categoryName)} <span class="rt-drawer-area-code">${esc(area.category)}</span></span>` +
    `<span class="rt-drawer-area-meta">risk ${pyFixed(area.riskScore, 1)} · ${area.tracesAnalyzed} failed trace(s) analyzed</span>` +
    `${patterns}</div>`
  );
}

export function simBreakdownHtml(rec: SimulationRecommendation): string {
  const triggers = rec.triggers.length
    ? `<div class="rt-drawer-patterns">${esc(rec.triggers.join("; "))}</div>`
    : "";
  return (
    '<div class="rt-drawer-section-label">Simulation finding</div><div class="rt-drawer-area">' +
    `<span class="rt-drawer-area-name">${esc(rec.persona)}</span>` +
    `<span class="rt-drawer-area-meta">${esc(rec.scenario)}</span>${triggers}</div>`
  );
}

const REVIEW_CALLOUT =
  '<div class="rt-drawer-review"><span class="rt-drawer-review-icon" aria-hidden="true">&#9888;</span><div class="rt-drawer-review-text"><b>Read this diff before applying.</b> An LLM rewrote the instructions, so it may also reword or remove lines the recommendations never mentioned. Applying replaces the whole instructions field with the right-hand side.</div></div>';

export function renderPreviewDrawer(
  rid: string,
  result: ApplyRecommendationsResult,
  area: FocusAreaRecommendation | null = null,
  options: {
    surface?: string;
    breakdown?: string;
    confirmToken?: string | null;
  } = {},
): string {
  const { surface = "redteam", breakdown = "", confirmToken = null } = options;
  const recs = result.recommendations.map((r) => `<li>${esc(r)}</li>`).join("");
  const unchanged =
    pythonStrip(result.newInstructions) ===
    pythonStrip(result.originalInstructions);
  const recLabel =
    result.recommendations.length === 1
      ? "Recommendation to fold in"
      : `${result.recommendations.length} recommendations to fold in`;
  const body =
    `<div class="rt-drawer-section-label">Agent</div><div class="rt-drawer-agent">${esc(result.agentKey)}</div>` +
    (area !== null ? areaBreakdownHtml(area) : breakdown) +
    `<div class="rt-drawer-section-label">${esc(recLabel)}</div><ul class="rt-drawer-recs">${recs}</ul>` +
    '<div class="rt-drawer-section-label">Instructions diff</div>' +
    (unchanged
      ? '<p class="rt-drawer-note">The merge produced no change to the instructions.</p>'
      : REVIEW_CALLOUT + diffHtml(result.diff));
  if (unchanged) return drawer("Preview: no change", body);
  const footer =
    `<form hx-post="/r/${esc(rid)}/${surface}/apply/confirm" hx-target="#${DRAWER_ID}" hx-swap="innerHTML">` +
    `<input type="hidden" name="confirm_token" value="${esc(confirmToken ?? "")}">${csrfField()}` +
    '<button type="submit" class="rt-apply-btn rt-apply-btn--confirm">Apply to agent</button></form>' +
    `<button class="rt-apply-btn rt-apply-btn--ghost" hx-get="/apply/dismiss" hx-target="#${DRAWER_ID}" hx-swap="innerHTML">Cancel</button>` +
    '<span class="rt-drawer-footnote">Applies the diff above, as a new minor version of the agent.</span>';
  return drawer("Preview changes", body, footer);
}

export function renderAppliedDrawer(
  agentKey: string,
  appliedCount: number,
  newVersion: string | null,
): string {
  const chip = newVersion
    ? `<span class="rt-applied-version">v${esc(newVersion)}</span>`
    : "";
  const check =
    '<svg class="rt-applied-check" viewBox="0 0 72 72" aria-hidden="true"><circle class="rt-applied-check-ring" cx="36" cy="36" r="32" fill="none" stroke-width="4"/><path class="rt-applied-check-mark" fill="none" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" d="M22 37 L32 47 L51 27"/></svg>';
  return drawer(
    "Applied",
    `<div class="rt-drawer-body--applied">${check}<p class="rt-applied-headline">Applied ${appliedCount} recommendation(s)</p>` +
      `<p class="rt-applied-target">to <b>${esc(agentKey)}</b>${chip}</p>` +
      '<p class="rt-drawer-note">The report now records them as applied; reload the page to see the updated state. Review the new version in the Orq UI before routing traffic to it.</p></div>',
  );
}

let recordChain: Promise<unknown> = Promise.resolve();

export function recordAppliedOnReport(
  path: string,
  recommendations: readonly string[],
  field = "applied_recommendations",
): Promise<void> {
  const run = async () => {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const existing = Array.isArray(raw[field])
      ? [...(raw[field] as unknown[])]
      : [];
    const seen = new Set(existing.map((r) => pythonStrip(String(r))));
    for (const rec of recommendations) {
      const key = pythonStrip(rec);
      if (!seen.has(key)) {
        existing.push(rec);
        seen.add(key);
      }
    }
    raw[field] = existing;
    await writePrivateAtomic(path, pythonJsonDumps(raw), {
      privateDirectory: false,
    });
  };
  const next = recordChain.then(run, run);
  recordChain = next.catch(() => undefined);
  return next;
}
