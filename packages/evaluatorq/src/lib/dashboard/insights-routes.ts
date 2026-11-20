import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ModelInfo } from "../common/model-catalogue.js";
import { esc } from "../common/reports/html-helpers.js";
import { listManifests } from "../common/run-manifest.js";
import type { RunManifest } from "../contracts.js";
import {
  estimateRun,
  type RunEstimate,
  stageSeconds,
  traceBound,
} from "../insights/estimate.js";
import {
  LabelSpec,
  labelKey,
  populationSource,
  readsOrq,
  type TraceInsight,
} from "../insights/models.js";
import {
  projectionCoverage,
  readSnapshot,
  snapshotDocuments,
} from "../insights/population.js";
import {
  CODING_CONVERSATION_LABELS,
  CODING_LABELS,
  LABEL_PRESETS,
  SENTIMENT,
} from "../insights/presets.js";
import { runManifestFor } from "../insights/progress.js";
import {
  getInsightsRunsDir,
  listRunPaths,
  loadRun,
} from "../insights/store.js";
import {
  buildSessionSnapshot,
  MAX_SELECTED_SESSIONS,
  MAX_SESSION_TEXT_CHARS,
  SESSION_SOURCES,
  type SessionFamily,
  SessionLoadError,
  type SessionQuery,
  type SessionRef,
  type SessionSource,
  SnapshotTooLarge,
  searchSessions,
} from "../local-sessions/index.js";
import { sessionRoots } from "../local-sessions/roots.js";
import { RunExport } from "../trace-finder/export.js";
import { loadFacetCatalogue } from "../trace-finder/facets.js";
import {
  FACET_NAMES,
  type FacetCatalogue,
  FacetCatalogueSchema,
  FacetSelection,
  Snapshot,
} from "../trace-finder/models.js";
import { OrqTraceSource } from "../trace-finder/orq-source.js";
import {
  type DashboardSettings,
  effectiveDashboardSettings,
  MAX_TRACE_INPUT_CHARS,
  MIN_TRACE_INPUT_CHARS,
} from "../trace-finder/settings.js";
import {
  accountIdentity,
  authIdentity,
  buildOrqClient,
  type DashboardAuth,
  resolveDashboardAuth,
  verifiedAccountIdentity,
} from "./auth.js";
import { camel } from "./facet-picker.js";
import {
  renderCompactEstimate,
  renderEstimate,
  renderEstimateUnavailable,
} from "./insights-estimate-views.js";
import {
  getFinderExportsDir,
  InsightsLaunchSpec,
  launchInsights,
  readApprovedFinderExport,
  reconcileStaleWorker,
} from "./insights-launch.js";
import {
  buildReviewPayload,
  buildSignalDetailPayload,
} from "./insights-review-data.js";
import { reviewPage } from "./insights-review-views.js";
import {
  facetOptions,
  INSIGHTS_MODEL_FIELDS,
  RunFormValues,
  renderPlan,
  renderRecentFiles,
  renderRunForm,
  renderRunPage,
} from "./insights-run-form.js";
import { renderSessionResults } from "./insights-sessions-views.js";
import {
  loadOrqRecord,
  loadSnapshotRecord,
  sourceNotRereadable,
} from "./insights-trace-source.js";
import {
  cleanupExpiredUploads,
  isUploadedSource,
  limitRequestBody,
  MAX_INSIGHTS_UPLOAD_BYTES,
  readUploadedSource,
  receiveUpload,
  recentTraceFiles,
  SNAPSHOT_TOO_LARGE_MESSAGE,
  storeUpload,
  UploadRequestTooLargeError,
  UploadTooLargeError,
} from "./insights-uploads.js";
import {
  clusterDetail,
  type InsightsRun,
  mapPayload,
  overviewPage,
  projectionNotice,
  type RunEntry,
  runningPage,
  TABS,
  tabContent,
  tabs,
  traceDetailPage,
  traces,
  unreadablePage,
} from "./insights-views.js";
import { catalogueEntry, modelGroups } from "./model-choices.js";
import { cliSlugRenderScope } from "./orq-workspace.js";
import { listProjectDirectories } from "./project-browser.js";
import { csrfToken, requestRejected } from "./security.js";
import { browserOffsetMinutes } from "./trace-finder/route-forms.js";
import type { FinderState } from "./trace-finder/routes.js";
import { spanTreeFragment } from "./trace-finder/routes.js";
import {
  traceConversation,
  unavailableConversation,
} from "./trace-finder/views.js";
import { modelControl } from "./view.js";

type Loaded = readonly [path: string, run: InsightsRun | string];
type Form = FormData;
type CatalogueResult = [FacetCatalogue | null, string | null, boolean];

const SESSION_FAMILIES: readonly SessionFamily[] = ["claude", "codex", "omp"];
const MAX_SEARCH_TABS = 64;
const TAB_ID_CHARS = 64;
const JSON_NO_STORE = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

export interface InsightsRouteDeps {
  finder?: FinderState | null;
  runsDir?: () => string;
  finderDir?: () => string;
  selectedAuth?: () => Promise<DashboardAuth>;
  settings?: () => Promise<DashboardSettings>;
  launch?: typeof launchInsights;
  catalogueEntry?: typeof catalogueEntry;
  modelGroups?: typeof modelGroups;
  loadCatalogue?: (
    auth: DashboardAuth,
    scope: { workspace: string | null; project: string | null },
    windowDays: number,
  ) => Promise<FacetCatalogue>;
}

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const json = (
  payload: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
) => new Response(JSON.stringify(payload), { status, headers });

const redirect = (location: string, status: number) =>
  new Response(null, { status, headers: { location } });

const alert = (message: string, status: number) =>
  html(`<p class="insights-error" role="alert">${esc(message)}</p>`, status);

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function validationMessage(error: unknown): string {
  const issues = (error as { issues?: { message: string }[] } | null)?.issues;
  if (Array.isArray(issues))
    return issues
      .map((issue) => issue.message.replace(/^Value error, /, ""))
      .join("; ");
  return errorText(error);
}

const expandUser = (path: string) =>
  path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;

const formText = (form: Form, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const formTexts = (form: Form, name: string) =>
  form
    .getAll(name)
    .filter((value): value is string => typeof value === "string");

function unauthorized(error: unknown): boolean {
  const value = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  } | null;
  return (
    (value?.statusCode ?? value?.status ?? value?.response?.status) === 401
  );
}

function snapshotClassifierQuestions(
  form: Form,
): Record<string, Record<string, unknown>> | null {
  if (
    !["labels", "dimensions", "coding_labels", "custom_labels_json"].some(
      (name) => form.has(name),
    )
  )
    return null;
  const selected = formTexts(form, "labels").map((name) => {
    const spec = LABEL_PRESETS[name];
    if (!spec) throw new TypeError(`unknown label ${name}`);
    return spec;
  });
  if (
    formTexts(form, "dimensions").includes("sentiment") &&
    !selected.some((spec) => spec.name === "sentiment")
  )
    selected.push(SENTIMENT);
  const custom = JSON.parse(formText(form, "custom_labels_json") || "[]");
  if (!Array.isArray(custom))
    throw new TypeError("custom label questions must be a list");
  selected.push(...custom.map((item) => new LabelSpec(item)));
  const coding = new Map(
    CODING_LABELS.slice(1).map((spec) => [spec.name, spec]),
  );
  for (const name of formTexts(form, "coding_labels")) {
    const spec = coding.get(name);
    if (!spec) throw new TypeError(`unknown coding label ${name}`);
    if (CODING_CONVERSATION_LABELS.includes(spec)) selected.push(spec);
  }
  return Object.fromEntries(
    selected.map((spec) => [
      spec.name,
      JSON.parse(JSON.stringify(spec.toQuestion({}))) as Record<
        string,
        unknown
      >,
    ]),
  );
}

async function entries(directory: string): Promise<{
  rows: RunEntry[];
  loaded: Map<string, Loaded>;
  manifests: Map<string, RunManifest>;
}> {
  try {
    for (const manifest of await listManifests(directory))
      if (manifest.surface === "insights")
        await reconcileStaleWorker(directory, manifest.runId);
  } catch (error) {
    console.warn(
      `Could not reconcile stale Insights workers in ${directory}: ${errorText(error)}`,
    );
  }
  const rows: RunEntry[] = [];
  const loaded = new Map<string, Loaded>();
  const aliases: [string, Loaded][] = [];
  const seen = new Set<string>();
  for (const path of await listRunPaths(directory)) {
    const stem = basename(path, ".json");
    let run: InsightsRun | string;
    try {
      run = await loadRun(path);
    } catch (error) {
      run = `${error instanceof Error ? error.name : "Error"}: ${errorText(error)}`;
      console.warn(`Unreadable Insights run ${path}: ${run}`);
    }
    if (typeof run !== "string") {
      if (!seen.has(run.runId)) {
        rows.push([run.runId, run.runName, run.status]);
        loaded.set(run.runId, [path, run]);
        seen.add(run.runId);
      }
      aliases.push([stem, [path, run]]);
    } else {
      rows.push([stem, stem, "unreadable"]);
      if (!loaded.has(stem)) loaded.set(stem, [path, run]);
    }
  }
  for (const [alias, target] of aliases)
    if (!loaded.has(alias)) loaded.set(alias, target);
  const all = await listManifests(directory);
  const manifests = new Map(
    all
      .filter((manifest) => manifest.surface === "insights")
      .map((manifest) => [manifest.runId, manifest] as const),
  );
  for (const [, run] of loaded.values())
    if (typeof run !== "string" && !manifests.has(run.runId))
      manifests.set(run.runId, runManifestFor(run));
  const known = new Set(rows.map(([id]) => id));
  const manifestRows: RunEntry[] = [];
  for (const manifest of all) {
    if (manifest.surface !== "insights" || known.has(manifest.runId)) continue;
    manifestRows.push([manifest.runId, manifest.runName, manifest.status]);
    loaded.set(manifest.runId, [
      join(directory, `${manifest.runId}.json`),
      manifest.status,
    ]);
  }
  return { rows: [...manifestRows, ...rows], loaded, manifests };
}

function recordedOrqScope(
  run: InsightsRun,
): Record<string, string | null> | null {
  const scope =
    (run.population as Record<string, unknown>).orq_scope ??
    (run.population as Record<string, unknown>).orqScope;
  if (scope === undefined || scope === null) return null;
  const value = scope as Record<string, unknown>;
  const optional = (key: string) =>
    value[key] === undefined ||
    value[key] === null ||
    typeof value[key] === "string";
  if (
    typeof scope === "object" &&
    !Array.isArray(scope) &&
    typeof value.account === "string" &&
    typeof (value.account_label ?? value.accountLabel) === "string" &&
    optional("workspace") &&
    optional("project") &&
    [undefined, null, "2"].includes(
      (value.account_version ?? value.accountVersion) as string,
    )
  )
    return {
      account: value.account as string,
      account_label: (value.account_label ?? value.accountLabel) as string,
      workspace: (value.workspace as string | null) ?? null,
      project: (value.project as string | null) ?? null,
      account_version:
        ((value.account_version ?? value.accountVersion) as string | null) ??
        null,
    };
  console.warn(
    `Insights run ${run.runId} has a malformed orq_scope; using the Settings scope`,
  );
  return null;
}

function reviewHash(
  run: InsightsRun,
  tab: string,
  query: URLSearchParams,
): string {
  const quote = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const view =
    tab === "map" ? "map" : tab === "crosstab" ? "compare" : "themes";
  const dimensions = run.dimensions;
  let dimension = query.get("dimension") ?? "";
  if (!(dimension in dimensions)) dimension = Object.keys(dimensions)[0] ?? "";
  const state: [string, string][] = [];
  if (dimension) state.push(["dim", dimension]);
  state.push(["view", view]);
  const filters: string[] = [];
  const clusterId = query.get("cluster");
  if (clusterId && dimension in dimensions) {
    const cluster = dimensions[dimension]?.clusters.find(
      (item) => item.id === clusterId,
    );
    if (cluster) filters.push(`c:${quote(cluster.id)}`);
  }
  const labelName = query.get("label") ?? "";
  const labelValue = query.get("value");
  const label = run.config.labels.find((item) => item.name === labelName);
  if (label && labelValue) {
    const valid = run.traces.some((trace) => {
      const answer = trace.labels[labelName];
      return (
        answer !== undefined &&
        answer.error === null &&
        answer.value !== null &&
        labelKey(label as LabelSpec, answer.value) === labelValue
      );
    });
    if (valid) filters.push(`l:${quote(labelName)}:${quote(labelValue)}`);
  }
  if (filters.length) state.push(["f", filters.join("|")]);
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/%2E/gi, ".");
  return `#${state.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&")}`;
}

function dayWindow(
  first: string,
  last: string,
  offsetMinutes: number,
): [Date | null, Date | null] {
  const midnight = (value: string, plusDays: number) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error("bad date");
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (
      y < 1 ||
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() !== m - 1 ||
      check.getUTCDate() !== d
    )
      throw new Error("bad date");
    return new Date(Date.UTC(y, m - 1, d + plusDays) - offsetMinutes * 60_000);
  };
  const start = first ? midnight(first, 0) : null;
  const end = last ? midnight(last, 1) : null;
  if (first && last && first > last)
    throw new RangeError("The first day must not be after the last day.");
  return [start, end];
}

function sessionQuery(form: Form): SessionQuery {
  const chosen = new Set(formTexts(form, "session_source"));
  const sources = SESSION_SOURCES.filter((source) => chosen.has(source));
  if (
    !sources.length ||
    [...chosen].some(
      (source) => !SESSION_SOURCES.includes(source as SessionSource),
    )
  )
    throw new Error("Choose at least one valid session source.");
  const first = formText(form, "session_from").trim();
  const last = formText(form, "session_to").trim();
  let start: Date | null = null;
  let end: Date | null = null;
  if (first || last) {
    let offset: number;
    try {
      offset = browserOffsetMinutes(formText(form, "tz_offset"));
    } catch {
      throw new Error("The browser timezone offset is not usable.");
    }
    try {
      [start, end] = dayWindow(first, last, offset);
    } catch (error) {
      if (error instanceof RangeError) throw new Error(error.message);
      throw new Error("From and To must be dates like 2026-10-07.");
    }
  }
  let projectDir: string | null = formText(form, "session_project_dir") || null;
  if (projectDir !== null) {
    const expanded = expandUser(projectDir);
    if (!isAbsolute(expanded))
      throw new Error(
        "Enter an absolute project directory, such as ~/code/repo.",
      );
    projectDir = expanded;
  }
  const text = formText(form, "session_text").trim() || null;
  if (text !== null && Array.from(text).length > MAX_SESSION_TEXT_CHARS)
    throw new Error(
      `Search text is limited to ${MAX_SESSION_TEXT_CHARS} characters.`,
    );
  return {
    sources,
    start,
    end,
    projectDir,
    text,
    limit: MAX_SELECTED_SESSIONS,
  };
}

function sessionRefs(values: string[]): SessionRef[] {
  if (!values.length) throw new Error("Select at least one session.");
  if (values.length > MAX_SELECTED_SESSIONS)
    throw new Error(`Select at most ${MAX_SELECTED_SESSIONS} sessions.`);
  return values.map((value) => {
    const at = value.indexOf(":");
    const source = at < 0 ? value : value.slice(0, at);
    const path = at < 0 ? "" : value.slice(at + 1);
    if (!SESSION_SOURCES.includes(source as SessionSource) || !path)
      throw new Error("A selected session is not valid.");
    return { source: source as SessionSource, path };
  });
}

async function fileSize(rawPath: string): Promise<number | null> {
  try {
    return (await stat(expandUser(rawPath))).size;
  } catch (error) {
    console.warn(
      `Could not read the size of the local file for the plan: ${error instanceof Error ? error.name : "Error"}`,
    );
    return null;
  }
}

async function readForm(req: Request): Promise<Form | null> {
  try {
    return (await req.formData()) as unknown as Form;
  } catch {
    return null;
  }
}

/** Insights launch, review and export routes; returns null for paths it does not own. */
export function insightsRoutes(deps: InsightsRouteDeps = {}) {
  const runsDir = deps.runsDir ?? getInsightsRunsDir;
  const finderDir = deps.finderDir ?? getFinderExportsDir;
  const launch = deps.launch ?? launchInsights;
  const entryFor = deps.catalogueEntry ?? catalogueEntry;
  const groupsFor = deps.modelGroups ?? modelGroups;
  const latestSearch = new Map<string, AbortController>();
  const catalogueCache = new Map<
    string,
    [number, FacetCatalogue | null, boolean]
  >();
  const catalogueTasks = new Map<
    string,
    Promise<[FacetCatalogue | null, boolean]>
  >();
  let cacheGeneration = 0;

  const settings = async () =>
    deps.settings
      ? deps.settings()
      : (deps.finder?.settings ?? (await effectiveDashboardSettings()));
  const selectedAuth = async () =>
    deps.selectedAuth
      ? deps.selectedAuth()
      : deps.finder
        ? deps.finder.dashboardAuth()
        : resolveDashboardAuth(await settings());
  const generation = () => deps.finder?.generation ?? 0;

  async function orqScope(
    auth: DashboardAuth,
    scope: Record<string, string | null> | null,
  ) {
    if (auth.method !== "cli_oauth") return { workspace: null, project: null };
    if (scope !== null)
      return {
        workspace: scope.workspace ?? null,
        project: scope.project ?? null,
      };
    const current = await settings();
    return {
      workspace: current.orqWorkspace ?? null,
      project: current.orqProjectId ?? null,
    };
  }

  const loadCatalogue =
    deps.loadCatalogue ??
    (async (auth, scope, windowDays) => {
      const orq = await buildOrqClient(auth, scope);
      const now = Date.now();
      return loadFacetCatalogue(
        orq as never,
        {
          start: new Date(now - windowDays * 86_400_000),
          end: new Date(now),
          limit: 50,
        } as never,
      );
    });

  async function catalogue(
    windowDays: number,
    retry = false,
  ): Promise<CatalogueResult> {
    let auth: DashboardAuth;
    try {
      auth = await selectedAuth();
    } catch (error) {
      console.warn(
        `Insights facet values are unavailable: ${errorText(error)}`,
      );
      return [null, null, false];
    }
    const sourceName = auth.profile ? auth.profile.name : auth.label;
    const fingerprint = createHash("sha256")
      .update(`${auth.method}\0${auth.baseUrl}\0${auth.apiKey ?? ""}`)
      .digest("hex");
    const current = generation();
    if (current !== cacheGeneration) {
      catalogueCache.clear();
      cacheGeneration = current;
    }
    const key = JSON.stringify([sourceName, fingerprint, windowDays]);
    const cached = catalogueCache.get(key);
    if (!retry && cached && cached[0] > Date.now())
      return [cached[1], sourceName, cached[2]];
    const taskKey = JSON.stringify([current, key]);
    let task = catalogueTasks.get(taskKey);
    if (!task) {
      task = (async (): Promise<[FacetCatalogue | null, boolean]> => {
        let loaded: FacetCatalogue | null = null;
        let rejected = false;
        try {
          loaded = await loadCatalogue(
            auth,
            await orqScope(auth, null),
            windowDays,
          );
        } catch (error) {
          rejected = unauthorized(error);
          console.warn(
            `Insights facet values are unavailable for the ${windowDays}-day window: ${errorText(error)}`,
          );
        }
        if (current === generation())
          catalogueCache.set(key, [
            Date.now() + (loaded ? 5 : 1) * 60_000,
            loaded,
            rejected,
          ]);
        return [loaded, rejected];
      })().finally(() => {
        if (catalogueTasks.get(taskKey) === task)
          catalogueTasks.delete(taskKey);
      });
      catalogueTasks.set(taskKey, task);
    }
    const [loaded, rejected] = await task;
    if (current !== generation()) return [null, sourceName, false];
    return [loaded, sourceName, rejected];
  }

  async function estimate(spec: InsightsLaunchSpec): Promise<RunEstimate> {
    let finderCount: number | null = null;
    let snapshotCount: number | null = null;
    let facets: FacetCatalogue = FacetCatalogueSchema.parse({});
    if (spec.source === "finder") {
      const raw = spec.validatedFinderExportSnapshot();
      finderCount =
        raw === null
          ? null
          : new RunExport(JSON.parse(raw)).matchedTraceIds.length;
    } else if (spec.source === "snapshot") {
      try {
        snapshotCount = (await readSnapshot(expandUser(spec.snapshotPath)))
          .snapshot.traces.length;
      } catch (error) {
        console.warn(
          `Could not count the traces in the local file for the estimate: ${errorText(error)}`,
        );
      }
    } else {
      const [loaded] = await catalogue(spec.windowDays);
      facets = loaded ?? facets;
    }
    const bound = traceBound(spec.source, {
      catalogue: facets,
      facets: spec.facets,
      limit: spec.limit,
      finderCount,
      snapshotCount,
    });
    const models = {
      summary: spec.summaryModel,
      classifier: spec.classifierModel,
      embedding: spec.embeddingModel,
    };
    let prices: Record<string, ModelInfo | null> = {};
    try {
      const auth = await selectedAuth();
      const chosen = [...new Set(Object.values(models))].sort();
      const found = await Promise.all(
        chosen.map((model) => entryFor(auth, model)),
      );
      prices = Object.fromEntries(
        chosen.map((model, i) => [model, found[i] ?? null]),
      );
    } catch (error) {
      console.warn(
        `No Orq catalogue for the Insights estimate prices: ${errorText(error)}`,
      );
    }
    return estimateRun({
      bound,
      dimensions: spec.dimensionNames(),
      questionCount: spec.labels.length + spec.customLabels.length,
      coding: spec.codingEnabled,
      models,
      prices,
      seconds: await stageSeconds(runsDir()),
      parallelism: spec.parallelism,
      query: spec.source === "query",
      sentimentSelected: spec.labels.includes("sentiment"),
      traceInputChars: spec.traceInputChars,
    });
  }

  async function modelRejection(
    auth: DashboardAuth,
    spec: InsightsLaunchSpec,
  ): Promise<string | null> {
    const unchecked: string[] = [];
    const checks = [
      [
        "classifierModel",
        (info: ModelInfo) => !info.supportsClassify,
        "serve /decisions",
      ],
      [
        "embeddingModel",
        (info: ModelInfo) => info.modelType !== "embedding",
        "produce embeddings",
      ],
    ] as const;
    for (const [field, wrong, what] of checks) {
      const model = spec[field];
      if (!model) continue;
      const info = await entryFor(auth, model);
      if (info === null) unchecked.push(`${field} '${model}'`);
      else if (wrong(info))
        return `${INSIGHTS_MODEL_FIELDS[field][1]} ${model} cannot ${what}. Choose another from the list.`;
    }
    if (unchecked.length)
      console.warn(
        `Orq model catalogue has no entry for ${unchecked.join(" and ")}; accepting the typed values unchecked`,
      );
    return null;
  }

  async function runFormResponse(
    values: RunFormValues,
    error: string | null,
    status: number,
  ): Promise<Response> {
    const csrf = csrfToken();
    if (values.mount === "dialog")
      return html(renderRunForm(values, { csrf, error }), status);
    return html(await renderRunPage(values, { csrf, error }), status);
  }

  async function loadOne(runId: string): Promise<{
    resolved: Loaded | undefined;
    manifests: Map<string, RunManifest>;
  }> {
    const { loaded, manifests } = await entries(runsDir());
    return { resolved: loaded.get(runId), manifests };
  }

  async function loadedRun(runId: string): Promise<InsightsRun | null> {
    const { resolved } = await loadOne(runId);
    return resolved && typeof resolved[1] !== "string" ? resolved[1] : null;
  }

  async function resolveTrace(
    runId: string,
    traceId: string | null,
    spanId: string | null,
  ): Promise<[InsightsRun, TraceInsight] | string> {
    const run = await loadedRun(runId);
    if (run === null) return "Insights run not found.";
    const span = spanId || null;
    const trace = run.traces.find(
      (item) => item.traceId === traceId && (item.spanId ?? null) === span,
    );
    return trace ? [run, trace] : "Trace not found in this Insights run.";
  }

  const WRONG_ACCOUNT = (label: string) =>
    `This run read Orq as ${label}. Select that account in Settings to load this conversation.`;
  const NO_CONNECT =
    "Could not connect to Orq with the account selected in Settings.";

  /** Open an Orq trace source in the account and scope the run recorded, or say why not. */
  async function traceSource(
    run: InsightsRun,
  ): Promise<OrqTraceSource | string> {
    let auth: DashboardAuth;
    try {
      auth = await selectedAuth();
    } catch (error) {
      console.warn(`Insights trace source unavailable: ${errorText(error)}`);
      return "Connect an Orq account in Settings to load this conversation.";
    }
    const scope = recordedOrqScope(run);
    if (scope !== null && scope.account_version !== "2") {
      let account: string;
      try {
        account = accountIdentity(auth);
      } catch (error) {
        console.warn(
          `Insights trace source could not identify the selected Orq account: ${errorText(error)}`,
        );
        return NO_CONNECT;
      }
      if (account !== scope.account) {
        console.warn(
          `Insights run ${run.runId} read Orq as ${scope.account_label}, but Settings selects ${auth.label}`,
        );
        return WRONG_ACCOUNT(scope.account_label as string);
      }
    }
    let orq: unknown;
    try {
      orq = await buildOrqClient(auth, await orqScope(auth, scope));
    } catch (error) {
      console.warn(
        `Insights trace source could not be created: ${errorText(error)}`,
      );
      return NO_CONNECT;
    }
    if (scope !== null && scope.account_version === "2") {
      let account: string;
      try {
        account = await verifiedAccountIdentity(auth, orq as never);
      } catch (error) {
        console.warn(
          `Insights trace source could not verify the selected Orq account: ${errorText(error)}`,
        );
        return "Could not verify the Orq account selected in Settings to load this conversation.";
      }
      if (account !== scope.account) {
        console.warn(
          `Insights run ${run.runId} read Orq as ${scope.account_label}, but Settings selects ${auth.label}`,
        );
        return WRONG_ACCOUNT(scope.account_label as string);
      }
    }
    try {
      return new OrqTraceSource(orq as never, { ownsClient: true });
    } catch (error) {
      console.warn(
        `Insights trace source could not be created: ${errorText(error)}`,
      );
      return NO_CONNECT;
    }
  }

  const closeSource = (source: OrqTraceSource) => {
    try {
      source.close();
    } catch (error) {
      console.warn(
        `Could not close the Insights trace source: ${errorText(error)}`,
      );
    }
  };

  // ---- handlers ----

  async function home(): Promise<Response> {
    const directory = runsDir();
    await cleanupExpiredUploads(directory);
    const { rows, loaded, manifests } = await entries(directory);
    const runs = new Map<string, InsightsRun>();
    for (const [id, [, run]] of loaded)
      if (typeof run !== "string") runs.set(id, run);
    return html(await overviewPage(rows, runs, manifests));
  }

  async function newForm(url: URL): Promise<Response> {
    const rerun = url.searchParams.get("rerun");
    let values: RunFormValues;
    if (rerun) {
      const run = await loadedRun(rerun);
      if (run === null)
        return html(
          '<p class="insights-empty">Insights run not found.</p>',
          404,
        );
      values = await RunFormValues.fromRun(run, runsDir());
    } else values = await RunFormValues.defaults();
    const mount =
      url.searchParams.get("mount") === "dialog" ? "dialog" : "page";
    return runFormResponse(values.with({ mount }), null, 200);
  }

  async function plan(url: URL): Promise<Response> {
    const query = url.searchParams;
    const compact = query.get("compact") === "1";
    let values: RunFormValues;
    let spec: InsightsLaunchSpec;
    try {
      values = await RunFormValues.fromForm(query);
      spec = await InsightsLaunchSpec.create(values.launchFields());
    } catch (error) {
      const message =
        query.get("source") === "sessions" && !query.get("trace_file")
          ? "Select local sessions and press Continue."
          : validationMessage(error);
      if (compact) return html(renderEstimateUnavailable(message));
      return alert(message, 422);
    }
    const stages = compact ? [] : spec.stages();
    const result = await estimate(spec);
    if (compact) return html(renderCompactEstimate(result));
    const nBytes =
      spec.source === "snapshot" ? await fileSize(spec.snapshotPath) : null;
    return html(
      `<div data-part="estimate">${renderEstimate(result, stages)}</div>` +
        `<div data-part="compact">${renderCompactEstimate(result)}</div>` +
        `<div data-part="plan">${renderPlan(spec, stages, {
          source: values.source,
          nTraces: result.bound.n,
          nBytes,
        })}</div>`,
    );
  }

  async function facets(url: URL): Promise<Response> {
    const raw = url.searchParams.get("window_days") ?? "7";
    if (!/^\s*[+-]?\d+\s*$/.test(raw))
      return html(
        '<p class="insights-error">Enter a valid window to load facets.</p>',
        422,
      );
    const windowDays = Number(raw);
    if (windowDays < 1 || windowDays > 90)
      return html(
        '<p class="insights-error">Choose a window from 1 to 90 days.</p>',
        422,
      );
    const selection = new FacetSelection(
      Object.fromEntries(
        FACET_NAMES.map((name) => [
          camel(name),
          url.searchParams.getAll(`facet_${name}`),
        ]),
      ),
    );
    const [loaded, profileName, credentialRejected] = await catalogue(
      windowDays,
      url.searchParams.get("retry") === "1",
    );
    return html(
      facetOptions(loaded, selection, {
        profileName,
        credentialRejected,
        windowDays,
      }),
    );
  }

  async function files(): Promise<Response> {
    try {
      return html(
        renderRecentFiles(await recentTraceFiles(runsDir(), finderDir())),
      );
    } catch {
      return html(
        '<p class="insights-error" role="status">Recent trace files could not be loaded.</p>',
        422,
      );
    }
  }

  async function upload(req: Request): Promise<Response> {
    await cleanupExpiredUploads(runsDir());
    let form: Form;
    try {
      form = (await limitRequestBody(req).formData()) as unknown as Form;
    } catch (error) {
      if (error instanceof UploadRequestTooLargeError)
        return json({ error: error.message }, 413);
      console.warn(
        `Could not parse Insights source upload: ${errorText(error)}`,
      );
      return json({ error: "Could not read the uploaded file." }, 422);
    }
    const rejected = requestRejected(req, form);
    if (rejected) return json({ error: rejected }, 403);
    const file = form.get("file");
    if (!(file instanceof Blob) || !(file as File).name)
      return json({ error: "Choose a JSON file to upload." }, 422);
    try {
      const [kind, contents] = await receiveUpload(file);
      const path = await storeUpload(runsDir(), contents, kind, {
        displayName: (file as File).name,
      });
      return json({ kind, path }, 201);
    } catch (error) {
      if (error instanceof UploadTooLargeError)
        return json({ error: error.message }, 413);
      return json({ error: errorText(error) }, 422);
    }
  }

  async function snapshotPreview(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form === null) return alert("Could not read the request.", 422);
    const rejected = requestRejected(req, form);
    if (rejected) return alert(rejected, 403);
    const rawPath = formText(form, "snapshot_path").trim();
    if (!rawPath || rawPath.length > 4096)
      return alert("Enter a trace snapshot JSON path.", 422);
    let traceInputChars: number;
    const rawChars =
      formText(form, "trace_input_chars") ||
      String((await settings()).traceInputChars);
    traceInputChars = Number(rawChars.trim());
    if (
      !/^\s*[+-]?\d+\s*$/.test(rawChars) ||
      traceInputChars < MIN_TRACE_INPUT_CHARS ||
      traceInputChars > MAX_TRACE_INPUT_CHARS
    )
      return alert("Enter a valid model input character cap.", 422);
    const classifierModel = formText(form, "classifier_model") || undefined;
    let classifierQuestions: Record<string, Record<string, unknown>> | null;
    try {
      classifierQuestions = snapshotClassifierQuestions(form);
    } catch {
      return alert("Could not read the selected classifier questions.", 422);
    }
    let coverage: Record<string, unknown>;
    try {
      const path = expandUser(rawPath);
      const directory = runsDir();
      const snapshot = (await isUploadedSource(directory, path))
        ? new Snapshot(
            JSON.parse(
              (await readUploadedSource(directory, path, "snapshot")).toString(
                "utf8",
              ),
            ),
          )
        : (await readSnapshot(path)).snapshot;
      coverage = (await projectionCoverage(snapshotDocuments(snapshot), {
        traceInputChars,
        classifierModel,
        ...(classifierQuestions ? { classifierQuestions } : {}),
      })) as unknown as Record<string, unknown>;
    } catch {
      return alert("Could not read a valid local trace snapshot.", 422);
    }
    if (!coverage.nTraces)
      return alert("This trace snapshot contains no traces.", 422);
    return html(await projectionNotice(coverage));
  }

  async function sessionsSearch(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form === null) return alert("Could not read the request.", 422);
    const rejected = requestRejected(req, form);
    if (rejected) return alert(rejected, 403);
    let query: SessionQuery;
    try {
      query = sessionQuery(form);
    } catch (error) {
      return alert(errorText(error), 422);
    }
    const tab = formText(form, "session_tab").slice(0, TAB_ID_CHARS);
    latestSearch.get(tab)?.abort();
    const mine = new AbortController();
    latestSearch.delete(tab);
    latestSearch.set(tab, mine);
    while (latestSearch.size > MAX_SEARCH_TABS)
      latestSearch.delete(latestSearch.keys().next().value as string);
    const result = await searchSessions(query, { signal: mine.signal });
    const roots = await Promise.all(
      SESSION_FAMILIES.map((family) => sessionRoots(family)),
    );
    return html(
      renderSessionResults(result, {
        selected: new Set(formTexts(form, "selected")),
        rootsFound: roots.some((found) => found.length > 0),
      }),
    );
  }

  async function sessionsSnapshot(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form === null)
      return json({ error: "Could not read the request." }, 422);
    const rejected = requestRejected(req, form);
    if (rejected) return json({ error: rejected }, 403);
    let refs: SessionRef[];
    try {
      refs = sessionRefs(formTexts(form, "session"));
    } catch (error) {
      return json({ error: errorText(error) }, 422);
    }
    const directory = runsDir();
    await cleanupExpiredUploads(directory);
    let frozen: Awaited<ReturnType<typeof buildSessionSnapshot>>;
    try {
      frozen = await buildSessionSnapshot(refs, {
        maxBytes: MAX_INSIGHTS_UPLOAD_BYTES,
      });
    } catch (error) {
      if (error instanceof SnapshotTooLarge)
        return json(
          { error: `${SNAPSHOT_TOO_LARGE_MESSAGE} Select fewer sessions.` },
          413,
        );
      if (error instanceof SessionLoadError)
        return json({ error: error.message }, 422);
      throw error;
    }
    let path: string;
    try {
      path = await storeUpload(directory, frozen.data, "snapshot", {
        source: "sessions",
      });
    } catch (error) {
      return json({ error: errorText(error) }, 422);
    }
    return json(
      {
        path,
        n_sessions: frozen.nSessions,
        bytes: frozen.data.length,
        failed: frozen.failed.map(([ref, error]) => ({
          path: ref.path,
          error,
        })),
      },
      201,
    );
  }

  async function sessionsDirectories(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form === null)
      return json({ error: "Could not read the directory request." }, 422);
    const rejected = requestRejected(req, form);
    if (rejected) return json({ error: rejected }, 403);
    const rawPath = form.has("path") ? form.get("path") : "";
    const rawOffset = form.has("offset") ? form.get("offset") : "0";
    try {
      if (typeof rawPath !== "string" || rawPath.length > 4096)
        throw new Error("Enter a valid directory path.");
      if (typeof rawOffset !== "string" || !/^\s*[+-]?\d+\s*$/.test(rawOffset))
        throw new Error("Directory page offset must be a nonnegative integer.");
      const offset = Number(rawOffset);
      if (offset < 0)
        throw new Error("Directory page offset must be a nonnegative integer.");
      return json(await listProjectDirectories(rawPath, { offset }));
    } catch (error) {
      return json({ error: errorText(error) }, 422);
    }
  }

  async function finderPreview(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form === null) return alert("Could not read the request.", 422);
    const rejected = requestRejected(req, form);
    if (rejected) return alert(rejected, 403);
    const rawPath = formText(form, "finder_path").trim();
    if (!rawPath || rawPath.length > 4096)
      return alert("Choose a Finder export.", 422);
    let matched: number;
    try {
      const directory = runsDir();
      const root = resolve(finderDir());
      const requested = expandUser(rawPath);
      const path = resolve(
        isAbsolute(requested) ? requested : join(root, requested),
      );
      let contents: Buffer;
      if (await isUploadedSource(directory, path))
        contents = await readUploadedSource(directory, path, "finder");
      else {
        if (dirname(path) !== root)
          throw new Error(
            "Finder exports must be in the approved directory or use a validated upload.",
          );
        contents = await readApprovedFinderExport(root, path);
      }
      matched = new RunExport(JSON.parse(contents.toString("utf8")))
        .matchedTraceIds.length;
    } catch {
      return alert("Could not read a valid Finder export.", 422);
    }
    return html(
      `<p class="insights-projection" role="status">Finder export is ready with ${matched.toLocaleString("en-US")} matched traces.</p>`,
    );
  }

  async function models(url: URL): Promise<Response> {
    const raw = url.searchParams.get("field") ?? "";
    const field = camel(raw) as keyof typeof INSIGHTS_MODEL_FIELDS;
    if (!raw.includes("_") || !(field in INSIGHTS_MODEL_FIELDS))
      return html("");
    const [kind, label] = INSIGHTS_MODEL_FIELDS[field];
    let groups: Record<string, string[]> = {};
    try {
      groups = await groupsFor(await selectedAuth(), kind);
    } catch (error) {
      console.warn(
        `No model catalogue for the Insights run form (${raw}): ${errorText(error)}`,
      );
    }
    return html(
      modelControl(raw, url.searchParams.get(raw) ?? "", groups, { label }),
    );
  }

  async function start(req: Request): Promise<Response> {
    const form = (await readForm(req)) ?? new FormData();
    const rejected = requestRejected(req, form);
    let values: RunFormValues;
    let unreadable: string | null = null;
    try {
      values = await RunFormValues.fromForm(form);
    } catch (error) {
      values = (await RunFormValues.defaults()).with({
        mount: formText(form, "mount") === "dialog" ? "dialog" : "page",
      });
      unreadable = validationMessage(error);
    }
    if (rejected) return runFormResponse(values, rejected, 403);
    if (unreadable) return runFormResponse(values, unreadable, 422);
    let spec: InsightsLaunchSpec;
    try {
      spec = await InsightsLaunchSpec.create(values.launchFields());
    } catch (error) {
      return runFormResponse(values, validationMessage(error), 422);
    }
    let auth: DashboardAuth;
    let identity: string;
    try {
      auth = await selectedAuth();
      identity = authIdentity(auth, await settings());
    } catch (error) {
      return runFormResponse(values, errorText(error), 422);
    }
    const modelError = await modelRejection(auth, spec);
    if (modelError) return runFormResponse(values, modelError, 422);
    const runId = await launch(spec, runsDir(), {
      authMethod: auth.method,
      authIdentity: identity,
    });
    return redirect(`/insights/${encodeURIComponent(runId)}`, 303);
  }

  async function runPage(runId: string): Promise<Response> {
    const { resolved, manifests } = await loadOne(runId);
    if (!resolved) return html("<h1>Insights run not found</h1>", 404);
    const run = resolved[1];
    if (typeof run !== "string")
      return html(await reviewPage(run, manifests.get(run.runId) ?? null));
    const manifest = manifests.get(runId);
    if (
      ["running", "error", "cancelled", "completed"].includes(run) &&
      manifest
    )
      return html(await runningPage(runId, manifest.runName, manifest));
    return html(await unreadablePage(run));
  }

  async function reviewData(runId: string): Promise<Response> {
    const { resolved } = await loadOne(runId);
    if (!resolved)
      return json({ error: "Insights run not found" }, 404, JSON_NO_STORE);
    if (typeof resolved[1] === "string")
      return json(
        { error: `Insights run is unreadable: ${resolved[1]}` },
        422,
        JSON_NO_STORE,
      );
    return json(await buildReviewPayload(resolved[1]), 200, JSON_NO_STORE);
  }

  async function traceSignals(runId: string, url: URL): Promise<Response> {
    const { resolved } = await loadOne(runId);
    let payload: unknown;
    let status: number;
    if (!resolved)
      [payload, status] = [{ error: "Insights run not found" }, 404];
    else if (typeof resolved[1] === "string")
      [payload, status] = [
        { error: `Insights run is unreadable: ${resolved[1]}` },
        422,
      ];
    else {
      const traceId = url.searchParams.get("trace_id");
      const spanId = url.searchParams.get("span_id");
      if (!traceId || spanId === null)
        [payload, status] = [
          { error: "trace_id and span_id are required" },
          400,
        ];
      else {
        const detail = buildSignalDetailPayload(
          resolved[1],
          traceId,
          spanId || null,
        );
        [payload, status] =
          detail === null
            ? [{ error: "Trace not found in this Insights run" }, 404]
            : [detail, 200];
      }
    }
    return json(payload, status, JSON_NO_STORE);
  }

  async function tab(
    req: Request,
    url: URL,
    runId: string,
    name: string,
  ): Promise<Response> {
    if (!(TABS as readonly string[]).includes(name))
      return html('<p class="insights-empty">Unknown Insights tab.</p>', 404);
    const run = await loadedRun(runId);
    if (run === null)
      return html('<p class="insights-empty">Insights run not found.</p>', 404);
    if ((req.headers.get("HX-Request") ?? "").toLowerCase() === "true") {
      const query: Record<string, string> = {};
      for (const key of [
        "dimension",
        "cluster",
        "label",
        "value",
        "row",
        "row_value",
        "column",
        "column_value",
      ]) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return html(
        (await tabContent(run, name, query)) + tabs(run, name, { oob: true }),
      );
    }
    return redirect(
      `/insights/${encodeURIComponent(run.runId)}${reviewHash(run, name, url.searchParams)}`,
      302,
    );
  }

  async function traceConversationRoute(
    runId: string,
    url: URL,
  ): Promise<Response> {
    const traceId = url.searchParams.get("trace_id");
    const resolved = await resolveTrace(
      runId,
      traceId,
      url.searchParams.get("span_id"),
    );
    let spansUrl: string | null = null;
    let record: Awaited<ReturnType<typeof loadSnapshotRecord>>;
    if (typeof resolved === "string") {
      console.warn(
        `Insights run ${runId} trace ${traceId} conversation unavailable: ${resolved}`,
      );
      record = resolved;
    } else {
      const [run, trace] = resolved;
      const kind = populationSource(run.population);
      if (kind === "snapshot") record = await loadSnapshotRecord(run, trace);
      else if (kind === "unknown") record = sourceNotRereadable(run, trace);
      else {
        spansUrl = `/insights/${encodeURIComponent(run.runId)}/trace-spans?${new URLSearchParams(
          {
            trace_id: trace.traceId,
            span_id: trace.spanId ?? "",
          },
        )}`;
        record = await loadOrqRecord(run, trace, {
          openSource: async () => {
            const source = await traceSource(run);
            if (typeof source === "string") return source;
            return { source, close: async () => closeSource(source) };
          },
        });
      }
    }
    const body =
      typeof record === "string"
        ? unavailableConversation({ reason: record, spansUrl })
        : await cliSlugRenderScope(() =>
            traceConversation(record as never, { spansUrl }),
          );
    return html(`<div class="fd-traces insights-trace-view">${body}</div>`);
  }

  async function traceSpans(runId: string, url: URL): Promise<Response> {
    const traceId = url.searchParams.get("trace_id") ?? "";
    const resolved = await resolveTrace(
      runId,
      traceId,
      url.searchParams.get("span_id"),
    );
    const unavailable = html(
      '<p class="finder-empty">Span loading is unavailable.</p>',
      404,
    );
    if (typeof resolved === "string") return unavailable;
    const [run] = resolved;
    if (!readsOrq(run.population)) return unavailable;
    const source = await traceSource(run);
    if (typeof source === "string")
      return html(`<p class="finder-empty" role="status">${esc(source)}</p>`);
    try {
      return html(
        await spanTreeFragment(traceId, {
          loadSpans: (id) => source.listSpans(id as never) as never,
          loadFirstErrorMessage: (id, spans) =>
            source.firstErrorMessage(id as never, spans as never) as never,
        }),
      );
    } finally {
      closeSource(source);
    }
  }

  async function runRoute(req: Request, url: URL, runId: string, rest: string) {
    const notFound = () =>
      html('<p class="insights-empty">Insights run not found.</p>', 404);
    if (rest === "") return runPage(runId);
    if (rest === "/review-data.json") return reviewData(runId);
    if (rest === "/trace-signals.json") return traceSignals(runId, url);
    const tabMatch = /^\/tab\/([^/]+)$/.exec(rest);
    if (tabMatch)
      return tab(req, url, runId, decodeURIComponent(tabMatch[1] as string));
    if (rest === "/rerun") {
      const run = await loadedRun(runId);
      return run === null
        ? notFound()
        : redirect(`/insights/${encodeURIComponent(run.runId)}?rerun=1`, 302);
    }
    const clusterMatch = /^\/cluster\/([^/]+)$/.exec(rest);
    if (clusterMatch) {
      const run = await loadedRun(runId);
      return run === null
        ? notFound()
        : html(
            await clusterDetail(
              run,
              decodeURIComponent(clusterMatch[1] as string),
            ),
          );
    }
    if (rest === "/trace") {
      const resolved = await resolveTrace(
        runId,
        url.searchParams.get("trace_id"),
        url.searchParams.get("span_id"),
      );
      if (typeof resolved === "string")
        return html(`<p class="insights-empty">${esc(resolved)}</p>`, 404);
      const view =
        url.searchParams.get("view") === "trace" ? "trace" : "analysis";
      return html(await traceDetailPage(resolved[0], resolved[1], { view }));
    }
    if (rest === "/trace-conversation")
      return traceConversationRoute(runId, url);
    if (rest === "/trace-spans") return traceSpans(runId, url);
    if (rest === "/traces") {
      const run = await loadedRun(runId);
      if (run === null) return notFound();
      const q = url.searchParams;
      return html(
        await traces(run, {
          dimension: q.get("dimension"),
          cluster: q.get("cluster"),
          label: q.get("label"),
          value: q.get("value"),
          row: q.get("row"),
          rowValue: q.get("row_value"),
          column: q.get("column"),
          columnValue: q.get("column_value"),
        }),
      );
    }
    if (rest === "/map.json") {
      const run = await loadedRun(runId);
      if (run === null)
        return new Response(
          '{"points": [], "legend": [], "color_scale": null}',
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      return json(
        mapPayload(
          run,
          url.searchParams.get("dimension") ??
            Object.keys(run.dimensions)[0] ??
            "",
          url.searchParams.get("color_by") ?? "cluster",
        ),
      );
    }
    if (rest === "/export.json") {
      const run = await loadedRun(runId);
      if (run === null)
        return new Response('{"error": "Insights run not found"}', {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      return new Response(
        JSON.stringify(
          run,
          (_key, value) => (value instanceof Set ? [...value] : value),
          2,
        ),
        {
          headers: {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${encodeURIComponent(runId)}.json"`,
          },
        },
      );
    }
    return null;
  }

  return async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (path !== "/insights" && !path.startsWith("/insights/")) return null;
    const method = req.method;
    if (method === "GET") {
      if (path === "/insights") return home();
      if (path === "/insights/new") return newForm(url);
      if (path === "/insights/new/plan") return plan(url);
      if (path === "/insights/facets") return facets(url);
      if (path === "/insights/files") return files();
      if (path === "/insights/models") return models(url);
    }
    if (method === "POST") {
      if (path === "/insights/uploads") return upload(req);
      if (path === "/insights/snapshot-preview") return snapshotPreview(req);
      if (path === "/insights/sessions/directories")
        return sessionsDirectories(req);
      if (path === "/insights/sessions/search") return sessionsSearch(req);
      if (path === "/insights/sessions/snapshot") return sessionsSnapshot(req);
      if (path === "/insights/finder-preview") return finderPreview(req);
      if (path === "/insights/runs") return start(req);
      return null;
    }
    if (method !== "GET") return null;
    const match = /^\/insights\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return null;
    return runRoute(
      req,
      url,
      decodeURIComponent(match[1] as string),
      match[2] ?? "",
    );
  };
}
