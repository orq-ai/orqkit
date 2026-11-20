import { simulationBrief } from "../common/reports/brief.js";
import {
  entryOutcome,
  esc,
  htmlTable,
  kpiCards,
  pct,
  statusBadge,
} from "../common/reports/html-helpers.js";
import { TARGET_ICONS } from "../common/reports/icons.js";
import {
  groupThousands,
  pyFixed,
  pyRound,
} from "../common/reports/number-format.js";
import { renderTranscriptFragment } from "../common/reports/sim-detail.js";
import { pythonSplit, pythonStrip } from "../common/sanitize.js";
import type { ReportSection } from "../contracts.js";
import { fetchAgentInfo } from "../integrations/simulation/agent-snapshot.js";
import {
  isErroredResult,
  TURN_METRICS,
} from "../integrations/simulation/metrics.js";
import type { ReportResult } from "../integrations/simulation/reports/helpers.js";
import {
  capTableText,
  criteriaDots,
  SIMULATION_TAB_RENDERERS,
} from "../integrations/simulation/reports/html-sections.js";
import { buildSimulationReportSections } from "../integrations/simulation/reports/sections.js";
import type {
  AgentInfoSnapshot,
  SimulationRun,
} from "../integrations/simulation/run-store.js";
import {
  isSimApplyEnabled,
  renderSimApplyPanel,
  renderSimRecApplyButton,
} from "./apply-ui.js";
import { orqStudioUrl } from "./orq-links.js";
import {
  barRows,
  callout,
  donut,
  execSummary,
  heatmap,
  histogram,
  interpColor,
  lineChart,
  metaGrid,
  panel,
} from "./report-kit.js";
import type { ReportSections } from "./report-tabs.js";
import {
  renderSections,
  reportTabs,
  stableSimulationEntries,
} from "./report-tabs.js";
import { simulationInteractivePanels } from "./sim-views.js";
import {
  type SimulationDashboardEntry,
  type SimulationEntityContext,
  setFailureFullRunIndexes,
  simulationConfigPersonaHeader,
  simulationConfigPersonaRow,
  simulationConfigScenarioHeader,
  simulationConfigScenarioRow,
  simulationEntityContext,
  simulationEntityModal,
  simulationEntityTriggerAttrs,
  simulationPairEntries,
} from "./simulation-entities.js";
import { runTraceUrl, traceLinkButton } from "./trace-links.js";

export function simulationRecommendations(
  rid: string,
  run: SimulationRun,
  options: { standalone?: boolean } = {},
): string {
  if (!run.recommendations?.length) return "";
  const enabled = !options.standalone && isSimApplyEnabled(run),
    bar = options.standalone ? "" : renderSimApplyPanel(rid, run),
    applied = new Set(run.appliedSuggestions.map(pythonStrip));
  const intro =
    '<p class="rt-focus-intro">Remediation suggestions generated from the simulated conversations, grouped by the persona and scenario that surfaced them.</p>';
  const cards = run.recommendations
    .map((rec) => {
      const items = rec.suggestions
        .map((s) => {
          const done = applied.has(pythonStrip(s)),
            tail = done
              ? '<span class="rt-focus-rec-applied">✓ applied</span>'
              : enabled
                ? renderSimRecApplyButton(rid, rec.resultIndex, s)
                : "";
          return `<li class="rt-focus-rec${done ? " rt-focus-rec--applied" : ""}"><span class="rt-focus-rec-text">${esc(s)}</span>${tail}</li>`;
        })
        .join("");
      const triggers = rec.triggers.length
        ? `<div class="rt-focus-patterns"><span class="rt-focus-pattern-dot" style="background:var(--accent)"></span><span>${esc(rec.triggers.join("; "))}</span></div>`
        : "";
      const head = `<div class="rt-focus-head"><div class="rt-focus-head-main"><div class="rt-focus-category-name">${esc(rec.persona)}</div><div class="rt-focus-tier-row"><span class="rt-focus-tier-label">${esc(rec.scenario)}</span></div></div></div>`;
      return `<div class="rk-panel rt-focus-card">${head}<div class="rt-focus-body">${triggers}<div class="rt-focus-recs-section"><div class="rt-focus-fixbox-label rt-focus-recs-label">Suggestions</div><ul class="rt-focus-recs">${items}</ul></div></div></div>`;
    })
    .join("");
  return `${bar}${intro}${cards}`;
}

export function simulationConfig(
  sections: ReportSections,
  run: SimulationRun,
  context: SimulationEntityContext = simulationEntityContext(sections),
  options: { standalone?: boolean } = {},
): string {
  const { personas, scenarios } = context,
    match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(run.createdAt),
    months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
  const generated = match
    ? `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]} · ${match[4]}:${match[5]} UTC`
    : run.createdAt.slice(0, 16);
  const scope: [string, string][] = [];
  if (personas.length) scope.push([String(personas.length), "Personas"]);
  if (scenarios.length) scope.push([String(scenarios.length), "Scenarios"]);
  scope.push([String(run.totalResults), "Conversations"]);
  const stat = `<div class="rk-stat-row">${scope.map(([num, caption]) => `<div class="rk-stat"><span class="rk-stat-num">${esc(num)}</span><span class="rk-stat-cap">${esc(caption)}</span></div>`).join("")}</div>`;
  const target = metaGrid([
      ["Target", run.target],
      ["Run name", run.runName],
      ["Model", run.targetModel],
      ["Target kind", run.targetKind],
      ["Mode", run.mode],
      ["Max turns", run.maxTurns !== null ? String(run.maxTurns) : null],
    ]),
    runGrid = metaGrid([
      [
        "Evaluators",
        run.evaluatorNames.length ? run.evaluatorNames.join(", ") : null,
      ],
      ["Generated", generated],
    ]);
  const groups = `<div class="rk-meta-group"><div class="rk-meta-group-title">Target</div>${target}</div><div class="rk-meta-group"><div class="rk-meta-group-title">Run</div>${runGrid}</div>`,
    config = panel("Run configuration", stat + groups, {
      sub: "Job-level metadata",
    });
  const personaHtml = personas.length
    ? panel(
        "Personas",
        simulationConfigPersonaHeader() +
          personas
            .map((p) =>
              simulationConfigPersonaRow(
                p,
                context.personaDomIds.get(String(p.id)),
                options,
              ),
            )
            .join(""),
        { sub: "Simulated user profiles" },
      )
    : "";
  const scenarioHtml = scenarios.length
    ? panel(
        "Scenarios",
        simulationConfigScenarioHeader() +
          scenarios
            .map((s) =>
              simulationConfigScenarioRow(
                s,
                context.scenarioDomIds.get(String(s.id)),
                options,
              ),
            )
            .join(""),
        { sub: "Goals + pass/fail criteria" },
      )
    : "";
  return (
    config +
    personaHtml +
    scenarioHtml +
    (options.standalone
      ? simulationEntityModal(context, { standalone: true })
      : "")
  );
}

export function simulationTurnDeltaCallout(
  series: Readonly<Record<string, readonly (number | null)[]>>,
): string {
  const clauses: string[] = [];
  for (const metric of TURN_METRICS) {
    const points = (series[metric.key] ?? []).filter(
      (v): v is number => v !== null,
    );
    if (points.length < 2) continue;
    const first = points[0] as number,
      last = points.at(-1) as number,
      delta = last - first,
      label = esc(metric.label);
    if (Math.abs(delta) < 0.005) {
      clauses.push(
        `${label} held steady around <strong>${pyFixed(last, 2)}</strong>`,
      );
      continue;
    }
    const verb = metric.highIsRisky
      ? delta > 0
        ? "rose"
        : "fell"
      : delta > 0
        ? "improved"
        : "declined";
    clauses.push(
      `${label} ${verb} by <strong>${pyFixed(Math.abs(delta), 2)}</strong> from turn 1 to the last turn`,
    );
  }
  if (!clauses.length) return "";
  const body = `${clauses.join("; ")}.`,
    sentence = (body[0]?.toUpperCase() ?? "") + body.slice(1);
  return `<div class="exec-summary"><div class="es-head"><span class="es-label">Turn quality trend</span></div><p class="es-body">${sentence}</p></div>`;
}
export function simulationTurnCountBar(
  distribution: Readonly<Record<string, number>>,
): string {
  if (!Object.keys(distribution).length) return "";
  return barRows(
    Object.entries(distribution)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([turns, count]) => [`${turns} turns`, count]),
    {
      width: 420,
      labelWidth: 70,
      color: "var(--chart-2)",
      format: (value) => String(Math.trunc(value)),
    },
  );
}
export function simulationAvgQualityTiles(
  metrics: Readonly<Record<string, number>>,
): string {
  if (!Object.keys(metrics).length) return "";
  const cells: string[] = [];
  for (const metric of TURN_METRICS) {
    const value = metrics[metric.key];
    if (value == null) continue;
    const score = metric.highIsRisky ? 1 - value : value,
      color = interpColor(score);
    cells.push(
      `<div class="sim-aq-cell"><div class="sim-aq-label">${esc(metric.label)}</div><div class="sim-aq-value" style="--aq-accent:${color}">${pyFixed(value, 2)}</div></div>`,
    );
  }
  return `<div class="sim-aq-grid">${cells.join("")}</div>`;
}
export function simulationTurnQuality(sections: ReportSections): string {
  const timeline = sections.get("turn_quality_timeline")?.data ?? {},
    metrics = sections.get("turn_metrics")?.data ?? {},
    series = (timeline.series ?? {}) as Record<string, (number | null)[]>,
    quality = (metrics.avg_quality_metrics ?? {}) as Record<string, number>,
    distribution = (metrics.turn_count_distribution ?? {}) as Record<
      string,
      number
    >;
  if (!Object.keys(series).length && !Object.keys(quality).length) return "";
  if (
    Object.keys(distribution).length &&
    Math.max(...Object.keys(distribution).map(Number)) <= 1
  )
    return "";
  let chartHtml = "";
  const turns = (timeline.turns ?? []) as number[];
  if (turns.length >= 2) {
    const pretty = Object.fromEntries(
        TURN_METRICS.filter((metric) => Object.hasOwn(series, metric.key)).map(
          (metric) => [
            (metric.label[0]?.toUpperCase() ?? "") +
              metric.label.slice(1).toLowerCase(),
            series[metric.key] as (number | null)[],
          ],
        ),
      ),
      chart = lineChart(
        turns.map((t) => `Turn ${t}`),
        pretty,
      );
    if (chart)
      chartHtml = panel("Per-turn quality", chart, {
        sub: "Average across conversations, by turn index (0-1)",
      });
  }
  const bar = simulationTurnCountBar(distribution),
    dist = bar ? panel("Turn-count distribution", bar) : "",
    tiles = simulationAvgQualityTiles(quality),
    avg = tiles ? panel("Average quality metrics", tiles) : "",
    grid =
      dist || avg
        ? `<div class="sim-breakdown-grid-2">${dist}${avg}</div>`
        : "";
  return simulationTurnDeltaCallout(series) + chartHtml + grid;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const rowList = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
export function simulationTinted(text: string, value: number | null): string {
  return value === null
    ? `<span class="sim-td-tint sim-td-tint--unknown">${esc(text)}</span>`
    : `<span class="sim-td-tint" style="color:${interpColor(Math.max(0, Math.min(1, value)))}">${esc(text)}</span>`;
}
export function simulationFailuresTable(
  section: ReportSection | undefined,
  rid: string,
  options: { standalone?: boolean; erroredCount?: number } = {},
): string {
  const values = rowList(section?.data.rows),
    errors = options.erroredCount ?? 0;
  if (!values.length) {
    const note = errors
      ? ` ${errors} execution error${errors !== 1 ? "s" : ""} occurred; see transcript evidence.`
      : "";
    return `<section class="report-card"><h2>Failures</h2><p>No completed conversations failed their goal.${note}</p></section>`;
  }
  const tableRows = values.map((r) => [
    esc(String(r.scenario)),
    esc(String(r.persona)),
    `<span data-no-drawer title="${esc(String(r.reason ?? ""))}">${esc(capTableText(String(r.reason ?? "")))}</span>`,
    `<span data-no-drawer>${criteriaDots(rowList(r.criteria))}</span>`,
    pyFixed(num(r.score), 2),
  ]);
  let attrs: string[] | null = values.map(
    (r) =>
      `class="sim-drawer-row sim-failure-row" role="button" tabindex="0" data-sim-entity-trigger data-entity-kind="conversation" data-drawer-url="/r/${esc(rid)}/sim/transcript?idx=${num(r.index) - 1}"`,
  );
  if (options.standalone) {
    attrs = null;
    for (const [index, row] of tableRows.entries()) {
      const source = values[index] as Row;
      row[0] = `<a href="#conv-${source.index}">${row[0]}</a>`;
      row[2] = esc(String(source.reason ?? ""));
    }
  }
  const note = errors
    ? `<p>${errors} execution error${errors !== 1 ? "s" : ""} occurred; see transcript evidence.</p>`
    : "";
  return `<section class="report-card"><h2>Failures</h2>${htmlTable(["Scenario", "Persona", "Why", "Criteria", "Score"], tableRows, { rowAttrs: attrs, colClasses: ["", "", "fail-why", "num", "num"] })}${note}</section>`;
}
export function simulationBreakdownTable(
  section: ReportSection | undefined,
  title: string,
  key: string,
  headers: string[],
  columns: (row: Row) => string[],
  kind: string,
  entityIds: ReadonlyMap<string, string>,
  options: { standalone?: boolean } = {},
): string {
  const values = rowList(section?.data.rows);
  if (!values.length) return "";
  const tableRows = values.map((r) => [esc(String(r[key])), ...columns(r)]);
  let attrs: string[] | null = values.map(
    (r) =>
      `class="sim-drawer-row" role="button" tabindex="0" ${simulationEntityTriggerAttrs(kind, entityIds.get(String(r.id ?? "")))}`,
  );
  if (options.standalone) {
    attrs = null;
    for (const [index, cells] of tableRows.entries()) {
      const anchor = entityIds.get(String(values[index]?.id ?? ""));
      if (anchor) cells[0] = `<a href="#${esc(anchor)}">${cells[0]}</a>`;
    }
  }
  const table = htmlTable(headers, tableRows, {
      rowAttrs: attrs,
      colClasses: ["", ...headers.slice(1).map(() => "num")],
    }),
    note = values.some((r) => num(r.errored_conversations))
      ? "Rates and averages use all cohort conversations, including errors. n/a means no conversation completed."
      : "";
  return panel(title, `<div class="sim-bd-table">${table}</div>`, {
    sub: note,
  });
}
export function simulationHeatCellTrigger(
  rid: string,
  context: SimulationEntityContext,
): (cell: Row, text: string) => string {
  return (cell, text) => {
    const entries = [
      ...simulationPairEntries(
        context,
        String(cell.persona_id),
        String(cell.scenario_id),
      ),
    ].sort(
      (a, b) =>
        a.goal_completion_score - b.goal_completion_score || a.index - b.index,
    );
    if (!entries.length) return text;
    const label = `Open ${entries.length} conversation${entries.length !== 1 ? "s" : ""}: ${cell.persona} × ${cell.scenario}`;
    return entries
      .map(
        (entry, index) =>
          `<button type="button" class="rk-heat-trigger" data-sim-entity-trigger data-entity-kind="conversation" data-drawer-url="/r/${esc(rid)}/sim/transcript?idx=${entry.index}"${index === 0 ? ` aria-label="${esc(label)}">${text}` : ' hidden tabindex="-1">'}</button>`,
      )
      .join("");
  };
}
export function simulationFailureModes(
  values: readonly (readonly [string, number])[],
  options: { standalone?: boolean } = {},
): string {
  if (!values.length) return "";
  const max = Math.max(...values.map(([, count]) => count)),
    minimum = options.standalone ? 1 : max >= 2 ? 2 : 1;
  const bars = values
    .map(
      ([label, count]) =>
        `<div class="sim-fm-row" data-count="${count}"${count < minimum ? " hidden" : ""}><span class="sim-fm-label" title="${esc(label)}">${esc(label)}</span><span class="sim-fm-track"><span class="sim-fm-fill" style="width:${pyFixed(max ? (count / max) * 100 : 0, 1)}%"></span></span><span class="sim-fm-count">${count}</span></div>`,
    )
    .join("");
  const slider = options.standalone
    ? ""
    : `<span class="sim-fm-filter"><label for="sim-fm-slider">min count</label><input id="sim-fm-slider" type="range" class="sim-fm-slider" data-fm-slider min="1" max="${max}" value="${minimum}" aria-label="Minimum failure count"><output class="sim-fm-out" data-fm-out>${minimum}</output></span>`;
  return `<div class="rk-panel sim-fm" data-fm-panel><div class="rk-panel-title sim-fm-head"><span>Top failure modes</span>${slider}</div><div class="rk-panel-body"><p class="sim-fm-note">Confirmed criterion failures, including violations observed before an execution error.</p><div class="sim-fm-bars">${bars}</div><p class="sim-fm-empty" data-fm-empty hidden>No failure modes at or above this count.</p></div></div>`;
}
export function simulationBreakdown(
  sections: ReportSections,
  rid: string,
  context: SimulationEntityContext = simulationEntityContext(sections),
  options: { standalone?: boolean } = {},
): string {
  let heat = "",
    distribution = "";
  const h = sections.get("persona_scenario_heatmap");
  if (h) {
    const d = h.data;
    heat = panel(
      "Goal completion - persona × scenario",
      heatmap(
        (d.personas ?? []) as string[],
        (d.scenarios ?? []) as string[],
        rowList(d.cells),
        {
          valueKey: "avg_score",
          renderValue: options.standalone
            ? undefined
            : simulationHeatCellTrigger(rid, context),
        },
      ),
      {
        sub: "Red → yellow → green as the average goal-completion score rises. Click a cell to read its conversations.",
        info: `Each cell is the average goal-completion score (0-100%) the judge gave the agent across that persona × scenario's conversations - a continuous measure of how fully the goal was met, not a count of goals achieved. 100% = the goal was fully accomplished in every conversation; a single half-met conversation reads ~50%. The binary pass/fail rate is shown separately as "Goal rate" in the tables below.`,
      },
    );
  }
  const dist = sections.get("score_distribution");
  if (dist) {
    const scores = (dist.data.measured_scores ??
        dist.data.scores ??
        []) as number[],
      completed =
        dist.data.completed_conversations == null
          ? scores.length
          : num(dist.data.completed_conversations),
      errors = num(dist.data.errored_conversations);
    if (scores.length)
      distribution = panel(
        "Goal-completion score distribution",
        histogram(scores),
        {
          sub: `${completed} completed · ${errors} errors · dashed line = mean`,
        },
      );
    else if (errors)
      distribution = panel(
        "Goal-completion score distribution",
        '<p class="sim-td-tint sim-td-tint--unknown">No completed conversations to score.</p>',
        { sub: `0 completed · ${errors} errors` },
      );
  }
  const common = (r: Row): string[] => {
    const empty = (r.completed_conversations ?? r.conversations) === 0;
    return [
      String(r.conversations),
      String(r.errored_conversations ?? 0),
      simulationTinted(
        empty ? "n/a" : pct(num(r.success_rate)),
        empty ? null : num(r.success_rate),
      ),
      simulationTinted(
        empty ? "n/a" : pyFixed(num(r.avg_goal_completion_score), 2),
        empty ? null : num(r.avg_goal_completion_score),
      ),
    ];
  };
  const tokens = (r: Row) =>
    r.total_tokens ? groupThousands(String(r.total_tokens)) : "-";
  const personas = simulationBreakdownTable(
    sections.get("persona_breakdown"),
    "Per-persona",
    "persona",
    ["Persona", "Conv", "Errors", "Goal rate", "Avg score", "Tokens"],
    (r) => [...common(r), tokens(r)],
    "persona",
    context.personaDomIds,
    options,
  );
  const scenarios = simulationBreakdownTable(
    sections.get("scenario_breakdown"),
    "Per-scenario",
    "scenario",
    [
      "Scenario",
      "Conv",
      "Errors",
      "Goal rate",
      "Avg score",
      "Avg turns",
      "Tokens",
    ],
    (r) => [...common(r), pyFixed(num(r.avg_turn_count), 1), tokens(r)],
    "scenario",
    context.scenarioDomIds,
    options,
  );
  const failure = sections.get("failure_mode"),
    failureHtml = failure
      ? simulationFailureModes(
          (failure.data.rows ?? []) as [string, number][],
          options,
        )
      : "",
    errors = num(sections.get("errors")?.data.total_errored),
    failures = `<div id="section-failures_first">${simulationFailuresTable(sections.get("failures_first"), rid, { ...options, erroredCount: errors })}</div>`;
  return heat + failures + failureHtml + distribution + personas + scenarios;
}

export const SIMULATION_NO_MATCH_NOTE =
  '<p class="sim-empty-note">No conversations match the current filter.</p>';
type AgentDisplay = Partial<AgentInfoSnapshot>;
export function simulationAgentKeyFor(run: SimulationRun): string | null {
  if (run.agentInfo?.key) return run.agentInfo.key;
  if (run.target)
    return run.target.startsWith("agent:") ? run.target.slice(6) : run.target;
  return run.runName.startsWith("sim:")
    ? pythonStrip(run.runName.slice(4).split(":")[0] ?? "") || null
    : null;
}
export function simulationStoredAgentInfo(
  run: SimulationRun,
): AgentDisplay | null {
  const key = simulationAgentKeyFor(run);
  return key
    ? { key, ...(run.targetModel ? { model: run.targetModel } : {}) }
    : null;
}
export function agentDescriptionPreview(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const first = pythonStrip(description.split("\n\n", 1)[0] ?? "");
  if (!first) return null;
  const compact = pythonSplit(first).join(" "),
    chars = Array.from(compact);
  return chars.length <= 280
    ? compact
    : `${pythonStrip(chars.slice(0, 280).join(""))}...`;
}
export async function simulationAgentCard(
  info: AgentDisplay | null,
  options: {
    bare?: boolean;
    footerHtml?: string;
    experimentUrl?: string | null;
  } = {},
): Promise<string> {
  if (!info || !Object.keys(info).length) return "";
  const key = info.key || "",
    description = agentDescriptionPreview(info.description),
    url = await orqStudioUrl({
      targetKind: "agent",
      entityId: info.id ?? null,
      experimentUrl: options.experimentUrl,
      workspaceId: info.workspaceKey ?? null,
      baseUrl: info.baseUrl || null,
    });
  const icon = (TARGET_ICONS.agent ?? "").replace(
      "<svg ",
      '<svg class="sim-agent-icon" aria-hidden="true" ',
    ),
    open = url
      ? `<a class="sim-agent-open" href="${esc(url)}" target="_blank" rel="noopener">Open in ORQ ↗</a>`
      : "",
    model = info.model
      ? `<div class="sim-agent-model">${esc(info.model)}</div>`
      : "",
    desc = description
      ? `<p class="sim-agent-desc">${esc(description)}</p>`
      : "";
  const group = (label: string, items: readonly string[]) =>
    items.length
      ? `<div class="sim-agent-group"><span class="sim-agent-group-label">${esc(label)}</span><div class="sim-agent-chips">${items.map((value) => `<span class="sim-agent-chip">${esc(value)}</span>`).join("")}</div></div>`
      : "";
  const groups =
      group("Sub-agents", info.subAgents || []) +
      group("Tools", info.tools || []) +
      group("Knowledge", info.knowledgeBases || []) +
      group("Memory", info.memoryStores || []),
    wrap = groups ? `<div class="sim-agent-groups">${groups}</div>` : "";
  return `<div class="${options.bare ? "sim-agent-card" : "rk-panel sim-agent-card"}"><div class="sim-agent-head"><div class="sim-agent-identity">${icon}<span class="sim-agent-name">${esc(key)}</span></div>${open}</div>${model}${desc}${wrap}${options.footerHtml ?? ""}</div>`;
}
export async function simulationAgentSection(
  rid: string,
  run: SimulationRun,
): Promise<string> {
  const captured = run.agentInfo;
  if (run.targetKind !== "orq_agent")
    return simulationAgentCard(captured, { experimentUrl: run.experimentUrl });
  const missing =
      captured === null ||
      ["key", "model", "description", "url"].some(
        (key) => !(captured as Record<string, unknown>)[key],
      ),
    key = simulationAgentKeyFor(run);
  if (!missing || !key)
    return simulationAgentCard(captured, { experimentUrl: run.experimentUrl });
  const stored = captured || simulationStoredAgentInfo(run);
  if (!stored) return "";
  return `<div class="sim-agent-async" hx-get="/r/${esc(rid)}/sim/agent-card" hx-trigger="load" hx-swap="outerHTML">${await simulationAgentCard(stored, { experimentUrl: run.experimentUrl })}</div>`;
}
export async function simulationAgentCardWithSource(
  display: AgentDisplay | null,
  original: AgentDisplay | null,
  source: string,
  experimentUrl: string | null = null,
): Promise<string> {
  if (source === "captured" || source === "none")
    return simulationAgentCard(display, { experimentUrl });
  let note: string,
    toggle = "";
  if (source === "augmented") {
    note =
      "Missing fields loaded live from Orq - as-run values kept where captured.";
    const body =
      (await simulationAgentCard(original, { bare: true, experimentUrl })) ||
      '<p class="sim-agent-empty">Nothing captured.</p>';
    toggle = `<details class="sim-agent-original"><summary>Show captured snapshot</summary><div class="sim-agent-original-body">${body}</div></details>`;
  } else
    note =
      source === "fetched"
        ? "Loaded live from Orq - no agent config was captured in this run."
        : "Showing the target recorded in this run; live Orq details are unavailable.";
  return simulationAgentCard(display, {
    footerHtml: `<div class="sim-agent-source">${note}</div>${toggle}`,
    experimentUrl,
  });
}
export function simulationKpiBand(
  summary: Row,
  nPersonas = 0,
  nScenarios = 0,
): string {
  const errors = num(summary.errors),
    total = num(summary.total_conversations),
    score =
      total && errors >= total
        ? "n/a"
        : pyFixed(num(summary.avg_goal_completion_score), 2);
  return kpiCards([
    { label: "Personas", value: String(nPersonas), status: "neutral" },
    { label: "Scenarios", value: String(nScenarios), status: "neutral" },
    { label: "Conversations", value: String(total), status: "neutral" },
    { label: "Avg score", value: score, status: "neutral" },
    {
      label: "Avg turns",
      value: pyFixed(num(summary.avg_turn_count), 1),
      status: "neutral",
    },
    {
      label: "Errors",
      value: String(errors),
      status: errors ? "fail" : "pass",
    },
  ]);
}
export function simulationTokensPanel(data: Row): string {
  const total = num(data.total_tokens);
  if (!total) return "";
  return panel(
    "Tokens",
    barRows(
      [
        ["Input", num(data.prompt_tokens)],
        ["Output", num(data.completion_tokens)],
      ],
      {
        width: 360,
        labelWidth: 70,
        color: "var(--chart-2)",
        format: (value) => groupThousands(String(Math.trunc(value))),
      },
    ),
    {
      sub: `${groupThousands(String(total))} total · ${groupThousands(pyFixed(num(data.avg_total_per_conversation), 0))}/conv`,
    },
  );
}
export function simulationOutcomesDonut(
  results: readonly ReportResult[],
): string {
  let achieved = 0,
    failed = 0,
    errors = 0;
  for (const r of results) {
    if (isErroredResult(r)) errors++;
    else if (r.goal_achieved) achieved++;
    else failed++;
  }
  const total = achieved + failed + errors;
  if (!total) return "";
  return `<figure class="chart-card"><figcaption>Outcomes</figcaption>${donut(
    [
      { label: "Achieved", value: achieved, color: "var(--teal-600)" },
      {
        label: "Not achieved",
        value: failed,
        color: "var(--outcome-vulnerable)",
      },
      { label: "Errors", value: errors, color: "var(--outcome-error)" },
    ],
    achieved + failed ? `${pyRound((achieved / total) * 100)}%` : "n/a",
    achieved + failed ? "goal met" : "no goal verdict",
  )}</figure>`;
}
export async function simulationHero(
  run: SimulationRun,
  compareHtml = "",
  targetLabel: string | null = null,
): Promise<string> {
  const button = traceLinkButton(
      await runTraceUrl(run.runId, run.experimentUrl),
      "View all run traces ↗",
    ),
    inner =
      button +
      traceLinkButton(run.experimentUrl, "Open experiment in Orq") +
      compareHtml,
    actions = inner ? `<div class="report-hero-actions">${inner}</div>` : "";
  return `<header class="report-hero"><p class="report-hero-kicker">Agent Simulation</p><h2 class="report-hero-title">${esc(run.runName)}</h2><p class="report-hero-sub">target ${esc(targetLabel || run.targetKind)}</p>${actions}</header>`;
}
export async function simulationOverview(
  rid: string,
  sections: ReportSections,
  full: ReportSections,
  results: readonly ReportResult[],
  run: SimulationRun,
  options: { filtered: boolean; standalone?: boolean },
): Promise<string> {
  const agent = options.standalone
      ? await simulationAgentCard(
          run.agentInfo || simulationStoredAgentInfo(run),
          { experimentUrl: run.experimentUrl },
        )
      : await simulationAgentSection(rid, run),
    summary = sections.get("summary")?.data ?? {},
    heat = sections.get("persona_scenario_heatmap")?.data ?? {},
    tokens = sections.get("token_usage")?.data ?? {},
    metrics = sections.get("turn_metrics")?.data ?? {},
    fullSummary = full.get("summary")?.data ?? {},
    fullHeat = full.get("persona_scenario_heatmap")?.data ?? {},
    label = options.filtered
      ? "Executive summary · whole run"
      : "Executive summary";
  let executive: string;
  if (run.executiveSummary) {
    let narrative = esc(run.executiveSummary);
    const total = num(fullSummary.total_conversations),
      errors = num(fullSummary.errors);
    if (total && errors >= total)
      narrative += ` No goal verdict is available because all <strong>${total}</strong> conversations errored.`;
    else if (errors)
      narrative += ` <strong>${total - errors}/${total}</strong> conversations completed and <strong>${errors}</strong> errored; the recorded rate and average score use all ${total} conversations.`;
    executive = callout(narrative, { label, confidence: null });
  } else
    executive = execSummary({
      summaryData: fullSummary,
      heatmapData: fullHeat,
      confidence: null,
      label,
    });
  const kpi = simulationKpiBand(
    summary,
    Array.isArray(heat.personas) ? heat.personas.length : 0,
    Array.isArray(heat.scenarios) ? heat.scenarios.length : 0,
  );
  let outcomes: string, second: string;
  if (!results.length) {
    outcomes = `<figure class="chart-card"><figcaption>Outcomes</figcaption>${SIMULATION_NO_MATCH_NOTE}</figure>`;
    second = panel("Average quality metrics", SIMULATION_NO_MATCH_NOTE);
  } else {
    outcomes = simulationOutcomesDonut(results);
    const tiles = simulationAvgQualityTiles(
      (metrics.avg_quality_metrics ?? {}) as Record<string, number>,
    );
    second = tiles
      ? panel("Average quality metrics", tiles)
      : simulationTokensPanel(tokens);
  }
  return `${executive}${agent}${kpi}<div class="sim-overview-grid-2">${outcomes}${second}</div>`;
}
export async function simulationTranscripts(
  rid: string,
  entries: SimulationDashboardEntry[],
  options: { standalone?: boolean } = {},
): Promise<string> {
  if (!options.standalone) return simulationInteractivePanels(rid, entries);
  if (!entries.length)
    return '<p class="rk-empty">No conversations recorded for this run.</p>';
  return entries
    .map((entry) => {
      const state = entryOutcome(entry),
        outcome = statusBadge(state.label, state.status);
      return `<details class="rk-panel export-conversation export-evidence" id="conv-${entry.index + 1}"><summary class="export-conversation-summary"><span class="export-conversation-title">Conversation ${entry.index + 1} · ${esc(entry.persona)} · ${esc(entry.scenario)}</span> ${outcome}<span class="export-conversation-meta">${entry.turn_count} turns · Score ${pyFixed(entry.goal_completion_score, 2)} · ${groupThousands(String(entry.total_tokens))} tokens</span></summary>${renderTranscriptFragment(entry)}</details>`;
    })
    .join("");
}
export async function simulationReportTabs(
  rid: string,
  run: SimulationRun,
  options: {
    results?: readonly ReportResult[];
    compareHtml?: string;
    standalone?: boolean;
  } = {},
): Promise<string> {
  const results = options.results ?? run.results,
    filtered = options.results !== undefined,
    build = buildSimulationReportSections(results, {
      executiveSummary: run.executiveSummary,
      runTokenUsageTotal: filtered ? null : run.tokenUsageTotal,
    }),
    sections = new Map(build.map((s) => [s.kind, s])),
    entitySections = filtered
      ? buildSimulationReportSections(run.results)
      : build,
    full = new Map(entitySections.map((s) => [s.kind, s])),
    hero = await simulationHero(
      run,
      options.compareHtml,
      options.standalone ? run.target : null,
    ),
    entries = stableSimulationEntries(
      run,
      results,
    ) as unknown as SimulationDashboardEntry[],
    context = simulationEntityContext(full, entries, results, rid);
  setFailureFullRunIndexes(sections.get("failures_first"), entries);
  const noMatches = filtered && !results.length,
    breakdown = noMatches
      ? SIMULATION_NO_MATCH_NOTE
      : simulationBreakdown(sections, rid, context, options),
    transcripts = noMatches
      ? SIMULATION_NO_MATCH_NOTE
      : (await simulationTranscripts(rid, entries, options)) +
        (await renderSections(sections, SIMULATION_TAB_RENDERERS, [
          "evaluator_scores",
          "judge_verdicts",
          "errors",
        ])),
    turnQuality = noMatches
      ? SIMULATION_NO_MATCH_NOTE
      : simulationTurnQuality(sections),
    recommendations = simulationRecommendations(rid, run, options),
    count = (run.recommendations ?? []).reduce(
      (n, r) => n + r.suggestions.length,
      0,
    ),
    brief = options.standalone ? simulationBrief(run, sections) : "";
  const tabs = reportTabs(
    "simtab",
    [
      [
        "Overview",
        await simulationOverview(rid, sections, full, results, run, {
          filtered,
          standalone: options.standalone,
        }),
      ],
      ["Breakdown", breakdown],
      [
        "Recommendations",
        recommendations,
        `Recommendations <span class="tab-count">${count}</span>`,
      ],
      [
        "Transcripts",
        transcripts,
        `Transcripts <span class="tab-count">${entries.length}</span>`,
      ],
      ["Turn quality", turnQuality],
      [
        "Config",
        simulationConfig(sections, run, context, options) +
          (await renderSections(sections, SIMULATION_TAB_RENDERERS, [
            "token_usage",
          ])),
      ],
    ],
    { standalone: options.standalone, brief },
  );
  return `<div class="report-aligned sim-report">${hero}${tabs}${options.standalone ? "" : simulationEntityModal(context)}</div>`;
}

const agentInfoCache = new Map<string, AgentDisplay>();
export function clearSimulationAgentInfoCache(): void {
  agentInfoCache.clear();
}
async function cachedAgentInfo(key: string): Promise<AgentDisplay | null> {
  const cached = agentInfoCache.get(key);
  if (cached) return cached;
  let result: AgentDisplay | null = null;
  try {
    result = await fetchAgentInfo(key);
  } catch (error) {
    console.warn(
      `live agent_info enrichment unavailable for ${key}: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  if (result !== null) agentInfoCache.set(key, result);
  return result;
}
export async function resolveSimulationAgentInfo(
  run: SimulationRun,
): Promise<readonly [AgentDisplay | null, AgentDisplay | null, string]> {
  const captured =
    run.agentInfo && Object.keys(run.agentInfo).length ? run.agentInfo : null;
  if (run.targetKind !== "orq_agent")
    return [captured, captured, captured ? "captured" : "none"];
  const missing =
    captured === null ||
    ["key", "model", "description", "url"].some(
      (key) => !(captured as Record<string, unknown>)[key],
    );
  if (!missing) return [captured, captured, "captured"];
  const key = simulationAgentKeyFor(run);
  if (!key) return [captured, captured, captured ? "captured" : "none"];
  const fetched = await cachedAgentInfo(key);
  if (!fetched)
    return [
      captured || simulationStoredAgentInfo(run),
      captured,
      captured ? "captured" : "stored",
    ];
  if (captured) {
    const kept = Object.fromEntries(
      Object.entries(captured).filter(
        ([, value]) =>
          Boolean(value) && (!Array.isArray(value) || value.length),
      ),
    );
    return [{ ...fetched, ...kept }, captured, "augmented"];
  }
  return [fetched, null, "fetched"];
}
export async function simulationAgentCardFragment(
  run: SimulationRun,
): Promise<string> {
  const [display, original, source] = await resolveSimulationAgentInfo(run);
  return simulationAgentCardWithSource(
    display,
    original,
    source,
    run.experimentUrl,
  );
}
