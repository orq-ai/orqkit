import { coerceContentText } from "../messages.js";
import { entryOutcome, esc, statusBadge } from "./html-helpers.js";
import { renderMessageList } from "./messages.js";

export interface SimulationEntryView {
  index: number;
  persona: string;
  scenario: string;
  turn_count: number;
  goal_achieved: boolean;
  terminated_by: string;
  criteria: readonly {
    state: "pass" | "fail" | "unknown";
    type?: string | null;
    description: string;
    evidence?: string | null;
  }[];
  criteria_verified: boolean | null;
  judge_reason: string;
  error: string | null;
  transcript: readonly { role: string; content: unknown }[];
  goal?: string | null;
}
const ROLE_LABELS = {
  user: "USR",
  assistant: "AGT",
  system: "SYS",
  developer: "SYS",
  tool: "TOOL",
};
const PERSONA_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>';
const SCENARIO_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h10"/></svg>';
function criteriaColumn(entry: SimulationEntryView): string {
  const criteria = entry.criteria ?? [],
    items = criteria.map((criterion) => {
      const icon =
          criterion.state === "pass"
            ? "&#x2713;"
            : criterion.state === "fail"
              ? "&#x2717;"
              : "?",
        prohibited = criterion.type === "must_not_happen";
      const chip = criterion.type
          ? `<span class="${prohibited ? "sim-ctype sim-ctype-unsafe" : "sim-ctype"}">${prohibited ? "Prohibited" : "Required"}</span>`
          : "",
        evidence = criterion.evidence
          ? `<span class="sim-criterion-evidence">&ldquo;${esc(criterion.evidence)}&rdquo;</span>`
          : "",
        unaudited =
          criterion.state === "unknown"
            ? '<span class="sim-criterion-unaudited">not audited</span>'
            : "";
      return `<li class="sim-criterion sim-criterion-${criterion.state}"><span class="sim-criterion-icon">${icon}</span>${chip}<span class="sim-criterion-desc">${esc(criterion.description)}</span>${unaudited}${evidence}</li>`;
    });
  const outcome = entryOutcome(entry),
    verdict = statusBadge(outcome.label, outcome.status),
    goalText = entry.goal
      ? `<p class="sim-goal-text">${esc(entry.goal)}</p>`
      : '<p class="sim-goal-text sim-goal-text--missing">The goal text was not saved with this run.</p>',
    goal = `<div class="sim-goal"><div class="sim-goal-head"><span class="sim-goal-label">GOAL</span>${verdict}</div>${goalText}</div>`;
  let count = "";
  if (criteria.length) {
    const met = criteria.filter((row) => row.state === "pass").length,
      unknown = criteria.filter((row) => row.state === "unknown").length;
    count = `<span class="sim-criteria-count">${met}/${criteria.length} criteria met</span>${unknown ? `<span class="sim-criteria-unknown">${unknown} not audited</span>` : ""}`;
  }
  const unverified =
      entry.criteria_verified === false
        ? '<p class="sim-criteria-unverified">Criteria unverified - the judge did not audit every criterion and <code>criteria_met</code> scored this run 0.0.</p>'
        : "",
    list = items.length
      ? `<ul class="sim-criteria-list">${items.join("")}</ul>`
      : '<p class="sim-criteria-empty">No criteria defined for this scenario.</p>',
    judge = entry.judge_reason
      ? `<div class="sim-judge"><span class="sim-judge-label">Judge</span><p class="sim-judge-reason">${esc(entry.judge_reason)}</p></div>`
      : "";
  return `<div class="sim-criteria">${goal}<div class="sim-criteria-head"><span class="sim-criteria-header">CRITERIA</span>${count}</div>${unverified}${list}${judge}</div>`;
}
function conversationValue(
  value: string,
  kind: string,
  id?: string | null,
): string {
  return id
    ? `<button type="button" class="sim-conv-value sim-conv-value--link" data-sim-entity-trigger data-entity-kind="${esc(kind)}" data-entity-id="${esc(id)}">${esc(value)}</button>`
    : `<span class="sim-conv-value">${esc(value)}</span>`;
}
export function renderTranscriptFragment(
  entry: SimulationEntryView,
  options: {
    personaEntityId?: string | null;
    scenarioEntityId?: string | null;
  } = {},
): string {
  const turns = entry.turn_count,
    persona = conversationValue(
      entry.persona,
      "persona",
      options.personaEntityId,
    ),
    scenario = conversationValue(
      entry.scenario,
      "scenario",
      options.scenarioEntityId,
    );
  const field = (icon: string, label: string, value: string) =>
    `<div class="sim-conv-field"><span class="sim-conv-ico">${icon}</span><div class="sim-conv-field-text"><span class="sim-conv-label">${label}</span>${value}</div></div>`;
  const summary = `<div class="sim-conv-summary"><div class="sim-conv-head"><span class="sim-conv-index">#${entry.index}</span><span class="sim-conv-turns-pill">${turns} ${turns === 1 ? "turn" : "turns"}</span></div><div class="sim-conv-meta">${field(PERSONA_ICON, "Persona", persona)}${field(SCENARIO_ICON, "Scenario", scenario)}</div></div>`;
  const error = entry.error
      ? `<div class="sim-transcript-error"><strong>Error:</strong> ${esc(entry.error)}</div>`
      : "",
    messages = (entry.transcript ?? []).map((message) => ({
      role: message.role,
      content: coerceContentText(message.content) || "(empty)",
    })),
    bubbles = `<div class="sim-transcript-bubbles">${renderMessageList(messages, { roleLabels: ROLE_LABELS, classPrefix: "sim" })}</div>`;
  return `<div class="sim-transcript-detail">${summary}<div class="sim-transcript-grid">${criteriaColumn(entry)}${error}${bubbles}</div></div>`;
}
