import { esc } from "../common/reports/html-helpers.js";
import {
  COLORS,
  type ColorScale,
  ORQ_SCALE_GOOD_BAD,
  ORQ_SCALE_HEAT,
  QUALITATIVE,
} from "../common/reports/palette.js";
import { renderEmbed } from "../common/reports/vega.js";
import { sumStructuredUsage } from "../common/structured-output.js";
import type { RunManifest } from "../contracts.js";
import { costIsPartial } from "../contracts.js";
import {
  type Cluster,
  type InsightsRunFields,
  labelKey,
  labelOrder,
  type TraceInsight,
} from "../insights/models.js";
import { describeProjectionCoverage } from "../insights/population.js";
import { conversationUnavailableReason } from "./insights-trace-source.js";
import { page } from "./shell.js";
import {
  componentAssets,
  scriptAsset,
  stylesheetAsset,
} from "./static-assets.js";
import { traceLinkButton, traceSpanUrl } from "./trace-links.js";

export type InsightsRun = InsightsRunFields;
export type RunEntry = readonly [runId: string, label: string, status: string];

export const TABS = [
  "dimensions",
  "labels",
  "crosstab",
  "traces",
  "priority",
  "map",
] as const;
export const TAB_LABELS: Record<string, string> = {
  dimensions: "Dimensions",
  labels: "Labels",
  crosstab: "Crosstab",
  traces: "Traces",
  priority: "Priority matrix",
  map: "3D Map",
};

const q = (value: string) => encodeURIComponent(value);
const runUrl = (run: InsightsRun) => q(run.runId);
const title = (text: string) =>
  text
    .toLowerCase()
    .replace(
      /(^|[^a-z0-9])([a-z])/g,
      (_, lead: string, letter: string) => lead + letter.toUpperCase(),
    );
const MONTHS = [
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
const pad = (n: number) => String(n).padStart(2, "0");

/** `%d %b %Y, %H:%M UTC` for an aware time. */
export function formatUtc(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** Split a stored ISO time into its wall-clock minutes and offset, as Python keeps a parsed datetime's own zone. */
function wallTime(
  value: string,
): { day: string; minutes: string; offset: string } | null {
  const match =
    /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/.exec(
      value,
    );
  if (!match) return null;
  const offset =
    match[3] === undefined
      ? ""
      : match[3] === "Z"
        ? "+00:00"
        : match[3].replace(/^([+-]\d\d)(\d\d)$/, "$1:$2");
  return { day: match[1] ?? "", minutes: match[2] ?? "", offset };
}

function traceMinute(timestamp: string | null): string {
  if (!timestamp) return "Time unavailable";
  const wall = wallTime(timestamp);
  return wall ? `${wall.day} ${wall.minutes}` : timestamp;
}

function traceIsoMinutes(timestamp: string | null): string {
  if (!timestamp) return "Time unavailable";
  const wall = wallTime(timestamp);
  return wall ? `${wall.day}T${wall.minutes}${wall.offset}` : timestamp;
}

function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Dump a parsed model the way Pydantic's `model_dump(mode="json")` names its fields, for the shared browser scripts. */
export function snakeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeJson);
  if (value instanceof Set) return [...value].map(snakeJson);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        snakeKey(key),
        snakeJson(item),
      ]),
    );
  return value;
}

function stageName(manifest: RunManifest): string {
  const stage = manifest.stage ?? "";
  return (
    manifest.stageLabels[stage] ??
    title((manifest.stage || "Starting").replaceAll("_", " "))
  );
}

function stageRows(manifest: RunManifest): [string, string, string][] {
  const records = new Map(manifest.stages.map((stage) => [stage.name, stage]));
  const planned = [
    ...manifest.plannedStages,
    ...[...records.keys()].filter(
      (name) => !manifest.plannedStages.includes(name),
    ),
  ];
  if (
    manifest.status === "error" &&
    manifest.stage &&
    !planned.includes(manifest.stage)
  )
    planned.push(manifest.stage);
  return planned.map((name) => {
    const record = records.get(name);
    const status =
      record !== undefined
        ? String(record.status)
        : manifest.status === "error" && name === manifest.stage
          ? "error"
          : manifest.status !== "running"
            ? "skipped"
            : "pending";
    const label =
      manifest.stageLabels[name] ??
      title(name.replace("dimension:", "Cluster ").replaceAll("_", " "));
    return [name, label, status];
  });
}

function overviewStages(manifest: RunManifest | undefined): string {
  if (manifest === undefined)
    return '<span class="insights-overview-no-stages">Stage history unavailable</span>';
  const rows = stageRows(manifest);
  if (!rows.length)
    return '<span class="insights-overview-no-stages">No stages recorded</span>';
  const marks = rows
    .map(
      ([, label, status]) =>
        `<li class="${esc(status)}" title="${esc(label)}: ${esc(status)}" aria-label="${esc(label)}: ${esc(status)}"></li>`,
    )
    .join("");
  const done = rows.filter(([, , status]) => status === "completed").length;
  return (
    '<span class="insights-overview-stage-wrap"><span>Stages</span>' +
    `<ol class="insights-overview-stages" aria-label="Run stages">${marks}</ol>` +
    `<span>${done}/${rows.length}</span></span>`
  );
}

const traceCount = (run: InsightsRun) =>
  run.counts.n_traces ?? run.traces.length;

/** Render the saved runs as one navigable overview. */
export function runOverview(
  entries: readonly RunEntry[],
  runs: ReadonlyMap<string, InsightsRun>,
  manifests: ReadonlyMap<string, RunManifest>,
): string {
  if (!entries.length)
    return (
      '<section class="insights-overview-empty"><h2>No Insights runs yet</h2>' +
      "<p>Start a run to find patterns across traces. Its progress and results will appear here.</p>" +
      '<a class="insights-overview-new" href="/insights/new">+ New Run</a></section>'
    );
  const rows = entries.map(([runId, label, status]) => {
    const run = runs.get(runId);
    const manifest = manifests.get(runId);
    const stage =
      manifest !== undefined && status === "running" ? stageName(manifest) : "";
    const startedAt =
      run !== undefined
        ? run.createdAt
        : manifest !== undefined
          ? manifest.startedAt
          : null;
    const created = startedAt !== null ? formatUtc(startedAt) : "";
    const count = run !== undefined ? String(traceCount(run)) : "\u2014";
    let dimensions =
      run !== undefined
        ? Object.keys(run.dimensions).map(title).join(", ")
        : "\u2014";
    if (run !== undefined && !Object.keys(run.dimensions).length)
      dimensions = "None";
    const statusClass = [
      "running",
      "completed",
      "error",
      "cancelled",
      "unreadable",
    ].includes(status)
      ? status
      : "other";
    return (
      `<a class="insights-overview-row" href="/insights/${q(runId)}">` +
      `<span class="insights-overview-name"><strong>${esc(label)}</strong>` +
      `<small>${esc(stage || created || "Run file could not be read")}</small></span>` +
      overviewStages(manifest) +
      `<span class="insights-overview-status ${statusClass}">${esc(status)}</span>` +
      `<span class="insights-overview-number">${esc(count)}</span>` +
      `<span class="insights-overview-dimensions">${esc(dimensions)}</span>` +
      '<span class="insights-overview-arrow" aria-hidden="true">\u2192</span></a>'
    );
  });
  return (
    '<section class="insights-overview"><div class="insights-overview-head">' +
    "<div><h2>Recent runs</h2><p>Explore clusters, labels, traces, and 3D maps from each run.</p></div>" +
    `<span>${entries.length} run${entries.length !== 1 ? "s" : ""}</span></div>` +
    '<div class="insights-overview-table"><div class="insights-overview-columns">' +
    "<span>Run</span><span>Stages</span><span>Status</span><span>Traces</span><span>Dimensions</span><span></span></div>" +
    `${rows.join("")}</div></section>`
  );
}

const SHORT_LABELS: Record<string, string> = {
  "Load local traces": "Load local",
  "Load Finder matches": "Load Finder",
  "Find matching traces": "Find matches",
  "Load recent traces": "Load recent",
  "Classify traces": "Classify",
  "Match traces": "Match",
  "Match and classify traces": "Match + classify",
  "Prepare traces": "Prepare",
  "Summarize traces": "Summarize",
  "Build priority matrix": "Priority",
  "Check priority matrix": "Priority",
  "Save run": "Save",
};

function elapsed(start: Date, end: Date | null = null): string {
  const seconds = Math.floor(
    ((end ?? new Date()).getTime() - start.getTime()) / 1000,
  );
  if (seconds < 0) return "";
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
    : `${seconds}s`;
}

/** Render the persisted stage plan and actual stage outcomes. */
export function progress(manifest: RunManifest | null | undefined): string {
  if (!manifest) return "";
  const records = new Map(manifest.stages.map((stage) => [stage.name, stage]));
  const rows = stageRows(manifest);
  const items = rows.map(([name, label, status]) => {
    const record = records.get(name);
    const shortLabel = name.startsWith("dimension:")
      ? title(name.split(":").slice(1).join(":"))
      : (SHORT_LABELS[label] ?? label);
    let flag = "";
    if (status === "running") {
      const time = record !== undefined ? elapsed(record.startedAt) : "";
      flag = `<span class="insights-stage-flag">Running${time ? ` \u00b7 ${time}` : ""}</span>`;
    } else if (status === "error")
      flag = '<span class="insights-stage-flag">Failed</span>';
    const stageCount =
      record !== undefined && record.completed !== null && record.total !== null
        ? `<small>${record.completed}/${record.total}</small>`
        : "";
    return (
      `<li class="insights-stage ${esc(status)}" title="${esc(label)}: ${esc(status)}">${flag}` +
      '<span class="insights-stage-mark" aria-hidden="true"></span>' +
      `<span class="insights-stage-label">${esc(shortLabel)}</span>${stageCount}` +
      `<span class="sr-only">${esc(status)}</span></li>`
    );
  });
  const done = rows.filter(([, , status]) => status === "completed").length;
  const current =
    manifest.status === "running"
      ? stageName(manifest)
      : title(String(manifest.status));
  const count = rows.length ? ` \u00b7 ${done} of ${rows.length}` : "";
  const list =
    items.join("") || '<li class="insights-stage pending">Preparing run</li>';
  return (
    '<section class="insights-progress" aria-label="Run progress">' +
    `<div class="insights-progress-head"><h3>Run progress</h3><span>${esc(current)}${count}</span></div>` +
    `<ol>${list}</ol></section>`
  );
}

/** The saved signal summary shape the review page and the trace page read. */
export function signalSummary(
  trace: TraceInsight,
): Record<string, unknown> | null {
  const report = trace.signals;
  if (!report) return null;
  return {
    config_version: report.configVersion,
    results: Object.fromEntries(
      Object.entries(report.results).map(([name, item]) => [
        name,
        {
          name: item.name,
          group: item.group,
          value: item.value,
          approximate: item.approximate,
          no_basis: item.noBasis,
          reason: item.reason,
          rule_version: item.ruleVersion,
        },
      ]),
    ),
  };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Set) return value.size === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function pyText(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function chip(label: string, value: unknown): string {
  if (isEmptyValue(value)) return "";
  return `<span class="insights-chip"><b>${esc(label)}</b> ${esc(pyText(value))}</span>`;
}

function windowChip(label: string, value: unknown): string {
  if (!value) return "";
  const text = String(value);
  const wall = wallTime(text);
  if (wall === null) return chip(label, value);
  const formatted = wall.offset
    ? formatUtc(text)
    : (() => {
        const [year, month, day] = wall.day.split("-");
        return `${day} ${MONTHS[Number(month) - 1]} ${year}, ${wall.minutes}`;
      })();
  return `<span class="insights-chip" title="${esc(text)}"><b>${esc(label)}</b> ${esc(formatted)}</span>`;
}

function cost(run: InsightsRun): string {
  const usages = Object.values(run.costByStage);
  if (!usages.length) return "";
  const total = sumStructuredUsage(usages);
  if (total === null || total.totalCost === null) return " \u00b7 cost unknown";
  let text = ` \u00b7 $${total.totalCost.toFixed(4)}`;
  if (costIsPartial(total))
    text += ` (priced for ${total.pricedCalls} of ${total.calls} calls)`;
  // Population and filter-selection model calls never reach the usage ledger, so the total is a lower bound.
  return `${text} \u00b7 excludes trace selection`;
}

const NUMERIC_LABELS: Record<string, string> = {
  tokens_min: "tokens \u2265",
  tokens_max: "tokens \u2264",
  duration_ms_min: "duration ms \u2265",
  duration_ms_max: "duration ms \u2264",
};

function record(value: unknown): Record<string, unknown> {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Set)
    ? (value as Record<string, unknown>)
    : {};
}

export function header(run: InsightsRun): string {
  const population = run.population;
  const query = population.query;
  const chips = [
    chip("source", population.mode === "snapshot" ? "trace file" : null),
    chip("query", query),
  ];
  for (const [name, values] of Object.entries(record(population.facets))) {
    if (Array.isArray(values) || values instanceof Set)
      chips.push(...[...values].map((value) => chip(name, value)));
    else if (values) chips.push(chip(name, values));
  }
  for (const [name, value] of Object.entries(record(population.numeric)))
    chips.push(chip(NUMERIC_LABELS[name] ?? name.replaceAll("_", " "), value));
  chips.push(
    windowChip("from", population.start),
    windowChip("to", population.end),
  );
  chips.push(chip("limit", population.limit));
  const labelChips = run.config.labels
    .map((label) => chip("label", label.name))
    .join("");
  const models = `${run.config.summaryModel} \u00b7 ${run.config.classifierModel} \u00b7 ${run.config.embeddingModel}`;
  const finder = query
    ? '<a class="insights-action" href="/find">Open in finder \u2197</a>'
    : "";
  const populationChips =
    chips.join("") || '<span class="insights-muted">All traces</span>';
  const labelGroup = labelChips
    ? `<div class="insights-chip-group"><span class="insights-group-label">Labels</span>${labelChips}</div>`
    : "";
  const count = traceCount(run);
  const traceText = count === 1 ? `${count} trace` : `${count} traces`;
  return (
    '<header class="insights-header">' +
    `<div class="insights-header-copy"><h2>${esc(run.runName)}</h2><p class="insights-subtitle">` +
    `<span class="insights-header-count">${traceText}${esc(cost(run))}</span>` +
    `<span>${esc(formatUtc(run.createdAt))}</span></p>` +
    `<div class="insights-chip-group"><span class="insights-group-label">Population</span>${populationChips}</div>` +
    labelGroup +
    `<details class="insights-models"><summary>Models used</summary><span>${esc(models)}</span></details></div>` +
    '<div class="insights-actions">' +
    `${finder}<a class="insights-action" href="/insights/${runUrl(run)}/export.json">Export JSON</a>` +
    "</div></header>"
  );
}

export async function failures(run: InsightsRun): Promise<string> {
  const banners: string[] = [];
  const truncated = Object.hasOwn(run.population, "n_projection_truncated");
  if (truncated) banners.push(await projectionNotice(run.population));
  if (run.status === "error") {
    const items =
      run.stageFailures
        .map(
          (item) => `<li><b>${esc(item.stage)}</b>: ${esc(item.message)}</li>`,
        )
        .join("") || "<li>The run ended with an error.</li>";
    banners.push(
      `<section class="insights-error" role="alert"><b>Run failed; results may be partial.</b><ul>${items}</ul></section>`,
    );
  }
  const failed = run.counts.n_failed_traces ?? 0;
  if (failed)
    banners.push(
      `<p class="insights-warning">${failed} ${failed === 1 ? "trace" : "traces"} had a label, summary, match, or dimension error.</p>`,
    );
  const warnings = run.warnings.filter(
    (warning) =>
      !(
        truncated &&
        (warning.startsWith("Input character cap: ") ||
          warning.startsWith("Projection budget: ") ||
          (warning.endsWith(
            "whole messages were omitted from classification and summaries.",
          ) &&
            warning.includes(" exceeded the model projection budget; ")))
      ),
  );
  if (warnings.length)
    banners.push(
      `<section class="insights-warning" role="status"><b>Run warnings</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>`,
    );
  return banners.join("");
}

/** Show character-based model input coverage for a run or preview. */
export async function projectionNotice(
  coverage: Readonly<Record<string, unknown>>,
): Promise<string> {
  if (
    !Object.hasOwn(coverage, "classifier_state_chars") ||
    !Object.hasOwn(coverage, "source_chars")
  )
    return (
      '<section class="insights-projection" role="status"><b>Model input coverage</b>' +
      "<p>Input character coverage was not recorded for this earlier run.</p></section>"
    );
  let reserveNote = "";
  if (coverage.classifier_question_reserve === "not_available")
    reserveNote =
      "<p>The preview did not include selected classifier questions; the final request may reserve more of the input cap for them.</p>";
  else if (coverage.classifier_question_reserve === "applied")
    reserveNote =
      "<p>Exact serialized selected questions share the configured input cap with classifier state; Jev also applies its model-specific state and question ceilings.</p>";
  const excerptNote =
    coverage.classifier_state_format === "jev"
      ? "<p>Text inside kept messages may also be shortened. Tool inputs and results retain bounded excerpts; source traces are not changed.</p>"
      : "<p>The full readable transcript may be shortened to fit the cap; source traces are not changed.</p>";
  return (
    '<section class="insights-projection" role="status"><b>Model input coverage</b>' +
    `<p>${esc(await describeProjectionCoverage(coverage))}</p>${reserveNote}${excerptNote}</section>`
  );
}

/** The tab bar; `oob` marks it for an htmx out-of-band swap so a tab fragment moves the indicator. */
export function tabs(
  run: InsightsRun,
  active: string,
  options: { oob?: boolean } = {},
): string {
  const links = TABS.map((name) => {
    const cls = name === active ? "insights-tab active" : "insights-tab";
    const current = name === active ? ' aria-current="page"' : "";
    const href = `/insights/${runUrl(run)}/tab/${name}`;
    // hx-sync aborts an in-flight tab request, so a slow response (the map) cannot land over a newer click.
    return `<a class="${cls}" href="${href}" hx-get="${href}" hx-target="#insights-content" hx-push-url="true"${current} hx-sync="closest nav:replace">${TAB_LABELS[name]}</a>`;
  });
  const swap = options.oob ? ' hx-swap-oob="true"' : "";
  return `<nav id="insights-tabs" class="insights-tabs" aria-label="Insights views"${swap}>${links.join("")}</nav>`;
}

/** Python's round(): halves go to the even neighbour. */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function bar(size: number, total: number): string {
  const pct = total ? Math.min(100, pyRound((size / total) * 100)) : 0;
  return `<span class="insights-bar"><i style="width:${pct}%"></i></span>`;
}

export function dimensions(
  run: InsightsRun,
  selectedCluster: string | null = null,
): string {
  const entries = Object.entries(run.dimensions);
  if (!entries.length)
    return '<section class="insights-empty-state"><h3>No dimensions available</h3><p>This run did not produce any cluster dimensions.</p></section>';
  const controls = entries
    .map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`)
    .join("");
  const parts = [
    '<div class="insights-dimension-control"><label for="insights-dimension">Dimension</label>' +
      `<select id="insights-dimension" name="dimension" onchange="document.querySelectorAll('.insights-dimension').forEach(function(s){s.hidden=s.dataset.dimension!==this.value}.bind(this))">${controls}</select>` +
      "</div>",
  ];
  entries.forEach(([name, dimension], index) => {
    const total = Math.max(1, run.traces.length);
    const rows: string[] = [];
    for (const top of dimension.clusters.filter(
      (cluster) => cluster.level === "top",
    )) {
      rows.push(
        `<div class="insights-cluster-row top"><span class="insights-tree-marker">\u25be</span><b>${esc(top.name)}</b>` +
          `<span class="insights-count">${top.size} \u00b7 ${pyRound((top.size / total) * 100)}%</span>${bar(top.size, total)}</div>`,
      );
      for (const child of dimension.clusters.filter(
        (c) => c.level === "base" && c.parentId === top.id,
      )) {
        const href = `/insights/${runUrl(run)}/cluster/${q(child.id)}`;
        const selected = child.id === selectedCluster ? " selected" : "";
        rows.push(
          `<button class="insights-cluster-row child${selected}" hx-get="${href}" hx-target="#insights-cluster-detail" ` +
            `aria-label="Show cluster ${esc(child.name)}"><span class="insights-tree-marker">\u21b3</span><span>${esc(child.name)}</span>` +
            `<span class="insights-count">${child.size}</span>${bar(child.size, total)}</button>`,
        );
      }
    }
    if (!rows.length)
      rows.push('<p class="insights-empty">No clusters in this dimension.</p>');
    if (dimension.nNoise)
      rows.push(
        `<div class="insights-cluster-row muted"><span>Outliers (noise)</span><span class="insights-count">${dimension.nNoise}</span></div>`,
      );
    if (dimension.nFailed)
      rows.push(
        `<div class="insights-cluster-row failed"><span>Failed / unclassified</span><span class="insights-count">${dimension.nFailed}</span></div>`,
      );
    if (dimension.nNoSignal)
      rows.push(
        `<div class="insights-cluster-row muted"><span>No signal</span><span class="insights-count">${dimension.nNoSignal}</span></div>`,
      );
    const hidden = index ? " hidden" : "";
    parts.push(
      `<section class="insights-dimension" data-dimension="${esc(name)}"${hidden}><h3>${esc(title(name))}</h3><div class="insights-tree">${rows.join("")}</div></section>`,
    );
  });
  const side =
    '<section id="insights-cluster-detail" class="insights-detail"><p class="insights-empty">Select a cluster to see its details and example traces.</p></section>';
  return `<div class="insights-dimensions"><div class="insights-tree-column">${parts.join("")}</div>${side}</div>`;
}

function findCluster(
  run: InsightsRun,
  clusterId: string,
): [string, Cluster] | null {
  for (const [name, dimension] of Object.entries(run.dimensions))
    for (const cluster of dimension.clusters)
      if (cluster.id === clusterId) return [name, cluster];
  return null;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function traceHref(
  run: InsightsRun,
  trace: TraceInsight,
  view: "analysis" | "trace" = "analysis",
): string {
  const locator = form({
    trace_id: trace.traceId,
    span_id: trace.spanId ?? "",
  });
  return `/insights/${runUrl(run)}/trace?${locator}${view === "trace" ? "&view=trace" : ""}`;
}

function traceIdLink(run: InsightsRun, trace: TraceInsight): string {
  return `<a class="insights-trace-id" href="${esc(traceHref(run, trace))}">${esc(trace.traceId)}</a>`;
}

const isSnapshot = (run: InsightsRun) => run.population.mode === "snapshot";

export async function clusterDetail(
  run: InsightsRun,
  clusterId: string,
): Promise<string> {
  const found = findCluster(run, clusterId);
  if (found === null) return '<p class="insights-empty">Cluster not found.</p>';
  const [dimension, cluster] = found;
  const ids = new Set(cluster.traceIds);
  const members = run.traces.filter((trace) => ids.has(trace.traceId));
  const labelRows: string[] = [];
  for (const labelName of Object.keys(run.labels)) {
    const values = new Map<string, number>();
    for (const trace of members) {
      const answer = trace.labels[labelName];
      if (answer && answer.error === null && answer.value !== null) {
        const key = labelValueKey(run, labelName, answer.value);
        values.set(key, (values.get(key) ?? 0) + 1);
      }
    }
    if (values.size) {
      const summary = [...values.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([value, count]) =>
            `${esc(labelValueName(run, labelName, value))} ${count}/${members.length}`,
        )
        .join(", ");
      labelRows.push(
        `<div class="insights-label-summary"><b>${esc(labelName)}</b><span>${summary}</span></div>`,
      );
    }
  }
  const byId = new Map(members.map((trace) => [trace.traceId, trace]));
  const examples: string[] = [];
  for (const traceId of cluster.exampleTraceIds) {
    const trace = byId.get(traceId);
    if (trace === undefined) continue;
    const excerpt = trace.summary ? trace.summary.summary : "";
    const link = isSnapshot(run)
      ? ""
      : traceLinkButton(
          await traceSpanUrl(trace.traceId, trace.spanId),
          "Open in Orq \u2197",
        );
    examples.push(
      `<div class="insights-example"><code>${traceIdLink(run, trace)}</code><span>${esc(excerpt)}</span>${link}</div>`,
    );
  }
  const tracesHref = `/insights/${runUrl(run)}/tab/traces?dimension=${pyQuote(dimension)}&cluster=${pyQuote(cluster.id)}`;
  const labelHtml =
    labelRows.join("") ||
    '<p class="insights-empty">No label answers for this cluster.</p>';
  const exampleHtml =
    examples.join("") ||
    '<p class="insights-empty">No example traces available.</p>';
  return (
    '<div class="insights-detail-kicker">Cluster \u00b7 ' +
    `${esc(dimension)}</div><h3>${esc(cluster.name)}</h3><p>${esc(cluster.description) || "No description available."}</p>` +
    `<div class="insights-detail-kicker">Labels in this cluster</div>${labelHtml}` +
    `<div class="insights-detail-kicker">Example traces</div>${exampleHtml}` +
    `<a class="insights-action" href="${tracesHref}" hx-get="${tracesHref}" hx-target="#insights-content" hx-push-url="true">Show all ${cluster.size} in Traces \u2192</a>`
  );
}

/** Python's `urllib.parse.quote` with its default safe "/". */
function pyQuote(value: string): string {
  return encodeURIComponent(value)
    .replace(/%2F/g, "/")
    .replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/** Show an answer under the same text its label card counts it by, so a card row filters to its traces. */
function answerKey(run: InsightsRun, name: string, value: unknown): string {
  const result = run.labels[name];
  return result !== undefined ? labelKey(result.spec, value) : pyText(value);
}

/** Sort label values in their label's own order (positive before negative, 1 before 5); other values follow A-Z. */
function ordered(
  run: InsightsRun,
  name: string | null,
  values: Iterable<string>,
): string[] {
  const result = name ? run.labels[name] : undefined;
  const rank = new Map(
    result !== undefined
      ? labelOrder(result.spec).map((value, index) => [value, index])
      : [],
  );
  const fallback = rank.size;
  return [...values].sort((a, b) => {
    const order = (rank.get(a) ?? fallback) - (rank.get(b) ?? fallback);
    return order || (a < b ? -1 : a > b ? 1 : 0);
  });
}

export function labels(run: InsightsRun): string {
  const entries = Object.entries(run.labels);
  if (!entries.length)
    return '<section class="insights-empty-state"><h3>No labels in this run</h3><p>This run has no classifier labels to review.</p></section>';
  const cards = entries.map(([name, result]) => {
    const total = Math.max(
      1,
      Object.values(result.counts).reduce((sum, count) => sum + count, 0),
    );
    const rows = ordered(run, name, Object.keys(result.counts)).map((value) => {
      const count = result.counts[value] ?? 0;
      const href = `/insights/${runUrl(run)}/tab/traces?label=${pyQuote(name)}&value=${pyQuote(value)}`;
      return `<a class="insights-label-row" href="${href}" hx-get="${href}" hx-target="#insights-content" hx-push-url="true"><span>${esc(labelValueName(run, name, value))}</span><b>${pyRound((count / total) * 100)}%</b>${bar(count, total)}</a>`;
    });
    const rowHtml =
      rows.join("") ||
      '<p class="insights-empty">No label values were recorded.</p>';
    const warning = result.countsWarning
      ? `<p class="insights-warning" role="status">${esc(result.countsWarning)}</p>`
      : "";
    const failed = result.nFailed
      ? `<p class="insights-muted">${result.nFailed} failed</p>`
      : "";
    return (
      `<article class="insights-label-card"><div class="insights-card-head"><h3>${esc(name)}</h3><span>${esc(result.spec.kind)}</span></div>` +
      `<p class="insights-label-instructions">${esc(result.spec.instructions)}</p>${warning}${rowHtml}${failed}</article>`
    );
  });
  return `<div class="insights-label-grid">${cards.join("")}</div>`;
}

function pyFloatText(value: number): string {
  if (Number.isInteger(value)) return `${value}.0`;
  return String(value);
}

function labelValueKey(
  run: InsightsRun,
  labelName: string,
  value: boolean | number | string,
): string {
  const result = run.labels[labelName];
  const plain = typeof value === "number" ? pyFloatText(value) : pyText(value);
  if (
    result === undefined ||
    result.spec.kind !== "score" ||
    !Array.isArray(result.spec.criteria)
  )
    return plain;
  const levels = result.spec.criteria.length;
  if (levels < 2) return plain;
  return String(pyRound(Number(value) * (levels - 1)));
}

function labelValueName(
  run: InsightsRun,
  labelName: string,
  value: string,
): string {
  const result = run.labels[labelName];
  if (
    result === undefined ||
    result.spec.kind !== "score" ||
    !Array.isArray(result.spec.criteria)
  )
    return value;
  if (!/^\s*[+-]?\d+\s*$/.test(value)) return value;
  const index = Number.parseInt(value, 10);
  return index >= 0 && index < result.spec.criteria.length
    ? (result.spec.criteria[index] ?? value)
    : value;
}

async function traceRow(
  run: InsightsRun,
  trace: TraceInsight,
): Promise<string> {
  const cells = [
    `<td class="id">${traceIdLink(run, trace)}</td>`,
    `<td>${esc(traceMinute(trace.timestamp))}</td>`,
  ];
  for (const name of run.config.dimensions)
    cells.push(`<td>${esc(trace.assignments[name]?.base ?? "\u2014")}</td>`);
  for (const name of Object.keys(run.labels)) {
    const answer = trace.labels[name];
    const value =
      answer === undefined || answer.error
        ? "failed"
        : answer.value === null
          ? "\u2014"
          : answerKey(run, name, answer.value);
    cells.push(`<td>${esc(value)}</td>`);
  }
  if (!isSnapshot(run))
    cells.push(
      `<td>${traceLinkButton(await traceSpanUrl(trace.traceId, trace.spanId), "\u2197 Orq")}</td>`,
    );
  return `<tr>${cells.join("")}</tr>`;
}

function toolCounts(
  heading: string,
  counts: Record<string, number>,
  empty: string,
): string {
  const items = Object.entries(counts)
    .map(([name, count]) => `<li>${esc(name)} <b>${count}</b></li>`)
    .join("");
  const body = items
    ? `<ul class="insights-tool-counts">${items}</ul>`
    : `<p class="insights-muted">${esc(empty)}</p>`;
  return `<h4>${esc(heading)}</h4>${body}`;
}

/** The saved analysis for one trace, or its source conversation, including traces from a local snapshot. */
export async function traceDetailPage(
  run: InsightsRun,
  trace: TraceInsight,
  options: { view?: "analysis" | "trace" } = {},
): Promise<string> {
  let view = options.view ?? "analysis";
  const field = (name: string, value: string | null | undefined) =>
    value ? `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>` : "";
  const summary = trace.summary;
  const context = summary
    ? field("Request", summary.request) +
      field("Task", summary.task) +
      field("Topic", summary.topic)
    : "";
  const labelFields = Object.entries(trace.labels)
    .map(([name, answer]) =>
      field(
        title(name.replaceAll("_", " ")),
        answer.error
          ? `Failed: ${answer.error}`
          : answer.value !== null
            ? answerKey(run, name, answer.value)
            : "No answer",
      ),
    )
    .join("");
  const clusterNames = new Map(
    Object.entries(run.dimensions).map(([name, dimension]) => [
      name,
      new Map(dimension.clusters.map((c) => [c.id, c.name])),
    ]),
  );
  const dimensionFields = Object.entries(trace.assignments)
    .map(([name, assignment]) =>
      field(
        title(name.replaceAll("_", " ")),
        clusterNames.get(name)?.get(assignment.base) ?? assignment.base,
      ),
    )
    .join("");
  const errors = Object.entries(trace.errors)
    .map(([name, message]) => `<li><b>${esc(name)}</b>: ${esc(message)}</li>`)
    .join("");
  const stats = trace.toolStats;
  const toolsHtml = stats
    ? toolCounts("Tools", stats.tools, "No tool calls.") +
      toolCounts("Shell commands", stats.commands, "No shell commands.") +
      toolCounts("Skills", stats.skills, "No skills loaded.")
    : "<p>Tool use was not recorded for this run.</p>";
  const orqLink = isSnapshot(run)
    ? ""
    : traceLinkButton(
        await traceSpanUrl(trace.traceId, trace.spanId),
        "Open full trace in Orq \u2197",
      );
  const contextHtml = context ? `<dl>${context}</dl>` : "";
  const labelsHtml = labelFields
    ? `<dl>${labelFields}</dl>`
    : "<p>No labels were recorded.</p>";
  const dimensionsHtml = dimensionFields
    ? `<dl>${dimensionFields}</dl>`
    : "<p>No dimension assignments were recorded.</p>";
  const errorsHtml = errors
    ? `<section><h3>Errors</h3><ul>${errors}</ul></section>`
    : "";
  const signalOptions = {
    report: signalSummary(trace),
    detail: {
      signals: trace.signals ? snakeJson(trace.signals) : null,
      source_coverage: trace.sourceCoverage,
    },
  };
  const signalHtml = `<div data-saved-signals="${esc(JSON.stringify(signalOptions))}"></div>`;
  const headerHtml =
    '<div class="insights-detail-kicker">Trace analysis</div>' +
    `<h2><code>${esc(trace.traceId)}</code></h2>` +
    `<p class="insights-muted">${esc(traceIsoMinutes(trace.timestamp))}` +
    `${trace.spanId ? ` \u00b7 span ${esc(trace.spanId)}` : ""}` +
    `${trace.agentName ? ` \u00b7 ${esc(trace.agentName)}` : ""}` +
    `${trace.project ? ` \u00b7 ${esc(trace.project)}` : ""}</p>${orqLink}`;
  const unavailableReason = await conversationUnavailableReason(run);
  if (unavailableReason !== null) view = "analysis";
  const tabLink = (name: "analysis" | "trace", label: string) =>
    `<a class="insights-tab${view === name ? " active" : ""}" href="${esc(traceHref(run, trace, name))}"${view === name ? ' aria-current="page"' : ""}>${label}</a>`;
  const traceTab =
    unavailableReason === null
      ? tabLink("trace", "Trace")
      : `<span class="insights-tab disabled" aria-disabled="true" title="${esc(unavailableReason)}">Trace</span>` +
        `<span class="insights-muted insights-trace-tab-reason">${esc(unavailableReason)}</span>`;
  const tabNav = `<nav class="insights-trace-tabs" aria-label="Trace views">${tabLink("analysis", "Analysis")}${traceTab}</nav>`;
  let content: string;
  if (view === "trace") {
    const conversationUrl = `/insights/${runUrl(run)}/trace-conversation?${form({ trace_id: trace.traceId, span_id: trace.spanId ?? "" })}`;
    const showSendError =
      'this.innerHTML = \'<p class="finder-empty" role="status">Could not load the conversation. Reload to try again.</p>\'';
    content =
      `<div class="fd-traces insights-trace-view" hx-get="${esc(conversationUrl)}" hx-trigger="load" ` +
      `hx-swap="outerHTML" hx-on::send-error="${esc(showSendError)}">` +
      '<p class="finder-empty" role="status">Loading conversation\u2026</p></div>';
  } else
    content =
      signalHtml +
      "<section><h3>Summary</h3>" +
      `<p>${summary ? esc(summary.summary) : "No summary was saved for this trace."}</p>${contextHtml}</section>` +
      `<section><h3>Labels</h3>${labelsHtml}</section>` +
      `<section><h3>Dimensions</h3>${dimensionsHtml}</section>` +
      `<section><h3>Tool use</h3>${toolsHtml}</section>${errorsHtml}`;
  const body = `<div class="insights-layout"><div class="insights-main insights-trace-detail">${headerHtml}${tabNav}${content}</div></div>`;
  const back = `<a class="report-back" href="/insights/${runUrl(run)}/tab/traces">\u2190 Traces in this run</a>`;
  return page("Insights trace", body, {
    activeNav: "insights",
    backHtml: back,
    headHtml: `${componentAssets()}${stylesheetAsset("insights-signals.css")}${scriptAsset("insights-signals.js")}`,
  });
}

export interface TraceFilters {
  dimension?: string | null;
  cluster?: string | null;
  label?: string | null;
  value?: string | null;
  row?: string | null;
  rowValue?: string | null;
  column?: string | null;
  columnValue?: string | null;
}

export async function traces(
  run: InsightsRun,
  filters: TraceFilters = {},
): Promise<string> {
  const {
    dimension,
    cluster,
    label,
    value,
    row,
    rowValue,
    column,
    columnValue,
  } = filters;
  const active: [string, "cluster" | "label" | "crosstab"][] = [];
  if (dimension && cluster) {
    const selected = run.dimensions[dimension]?.clusters.find(
      (item) => item.id === cluster,
    );
    active.push([
      `${dimension} = ${selected ? selected.name : cluster}`,
      "cluster",
    ]);
  }
  if (label !== null && label !== undefined)
    active.push([
      value !== null && value !== undefined ? `${label} = ${value}` : label,
      "label",
    ]);
  if (
    row &&
    rowValue !== null &&
    rowValue !== undefined &&
    column &&
    columnValue !== null &&
    columnValue !== undefined
  )
    active.push([`${rowValue} x ${columnValue}`, "crosstab"]);
  const base = `/insights/${runUrl(run)}/tab/traces`;
  const chips = active.map(([text, kind]) => {
    let remaining: Record<string, string | null | undefined> = {
      dimension,
      cluster,
      label,
      value,
    };
    if (kind === "cluster") remaining = { label, value };
    else if (kind === "label") remaining = { dimension, cluster };
    else remaining = {};
    const kept = Object.fromEntries(
      Object.entries(remaining).filter(
        (entry): entry is [string, string] => entry[1] != null,
      ),
    );
    const href = Object.keys(kept).length ? `${base}?${form(kept)}` : base;
    return (
      `<a class="insights-filter-chip" href="${esc(href)}" hx-get="${esc(href)}" ` +
      `hx-target="#insights-content" hx-push-url="true">${esc(text)} <span aria-label="Clear filter">&#215;</span></a>`
    );
  });
  const filterBar = active.length
    ? `<div class="insights-filter-bar"><span class="insights-group-label">Filters</span>${chips.join("")}` +
      `<a class="insights-clear-filters" href="${esc(base)}" hx-get="${esc(base)}" hx-target="#insights-content" hx-push-url="true">Clear filters</a></div>`
    : "";
  let filtered = [...run.traces];
  if (dimension && cluster)
    filtered = filtered.filter((trace) => {
      const assignment = trace.assignments[dimension];
      return (
        assignment !== undefined &&
        (assignment.base === cluster || assignment.top === cluster)
      );
    });
  if (label !== null && label !== undefined)
    filtered = filtered.filter((trace) => {
      const answer = trace.labels[label];
      return (
        answer !== undefined &&
        answer.error === null &&
        answer.value !== null &&
        (value === null ||
          value === undefined ||
          labelValueKey(run, label, answer.value) === value)
      );
    });
  if (row && rowValue !== null && rowValue !== undefined)
    filtered = filtered.filter(
      (trace) => crossValue(run, trace, row) === rowValue,
    );
  if (column && columnValue !== null && columnValue !== undefined)
    filtered = filtered.filter(
      (trace) => crossValue(run, trace, column) === columnValue,
    );
  if (!filtered.length)
    return (
      `${filterBar}<section class="insights-empty-state"><h3>No traces match these filters</h3>` +
      "<p>Clear a filter or choose a different cluster or label value.</p></section>"
    );
  const headings = [
    "Trace",
    "Time",
    ...run.config.dimensions,
    ...Object.keys(run.labels),
  ];
  if (!isSnapshot(run)) headings.push("Orq");
  const head = headings.map((item) => `<th>${esc(item)}</th>`).join("");
  const rows = await Promise.all(filtered.map((trace) => traceRow(run, trace)));
  return (
    `${filterBar}<div class="insights-table-wrap"><table class="insights-table"><thead><tr>${head}</tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table></div>`
  );
}

/** A top-level dimension or successful label value for a crosstab field. */
function crossValue(
  run: InsightsRun,
  trace: TraceInsight,
  field: string,
): string | null {
  const split = field.indexOf(":");
  const kind = split < 0 ? field : field.slice(0, split);
  const name = split < 0 ? "" : field.slice(split + 1);
  if (kind === "dimension") {
    const assignment = trace.assignments[name];
    if (assignment === undefined) return null;
    const cluster = run.dimensions[name]?.clusters.find(
      (item) => item.id === assignment.top,
    );
    return cluster ? cluster.name : assignment.top;
  }
  if (kind === "label") {
    const answer = trace.labels[name];
    return answer !== undefined &&
      answer.error === null &&
      answer.value !== null
      ? answerKey(run, name, answer.value)
      : null;
  }
  return null;
}

function crossFields(run: InsightsRun): [string, string][] {
  return [
    ...Object.keys(run.dimensions).map((name): [string, string] => [
      `dimension:${name}`,
      `${title(name)} cluster`,
    ]),
    ...Object.keys(run.labels).map((name): [string, string] => [
      `label:${name}`,
      name,
    ]),
  ];
}

export function crosstab(
  run: InsightsRun,
  query: Readonly<Record<string, string>>,
): string {
  const fields = crossFields(run);
  if (fields.length < 2)
    return '<section class="insights-empty-state"><h3>Crosstab unavailable</h3><p>Add at least two dimensions or labels to compare trace counts.</p></section>';
  const names = new Map(fields);
  const [defaultRow, defaultColumn] = [
    fields[0]?.[0] ?? "",
    fields[1]?.[0] ?? "",
  ];
  const row =
    query.row !== undefined && names.has(query.row) ? query.row : defaultRow;
  const fallbackColumn =
    fields.find(([key]) => key !== row)?.[0] ?? defaultColumn;
  const column =
    query.column !== undefined &&
    names.has(query.column) &&
    query.column !== row
      ? query.column
      : fallbackColumn;
  const values = (field: string) =>
    new Set(
      run.traces
        .map((trace) => crossValue(run, trace, field))
        .filter((v): v is string => v !== null),
    );
  const rows = ordered(run, row.replace(/^label:/, ""), values(row));
  const columns = ordered(run, column.replace(/^label:/, ""), values(column));
  if (!rows.length || !columns.length)
    return '<section class="insights-empty-state"><h3>No crosstab values</h3><p>No traces have readable values for both selected fields.</p></section>';
  const counts = new Map<string, number>();
  for (const trace of run.traces) {
    const y = crossValue(run, trace, row);
    const x = crossValue(run, trace, column);
    if (x !== null && y !== null)
      counts.set(
        JSON.stringify([y, x]),
        (counts.get(JSON.stringify([y, x])) ?? 0) + 1,
      );
  }
  const maximum = counts.size ? Math.max(...counts.values()) : 1;
  const cells = rows.flatMap((y) =>
    columns.map((x) => {
      const count = counts.get(JSON.stringify([y, x])) ?? 0;
      const href = `/insights/${runUrl(run)}/tab/traces?${form({ row, row_value: y, column, column_value: x })}`;
      return { x, y, count, text: String(count), href };
    }),
  );
  const heat = (scale: ColorScale) => scale.map(([, color]) => color);
  const spec = {
    data: { values: cells },
    layer: [
      {
        mark: { type: "rect", tooltip: true, cursor: "pointer" },
        encoding: {
          x: { field: "x", type: "nominal", title: names.get(column) },
          y: { field: "y", type: "nominal", title: names.get(row) },
          color: {
            field: "count",
            type: "quantitative",
            scale: { domain: [0, maximum], range: heat(ORQ_SCALE_HEAT) },
            legend: { title: "Trace count" },
          },
          href: { field: "href", type: "nominal" },
        },
      },
      {
        mark: { type: "text", fontSize: 11, color: COLORS.ink_700 },
        encoding: {
          x: { field: "x", type: "nominal" },
          y: { field: "y", type: "nominal" },
          text: { field: "text", type: "nominal" },
        },
      },
    ],
    width: { step: 100 },
    height: { step: 32 },
  };
  const option = (key: string, label: string, selected: boolean) =>
    `<option value="${esc(key)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const rowOptions = fields
    .map(([key, label]) => option(key, label, key === row))
    .join("");
  const columnOptions = fields
    .filter(([key]) => key !== row)
    .map(([key, label]) => option(key, label, key === column))
    .join("");
  const controls =
    `<form class="insights-chart-controls" hx-get="/insights/${runUrl(run)}/tab/crosstab" hx-target="#insights-content" hx-push-url="true">` +
    `<label>Rows <select name="row">${rowOptions}</select></label>` +
    `<label>Columns <select name="column">${columnOptions}</select></label>` +
    '<button type="submit" class="insights-action">Update</button></form>';
  return controls + renderEmbed(spec as never, "insights-crosstab");
}

export function priorityMatrix(run: InsightsRun): string {
  const points = run.priority;
  if (!points?.length) {
    const reason =
      run.priorityReason || "Priority data is not available for this run.";
    return `<section class="insights-empty-state"><h3>Priority matrix unavailable</h3><p>${esc(reason)}</p></section>`;
  }
  const volumes = points.map((point) => point.volume).sort((a, b) => a - b);
  const middle = Math.floor(volumes.length / 2);
  const medianVolume =
    volumes.length % 2
      ? (volumes[middle] ?? 0)
      : ((volumes[middle - 1] ?? 0) + (volumes[middle] ?? 0)) / 2;
  const xMax = Math.max(1, Math.max(...volumes) * 1.1);
  const xLeft = medianVolume / 2;
  const xRight = (medianVolume + xMax) / 2;
  const heat = ORQ_SCALE_HEAT.map(([, color]) => color);
  const spec = {
    data: {
      values: points.map((p) => ({
        name: p.name,
        volume: p.volume,
        satisfaction: p.meanSatisfaction,
        error_share: p.errorShare,
        cluster_id: p.clusterId,
      })),
    },
    layer: [
      {
        mark: { type: "circle", opacity: 0.82 },
        encoding: {
          x: {
            field: "volume",
            type: "quantitative",
            title: "Trace volume",
            scale: { domain: [0, xMax] },
          },
          y: {
            field: "satisfaction",
            type: "quantitative",
            title: "Mean satisfaction",
            scale: { domain: [0, 1] },
          },
          size: {
            field: "error_share",
            type: "quantitative",
            title: "Error share",
            scale: { range: [60, 900] },
          },
          color: {
            field: "error_share",
            type: "quantitative",
            scale: { domain: [0, 1], range: heat },
            legend: { title: "Error share" },
          },
          tooltip: [
            { field: "name" },
            { field: "volume" },
            { field: "satisfaction" },
            { field: "error_share" },
          ],
        },
      },
      {
        data: { values: [{ volume: medianVolume }] },
        mark: { type: "rule", strokeDash: [5, 4], color: COLORS.ink_700 },
        encoding: { x: { field: "volume", type: "quantitative" } },
      },
      {
        data: { values: [{ satisfaction: 0.5 }] },
        mark: { type: "rule", strokeDash: [5, 4], color: COLORS.ink_700 },
        encoding: { y: { field: "satisfaction", type: "quantitative" } },
      },
      {
        data: {
          values: [
            { x: xRight, y: 0.25, text: "fix first" },
            { x: xRight, y: 0.78, text: "watch" },
            { x: xLeft, y: 0.78, text: "fine" },
            { x: xLeft, y: 0.25, text: "niche" },
          ],
        },
        mark: {
          type: "text",
          fontSize: 12,
          fontWeight: "bold",
          color: COLORS.teal_400,
        },
        encoding: {
          x: { field: "x", type: "quantitative" },
          y: { field: "y", type: "quantitative" },
          text: { field: "text" },
        },
      },
    ],
    width: "container",
    height: 360,
  };
  return renderEmbed(spec as never, "insights-priority");
}

function mapEmpty(reason: string): string {
  return `<div class="insights-map-empty"><h4>Map unavailable: ${esc(reason)}</h4></div>`;
}

function dimensionMap(run: InsightsRun, dimensionName: string): string {
  const dimension = run.dimensions[dimensionName];
  if (dimension === undefined)
    return mapEmpty("This dimension is not part of the run.");
  const mapped = run.traces.filter((trace) =>
    Object.hasOwn(trace.coords, dimensionName),
  ).length;
  if (!mapped)
    return mapEmpty(
      dimension.warnings[0] ??
        "UMAP coordinates were not produced for this dimension.",
    );
  const options = [
    '<option value="cluster">Clusters</option>',
    ...Object.keys(run.dimensions)
      .filter((name) => name !== dimensionName)
      .map(
        (name) =>
          `<option value="dimension:${esc(name)}">${esc(title(name))} clusters</option>`,
      ),
    ...Object.keys(run.labels).map(
      (name) => `<option value="label:${esc(name)}">${esc(name)}</option>`,
    ),
    '<option value="agent">Agent</option>',
    '<option value="project">Project</option>',
  ];
  const id = q(run.runId);
  const dim = q(dimensionName);
  const chart =
    `<div id="insights-map-${dim}" class="insights-map-chart" ` +
    `data-run-id="${esc(run.runId)}" data-map-dimension="${esc(dimensionName)}" ` +
    `data-cluster-detail-url-template="/insights/${id}/cluster/{cluster_id}" ` +
    `data-map-url="/insights/${id}/map.json?dimension=${dim}&amp;color_by=cluster"></div>`;
  const detail =
    '<section class="insights-detail" data-map-detail><p class="insights-empty">Select a point to see its trace and cluster details.</p></section>';
  return (
    '<div class="insights-map-view"><div class="insights-map-toolbar">' +
    `<label>Colour by <select data-map-color data-dimension="${esc(dimensionName)}">${options.join("")}</select></label>` +
    `<span>${mapped} of ${run.traces.length} traces mapped \u00b7 UMAP 3D</span></div>` +
    `<div class="insights-map-layout">${chart}${detail}</div></div>`
  );
}

/** Every dimension's persisted UMAP projection in one expandable viewer. */
export function mapTab(
  run: InsightsRun,
  selected: string | null = null,
): string {
  const names = Object.keys(run.dimensions);
  if (!names.length) return mapEmpty("This run has no discovered dimensions.");
  const current =
    selected !== null && names.includes(selected) ? selected : (names[0] ?? "");
  const options = names
    .map(
      (name) =>
        `<option value="${esc(name)}"${name === current ? " selected" : ""}>${esc(title(name))}</option>`,
    )
    .join("");
  const panels = names
    .map(
      (name) =>
        `<div data-map-projection-panel="${esc(name)}"${name !== current ? " hidden" : ""}>${dimensionMap(run, name)}</div>`,
    )
    .join("");
  return (
    '<section class="insights-map-fullscreen-viewer"><div class="insights-map-head">' +
    "<div><h3>Trace map</h3><p>Each projection uses the embeddings for one discovered dimension. " +
    "Colour by clusters, another dimension, a label, agent, or project.</p></div>" +
    '<button type="button" class="insights-action" data-map-fullscreen>Full screen</button></div>' +
    `<div class="insights-map-projection"><label>Projection <select data-map-projection>${options}</select></label></div>` +
    `${panels}</section>`
  );
}

function mapCategory(
  run: InsightsRun,
  trace: TraceInsight,
  labelName: string | null,
  colorBy: string,
): string {
  if (labelName) {
    const answer = trace.labels[labelName];
    return answer && answer.error === null && answer.value !== null
      ? answerKey(run, labelName, answer.value)
      : "No value";
  }
  if (colorBy === "agent") return trace.agentName || "Unknown agent";
  return trace.project || "Unknown project";
}

const scaleList = (scale: ColorScale) =>
  scale.map(([stop, color]) => [stop, color]);

/** Keep one dimension's coordinates fixed while colouring by any saved axis. */
export function mapPayload(
  run: InsightsRun,
  dimensionName: string,
  colorBy = "cluster",
): Record<string, unknown> {
  const dimension = run.dimensions[dimensionName];
  if (dimension === undefined)
    return {
      points: [],
      missing_points: [],
      legend: [],
      color_scale: null,
      color_mode: "cluster",
      grid_color: COLORS.sand_400,
      background_color: COLORS.sand_100,
    };
  const colorDimension = colorBy.startsWith("dimension:")
    ? colorBy.slice("dimension:".length)
    : dimensionName;
  const labelName = colorBy.startsWith("label:")
    ? colorBy.slice("label:".length)
    : null;
  const labelSpec =
    labelName !== null ? (run.labels[labelName]?.spec ?? null) : null;
  if (colorBy.startsWith("label:") && labelSpec === null)
    return {
      error: `Unknown or unsupported colour label: ${labelName}`,
      points: [],
    };
  if (
    colorBy.startsWith("dimension:") &&
    run.dimensions[colorDimension] === undefined
  )
    return { error: `Unknown colour dimension: ${colorDimension}`, points: [] };
  if (
    !["cluster", "agent", "project"].includes(colorBy) &&
    !colorBy.startsWith("label:") &&
    !colorBy.startsWith("dimension:")
  )
    return { error: `Unknown colour axis: ${colorBy}`, points: [] };
  const categorical =
    colorBy === "agent" ||
    colorBy === "project" ||
    (labelSpec !== null && labelSpec.kind !== "score");
  const continuous = labelSpec !== null && labelSpec.kind === "score";
  const baseClusters = (run.dimensions[colorDimension]?.clusters ?? []).filter(
    (item) => item.level === "base",
  );
  const clusterById = new Map(baseClusters.map((item) => [item.id, item]));
  const clusterIndexes = new Map(
    baseClusters.map((item, index) => [item.id, index]),
  );
  const shapeIndexes = new Map(
    dimension.clusters
      .filter((item) => item.level === "base")
      .map((item, index) => [item.id, index]),
  );
  const categories = categorical
    ? new Set(
        run.traces.map((trace) => mapCategory(run, trace, labelName, colorBy)),
      )
    : new Set<string>();
  const orderedCategories = ordered(
    run,
    labelName,
    [...categories].filter((category) => category !== "No value"),
  );
  const categoryColors = new Map(
    orderedCategories.map((category, index) => [
      category,
      QUALITATIVE[index % QUALITATIVE.length] ?? "",
    ]),
  );
  const points: Record<string, unknown>[] = [];
  const missingPoints: Record<string, unknown>[] = [];
  const legend = new Map<string, Record<string, string>>();
  const satisfaction = (labelName ?? "").includes("satisfaction");
  for (const trace of run.traces) {
    const coords = trace.coords[dimensionName];
    if (coords === undefined) continue;
    const shapeIndex =
      shapeIndexes.get(trace.assignments[dimensionName]?.base ?? "") ?? -1;
    const clusterId = trace.assignments[colorDimension]?.base ?? "Unclassified";
    const symbol = shapeIndex >= 8 ? "diamond" : "circle";
    const clusterName = clusterById.get(clusterId)?.name ?? clusterId;
    const point: Record<string, unknown> = {
      trace_id: trace.traceId,
      span_id: trace.spanId,
      x: coords[0],
      y: coords[1],
      z: coords[2],
      cluster_id: clusterId,
      cluster_name: clusterName,
      symbol,
      summary: trace.summary ? trace.summary.summary : "",
      agent: trace.agentName,
      project: trace.project,
    };
    if (continuous) {
      const answer = trace.labels[labelName ?? ""];
      if (
        answer === undefined ||
        answer.error !== null ||
        typeof answer.value !== "number" ||
        !Number.isFinite(answer.value)
      ) {
        point.color = COLORS.sand_400;
        missingPoints.push(point);
        continue;
      }
      const value = Math.min(1, Math.max(0, answer.value));
      point.color_value = satisfaction ? 1 - value : value;
      point.color = "";
    } else if (categorical) {
      const category = mapCategory(run, trace, labelName, colorBy);
      const color = categoryColors.get(category) ?? COLORS.sand_400;
      Object.assign(point, {
        color_value: orderedCategories.indexOf(category),
        color,
        label_value: category,
      });
      if (!legend.has(category))
        legend.set(category, {
          cluster_id: category,
          name: category,
          color,
          symbol,
        });
    } else {
      const clusterIndex = clusterIndexes.get(clusterId) ?? -1;
      const color =
        clusterIndex >= 0 ? clusterColor(clusterIndex) : COLORS.sand_400;
      Object.assign(point, { color_value: clusterName, color });
      if (!legend.has(clusterId))
        legend.set(clusterId, {
          cluster_id: clusterId,
          name: clusterName,
          color,
          symbol,
        });
    }
    points.push(point);
  }
  return {
    points,
    missing_points: missingPoints,
    legend: continuous ? [] : [...legend.values()],
    color_scale: continuous
      ? scaleList(satisfaction ? ORQ_SCALE_GOOD_BAD : ORQ_SCALE_HEAT)
      : null,
    color_mode: continuous
      ? "continuous"
      : categorical
        ? "category"
        : "cluster",
    grid_color: COLORS.sand_400,
    background_color: COLORS.sand_100,
  };
}

function clusterColor(index: number): string {
  const base = QUALITATIVE[index % QUALITATIVE.length] ?? COLORS.sand_400;
  if (index < QUALITATIVE.length) return base;
  const target = COLORS.sand_100;
  const blend = 0.45;
  const channels = [1, 3, 5].map((offset) =>
    pyRound(
      Number.parseInt(base.slice(offset, offset + 2), 16) * (1 - blend) +
        Number.parseInt(target.slice(offset, offset + 2), 16) * blend,
    ),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export async function tabContent(
  run: InsightsRun,
  tab: string,
  query: Readonly<Record<string, string>> = {},
): Promise<string> {
  if (tab === "dimensions") return dimensions(run);
  if (tab === "labels") return labels(run);
  if (tab === "traces")
    return traces(run, {
      dimension: query.dimension,
      cluster: query.cluster,
      label: query.label,
      value: query.value,
      row: query.row,
      rowValue: query.row_value,
      column: query.column,
      columnValue: query.column_value,
    });
  if (tab === "map") return mapTab(run, query.dimension ?? null);
  if (tab === "crosstab") return crosstab(run, query);
  return priorityMatrix(run);
}

export function backToRuns(): string {
  return '<a class="report-back" href="/insights">\u2190 All Insights runs</a>';
}

export async function fullPage(
  run: InsightsRun,
  activeTab = "dimensions",
  options: {
    query?: Readonly<Record<string, string>>;
    manifest?: RunManifest | null;
  } = {},
): Promise<string> {
  const body =
    '<div class="insights-layout"><div class="insights-main">' +
    `${header(run)}${await failures(run)}${progress(options.manifest)}${tabs(run, activeTab)}` +
    `<div id="insights-content">${await tabContent(run, activeTab, options.query)}</div></div></div>`;
  return page(
    "Insights",
    `${body}<script src="/static/plotly-gl3d.min.js" defer></script>`,
    {
      activeNav: "insights",
      backHtml: backToRuns(),
    },
  );
}

function refreshIfRunning(entries: readonly RunEntry[]): string {
  return entries.some((entry) => entry[2] === "running")
    ? "<script>setTimeout(function(){location.reload()},3000)</script>"
    : "";
}

export async function overviewPage(
  entries: readonly RunEntry[],
  runs: ReadonlyMap<string, InsightsRun>,
  manifests: ReadonlyMap<string, RunManifest>,
): Promise<string> {
  const body = `<div class="insights-layout">${runOverview(entries, runs, manifests)}</div>`;
  return page("Insights", body + refreshIfRunning(entries), {
    activeNav: "insights",
    actionsHtml:
      '<a class="insights-overview-new" href="/insights/new">+ New Run</a>',
  });
}

export async function runningPage(
  runId: string,
  label: string,
  manifest: RunManifest,
): Promise<string> {
  let notice: string;
  if (manifest.status === "running")
    notice =
      `<section class="insights-empty-state"><h2>${esc(label)}</h2>` +
      "<p>This run updates every few seconds. Results appear when it finishes.</p></section>";
  else if (manifest.status === "error")
    notice =
      `<section class="insights-error" role="alert"><h2>${esc(label)} failed</h2>` +
      `<p>${esc(manifest.error || "The run stopped before a report was saved.")}</p></section>`;
  else
    notice = `<section class="insights-empty-state"><h2>${esc(label)}</h2><p>This run ended without a report file.</p></section>`;
  const body = `<div class="insights-layout"><div class="insights-main">${notice}${progress(manifest)}</div></div>`;
  const refresh =
    manifest.status === "running"
      ? refreshIfRunning([[runId, label, "running"]])
      : "";
  return page("Insights", body + refresh, {
    activeNav: "insights",
    backHtml: backToRuns(),
  });
}

export async function unreadablePage(error: string): Promise<string> {
  const body =
    '<div class="insights-layout"><div class="insights-main"><section class="insights-error"><h2>Run file is unreadable</h2>' +
    `<p>${esc(error)}</p></section></div></div>`;
  return page("Insights", body, {
    activeNav: "insights",
    backHtml: backToRuns(),
  });
}
