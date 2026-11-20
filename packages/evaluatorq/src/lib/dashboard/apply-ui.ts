import { collectRecommendations } from "../common/apply.js";
import { esc } from "../common/reports/html-helpers.js";
import type { SimulationRun } from "../integrations/simulation/run-store.js";
import type { RedTeamReport } from "../redteam/reports/models.js";
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
