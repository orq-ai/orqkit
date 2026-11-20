import {
  entryOutcome,
  esc,
  pct,
  statusBadge,
} from "../common/reports/html-helpers.js";
import {
  groupThousands,
  pyFixed,
  pyRound,
} from "../common/reports/number-format.js";
import type { SimulationEntryView } from "../common/reports/sim-detail.js";
import type { ReportSection } from "../contracts.js";
import type { ReportResult } from "../integrations/simulation/reports/helpers.js";
import { reportScalar } from "../integrations/simulation/reports/helpers.js";
import { simulationCohortId } from "../integrations/simulation/reports/sections.js";
import type { ReportSections } from "./report-tabs.js";

type Row = Record<string, unknown>;
export interface SimulationDashboardEntry extends SimulationEntryView {
  goal_completion_score: number;
  total_tokens: number;
}
export interface SimulationEntityContext {
  rid: string;
  personas: Row[];
  scenarios: Row[];
  personaStats: Map<string, Row>;
  scenarioStats: Map<string, Row>;
  cohorts: {
    persona: Map<string, SimulationDashboardEntry[]>;
    scenario: Map<string, SimulationDashboardEntry[]>;
  };
  pairs: Map<string, SimulationDashboardEntry[]>;
  personaDomIds: Map<string, string>;
  scenarioDomIds: Map<string, string>;
}
export function simulationSectionRows(
  sections: ReportSections,
  kind: ReportSection["kind"],
  key: string,
): Row[] {
  const value = sections.get(kind)?.data[key];
  return Array.isArray(value) ? (value as Row[]) : [];
}
const pairKey = (persona: string, scenario: string) =>
  JSON.stringify([persona, scenario]);
export function simulationEntityContext(
  sections: ReportSections,
  entries: SimulationDashboardEntry[] = [],
  results: readonly ReportResult[] = [],
  rid = "",
): SimulationEntityContext {
  if (entries.length !== results.length)
    throw new RangeError(
      "Conversation entries and results must have equal lengths",
    );
  const personas = simulationSectionRows(sections, "overview", "personas"),
    scenarios = simulationSectionRows(sections, "overview", "scenarios"),
    personaStats = simulationSectionRows(sections, "persona_breakdown", "rows"),
    scenarioStats = simulationSectionRows(
      sections,
      "scenario_breakdown",
      "rows",
    );
  const cohorts = {
      persona: new Map(
        personas.map((row) => [
          String(row.id),
          [] as SimulationDashboardEntry[],
        ]),
      ),
      scenario: new Map(
        scenarios.map((row) => [
          String(row.id),
          [] as SimulationDashboardEntry[],
        ]),
      ),
    },
    pairs = new Map<string, SimulationDashboardEntry[]>();
  for (const [index, result] of results.entries()) {
    const entry = entries[index];
    if (!entry) throw new RangeError("Missing conversation entry");
    const p = simulationCohortId(result, "persona"),
      s = simulationCohortId(result, "scenario");
    cohorts.persona.get(p)?.push(entry);
    cohorts.scenario.get(s)?.push(entry);
    const key = pairKey(p, s),
      members = pairs.get(key) ?? [];
    members.push(entry);
    pairs.set(key, members);
  }
  return {
    rid,
    personas,
    scenarios,
    personaStats: new Map(personaStats.map((row) => [String(row.id), row])),
    scenarioStats: new Map(scenarioStats.map((row) => [String(row.id), row])),
    cohorts,
    pairs,
    personaDomIds: new Map(
      personas.map((row, index) => [String(row.id), `persona-${index}`]),
    ),
    scenarioDomIds: new Map(
      scenarios.map((row, index) => [String(row.id), `scenario-${index}`]),
    ),
  };
}
export function simulationPairEntries(
  context: SimulationEntityContext,
  personaId: string,
  scenarioId: string,
): SimulationDashboardEntry[] {
  return context.pairs.get(pairKey(personaId, scenarioId)) ?? [];
}
export function setFailureFullRunIndexes(
  section: ReportSection | undefined,
  entries: SimulationDashboardEntry[],
): void {
  if (!section) return;
  const failures = entries.filter(
      (entry) =>
        !entry.goal_achieved && !entry.error && entry.terminated_by !== "error",
    ),
    rows = Array.isArray(section.data.rows) ? (section.data.rows as Row[]) : [];
  if (failures.length !== rows.length)
    throw new RangeError(
      "Failure rows and conversation entries must have equal lengths",
    );
  for (const [index, row] of rows.entries())
    row.index = (failures[index]?.index ?? 0) + 1;
}

const TRAITS = [
  ["patience", "Patience"],
  ["assertiveness", "Assertiveness"],
  ["politeness", "Politeness"],
  ["technical_level", "Technical"],
] as const;
const valueText = (value: unknown) => reportScalar(value);
const fieldText = (row: Row, key: string) =>
  Object.hasOwn(row, key) ? valueText(row[key]) : "";
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown): boolean =>
  typeof value === "number" || typeof value === "boolean";
const traitValue = (raw: unknown): number =>
  Number.isNaN(Number(raw)) ? 1 : Math.max(0, Math.min(1, Number(raw)));
const n = (value: unknown): number => (typeof value === "number" ? value : 0);
export function simulationEntityTriggerAttrs(
  kind: string,
  id: string | null | undefined,
): string {
  return id
    ? `data-sim-entity-trigger data-entity-kind="${esc(kind)}" data-entity-id="${esc(id)}"`
    : 'disabled aria-disabled="true"';
}
export function simulationTraitMinis(traits: Row): string {
  const bars = TRAITS.map(([key, label]) => {
    const raw = traits[key];
    if (!numeric(raw))
      return '<span class="sim-trait-mini sim-trait-mini--empty" aria-hidden="true"></span>';
    const value = traitValue(raw);
    return `<span class="sim-trait-mini" data-tip="${esc(label)} ${pyFixed(value, 2)}" aria-label="${esc(label)} ${pyFixed(value, 2)}"><span class="sim-trait-mini-fill" style="width:${pyFixed(value * 100, 0)}%"></span></span>`;
  });
  return `<span class="sim-trait-minis">${bars.join("")}</span>`;
}
export function simulationPassRateBadge(
  rate: number | null | undefined,
): string {
  if (rate == null) return "";
  const severity = rate >= 0.8 ? "high" : rate >= 0.5 ? "mid" : "low";
  return `<span class="sim-scenario-rate sim-scenario-rate--${severity}"><span class="sim-scenario-rate-dot"></span>${pyRound(rate * 100)}%</span>`;
}
export function simulationConfigCriteriaSplit(criteria: Row[]): string {
  const required = criteria.filter((c) => c.type === "must_happen").length,
    prohibited = criteria.filter((c) => c.type === "must_not_happen").length;
  const parts: string[] = [];
  if (required) parts.push(`${required} must-happen`);
  if (prohibited) parts.push(`${prohibited} must-not`);
  const label =
    required || prohibited
      ? parts.join(" · ")
      : `${criteria.length} ${criteria.length === 1 ? "check" : "checks"}`;
  return `<span class="sim-config-check-count">${label}</span>`;
}
export function simulationConfigPersonaHeader(): string {
  return `<div class="sim-config-persona-head"><span>Persona</span><span>Tone</span>${TRAITS.map(([, label]) => `<span>${esc(label)}</span>`).join("")}</div>`;
}
export function simulationConfigPersonaRow(
  persona: Row,
  entityId?: string | null,
  options: { standalone?: boolean } = {},
): string {
  const traits = persona.traits,
    style = record(traits) ? traits.communication_style : null,
    styleHtml = `<span class="sim-config-persona-style">${style ? esc(valueText(style)) : "-"}</span>`,
    traitsHtml = record(traits) ? simulationTraitMinis(traits) : "",
    attrs = options.standalone
      ? `href="#${esc(entityId || "")}"`
      : simulationEntityTriggerAttrs("persona", entityId),
    element = options.standalone ? "a" : "button",
    type = options.standalone ? "" : 'type="button"';
  return `<${element} ${type} class="sim-config-persona-row sim-entity-row" ${attrs}><span class="sim-config-persona-name">${esc(fieldText(persona, "name"))}</span>${styleHtml}${traitsHtml}</${element}>`;
}
export function simulationConfigScenarioHeader(): string {
  return '<div class="sim-config-scenario-head"><span>Scenario</span><span>Criteria</span><span>Pass rate</span></div>';
}
export function simulationConfigScenarioRow(
  scenario: Row,
  entityId?: string | null,
  options: { standalone?: boolean } = {},
): string {
  const goal = scenario.goal,
    goalHtml = goal
      ? `<div class="sim-config-scenario-goal">${esc(valueText(goal))}</div>`
      : "",
    criteria = (scenario.criteria || []) as Row[],
    attrs = options.standalone
      ? `href="#${esc(entityId || "")}"`
      : simulationEntityTriggerAttrs("scenario", entityId),
    element = options.standalone ? "a" : "button",
    type = options.standalone ? "" : 'type="button"';
  return `<${element} ${type} class="sim-config-scenario-row sim-entity-row" ${attrs}><div class="sim-config-scenario-main"><span class="sim-config-scenario-name">${esc(fieldText(scenario, "name"))}</span>${goalHtml}</div><span class="sim-config-scenario-checks">${simulationConfigCriteriaSplit(criteria)}</span><span class="sim-config-scenario-rate-cell">${simulationPassRateBadge(scenario.pass_rate as number | null)}</span></${element}>`;
}
export function simulationTraitDetail(label: string, raw: unknown): string {
  const value = traitValue(raw);
  return `<div class="sim-entity-trait-row"><span>${esc(label)}</span><span class="sim-entity-trait-track"><span class="sim-entity-trait-fill" style="width:${pyFixed(value * 100, 0)}%"></span></span><span class="sim-entity-trait-value">${pyFixed(value, 2)}</span></div>`;
}
export function simulationCriterionDetail(criterion: Row): string {
  const type = criterion.type,
    negative = type === "must_not_happen",
    mark = negative ? "&#x2717;" : "&#x2713;",
    cls = negative
      ? "sim-entity-criterion--negative"
      : "sim-entity-criterion--positive",
    typeHtml = type
      ? `<span class="sim-entity-criterion-type">${esc(valueText(type).replaceAll("_", " "))}</span>`
      : "";
  return `<li class="sim-entity-criterion ${cls}"><span class="sim-entity-criterion-mark">${mark}</span><span>${esc(fieldText(criterion, "description"))}</span>${typeHtml}</li>`;
}
export function simulationCohortStats(stats: Row | null | undefined): string {
  if (!stats || !Object.keys(stats).length) return "";
  const conversations = n(stats.conversations),
    completed =
      stats.completed_conversations == null
        ? conversations
        : n(stats.completed_conversations),
    errors =
      stats.errored_conversations == null
        ? Math.max(conversations - completed, 0)
        : n(stats.errored_conversations),
    tokens = stats.total_tokens;
  const tokenText =
      numeric(tokens) && tokens
        ? groupThousands(String(Math.trunc(Number(tokens))))
        : "-",
    goal = completed === 0 ? "n/a" : pct(stats.success_rate as number | null),
    score =
      completed === 0 || stats.avg_goal_completion_score == null
        ? "n/a"
        : pyFixed(n(stats.avg_goal_completion_score), 2);
  return `<div class="sim-cohort-stats"><span><b>Goal rate</b>${esc(goal)} · ${completed}/${conversations} completed</span><span><b>Avg score</b>${score}</span><span><b>Errors</b>${errors}</span><span><b>Tokens</b>${tokenText}</span></div>`;
}
export function simulationCohortList(
  entries: SimulationDashboardEntry[],
  rid: string,
): string {
  if (!entries.length)
    return '<p class="sim-cohort-empty">No conversations.</p>';
  const items = entries.map((entry) => {
    const state = entryOutcome(entry),
      outcome = statusBadge(state.label, state.status);
    if (!rid)
      return `<a class="sim-cohort-conversation" href="#conv-${entry.index + 1}">#${entry.index + 1} · ${esc(entry.persona)} · ${esc(entry.scenario)} ${outcome}</a>`;
    return `<button type="button" class="sim-cohort-conversation" data-sim-entity-trigger data-entity-kind="conversation" data-drawer-url="/r/${esc(rid)}/sim/transcript?idx=${entry.index}"><span>#${entry.index + 1}</span><span>${esc(entry.persona)}</span><span>${esc(entry.scenario)}</span><span>${pyFixed(entry.goal_completion_score, 2)}</span>${outcome}</button>`;
  });
  return `<section class="sim-cohort-conversations"><h3>Conversations</h3><div class="sim-cohort-list">${items.join("")}</div></section>`;
}
export function simulationPersonaTemplate(
  persona: Row,
  id: string,
  index: number,
  total: number,
  stats?: Row | null,
  conversations: SimulationDashboardEntry[] = [],
  rid = "",
  options: { standalone?: boolean } = {},
): string {
  const traits = record(persona.traits) ? persona.traits : {},
    style = traits.communication_style,
    background = persona.background || traits.background,
    count = persona.conversations;
  const traitRows = TRAITS.filter(([key]) => numeric(traits[key]))
    .map(([key, label]) => simulationTraitDetail(label, traits[key]))
    .join("");
  const meta =
    (style
      ? `<span class="sim-entity-pill">${esc(valueText(style))}</span>`
      : "") +
    (count
      ? `<span class="sim-entity-pill">${esc(valueText(count))} conversations</span>`
      : "");
  const backgroundHtml = background
    ? `<p class="sim-entity-prose">${esc(valueText(background))}</p>`
    : "";
  const body = `<div class="sim-entity-detail"><div class="sim-entity-kicker">Persona ${index + 1} / ${total}</div><h2>${esc(fieldText(persona, "name"))}</h2><div class="sim-entity-pills">${meta}</div><div class="sim-entity-traits">${traitRows}</div>${backgroundHtml}${simulationCohortStats(stats)}${simulationCohortList(conversations, rid)}</div>`;
  return options.standalone
    ? `<article class="rk-panel export-entity" id="${esc(id)}">${body}</article>`
    : `<template id="${esc(id)}" data-sim-entity-template data-entity-kind="persona" data-entity-id="${esc(id)}" data-entity-index="${index}">${body}</template>`;
}
export function simulationScenarioTemplate(
  scenario: Row,
  id: string,
  index: number,
  total: number,
  stats?: Row | null,
  conversations: SimulationDashboardEntry[] = [],
  rid = "",
  options: { standalone?: boolean } = {},
): string {
  const goal = scenario.goal,
    context = scenario.context,
    criteria = (scenario.criteria || []) as Row[],
    criteriaHtml = criteria.map(simulationCriterionDetail).join("");
  const goalHtml = goal
      ? `<section><h3>Goal</h3><p class="sim-entity-prose">${esc(valueText(goal))}</p></section>`
      : "",
    contextHtml = context
      ? `<section><h3>Context</h3><p class="sim-entity-prose">${esc(valueText(context))}</p></section>`
      : "",
    criteriaSection = criteriaHtml
      ? `<section><h3>Criteria</h3><ul class="sim-entity-criteria">${criteriaHtml}</ul></section>`
      : "";
  const body = `<div class="sim-entity-detail"><div class="sim-entity-kicker">Scenario ${index + 1} / ${total}</div><h2>${esc(fieldText(scenario, "name"))}</h2><div class="sim-entity-pills"><span class="sim-entity-pill">${criteria.length} ${criteria.length === 1 ? "check" : "checks"}</span></div>${goalHtml}${contextHtml}${criteriaSection}${simulationCohortStats(stats)}${simulationCohortList(conversations, rid)}</div>`;
  return options.standalone
    ? `<article class="rk-panel export-entity" id="${esc(id)}">${body}</article>`
    : `<template id="${esc(id)}" data-sim-entity-template data-entity-kind="scenario" data-entity-id="${esc(id)}" data-entity-index="${index}">${body}</template>`;
}
export function simulationEntityModal(
  context: SimulationEntityContext,
  options: { standalone?: boolean } = {},
): string {
  if (!context.personas.length && !context.scenarios.length) return "";
  const templates: string[] = [];
  for (const [index, p] of context.personas.entries()) {
    const id = String(p.id);
    templates.push(
      simulationPersonaTemplate(
        p,
        context.personaDomIds.get(id) ?? "",
        index,
        context.personas.length,
        context.personaStats.get(id),
        context.cohorts.persona.get(id),
        options.standalone ? "" : context.rid,
        options,
      ),
    );
  }
  for (const [index, s] of context.scenarios.entries()) {
    const id = String(s.id);
    templates.push(
      simulationScenarioTemplate(
        s,
        context.scenarioDomIds.get(id) ?? "",
        index,
        context.scenarios.length,
        context.scenarioStats.get(id),
        context.cohorts.scenario.get(id),
        options.standalone ? "" : context.rid,
        options,
      ),
    );
  }
  if (options.standalone) return templates.join("");
  return (
    '<dialog class="sim-entity-dialog" aria-label="Simulation entity detail"><div class="sim-entity-modal-shell"><div class="sim-entity-modal-content" data-sim-entity-content></div><div class="sim-entity-modal-actions"><button type="button" class="sim-entity-back" data-sim-entity-back hidden aria-label="Back to cohort">&larr; Back</button><button type="button" class="sim-entity-nav" data-sim-entity-prev aria-label="Previous entity (k)" title="Previous entity (k)">&larr;<kbd class="sim-entity-kbd">k</kbd></button><span class="sim-entity-position" data-sim-entity-position hidden aria-live="polite"></span><button type="button" class="sim-entity-nav" data-sim-entity-next aria-label="Next entity (j)" title="Next entity (j)">&rarr;<kbd class="sim-entity-kbd">j</kbd></button><button type="button" class="sim-entity-close" data-sim-entity-close>Close</button></div></div></dialog>' +
    `<div class="sim-entity-templates" hidden>${templates.join("")}</div>`
  );
}
