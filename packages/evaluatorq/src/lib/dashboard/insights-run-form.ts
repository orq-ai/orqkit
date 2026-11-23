import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { roleModel } from "../common/model-roles.js";
import { esc } from "../common/reports/html-helpers.js";
import {
  type DimensionName,
  defaultInsightsModels,
  type InsightsRunFields,
  LabelSpec,
  populationSource,
} from "../insights/models.js";
import { describeLocalSend } from "../insights/population.js";
import { CODING_LABELS, LABEL_PRESETS } from "../insights/presets.js";
import {
  MAX_SESSION_TEXT_CHARS,
  SESSION_SOURCES,
  type SessionSource,
} from "../local-sessions/models.js";
import {
  FACET_NAMES,
  type FacetCatalogue,
  FacetSelection,
} from "../trace-finder/models.js";
import {
  DEFAULT_TRACE_INPUT_CHARS,
  effectiveDashboardSettings,
} from "../trace-finder/settings.js";
import {
  camel,
  renderFacetChips,
  renderFacetMenu,
  selectedValues,
  windowCountNote,
} from "./facet-picker.js";
import {
  DEFAULT_TRACE_LIMIT,
  DEFAULT_WINDOW_DAYS,
  type FormSource,
  getFinderExportsDir,
  type InsightsLaunchSpec,
  SOURCE_BY_MODE,
  SOURCES,
  type Source,
} from "./insights-launch.js";
import {
  isUploadedSource,
  type RecentTraceFile,
  uploadKind,
} from "./insights-uploads.js";
import { backToRuns, snakeJson } from "./insights-views.js";
import { dateInput, dateRow } from "./native-dates.js";
import { icon, page } from "./shell.js";
import { STATIC_DIR } from "./static-assets.js";
import { modelControl } from "./view.js";

export type Mount = "page" | "dialog";
type ModelKind = "chat" | "classify" | "embedding";

export interface RunPreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly dimensions: readonly DimensionName[];
  readonly labels: readonly string[];
  readonly codingLabels: readonly string[];
}

const CODING_NAMES: readonly string[] = CODING_LABELS.slice(1).map(
  (spec) => spec.name,
);

export const RUN_PRESETS: readonly RunPreset[] = Object.freeze([
  {
    id: "failures",
    title: "Find failures",
    description: "Where does the agent go wrong?",
    dimensions: ["failure", "intent"],
    labels: ["made_errors", "user_frustration"],
    codingLabels: [],
  },
  {
    id: "intents",
    title: "Understand intents",
    description: "What do users come for?",
    dimensions: ["intent"],
    labels: [],
    codingLabels: [],
  },
  {
    id: "coding",
    title: "Coding agent",
    description: "Frustration, outcome, risky actions",
    dimensions: ["intent", "failure"],
    labels: ["user_frustration"],
    codingLabels: CODING_NAMES,
  },
]);

export const OFFERED_LABELS: readonly string[] = [
  "sentiment",
  "customer_satisfaction",
  "made_errors",
  "user_frustration",
];
export const OFFERED_DIMENSIONS: readonly DimensionName[] = [
  "intent",
  "failure",
  "sentiment",
];

export const QUESTION_TITLES: Readonly<Record<string, string>> = Object.freeze({
  sentiment: "Sentiment",
  customer_satisfaction: "Customer satisfaction",
  made_errors: "Assistant mistakes",
  user_frustration: "User frustration",
  task_type: "Task type",
  outcome: "Outcome",
  verified: "Verified",
  scope_creep: "Scope creep",
  user_corrections: "User corrections",
  unfixed_error: "Unfixed error",
  risky_action: "Risky action",
});

const DIMENSION_TEXT: Readonly<
  Record<DimensionName, readonly [string, string]>
> = {
  intent: ["Intent", "what users asked"],
  failure: ["Failure", "what went wrong"],
  sentiment: ["Sentiment", "how users felt"],
};

type FormTab = "orq" | "file" | "sessions";
const FILE_HINT = "A Finder export or a local trace file (JSON).";
const TAB_ICON = { cls: "irf-tab-icon", size: 14 };
const FORM_SOURCES: readonly (readonly [FormTab, string, string, string])[] = [
  [
    "orq",
    "Orq traces",
    "Analyze traces from your Orq workspace, optionally narrowed by a question.",
    icon(
      '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
      TAB_ICON,
    ),
  ],
  [
    "file",
    "Trace file",
    FILE_HINT,
    icon(
      '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/>',
      TAB_ICON,
    ),
  ],
  [
    "sessions",
    "Local sessions",
    "Claude Code, Claude desktop, Codex and omp sessions on this computer.",
    icon(
      '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62' +
        'a1 1 0 0 1-.9-1.45L4 16"/>',
      TAB_ICON,
    ),
  ],
];
const FORM_TABS = new Set<string>(FORM_SOURCES.map(([tab]) => tab));

const formTab = (source: FormSource): FormTab => SOURCES[source].tab;
const expandUser = (path: string) =>
  path.startsWith("~") ? join(process.env.HOME ?? "~", path.slice(1)) : path;

async function realDir(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function inFinderExports(path: string): Promise<boolean> {
  return (
    (await realDir(dirname(path))) === (await realDir(getFinderExportsDir()))
  );
}

/** An upload's stored name records its kind; any other file comes from a saved run, and only the Finder exports folder holds Finder exports. */
async function traceFileSource(traceFile: string): Promise<Source> {
  if (!traceFile) return "snapshot";
  const path = expandUser(traceFile);
  const kind = uploadKind(path);
  if (kind !== null) return kind;
  return (await inFinderExports(path)) ? "finder" : "snapshot";
}

function checkRegistries(): void {
  const problems: string[] = [];
  for (const name of OFFERED_LABELS)
    if (!(name in LABEL_PRESETS))
      problems.push(`offered label '${name}' is not in LABEL_PRESETS`);
  for (const name of [...OFFERED_LABELS, ...CODING_NAMES])
    if (!(name in QUESTION_TITLES))
      problems.push(`'${name}' has no entry in QUESTION_TITLES`);
  for (const preset of RUN_PRESETS) {
    for (const name of preset.labels)
      if (!(name in LABEL_PRESETS))
        problems.push(
          `preset '${preset.id}': label '${name}' is not in LABEL_PRESETS`,
        );
    for (const name of preset.codingLabels)
      if (!CODING_NAMES.includes(name))
        problems.push(
          `preset '${preset.id}': coding label '${name}' is not in CODING_LABELS[1:]`,
        );
  }
  if (
    new Set(RUN_PRESETS.map((preset) => preset.id)).size !== RUN_PRESETS.length
  )
    problems.push("RUN_PRESETS ids must be unique");
  if (problems.length) throw new Error(problems.join("; "));
}
checkRegistries();

export type FormInput =
  | URLSearchParams
  | FormData
  | Readonly<Record<string, unknown>>;

function getAll(form: FormInput, key: string): string[] {
  if (form instanceof URLSearchParams || form instanceof FormData)
    return form.getAll(key).map(String);
  const raw = form[key];
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function getOne(form: FormInput, key: string): string {
  if (form instanceof URLSearchParams || form instanceof FormData) {
    const value = form.get(key);
    return value === null ? "" : String(value);
  }
  const raw = form[key];
  return raw === undefined || raw === null ? "" : String(raw);
}

function wholeNumber(
  form: FormInput,
  key: string,
  fallback: number,
  label: string,
): number {
  const raw = getOne(form, key).trim();
  if (!raw) return fallback;
  if (!/^[+-]?\d+$/.test(raw))
    throw new Error(`${label} must be a whole number.`);
  return Number.parseInt(raw, 10);
}

function customLabels(raw: string): LabelSpec[] {
  let loaded: unknown;
  try {
    loaded = JSON.parse(raw || "[]");
  } catch {
    throw new Error("Custom questions must be valid JSON.");
  }
  if (!Array.isArray(loaded))
    throw new Error("Custom questions must be a JSON list.");
  try {
    return loaded.map((item) => new LabelSpec(item));
  } catch (error) {
    const issues = (error as { issues?: { message: string }[] }).issues;
    throw new Error(
      issues ? issues.map((issue) => issue.message).join("; ") : String(error),
    );
  }
}

function savedSource(population: Readonly<Record<string, unknown>>): Source {
  if (populationSource(population) === "snapshot") return "snapshot";
  if (population.finder_export ?? population.finderExport) return "finder";
  if (population.query) return "query";
  const source = SOURCE_BY_MODE[String(population.mode)];
  if (source === "finder") return "recent";
  if (source !== undefined) return source;
  if (population.mode === "finder") return "finder";
  return "recent";
}

async function savedFileUsable(
  source: Source,
  path: string,
  runsDir: string,
): Promise<boolean> {
  const isFile = await stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!isFile) return false;
  if (source === "snapshot") return true;
  return (
    (await isUploadedSource(runsDir, path)) || (await inFinderExports(path))
  );
}

export const INSIGHTS_MODEL_FIELDS: Readonly<
  Record<ModelField, readonly [ModelKind, string]>
> = Object.freeze({
  summaryModel: ["chat", "Summary model"],
  classifierModel: ["classify", "Classifier model"],
  embeddingModel: ["embedding", "Embedding model"],
  compilerModel: ["chat", "Question compiler"],
});
type ModelField =
  | "summaryModel"
  | "classifierModel"
  | "embeddingModel"
  | "compilerModel";
const MODEL_FIELDS = Object.keys(INSIGHTS_MODEL_FIELDS) as ModelField[];
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** What a run uses when the form does not choose: each Insights task's model role. */
function modelDefaults(): Record<ModelField, string> {
  const models = defaultInsightsModels();
  return {
    summaryModel: models.summary,
    classifierModel: models.classifier,
    embeddingModel: models.embedding,
    compilerModel: roleModel("fast", { task: "finder.compiler" }),
  };
}

const effectiveTraceInputChars = async () =>
  (await effectiveDashboardSettings()).traceInputChars;

export interface RunFormFields {
  source: FormSource;
  query: string;
  windowDays: number;
  limit: number;
  facets: FacetSelection;
  dimensions: readonly string[];
  labels: readonly string[];
  codingLabels: readonly string[];
  customLabels: readonly LabelSpec[];
  name: string;
  parallelism: number;
  traceInputChars: number;
  traceFile: string;
  sourceName: string;
  preset: string | null;
  mount: Mount;
  error: string | null;
  summaryModel: string;
  classifierModel: string;
  embeddingModel: string;
  compilerModel: string;
}

/** Everything the run form shows, so a rejected submission re-renders exactly what the user entered. */
export class RunFormValues implements RunFormFields {
  declare readonly source: FormSource;
  declare readonly query: string;
  declare readonly windowDays: number;
  declare readonly limit: number;
  declare readonly facets: FacetSelection;
  declare readonly dimensions: readonly string[];
  declare readonly labels: readonly string[];
  declare readonly codingLabels: readonly string[];
  declare readonly customLabels: readonly LabelSpec[];
  declare readonly name: string;
  declare readonly parallelism: number;
  declare readonly traceInputChars: number;
  declare readonly traceFile: string;
  declare readonly sourceName: string;
  declare readonly preset: string | null;
  declare readonly mount: Mount;
  declare readonly error: string | null;
  declare readonly summaryModel: string;
  declare readonly classifierModel: string;
  declare readonly embeddingModel: string;
  declare readonly compilerModel: string;

  constructor(fields: Partial<RunFormFields> = {}) {
    Object.assign(this, {
      source: "recent",
      query: "",
      windowDays: DEFAULT_WINDOW_DAYS,
      limit: DEFAULT_TRACE_LIMIT,
      facets: new FacetSelection(),
      dimensions: [],
      labels: [],
      codingLabels: [],
      customLabels: [],
      name: "",
      parallelism: 20,
      traceInputChars: DEFAULT_TRACE_INPUT_CHARS,
      traceFile: "",
      sourceName: "",
      preset: null,
      mount: "page",
      error: null,
      summaryModel: "",
      classifierModel: "",
      embeddingModel: "",
      compilerModel: "",
      ...fields,
    });
    Object.freeze(this);
  }

  with(update: Partial<RunFormFields>): RunFormValues {
    return new RunFormValues({ ...this, ...update });
  }

  /** The first preset applied to Recent traces: 7 days, 200 traces. */
  static async defaults(): Promise<RunFormValues> {
    const preset = RUN_PRESETS[0] as RunPreset;
    return new RunFormValues({
      dimensions: preset.dimensions,
      labels: preset.labels,
      codingLabels: preset.codingLabels,
      preset: preset.id,
      ...modelDefaults(),
      traceInputChars: await effectiveTraceInputChars(),
    });
  }

  /** Prefill the form from a saved run; a file source that is gone is cleared and a fresh one requested. */
  static async fromRun(
    run: InsightsRunFields,
    runsDir: string,
  ): Promise<RunFormValues> {
    const population = run.population as Readonly<Record<string, unknown>>;
    let source = savedSource(population);
    if (source === "recent" && populationSource(population) === "export")
      source = "finder";
    const savedPath = String(
      population.snapshot_path ||
        population.snapshotPath ||
        population.finder_export ||
        population.finderExport ||
        "",
    );
    const fileBacked = source === "finder" || source === "snapshot";
    const usable =
      Boolean(savedPath) &&
      (await savedFileUsable(source, expandUser(savedPath), runsDir));
    const codingNames = new Set(CODING_LABELS.map((spec) => spec.name));
    const configured = new Set(run.config.labels.map((spec) => spec.name));
    let coding = run.config.codingLabels.map((spec) => spec.name);
    if (run.config.codingAnalysis && !coding.length) coding = [...CODING_NAMES];
    const custom = run.config.labels.filter(
      (spec) => !(spec.name in LABEL_PRESETS) && !codingNames.has(spec.name),
    );
    const keptPath = fileBacked && usable ? savedPath : "";
    const windowDays = population.window_days ?? population.windowDays;
    return new RunFormValues({
      source,
      query: String(population.query || ""),
      windowDays:
        windowDays === undefined
          ? DEFAULT_WINDOW_DAYS
          : Math.trunc(Number(windowDays)),
      limit:
        population.limit === undefined
          ? DEFAULT_TRACE_LIMIT
          : Math.trunc(Number(population.limit)),
      facets: new FacetSelection(population.facets || {}),
      dimensions: [...run.config.dimensions],
      labels: Object.keys(LABEL_PRESETS).filter((name) => configured.has(name)),
      codingLabels: coding,
      customLabels: custom,
      name: run.runName,
      summaryModel: run.config.summaryModel,
      classifierModel: run.config.classifierModel,
      embeddingModel: run.config.embeddingModel,
      compilerModel: run.config.compilerModel || modelDefaults().compilerModel,
      traceInputChars: run.config.traceInputChars,
      traceFile: keptPath,
      sourceName: keptPath
        ? String(population.source_name || population.sourceName || "")
        : "",
      error:
        fileBacked && !usable
          ? "The original local file is no longer available. Browse for a fresh file to continue."
          : null,
    });
  }

  /** Parse the form fields from `FormData` or query parameters; throws on malformed numbers or JSON. */
  static async fromForm(form: FormInput): Promise<RunFormValues> {
    const mount: Mount = getOne(form, "mount") === "dialog" ? "dialog" : "page";
    const tab = getOne(form, "source") || "orq";
    if (!FORM_TABS.has(tab))
      throw new Error("Choose Orq traces, Trace file or Local sessions.");
    // Fields of the tab that is not chosen are still in the submitted form; drop them so they are never saved.
    const orq = tab === "orq";
    const orqForm: FormInput = orq ? form : {};
    const fileForm: FormInput = orq ? {} : form;
    const query = getOne(orqForm, "query").trim();
    const traceFile = getOne(fileForm, "trace_file").trim();
    let source: FormSource;
    if (orq) source = query ? "query" : "recent";
    // The Local sessions tab freezes its selection into a snapshot upload in the same `trace_file` field.
    else
      source =
        tab === "sessions" ? "sessions" : await traceFileSource(traceFile);
    const defaults = modelDefaults();
    const models = Object.fromEntries(
      MODEL_FIELDS.map((name) => [
        name,
        getOne(form, snake(name)).trim() || defaults[name],
      ]),
    ) as Record<ModelField, string>;
    if (source !== "query") models.compilerModel = defaults.compilerModel;
    const traceInputRaw = getOne(form, "trace_input_chars").trim();
    return new RunFormValues({
      source,
      query,
      windowDays: wholeNumber(
        orqForm,
        "window_days",
        DEFAULT_WINDOW_DAYS,
        "Window",
      ),
      limit: wholeNumber(orqForm, "limit", DEFAULT_TRACE_LIMIT, "Trace limit"),
      facets: new FacetSelection(
        Object.fromEntries(
          FACET_NAMES.map((name) => [
            camel(name),
            getAll(orqForm, `facet_${name}`),
          ]),
        ),
      ),
      dimensions: getAll(form, "dimensions"),
      labels: getAll(form, "labels"),
      codingLabels: getAll(form, "coding_labels"),
      customLabels: customLabels(getOne(form, "custom_labels_json") || "[]"),
      name: getOne(form, "name"),
      parallelism: wholeNumber(form, "parallelism", 20, "Parallel requests"),
      traceInputChars: traceInputRaw
        ? wholeNumber(form, "trace_input_chars", 0, "Model input cap")
        : await effectiveTraceInputChars(),
      traceFile,
      sourceName: getOne(form, "source_name"),
      preset: getOne(form, "preset") || null,
      mount,
      ...models,
    });
  }

  /** The fields `InsightsLaunchSpec.create` reads. */
  launchFields(): Record<string, unknown> {
    return {
      name: this.name,
      source: this.source === "sessions" ? "snapshot" : this.source,
      query: this.query,
      finder_export: this.source === "finder" ? this.traceFile : "",
      snapshot_path:
        this.source === "snapshot" || this.source === "sessions"
          ? this.traceFile
          : "",
      source_name: this.sourceName,
      window_days: this.windowDays,
      limit: this.limit,
      facets: Object.fromEntries(
        FACET_NAMES.map((name) => [
          name,
          [...selectedValues(this.facets, name)].sort(),
        ]),
      ),
      parallelism: this.parallelism,
      trace_input_chars: this.traceInputChars,
      labels: [...this.labels],
      coding_labels: [...this.codingLabels],
      custom_labels: this.customLabels.map((spec) => snakeJson(spec)),
      dimensions: [...this.dimensions],
      ...Object.fromEntries(
        MODEL_FIELDS.map((name) => [snake(name), this[name]]),
      ),
    };
  }
}

const hasFacets = (selection: FacetSelection) =>
  FACET_NAMES.some((name) => selectedValues(selection, name).size > 0);

/** Render the filter picker for an Insights window, with Orq's per-value counts and the selected values as chips. */
export function facetOptions(
  catalogue: FacetCatalogue | null,
  selection: FacetSelection,
  options: {
    profileName?: string | null;
    credentialRejected?: boolean;
    windowDays?: number | null;
  } = {},
): string {
  const {
    profileName = null,
    credentialRejected = false,
    windowDays = null,
  } = options;
  let unavailable = "";
  if (catalogue === null && credentialRejected) {
    let credential: string;
    if (profileName === "CLI OAuth")
      credential =
        "Orq rejected the CLI OAuth sign-in. Run <code>orq auth login</code> and try again.";
    else if (profileName === "Saved API key")
      credential =
        "Orq rejected the API key entered in Settings. Enter a key with trace access and Save.";
    else if (profileName === "ORQ_API_KEY" || !profileName)
      credential =
        "Orq rejected the dashboard Environment credentials for this workspace. Check " +
        "<code>ORQ_API_KEY</code> and <code>ORQ_BASE_URL</code>.";
    else
      credential =
        `Orq rejected the key for profile <code>${esc(profileName)}</code>. Check that this profile ` +
        "has trace access to the workspace selected in Settings.";
    unavailable =
      `<p class="insights-facet-unavailable" role="status">${credential} In ` +
      '<a href="/settings" target="_blank" rel="noopener">Settings → Authentication</a>, choose a ' +
      "matching profile or workspace, Save, then click " +
      '<button type="button" data-retry-facets>Retry</button>. Your selected filters are kept.</p>';
  } else if (catalogue === null)
    unavailable =
      '<p class="insights-facet-unavailable" role="status">Could not load filter choices from Orq. ' +
      'In <a href="/settings" target="_blank" rel="noopener">Settings → Authentication</a>, select an Orq ' +
      "profile with trace access and Save. If you use the environment API key, set <code>ORQ_API_KEY</code> for the " +
      'dashboard and restart it. Then click <button type="button" data-retry-facets>Retry</button>. ' +
      "Your selected filters are kept.</p>";
  if (catalogue === null && !hasFacets(selection)) return unavailable;
  const menu = renderFacetMenu(catalogue, {
    formId: "insights-new-form",
    selection,
    includeNumeric: false,
    counts: catalogue !== null ? catalogue.valueCounts : null,
    countNote: windowCountNote(windowDays),
  } as Parameters<typeof renderFacetMenu>[1]);
  return (
    `${unavailable}<div class="finder-controls insights-filter-picker">` +
    '<span class="addwrap"><button class="add" type="button" aria-haspopup="true" ' +
    'aria-label="Add a trace filter">+ Filter</button>' +
    `${menu}</span><div class="insights-selected-facets" aria-live="polite">` +
    `${renderFacetChips(selection, null, { removable: true })}</div></div>`
  );
}

function kindHint(spec: LabelSpec): string {
  if (spec.kind === "noul") return "yes / no";
  if (spec.kind === "score") return "score";
  return spec.criteria && !Array.isArray(spec.criteria)
    ? Object.keys(spec.criteria).join(", ")
    : "one of a list";
}

const LABEL_NOTES: Readonly<Record<string, string>> = {
  customer_satisfaction: "the priority matrix needs this",
};
const preset = (name: string) =>
  (LABEL_PRESETS as Readonly<Record<string, LabelSpec>>)[name];

function labelHint(name: string): string {
  const hint = kindHint(preset(name) as LabelSpec);
  return name in LABEL_NOTES ? `${hint} · ${LABEL_NOTES[name]}` : hint;
}

function toggle(
  name: string,
  spec: LabelSpec | null,
  value: string,
  title: string,
  hint: string,
  checked: boolean,
): string {
  const tooltip = spec !== null ? `${spec.instructions} (${hint})` : hint;
  return (
    `<label class="tg" title="${esc(tooltip)}"><input type="checkbox" name="${name}" value="${esc(value)}"` +
    `${checked ? " checked" : ""}><span class="tg-title">${esc(title)}</span><small>${esc(hint)}</small></label>`
  );
}

function questionTitle(name: string): string {
  if (QUESTION_TITLES[name]) return QUESTION_TITLES[name];
  const text = name.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function customChips(specs: readonly LabelSpec[]): string {
  return specs
    .map(
      (spec) =>
        `<span class="tg on" data-custom="${esc(spec.name)}"><span class="tg-title">${esc(spec.name)}</span>` +
        `<small>custom</small><button type="button" data-cq-remove="${esc(spec.name)}" ` +
        `aria-label="Remove question ${esc(spec.name)}">&times;</button></span>`,
    )
    .join("");
}

function presetButtons(values: RunFormValues): string {
  return RUN_PRESETS.map((item) => {
    const on = values.preset === item.id;
    return (
      `<button type="button" class="preset${on ? " on" : ""}" data-preset="${esc(item.id)}" ` +
      `data-dimensions="${esc(item.dimensions.join(" "))}" data-labels="${esc(item.labels.join(" "))}" ` +
      `data-coding-labels="${esc(item.codingLabels.join(" "))}" aria-pressed="${on}">` +
      `<b>${esc(item.title)}</b><span>${esc(item.description)}</span></button>`
    );
  }).join("");
}

function fileSource(values: RunFormValues): string {
  // The Local sessions tab freezes into the same trace_file field; only the Trace file tab shows it here.
  const chosen = formTab(values.source) === "file" ? values.traceFile : "";
  const shown = chosen ? values.sourceName || basename(chosen) : "";
  const status = !chosen
    ? FILE_HINT
    : values.source === "finder"
      ? "Finder export is ready."
      : "Trace snapshot is ready.";
  return (
    '<div class="irf-field" data-source="file"><span class="irf-label">Trace file</span>' +
    '<div class="irf-file"><input type="text" readonly data-file-name="file" aria-label="Selected trace file" ' +
    `placeholder="No file chosen" value="${esc(shown)}">` +
    '<button type="button" class="irf-btn" data-browse>Browse…</button>' +
    '<input type="file" accept="application/json,.json" data-file hidden></div>' +
    `<p class="irf-hint" role="status" data-file-status>${esc(status)}</p>` +
    "<h4>Recent trace files</h4>" +
    '<p class="irf-hint">Uploaded copies are kept for seven days after the last run. ' +
    "Your browser shares the filename, not the original file location.</p>" +
    '<div data-recent-files aria-live="polite"><p class="insights-muted">Loading recent files…</p></div></div>'
  );
}

/** Render selectable approved files without exposing a fictional original path. */
export function renderRecentFiles(files: readonly RecentTraceFile[]): string {
  if (!files.length)
    return '<p class="insights-muted">No recent trace files. Browse to upload a JSON file.</p>';
  const rows = files
    .map(
      (item) =>
        '<tr><td data-label="Filename"><button type="button" class="irf-btn" data-recent-file ' +
        `data-path="${esc(item.path)}" data-kind="${item.kind}" data-display-name="${esc(item.displayName)}">` +
        `${esc(item.displayName)}</button></td><td data-label="Saved / last used">${esc(item.date)}</td>` +
        `<td data-label="Traces">${item.traceCount.toLocaleString("en-US")}</td>` +
        `<td data-label="Kind">${item.kind === "finder" ? "Finder export" : "Trace snapshot"}</td></tr>`,
    )
    .join("");
  return (
    '<div class="insights-table-wrap"><table class="insights-table">' +
    '<caption class="irf-hint">Newest files first</caption>' +
    '<thead><tr><th scope="col">Filename</th><th scope="col">Saved / last used</th><th scope="col">Traces</th>' +
    `<th scope="col">Kind</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

const SESSION_SOURCE_TITLES: Readonly<Record<SessionSource, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude desktop",
  codex: "Codex",
  omp: "omp",
};
if (SESSION_SOURCES.some((source) => !(source in SESSION_SOURCE_TITLES)))
  throw new Error("SESSION_SOURCE_TITLES must list every session source");

function sessionsSource(values: RunFormValues): string {
  const boxes = Object.entries(SESSION_SOURCE_TITLES)
    .map(
      ([source, title]) =>
        `<label class="filter-checkbox"><input type="checkbox" name="session_source" value="${source}" checked><span>${esc(title)}</span></label>`,
    )
    .join("");
  const kept = values.source === "sessions" ? values.traceFile : "";
  const status = kept
    ? `Using the sessions selected earlier (${values.sourceName}). Search again to change them.`
    : "";
  const range = {
    cssClass: "xr-range irf-session-date-row",
    labelTag: "label",
  };
  const fromDate = dateRow(
    "From",
    dateInput({
      controlId: "session-from",
      name: "session_from",
      label: "From date",
    }),
    range,
  );
  const toDate = dateRow(
    "To",
    dateInput({
      controlId: "session-to",
      name: "session_to",
      label: "To date",
    }),
    range,
  );
  return (
    '<div class="irf-field" data-source="sessions"><span class="irf-label">Local sessions</span>' +
    `<div class="irf-session-sources" role="group" aria-label="Session sources">${boxes}</div>` +
    '<details class="xr-time-menu irf-session-time-menu"><summary><span class="xr-time-label" data-session-range-label>Last 7 days</span></summary>' +
    '<div class="xr-time-options"><div class="xr-presets" role="group" aria-label="Session date range">' +
    '<button type="button" class="xr-preset" data-session-preset="7" aria-pressed="true">Last 7 days</button>' +
    '<button type="button" class="xr-preset" data-session-preset="30" aria-pressed="false">Last 30 days</button>' +
    '<button type="button" class="xr-preset" data-session-preset="all" aria-pressed="false">All dates</button></div>' +
    '<details class="xr-exact"><summary>Custom range</summary><div class="xr-range-fields">' +
    `${fromDate}${toDate}<button type="button" class="xr-apply" data-session-apply>Apply range</button></div></details></div></details>` +
    '<div class="irf-field"><label class="irf-label" for="session-project-dir">Project directory</label>' +
    '<div class="irf-directory-row"><input id="session-project-dir" type="text" name="session_project_dir" placeholder="All recorded projects" aria-describedby="session-directory-hint">' +
    '<button type="button" class="irf-btn" data-folder-open>Browse…</button></div>' +
    '<p class="irf-hint" id="session-directory-hint">Includes projects below this directory and linked worktrees. Blank searches every recorded project; ~ means your home directory. Browsing uses the dashboard machine.</p></div>' +
    '<section class="irf-folder-browser" data-folder-browser aria-label="Browse project directories" aria-busy="false" hidden>' +
    '<nav class="irf-folder-crumbs" aria-label="Directory path" data-folder-breadcrumbs></nav>' +
    '<div class="irf-folder-toolbar"><button type="button" class="irf-btn" data-folder-home>Home</button>' +
    '<button type="button" class="irf-btn" data-folder-parent disabled>Parent</button><span class="irf-folder-current" data-folder-current></span></div>' +
    '<div class="irf-folder-list" role="list" data-folder-list></div>' +
    '<button type="button" class="irf-btn" data-folder-more hidden>Load more folders</button>' +
    '<p class="irf-folder-error" data-folder-error role="status" hidden></p>' +
    '<div class="irf-editor-actions"><button type="button" class="irf-btn" data-folder-cancel>Cancel</button>' +
    '<button type="button" class="irf-btn" data-folder-use disabled>Use this folder</button></div></section>' +
    '<label class="irf-field"><span class="irf-label">Contains text</span>' +
    `<input type="text" name="session_text" maxlength="${MAX_SESSION_TEXT_CHARS}"><span class="irf-hint">Case-insensitive literal text, not a regular expression. Limit ${MAX_SESSION_TEXT_CHARS} characters.</span></label>` +
    '<div class="irf-editor-actions"><button type="button" class="irf-btn" data-sessions-search>Search</button></div>' +
    '<div id="insights-sessions" aria-live="polite" aria-busy="false"></div>' +
    `<p class="irf-hint" data-sessions-status role="status">${esc(status)}</p>` +
    `<input type="hidden" data-file-name="sessions" value="${esc(kept ? values.sourceName : "")}"></div>`
  );
}

function facetPicker(values: RunFormValues): string {
  if (hasFacets(values.facets))
    return facetOptions(
      { valueCounts: {} } as unknown as FacetCatalogue,
      values.facets,
      { windowDays: values.windowDays },
    );
  return '<p class="insights-muted" role="status">Loading filter values…</p>';
}

function stepOne(values: RunFormValues): string {
  const tab = formTab(values.source);
  const sources = FORM_SOURCES.map(
    ([source, title, hint, svg]) =>
      `<label title="${esc(hint)}"><input type="radio" name="source" value="${source}"` +
      `${tab === source ? " checked" : ""}><span>${svg}${esc(title)}</span></label>`,
  ).join("");
  return (
    '<section class="irf-step" data-step="1"><h3>Which traces?</h3>' +
    `<div class="seg" role="radiogroup" aria-label="Where the traces come from">${sources}</div>` +
    '<label class="irf-field" data-source="orq"><span class="irf-label">Question <i>(optional)</i></span>' +
    '<textarea name="query" rows="3" maxlength="500" placeholder="Which conversations are about refunds?">' +
    `${esc(values.query)}</textarea>` +
    '<span class="irf-hint">The classifier reads each trace in the window and keeps only the ones that match. ' +
    "Leave it blank to analyze every trace in the window.</span></label>" +
    `${fileSource(values)}${sessionsSource(values)}` +
    '<div id="insights-snapshot-preview" data-source="file sessions" aria-live="polite"></div>' +
    '<div class="irf-row" data-source="orq">' +
    `<label>Last <input name="window_days" type="number" min="1" max="90" value="${values.windowDays}"> days, up to</label>` +
    `<label><input name="limit" type="number" min="1" max="5000" value="${values.limit}"> traces</label></div>` +
    '<div class="irf-facets" data-source="orq"><span class="irf-label">Only traces with</span>' +
    `<div id="insights-facet-options" aria-live="polite">${facetPicker(values)}</div></div>` +
    "</section>"
  );
}

const QUESTION_EDITOR =
  '<div class="card irf-editor" data-cq-editor hidden>' +
  '<label class="irf-field"><span class="irf-label">Name</span>' +
  '<input data-cq="name" maxlength="64" placeholder="needs_human_follow_up"></label>' +
  '<label class="irf-field"><span class="irf-label">Answer type</span><select data-cq="kind">' +
  '<option value="noul">Yes / no</option><option value="choice">One of a list</option>' +
  '<option value="score">Score 1&ndash;5</option></select></label>' +
  '<label class="irf-field"><span class="irf-label">Question</span>' +
  '<textarea data-cq="text" rows="2" placeholder="Should a human follow up on this conversation?"></textarea></label>' +
  '<label class="irf-field" data-cq-criteria hidden><span class="irf-label">Answer options</span>' +
  '<textarea data-cq="criteria" rows="5" aria-label="Answer options, one per line"></textarea></label>' +
  '<p class="insights-error" role="alert" data-cq-error hidden></p>' +
  '<div class="irf-editor-actions"><button type="button" class="irf-btn primary" data-cq-add>Add question</button>' +
  '<button type="button" class="irf-btn" data-cq-cancel>Cancel</button></div></div>';

function stepTwo(values: RunFormValues): string {
  const dimensions = OFFERED_DIMENSIONS.map((name) =>
    toggle(
      "dimensions",
      null,
      name,
      DIMENSION_TEXT[name][0],
      DIMENSION_TEXT[name][1],
      values.dimensions.includes(name),
    ),
  ).join("");
  const extra = values.labels.filter((name) => !OFFERED_LABELS.includes(name));
  const labels = [...OFFERED_LABELS, ...extra]
    .filter((name) => preset(name) !== undefined)
    .map((name) =>
      toggle(
        "labels",
        preset(name) as LabelSpec,
        name,
        questionTitle(name),
        labelHint(name),
        values.labels.includes(name),
      ),
    )
    .join("");
  const coding = CODING_LABELS.slice(1)
    .map((spec) =>
      toggle(
        "coding_labels",
        spec,
        spec.name,
        questionTitle(spec.name),
        kindHint(spec),
        values.codingLabels.includes(spec.name),
      ),
    )
    .join("");
  const hiddenHint = values.labels.includes("made_errors") ? " hidden" : "";
  return (
    '<section class="irf-step" data-step="2"><h3>What should Insights find?</h3>' +
    `<h4>Presets</h4><div class="presets">${presetButtons(values)}</div>` +
    `<h4>Group traces by</h4><div class="toggles">${dimensions}</div>` +
    `<h4>Ask about every trace</h4><div class="toggles">${labels}` +
    `<span class="irf-custom-list" data-custom-list>${customChips(values.customLabels)}</span>` +
    '<button type="button" class="tg tg-add" data-cq-open>+ Write your own question</button></div>' +
    QUESTION_EDITOR +
    `<p class="irf-hint" data-hint-made-errors${hiddenHint}>Without “Assistant mistakes”, the error share is estimated ` +
    "from the summaries instead of asked directly.</p>" +
    `<h4>Coding agent questions</h4><div class="toggles">${coding}</div>` +
    "</section>"
  );
}

function modelPickers(values: RunFormValues): string {
  return MODEL_FIELDS.map((field) => {
    const name = snake(field);
    const label = INSIGHTS_MODEL_FIELDS[field][1];
    const value = values[field];
    const fallback = modelControl(name, value, {}, { label });
    const scope = field === "compilerModel" ? " data-compiler-model" : "";
    const hidden =
      field === "compilerModel" && !values.query.trim() ? " hidden" : "";
    const query = new URLSearchParams({
      field: name,
      [name]: value,
    }).toString();
    return (
      `<div class="irf-field"${scope}${hidden}><label class="irf-label" for="${name}">${esc(label)}</label>` +
      `<span hx-get="/insights/models?${esc(query)}" hx-trigger="load" ` +
      `hx-include="find input" hx-swap="outerHTML">${fallback}</span></div>`
    );
  }).join("");
}

function stepThree(values: RunFormValues): string {
  return (
    '<section class="irf-step" data-step="3"><h3>Review and start</h3>' +
    '<label class="irf-field"><span class="irf-label">Run name <i>(optional)</i></span>' +
    `<input name="name" type="text" maxlength="80" placeholder="Weekly support review" value="${esc(values.name)}"></label>` +
    `<div id="insights-run-models">${modelPickers(values)}</div>` +
    '<label class="irf-field"><span class="irf-label">Parallel requests</span>' +
    `<input name="parallelism" type="number" min="1" max="200" value="${values.parallelism}"></label>` +
    '<div class="irf-review" hidden>' +
    '<div id="insights-run-plan" class="irf-plan" role="status" aria-live="polite"></div>' +
    '<div id="insights-run-estimate"></div></div>' +
    '<p class="irf-hint">The run reads the selected traces and makes model requests. Progress appears on its run page.</p>' +
    "</section>"
  );
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  return value;
}

/** Render the three-step form; `insights-run-form.js` only controls presentation. */
export function renderRunForm(
  values: RunFormValues,
  options: { csrf: string; error?: string | null },
): string {
  const message = options.error || values.error;
  const customJson = JSON.stringify(
    values.customLabels.map((spec) => withoutNulls(snakeJson(spec))),
  );
  const steps = ["Traces", "Analysis", "Review"]
    .map((title, index) =>
      index === 0
        ? `<li class="active" aria-current="step">1 · ${title}</li>`
        : `<li>${index + 1} · ${title}</li>`,
    )
    .join("");
  const kind = values.traceFile
    ? values.source === "sessions"
      ? "snapshot"
      : values.source
    : "";
  return (
    '<form id="insights-new-form" class="insights-run-form" method="post" action="/insights/runs" ' +
    `data-mount="${values.mount}">` +
    `<input type="hidden" name="csrf" value="${esc(options.csrf)}">` +
    `<input type="hidden" name="mount" value="${values.mount}">` +
    `<input type="hidden" name="preset" value="${esc(values.preset || "")}">` +
    `<input type="hidden" name="custom_labels_json" value="${esc(customJson)}">` +
    `<input type="hidden" name="trace_input_chars" value="${values.traceInputChars}">` +
    `<input type="hidden" name="trace_file" value="${esc(values.traceFile)}" data-kind="${kind}">` +
    `<ol class="irf-steps" aria-label="Steps">${steps}</ol>` +
    '<p id="insights-run-compact" class="irf-compact" role="status" aria-live="polite">Estimating traces, cost and time…</p>' +
    `<p id="insights-run-error" class="insights-error" role="alert"${message ? "" : " hidden"}>${esc(message || "")}</p>` +
    `${stepOne(values)}${stepTwo(values)}${stepThree(values)}` +
    '<div class="irf-actions"><button type="button" class="irf-btn" data-irf-back>Back</button>' +
    '<button type="button" class="irf-btn primary" data-irf-next>Continue</button>' +
    '<button type="submit" class="irf-btn start" data-irf-start>Start run</button></div>' +
    "</form>"
  );
}

/** The deferred `insights-run-form.js` tag, versioned by content so a stale cached copy is never used. */
export async function runFormScriptTag(): Promise<string> {
  let version: string;
  try {
    version = createHash("sha256")
      .update(await readFile(join(STATIC_DIR, "insights-run-form.js")))
      .digest("hex")
      .slice(0, 12);
  } catch {
    version = "missing";
  }
  return `<script src="/static/insights-run-form.js?v=${version}" defer></script>`;
}

/** Render the full new-run page around the form. */
export async function renderRunPage(
  values: RunFormValues,
  options: { csrf: string; error?: string | null },
): Promise<string> {
  const body =
    '<div class="insights-layout"><div class="insights-main insights-run-page">' +
    '<header class="insights-run-head"><h2>New Insights run</h2>' +
    "<p>Choose the traces and what to learn from them.</p></header>" +
    `${renderRunForm(values, options)}</div></div>${await runFormScriptTag()}`;
  return page("New Insights run", body, {
    activeNav: "insights",
    backHtml: backToRuns(),
  });
}

function sourceSummary(spec: InsightsLaunchSpec, source: FormSource): string {
  const days = `${spec.windowDays} day${spec.windowDays === 1 ? "" : "s"}`;
  const filtered = FACET_NAMES.reduce(
    (sum, name) => sum + selectedValues(spec.facets, name).size,
    0,
  );
  const filters = filtered
    ? `, ${filtered} filter value${filtered === 1 ? "" : "s"}`
    : "";
  if (spec.source === "query")
    return `Orq traces matching “${spec.query.trim()}” from the last ${days}, up to ${spec.limit}${filters}`;
  if (spec.source === "finder")
    return `Trace file ${spec.sourceName || basename(spec.finderExport)} (Finder export)`;
  if (spec.source === "snapshot") {
    if (source === "sessions")
      return `${spec.sourceName || SOURCES.sessions.label} from this computer`;
    return `Trace file ${spec.sourceName || basename(spec.snapshotPath)}`;
  }
  return `Orq traces from the last ${days}, up to ${spec.limit}${filters}`;
}

/**
 * Summarize what the run will do and list its expected stages, as the worker will report them. `source` is the
 * form source when it differs from the launch spec's (Local sessions launch as a snapshot); a local-file source
 * also states what leaves the machine when `nTraces` and `nBytes` are known.
 */
export function renderPlan(
  spec: InsightsLaunchSpec,
  stages: readonly (readonly [string, string])[],
  options: {
    source?: FormSource | null;
    nTraces?: number | null;
    nBytes?: number | null;
  } = {},
): string {
  const { source = null, nTraces = null, nBytes = null } = options;
  const questions =
    spec.labels.length + spec.customLabels.length + spec.codingLabels.length;
  const groupings = spec.dimensions.length;
  const summary =
    `${sourceSummary(spec, source || spec.source)}. ${questions} question${questions === 1 ? "" : "s"}, ` +
    `${groupings} grouping${groupings === 1 ? "" : "s"}.`;
  let send = "";
  if (spec.source === "snapshot" && nTraces !== null && nBytes !== null) {
    const note = describeLocalSend({
      nTraces,
      nBytes,
      fileName: spec.sourceName || basename(spec.snapshotPath),
      models: {
        summary: spec.summaryModel,
        classifier: spec.classifierModel,
        embedding: spec.embeddingModel,
      },
    } as Parameters<typeof describeLocalSend>[0]);
    send = `<p class="irf-summary" data-local-send>${esc(note)}</p>`;
  }
  const items = stages.map(([, title]) => `<li>${esc(title)}</li>`).join("");
  return `<p class="irf-summary">${esc(summary)}</p>${send}<h4>Expected stages</h4><ol class="irf-stages">${items}</ol>`;
}
