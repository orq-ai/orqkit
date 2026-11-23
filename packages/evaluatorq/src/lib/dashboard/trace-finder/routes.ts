import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod/v4";

import { withFileLock } from "../../common/file-lock.js";
import { listOrqProfiles, type OrqProfile } from "../../common/orq-client.js";
import { getStoreDir } from "../../common/run-store-dir.js";
import { resolveColumns } from "../../trace-finder/columns.js";
import {
  ExplorerView,
  matchesFirstView,
  QUICK_VIEWS,
} from "../../trace-finder/explorer.js";
import { exportFilename, exportJson } from "../../trace-finder/export.js";
import { loadFacetCatalogue } from "../../trace-finder/facets.js";
import {
  FACET_NAMES,
  type FacetCatalogue,
  FacetCatalogueSchema,
  FacetSelection,
  NUMERIC_FACET_NAMES,
  NumericFilters,
  PopulationRequest,
  type RunRequest,
  RunSnapshot,
  TraceDetail,
  type TraceRecord,
} from "../../trace-finder/models.js";
import { MAX_LIVE_TRACES } from "../../trace-finder/orq-source-data.js";
import { buildRunStore } from "../../trace-finder/pipeline.js";
import type { RunStore } from "../../trace-finder/run-store.js";
import {
  DashboardSettings,
  effectiveDashboardSettings,
  loadDashboardSettings,
  saveDashboardSettings,
} from "../../trace-finder/settings.js";
import { exportTableCsv } from "../../trace-finder/table-csv.js";
import {
  buildAuthClients,
  type DashboardAuth,
  resolveDashboardAuth,
} from "../auth.js";
import {
  FINDER_EXPORT_REFERENCE_DIR,
  readPrivateFinderReference,
  validatePrivateFinderReferenceDir,
} from "../insights-launch.js";
import { cliSlugRenderScope } from "../orq-workspace.js";
import { requestRejected } from "../security.js";
import {
  DEFAULT_EXPLORER_ROWS,
  results as explorerResults,
} from "./explorer-views.js";
import {
  compiledFromForm,
  FinderRunFormSchema,
  formValues,
  parseRange,
  rangeValues,
  runRequest,
  utcIso,
} from "./route-forms.js";
import { searchFragment, searchPageHtml } from "./search-views.js";
import {
  requestSessionState,
  TraceSessionRegistry,
  withTraceSession,
} from "./sessions.js";
import {
  type BodyOptions,
  drawer,
  facetMenu,
  fragment,
  missingTraceDrawer,
  pageHtml,
  runStatus,
  scopeToggle,
  spanTree,
} from "./views.js";
export {
  FINDER_EXPORT_REFERENCE_DIR,
  readPrivateFinderReference,
  validatePrivateFinderReferenceDir,
};

const NUMERIC_FIELDS = NUMERIC_FACET_NAMES.flatMap((name) => [
  `${name}_min`,
  `${name}_max`,
]);
export const CONFIRM_ROWS = 500;
const FINDER_EXPORT_RETENTION = 50;
const HOUR_MS = 3_600_000;
const FINDER_EXPORT_HANDOFF_GRACE_MS = HOUR_MS;
const FINDER_EXPORT_REFERENCE_MAX_AGE_MS = 30 * 24 * HOUR_MS;
const CATALOGUE_TTL_MS = 5 * 60_000;
const CATALOGUE_FAILURE_TTL_MS = 60_000;

const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const errorText = (error: unknown) =>
  error instanceof z.ZodError
    ? error.issues
        .map((issue) =>
          issue.path.length
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("\n")
    : error instanceof Error
      ? error.message
      : String(error);

const expandUser = (value: string) =>
  value === "~" || value.startsWith("~/")
    ? join(homedir(), value.slice(1))
    : value;

function exportCandidate(value: unknown, exportRoot: string): string | null {
  if (typeof value !== "string" || !value) return null;
  const candidate = expandUser(value);
  const resolved = resolve(
    isAbsolute(candidate) ? candidate : join(exportRoot, candidate),
  );
  return dirname(resolved) === exportRoot &&
    basename(resolved).startsWith("trace-finder-") &&
    resolved.endsWith(".json")
    ? resolved
    : null;
}

async function inflightFinderExport(
  marker: string,
  manifestsDir: string,
  exportRoot: string,
  now: number,
): Promise<[string | null, boolean]> {
  try {
    // An unreadable marker can block pruning while it might still belong to
    // a live run, but the lease itself expires after the maximum run age.
    const markerInfo = await lstat(marker);
    if (now - markerInfo.mtimeMs > FINDER_EXPORT_REFERENCE_MAX_AGE_MS) {
      if (markerInfo.isDirectory())
        console.warn(`Ignoring expired non-file Finder export lease ${marker}`);
      else {
        await unlink(marker).catch(() => undefined);
        console.warn(
          `Removed expired Finder export lease ${marker} before pruning`,
        );
      }
      return [null, true];
    }
    const stem = basename(marker, ".json");
    if (!/^[\p{L}\p{N}_-]+$/u.test(stem) || !/[\p{L}\p{N}]/u.test(stem)) {
      console.warn(
        `Could not inspect in-flight Finder export reference with invalid run ID: ${marker}`,
      );
      return [null, false];
    }
    const data = await readPrivateFinderReference(marker);
    const manifestPath = join(manifestsDir, `${stem}.json`);
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest === null || typeof manifest !== "object") return [null, false];
    const age = now - (await stat(manifestPath)).mtimeMs;
    if (
      (manifest as Record<string, unknown>).status !== "running" ||
      age > FINDER_EXPORT_REFERENCE_MAX_AGE_MS
    ) {
      await unlink(marker).catch(() => undefined);
      return [null, true];
    }
    const value = data.finder_export;
    if (typeof value !== "string" || !value) return [null, false];
    return [exportCandidate(value, exportRoot), true];
  } catch (error) {
    console.warn(
      `Could not inspect in-flight Finder export reference ${marker}: ${errorText(error)}`,
    );
    return [null, false];
  }
}

async function referencedFinderExports(
  exportDir: string,
): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  const runsDir = getStoreDir("insights-runs");
  let runPaths: string[];
  try {
    runPaths = (
      await readdir(runsDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      })
    )
      .filter((name) => name.startsWith("insights_") && name.endsWith(".json"))
      .map((name) => join(runsDir, name));
  } catch (error) {
    console.warn(
      `Could not inspect Insights runs for Finder export references: ${errorText(error)}`,
    );
    return null;
  }
  const exportRoot = resolve(exportDir);
  for (const runPath of runPaths) {
    try {
      const data: unknown = JSON.parse(await readFile(runPath, "utf8"));
      const population =
        data !== null && typeof data === "object"
          ? (data as Record<string, unknown>).population
          : null;
      const value =
        population !== null && typeof population === "object"
          ? (population as Record<string, unknown>).finder_export
          : null;
      const candidate = exportCandidate(value, exportRoot);
      if (candidate !== null) referenced.add(candidate);
    } catch (error) {
      console.warn(
        `Could not inspect Insights run ${runPath} for Finder export references: ${errorText(error)}`,
      );
      return null;
    }
  }
  const referencesDir = join(runsDir, FINDER_EXPORT_REFERENCE_DIR);
  try {
    await validatePrivateFinderReferenceDir(referencesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return referenced;
    console.warn(
      `Could not inspect Finder export lease directory ${referencesDir}: ${errorText(error)}`,
    );
    return null;
  }
  const now = Date.now();
  for (const name of await readdir(referencesDir)) {
    if (!name.endsWith(".json")) continue;
    const [candidate, trusted] = await inflightFinderExport(
      join(referencesDir, name),
      join(runsDir, ".manifests"),
      exportRoot,
      now,
    );
    if (!trusted) return null;
    if (candidate !== null) referenced.add(candidate);
  }
  return referenced;
}

async function pruneFinderExportsLocked(exportDir: string): Promise<void> {
  try {
    const files: { path: string; mtimeNs: bigint; mtimeMs: number }[] = [];
    for (const name of await readdir(exportDir)) {
      if (!name.startsWith("trace-finder-") || !name.endsWith(".json"))
        continue;
      const path = join(exportDir, name);
      const info = await lstat(path, { bigint: true });
      if (info.isFile())
        files.push({
          path: resolve(path),
          mtimeNs: info.mtimeNs,
          mtimeMs: Number(info.mtimeMs),
        });
    }
    files.sort((a, b) =>
      a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1,
    );
    // With at most the retention limit of exports, every unreferenced file is
    // retained anyway, so skip scanning Insights until pruning could remove one.
    if (files.length <= FINDER_EXPORT_RETENTION) return;
    const retained = await referencedFinderExports(exportDir);
    if (retained === null) {
      console.warn(
        "Skipping Finder export pruning because Insights references could not be verified",
      );
      return;
    }
    const cutoff = Date.now() - FINDER_EXPORT_HANDOFF_GRACE_MS;
    for (const file of files)
      if (file.mtimeMs >= cutoff) retained.add(file.path);
    const unreferenced = files.filter((file) => !retained.has(file.path));
    for (const file of unreferenced.slice(FINDER_EXPORT_RETENTION))
      await unlink(file.path).catch((error: unknown) =>
        console.warn(
          `Could not remove expired Finder export ${basename(file.path)}: ${errorText(error)}`,
        ),
      );
  } catch (error) {
    console.warn(
      `Could not prune saved Finder exports in ${exportDir}: ${errorText(error)}`,
    );
  }
}

export async function pruneFinderExports(exportDir: string): Promise<void> {
  await mkdir(exportDir, { recursive: true });
  await withFileLock(join(exportDir, ".finder-export.lock"), () =>
    pruneFinderExportsLocked(exportDir),
  );
}

export async function saveFinderExport(
  exportDir: string,
  exportName: string,
  payload: string,
): Promise<void> {
  await mkdir(exportDir, { recursive: true });
  await withFileLock(join(exportDir, ".finder-export.lock"), async () => {
    const temporary = join(
      exportDir,
      `.finder-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(exportDir, exportName));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await pruneFinderExportsLocked(exportDir);
  });
}

export async function spanTreeFragment(
  traceId: string,
  options: {
    loadSpans: (traceId: string) => Promise<readonly unknown[]>;
    loadFirstErrorMessage: (
      traceId: string,
      spans: readonly unknown[],
    ) => Promise<string | null>;
  },
): Promise<string> {
  let spans: readonly unknown[];
  try {
    spans = await options.loadSpans(traceId);
  } catch (error) {
    console.warn(
      `Span lookup failed for trace ${traceId}: ${errorText(error)}`,
    );
    return '<p class="finder-empty" role="status">Could not load spans. Try again.</p>';
  }
  let errorMessage: string | null;
  try {
    errorMessage = await options.loadFirstErrorMessage(traceId, spans);
  } catch (error) {
    console.warn(
      `Span status lookup failed for trace ${traceId}: ${error instanceof Error ? error.name : typeof error}`,
    );
    errorMessage = null;
  }
  return cliSlugRenderScope(() =>
    spanTree(traceId, spans, null, { firstErrorMessage: errorMessage }),
  );
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class SettingsChangedError extends Error {}

type Catalogue = FacetCatalogue | null;

export interface FinderRouteOptions {
  /** Starting settings; defaults to the saved settings file with environment overrides. */
  settings?: DashboardSettings;
  profiles?: () => Promise<readonly OrqProfile[]>;
  buildStore?: (state: FinderState) => Promise<RunStore | null>;
  loadCatalogue?: (
    state: FinderState,
    windowDays: number,
  ) => Promise<Catalogue>;
  signingKey?: Uint8Array;
  sessions?: TraceSessionRegistry;
}

/** Per-application Finder runtime: settings, Orq auth, stores and the facet cache. */
export class FinderState {
  settings: DashboardSettings;
  profile: OrqProfile | null = null;
  generation = 0;
  unavailableReason: string | null = null;
  readonly lock = new Mutex();
  readonly signingKey: Uint8Array;
  readonly sessions: TraceSessionRegistry;
  searchStore: RunStore | null = null;
  catalogueCache: [number, number, Catalogue] | null = null;
  catalogueWarmup:
    | [number, number, Promise<Catalogue>, { done: boolean }]
    | null = null;
  private readonly options: FinderRouteOptions;

  constructor(settings: DashboardSettings, options: FinderRouteOptions = {}) {
    this.settings = settings;
    this.options = options;
    this.signingKey = options.signingKey ?? randomBytes(32);
    this.sessions = options.sessions ?? new TraceSessionRegistry();
  }

  /** Resolve the saved profile while constructing the app, outside request handlers. */
  static async create(options: FinderRouteOptions = {}): Promise<FinderState> {
    const settings = options.settings ?? (await effectiveDashboardSettings());
    const state = new FinderState(settings, options);
    if (settings.orqAuthMethod === "cli_profile") {
      const profiles = await (options.profiles ?? listOrqProfiles)();
      state.profile =
        profiles.find((profile) => profile.name === settings.orqProfile) ??
        null;
      if (state.profile === null)
        console.warn(
          `Saved Orq profile ${settings.orqProfile} is unavailable; select another profile or Environment`,
        );
    }
    return state;
  }

  selectedProfile(): OrqProfile | null {
    const settings = this.settings;
    if (settings.orqAuthMethod !== "cli_profile") return null;
    if (settings.orqProfile != null && this.profile === null)
      throw new Error(
        `Orq profile ${settings.orqProfile} is unavailable. Choose another profile or Environment in Settings.`,
      );
    if (this.profile !== null && this.profile.apiKey.includes("*"))
      throw new Error(
        `Orq profile ${this.profile.name} has no usable API key. Choose another profile or Environment.`,
      );
    return this.profile;
  }

  async dashboardAuth(): Promise<DashboardAuth> {
    const profile = this.selectedProfile();
    return resolveDashboardAuth(this.settings, {
      profiles: profile !== null ? [profile] : [],
    });
  }

  async apiAvailable(): Promise<boolean> {
    try {
      const auth = await this.dashboardAuth();
      return auth.method === "cli_oauth" || Boolean(auth.apiKey);
    } catch {
      return false;
    }
  }

  async unavailableMessage(): Promise<string> {
    let auth: DashboardAuth;
    try {
      auth = await this.dashboardAuth();
    } catch (error) {
      return errorText(error);
    }
    if (auth.method === "environment" && !auth.apiKey)
      return "ORQ_API_KEY is not set. Choose an authentication method in Settings.";
    if (this.unavailableReason) return this.unavailableReason;
    return "Choose a working authentication method in Settings to load traces";
  }

  /** Build an app-owned store, returning null when Orq is unavailable. */
  async buildStore(): Promise<RunStore | null> {
    if (this.options.buildStore) return this.options.buildStore(this);
    let clients: Awaited<ReturnType<typeof buildAuthClients>>;
    try {
      clients = await buildAuthClients(await this.dashboardAuth(), {
        workspace: this.settings.orqWorkspace,
        project: this.settings.orqProjectId,
      });
    } catch (error) {
      this.unavailableReason = errorText(error);
      console.warn(
        `Find surface is unavailable because an Orq client could not be resolved: ${this.unavailableReason}`,
      );
      return null;
    }
    this.unavailableReason = null;
    const [orq, llm] = clients;
    return buildRunStore(this.settings, {
      client: llm as never,
      orq: orq as never,
    });
  }

  async store(
    surface: "search" | "traces",
    sessionId: string | null = null,
    req: Request | null = null,
  ): Promise<RunStore | null> {
    if (surface === "traces") {
      if (sessionId === null)
        throw new Error(
          "A verified browser session is required for the Traces store.",
        );
      const buildSessionStore = async () => {
        const generation = this.generation;
        const store = await this.buildStore();
        if (this.generation !== generation) {
          if (store !== null)
            await store
              .close()
              .catch((error: unknown) =>
                console.warn(
                  `Could not close a stale Traces store: ${errorText(error)}`,
                ),
              );
          throw new SettingsChangedError();
        }
        return store;
      };
      for (;;) {
        try {
          return (await this.sessions.get(
            sessionId,
            buildSessionStore as never,
            req ? requestSessionState(req) : undefined,
          )) as RunStore | null;
        } catch (error) {
          if (!(error instanceof SettingsChangedError)) throw error;
        }
      }
    }
    if (this.searchStore !== null) return this.searchStore;
    return this.lock.run(async () => {
      if (this.searchStore === null) this.searchStore = await this.buildStore();
      return this.searchStore;
    });
  }

  /** Load and cache facet values for five minutes; failures render an empty menu. */
  async loadCatalogue(windowDays: number | null = null): Promise<Catalogue> {
    const now = Date.now();
    const settings = this.settings;
    const generation = this.generation;
    let window = windowDays ?? settings.windowDays;
    if (window < 1 || window > 90) {
      console.warn(
        `Find facet menu uses the configured window because ${window} days is outside 1..90`,
      );
      window = settings.windowDays;
    }
    const cached = this.catalogueCache;
    if (cached !== null && cached[0] > now && cached[1] === window)
      return cached[2];
    let catalogue: FacetCatalogue | null;
    try {
      if (this.options.loadCatalogue)
        catalogue = await this.options.loadCatalogue(this, window);
      else {
        const [orq] = await buildAuthClients(await this.dashboardAuth(), {
          workspace: settings.orqWorkspace,
          project: settings.orqProjectId,
        });
        catalogue = await loadFacetCatalogue(orq as never, {
          start: new Date(now - window * 86_400_000),
          end: new Date(now),
          limit: 50,
        });
      }
      if (
        catalogue !== null &&
        settings.orqProjectId &&
        settings.orqProjectName
      )
        catalogue = FacetCatalogueSchema.parse({
          ...catalogue,
          project: [settings.orqProjectName],
        });
    } catch (error) {
      console.warn(
        `Find facet menu is unavailable because loading facet values failed: ${errorText(error)}`,
      );
      // Cached too, briefly: a menu that never resolves would otherwise retry on every poll swap.
      if (generation === this.generation)
        this.catalogueCache = [now + CATALOGUE_FAILURE_TTL_MS, window, null];
      return null;
    }
    if (generation !== this.generation) return null;
    this.catalogueCache = [now + CATALOGUE_TTL_MS, window, catalogue];
    return catalogue;
  }

  /** Start one background fetch so opening the filter menu can reuse it. */
  async warmCatalogue(windowDays: number): Promise<void> {
    await this.lock.run(() => {
      const cached = this.catalogueCache;
      if (cached !== null && cached[0] > Date.now() && cached[1] === windowDays)
        return;
      const active = this.catalogueWarmup;
      if (
        active !== null &&
        active[0] === this.generation &&
        active[1] === windowDays &&
        !active[3].done
      )
        return;
      const flag = { done: false };
      const task = this.loadCatalogue(windowDays).finally(() => {
        flag.done = true;
        if (this.catalogueWarmup?.[2] === task) this.catalogueWarmup = null;
      });
      task.catch((error: unknown) =>
        console.warn(`Could not warm the facet catalogue: ${errorText(error)}`),
      );
      this.catalogueWarmup = [this.generation, windowDays, task, flag];
    });
  }

  /** Share an in-flight warmup with the menu request for the same window. */
  async catalogueForWindow(windowDays: number): Promise<Catalogue> {
    const active = this.catalogueWarmup;
    if (
      active !== null &&
      active[0] === this.generation &&
      active[1] === windowDays &&
      !active[3].done
    )
      return active[2];
    return this.loadCatalogue(windowDays);
  }

  /** Use the range shown in the controls for the facet catalogue. */
  catalogueWindow(
    snapshot: RunSnapshot | null,
    explorerView: ExplorerView | null,
  ): number {
    const days = (start: string, end: string) =>
      Math.max(
        1,
        Math.round(
          (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
        ),
      );
    const population = snapshot?.request?.population;
    if (snapshot?.request) {
      if (population?.start && population.end)
        return days(population.start, population.end);
    } else if (explorerView?.start && explorerView.end)
      return days(explorerView.start, explorerView.end);
    return this.settings.windowDays;
  }

  /** The cached facet catalogue for a page render, or pending so the menu fetches it itself. */
  catalogueOptions(
    snapshot: RunSnapshot | null = null,
    explorerView: ExplorerView | null = null,
  ): { catalogue?: Catalogue; pending?: boolean } {
    const window = this.catalogueWindow(snapshot, explorerView);
    const cached = this.catalogueCache;
    if (cached !== null && cached[0] > Date.now() && cached[1] === window)
      return { catalogue: cached[2] };
    return { pending: true };
  }

  /** Start the default rows and facets without waiting for either Orq query. */
  async warmInitialFinder(
    sessionId: string,
    req: Request | null,
  ): Promise<RunStore | null> {
    if (!(await this.apiAvailable())) return null;
    const store = await this.store("traces", sessionId, req);
    if (store === null) return null;
    const explorer = store.explorer;
    if (explorer !== null) {
      await this.lock.run(async () => {
        if ((await explorer.view()).state === "idle") {
          const now = Date.now();
          await explorer.load(
            new Date(now - this.settings.windowDays * 86_400_000).toISOString(),
            new Date(now).toISOString(),
            DEFAULT_EXPLORER_ROWS,
            {
              facets: new FacetSelection({
                projectId: this.settings.orqProjectId,
              }),
              numeric: new NumericFilters({}),
              initialLoad: true,
            },
          );
        }
      });
      await this.warmCatalogue(
        this.catalogueWindow(await store.snapshot(), await explorer.view()),
      );
    }
    return store;
  }
}

const html = (
  content: string,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(content, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
const text = (content: string, status: number) =>
  new Response(content, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const pyInt = (raw: string): number => {
  const trimmed = raw.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(trimmed))
    throw new Error(`invalid literal for int() with base 10: '${raw}'`);
  return Number(trimmed.replaceAll("_", ""));
};

const optional = (params: URLSearchParams, name: string) => {
  const raw = params.get(name);
  return raw === null || raw === "" ? null : raw;
};

const facetSelection = (params: URLSearchParams, projectId?: string | null) => {
  const values: Record<string, unknown> = {};
  if (projectId !== undefined) values.projectId = projectId;
  for (const name of FACET_NAMES)
    values[camel(name)] = [...new Set(formValues(params, `facet_${name}`))];
  return new FacetSelection(values);
};

async function formParams(req: Request): Promise<URLSearchParams> {
  const params = new URLSearchParams();
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("form")) return params;
  const form = await req.formData();
  for (const [key, value] of form.entries())
    if (typeof value === "string") params.append(key, value);
  return params;
}

let pollRenderSequence = 0;

/** The /find and /traces routes, matching Python register_finder_routes. */
export function finderRoutes(
  state: FinderState,
): (req: Request, url: URL) => Promise<Response | null> {
  interface Ctx {
    req: Request;
    url: URL;
    surface: string | null;
  }
  const isSearch = (ctx: Ctx) =>
    ctx.url.searchParams.get("surface") === "search" ||
    ctx.surface === "search";
  const sessionId = (ctx: Ctx) =>
    requestSessionState(ctx.req).dashboardSessionId ?? null;
  const tracesStore = (ctx: Ctx) =>
    state.store("traces", sessionId(ctx), ctx.req);
  const storeFor = (ctx: Ctx) =>
    isSearch(ctx)
      ? state.store("search")
      : state.store("traces", sessionId(ctx), ctx.req);

  type FragmentOptions = BodyOptions & { error?: string | null };
  const renderFragment = (
    ctx: Ctx,
    snapshot: RunSnapshot,
    options: FragmentOptions = {},
  ) =>
    isSearch(ctx)
      ? searchFragment(snapshot, state.settings, {
          error: options.error ?? null,
          apiAvailable: options.apiAvailable ?? true,
          catalogue: options.catalogue ?? null,
          pending: options.pending ?? false,
        })
      : fragment(snapshot, state.settings, options);

  /** Carry the active table filters into every /traces controls render. */
  async function currentFragmentOptions(
    ctx: Ctx,
    snapshot: RunSnapshot,
  ): Promise<FragmentOptions> {
    if (isSearch(ctx)) return state.catalogueOptions(snapshot);
    const store = await tracesStore(ctx);
    const explorer = store?.explorer ?? null;
    const explorerView = explorer !== null ? await explorer.view() : null;
    return {
      ...state.catalogueOptions(snapshot, explorerView),
      explorerView,
      explorerFacets: explorerView?.facets ?? null,
      explorerNumeric: explorerView?.numeric ?? null,
    };
  }

  async function explorerHtml(
    ctx: Ctx,
    options: {
      oob?: boolean;
      error?: string | null;
      poll?: boolean;
      pollSequence?: number | null;
    } = {},
  ): Promise<string> {
    const {
      oob = false,
      error = null,
      poll = false,
      pollSequence = null,
    } = options;
    const common = {
      oob,
      error,
      windowDays: state.settings.windowDays,
      tracesLayout: !isSearch(ctx),
      poll,
      pollSequence,
    };
    const store = await tracesStore(ctx);
    const explorer = store?.explorer ?? null;
    if (store === null || explorer === null)
      return explorerResults(new ExplorerView(), resolveColumns(null), {
        ...common,
        records: null,
        snapshot: null,
      });
    let view = await explorer.view();
    const snapshot = await store.snapshotForRender();
    const results = snapshot.withinResults ? snapshot.results : null;
    const pageIds = view.pageRows(results).map((row) => row.traceId);
    let records: Record<string, TraceRecord | null> | null = null;
    if (view.view === "trajectories" && view.rows.length) {
      // A poll never fetches messages: it would wait on the hydration lock a run can hold for minutes.
      records =
        poll || view.state === "loading" || view.trajectoryWarming
          ? explorer.cachedRecords(pageIds)
          : await explorer.records(pageIds);
    } else if (view.state === "loaded" && !view.trajectoryWarming) {
      // Agent root spans often have no model of their own; hydrate only visible agent rows missing it.
      const missing = view
        .pageRows(results)
        .filter(
          (row) =>
            !row.models.length &&
            !row.isError &&
            (row.agentName ||
              (row.name || "").toLowerCase().includes("agent") ||
              (row.operation || "").toLowerCase().includes("agent") ||
              (row.product || "").toLowerCase() === "agents"),
        )
        .map((row) => row.traceId);
      if (missing.length) {
        await explorer.records(missing);
        view = await explorer.view();
      }
    }
    return explorerResults(
      view,
      resolveColumns(state.settings.explorerColumns),
      {
        ...common,
        records: records as never,
        snapshot,
      },
    );
  }

  const rejectedFragment = async (ctx: Ctx, rejected: string) =>
    html(
      renderFragment(ctx, new RunSnapshot(), {
        ...state.catalogueOptions(),
        error: rejected,
      }),
      403,
    );
  const unavailableFragment = async (ctx: Ctx) =>
    html(
      renderFragment(ctx, new RunSnapshot(), {
        ...state.catalogueOptions(),
        error: await state.unavailableMessage(),
        apiAvailable: false,
      }),
    );
  const withExplorer = async (ctx: Ctx, body: string) =>
    body + (isSearch(ctx) ? "" : await explorerHtml(ctx, { oob: true }));

  async function findPage(): Promise<Response> {
    const store = await state.store("search");
    const snapshot =
      store !== null ? await store.snapshot() : new RunSnapshot();
    return html(
      await searchPageHtml(snapshot, state.settings, {
        apiAvailable: store !== null,
        error: store === null ? await state.unavailableMessage() : null,
        ...state.catalogueOptions(snapshot),
      }),
    );
  }

  async function tracesPage(ctx: Ctx): Promise<Response> {
    const id = sessionId(ctx);
    const store =
      id !== null ? await state.warmInitialFinder(id, ctx.req) : null;
    const apiAvailable = store !== null;
    const explorer = store?.explorer ?? null;
    const explorerView = explorer !== null ? await explorer.view() : null;
    const snapshot =
      store !== null ? await store.snapshot() : new RunSnapshot();
    return html(
      await pageHtml(snapshot, state.settings, {
        apiAvailable,
        error: apiAvailable ? null : await state.unavailableMessage(),
        explorerHtml: store !== null ? await explorerHtml(ctx) : "",
        explorerView,
        hasRows: Boolean(explorerView?.rows.length),
        autoScopePending: Boolean(
          explorerView?.initialLoad && explorerView.state === "loading",
        ),
        ...state.catalogueOptions(snapshot, explorerView),
      } as never),
    );
  }

  /** Download every row in the active traces table view, across all pages. */
  async function tracesExportCsv(ctx: Ctx): Promise<Response> {
    const store = await tracesStore(ctx);
    const explorer = store?.explorer ?? null;
    if (store === null || explorer === null)
      return text("Trace table is unavailable.", 503);
    // Read the explorer on both sides of the run snapshot so one export never pairs two table generations.
    let view: ExplorerView | null = null;
    let snapshot: RunSnapshot | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await explorer.view();
      const firstSnapshot = await store.snapshotForRender();
      const confirmed = await explorer.view();
      const confirmedSnapshot = await store.snapshotForRender();
      if (
        first.generation === confirmed.generation &&
        first.version === confirmed.version &&
        firstSnapshot.generation === confirmedSnapshot.generation
      ) {
        view = first;
        snapshot = confirmedSnapshot;
        break;
      }
    }
    if (view === null || snapshot === null)
      return text(
        "Trace results changed while preparing the export. Retry the download.",
        409,
      );
    const sourceIds = new Set(snapshot.traceIds);
    const loadedView = view;
    const snapshotMatchesView =
      (!(Object.keys(snapshot.results).length || snapshot.dimensions?.length) ||
        snapshot.explorerGeneration === loadedView.generation) &&
      (!sourceIds.size ||
        loadedView.rows.every((row) => sourceIds.has(row.traceId)));
    const active =
      snapshot.withinResults && snapshotMatchesView ? snapshot : null;
    const results = active !== null ? active.results : null;
    const dimensions =
      active !== null && Object.keys(active.results).length
        ? (active.dimensions ?? []).map((dimension) => dimension.name)
        : [];
    const content = exportTableCsv(
      matchesFirstView(loadedView, active).visibleRows(results),
      state.settings.explorerColumns,
      { dimensions, results },
    );
    return new Response(content, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="traces.csv"',
      },
    });
  }

  async function findRun(ctx: Ctx, form: URLSearchParams): Promise<Response> {
    const rejected = requestRejected(ctx.req, form);
    if (rejected)
      return html(
        renderFragment(ctx, new RunSnapshot(), {
          ...state.catalogueOptions(),
          error: rejected,
          apiAvailable: await state.apiAvailable(),
        }),
        403,
      );
    const settings = state.settings;
    const store = await storeFor(ctx);
    if (store === null) return unavailableFragment(ctx);
    let snapshot: RunSnapshot;
    try {
      const hydrateExplorerRows = async (ids: readonly string[]) => {
        const explorerStore = store.explorer;
        if (explorerStore === null)
          throw new Error("The trace table is unavailable.");
        const records = Object.values(await explorerStore.records(ids));
        const missing = records.filter((record) => record === null).length;
        if (missing)
          console.warn(
            `Skipping ${missing} loaded trace(s) without usable messages in the classification`,
          );
        return records.filter(
          (record): record is TraceRecord => record !== null,
        );
      };
      if ((form.get("scope") || "new") === "within") {
        const explorer = store.explorer;
        const explorerView = explorer !== null ? await explorer.view() : null;
        if (
          explorer === null ||
          explorerView === null ||
          !explorerView.rows.length
        ) {
          const current = await store.snapshot();
          return html(
            renderFragment(ctx, current, {
              error: "Load traces first, then ask within the results.",
              ...(await currentFragmentOptions(ctx, current)),
            }),
          );
        }
        const base = runRequest(form, settings);
        // The AI trace limit caps how many rows are judged, not how many the table loaded.
        const limit = Math.min(explorerView.rows.length, base.population.limit);
        const request: RunRequest = {
          ...base,
          mode: limit > CONFIRM_ROWS ? "review" : base.mode,
          population: new PopulationRequest({
            start: explorerView.start,
            end: explorerView.end,
            timeOrigin: "within_results",
            facets: explorerView.facets,
            numeric: explorerView.numeric,
            limit,
          }),
        };
        const ids = explorerView.rows.map((row) => row.traceId);
        snapshot = await store.compile(request, {
          wait: false,
          traces: () => hydrateExplorerRows(ids),
          tracesLimited: async (traceLimit) => {
            const [records, missing] = await explorer.recordsUntilUsable(ids, {
              generation: explorerView.generation,
              limit: traceLimit,
            });
            if (missing)
              console.warn(
                `Skipping ${missing} loaded trace(s) without usable messages in the classification`,
              );
            return records;
          },
          sourceGeneration: () => explorerView.generation,
        });
      } else {
        const request = runRequest(form, settings);
        const explorer = ctx.surface !== "search" ? store.explorer : null;
        let loadedTableGeneration: number | null = null;
        snapshot = await store.compile(request, {
          wait: false,
          table:
            explorer !== null
              ? async (population) => {
                  const end = population.end ?? new Date().toISOString();
                  const start =
                    population.start ??
                    new Date(
                      new Date(end).getTime() -
                        settings.windowDays * 86_400_000,
                    ).toISOString();
                  const view = await explorer.load(
                    start,
                    end,
                    population.limit,
                    {
                      facets: population.facets,
                      numeric: population.numeric,
                      wait: true,
                      warmTrajectories: false,
                    },
                  );
                  if (view.state === "failed")
                    throw new Error(
                      view.error || "Trace table loading failed.",
                    );
                  loadedTableGeneration = view.generation;
                  return hydrateExplorerRows(
                    view.rows.map((row) => row.traceId),
                  );
                }
              : undefined,
          sourceGeneration: () => loadedTableGeneration,
        });
      }
    } catch (error) {
      const current = await store.snapshot();
      return html(
        renderFragment(ctx, current, {
          ...(await currentFragmentOptions(ctx, current)),
          error: errorText(error),
        }),
        422,
      );
    }
    return html(
      await withExplorer(
        ctx,
        renderFragment(
          ctx,
          snapshot,
          await currentFragmentOptions(ctx, snapshot),
        ),
      ),
    );
  }

  // How /traces polls without redrawing its controls: the Ask AI band polls /find/poll while a
  // run is compiling or classifying and answers 286 (htmx: stop polling) once it settles, while
  // #explorer-results polls /find/rows. Neither re-renders #finder-controls.
  async function findPoll(ctx: Ctx): Promise<Response> {
    pollRenderSequence += 1;
    const pollSequence = pollRenderSequence;
    const store = await storeFor(ctx);
    const snapshot =
      store !== null ? await store.snapshotForRender() : new RunSnapshot();
    const explorer = !isSearch(ctx) ? (store?.explorer ?? null) : null;
    const explorerView = explorer !== null ? await explorer.view() : null;
    let explorerOob = "";
    // A within-results run may narrow the table to zero rows, so it still needs the refresh.
    if (
      explorerView !== null &&
      (explorerView.rows.length || snapshot.withinResults) &&
      (snapshot.state === "classifying" ||
        snapshot.state === "completed" ||
        Object.keys(snapshot.results).length)
    )
      explorerOob = await explorerHtml(ctx, {
        oob: true,
        poll: true,
        pollSequence,
      });
    if (
      !isSearch(ctx) &&
      store !== null &&
      snapshot.state !== "idle" &&
      snapshot.state !== "awaiting_review"
    ) {
      const running =
        snapshot.state === "compiling" || snapshot.state === "classifying";
      return html(
        runStatus(snapshot, { hasExplorer: explorerView !== null }) +
          explorerOob,
        running ? 200 : 286,
      );
    }
    const options: FragmentOptions = state.catalogueOptions(
      snapshot,
      explorerView,
    );
    if (explorerView !== null) options.explorerView = explorerView;
    const body = renderFragment(ctx, snapshot, {
      ...options,
      apiAvailable: store !== null,
      error: store === null ? await state.unavailableMessage() : null,
    });
    return html(
      body + explorerOob,
      200,
      isSearch(ctx)
        ? {}
        : { "HX-Retarget": "#finder-body", "HX-Reswap": "innerHTML" },
    );
  }

  async function findLoad(ctx: Ctx, form: URLSearchParams): Promise<Response> {
    const rejected = requestRejected(ctx.req, form);
    if (rejected) return html(await explorerHtml(ctx, { error: rejected }));
    const store = await tracesStore(ctx);
    const explorer = store?.explorer ?? null;
    if (store === null || explorer === null)
      return html(
        await explorerHtml(ctx, { error: await state.unavailableMessage() }),
      );
    let start: bigint;
    let end: bigint;
    let rows: number;
    let numeric: NumericFilters;
    try {
      [start, end] = parseRange(
        ...rangeValues(form),
        form.get("tz_offset"),
        form.get("from_tz_offset"),
        form.get("to_tz_offset"),
      );
      rows = pyInt(form.get("rows") || String(DEFAULT_EXPLORER_ROWS));
      if (rows < 1 || rows > MAX_LIVE_TRACES)
        throw new Error(`Rows must be between 1 and ${MAX_LIVE_TRACES}.`);
      const values: Record<string, number> = {};
      for (const name of NUMERIC_FIELDS) {
        const raw = optional(form, name);
        if (raw !== null) values[camel(name)] = pyInt(raw);
      }
      numeric = new NumericFilters(values);
    } catch (error) {
      console.warn(`Explorer load rejected: ${errorText(error)}`);
      return html(await explorerHtml(ctx, { error: errorText(error) }));
    }
    const facets = facetSelection(form, state.settings.orqProjectId);
    await explorer.load(utcIso(start), utcIso(end), rows, { facets, numeric });
    const snapshot = await store.snapshotForRender();
    const explorerView = await explorer.view();
    await state.warmCatalogue(state.catalogueWindow(snapshot, explorerView));
    const options: FragmentOptions = {
      ...state.catalogueOptions(snapshot, explorerView),
      explorerFacets: facets,
      explorerNumeric: numeric,
      explorerView,
    };
    const bodyOob =
      `<div id="finder-body" hx-swap-oob="innerHTML">${renderFragment(ctx, snapshot, options)}</div>` +
      `<div id="finder-scope" hx-swap-oob="innerHTML">${scopeToggle({ hasRows: true, selected: "within" })}</div>`;
    return html((await explorerHtml(ctx)) + bodyOob);
  }

  async function findRows(ctx: Ctx): Promise<Response> {
    const polling = ctx.req.headers.get("HX-Trigger") === "explorer-results";
    let pollSequence: number | null = null;
    if (polling) {
      pollRenderSequence += 1;
      pollSequence = pollRenderSequence;
    }
    const store = await tracesStore(ctx);
    const explorer = store?.explorer ?? null;
    if (explorer !== null) {
      const params = ctx.url.searchParams;
      const sort = params.get("sort");
      const direction = params.get("dir");
      const page = params.get("page");
      const view = params.get("view");
      const quickView = params.get("quick_view");
      const flag = (name: string) =>
        ({ "1": true, "0": false })[params.get(name) ?? ""] ?? null;
      const { COLUMNS } = await import("../../trace-finder/columns.js");
      await explorer.setView({
        sort: sort !== null && Object.hasOwn(COLUMNS, sort) ? sort : null,
        descending:
          direction === "asc" || direction === "desc"
            ? direction === "desc"
            : null,
        page: page && /^\d+$/.test(page) ? Number(page) : sort ? 0 : null,
        view: view === "table" || view === "trajectories" ? view : null,
        showToolDefinitions: flag("show_tool_definitions"),
        matchedOnly: flag("matched_only"),
        quickView:
          quickView !== null && QUICK_VIEWS.has(quickView)
            ? (quickView as never)
            : null,
      });
      const current = await explorer.view();
      if (
        current.state === "loaded" &&
        current.quickView === "conv_longest" &&
        current.rows.length
      )
        await explorer.startMessageCounting({
          retry: quickView === "conv_longest",
        });
    }
    // The section's own timer swaps nothing itself (hx-swap="none"), so its render arrives out of band.
    return html(
      await explorerHtml(ctx, { oob: polling, poll: polling, pollSequence }),
    );
  }

  async function findColumns(
    ctx: Ctx,
    form: URLSearchParams,
  ): Promise<Response> {
    const rejected = requestRejected(ctx.req, form);
    if (rejected) return html(await explorerHtml(ctx, { error: rejected }));
    const { COLUMNS } = await import("../../trace-finder/columns.js");
    const keys = formValues(form, "columns").filter((key) =>
      Object.hasOwn(COLUMNS, key),
    );
    try {
      const saved = await loadDashboardSettings();
      await saveDashboardSettings(
        new DashboardSettings({ ...saved.toJSON(), explorerColumns: keys }),
        undefined,
        { changedFields: new Set(["explorerColumns"]) },
      );
    } catch (error) {
      console.warn(
        `Could not save explorer columns: ${error instanceof Error ? error.name : "error"}`,
      );
      return html(
        await explorerHtml(ctx, {
          error:
            "Could not save columns because the settings file is unreadable or invalid. Fix or restore the JSON settings file, then try again.",
        }),
      );
    }
    state.settings = new DashboardSettings({
      ...state.settings.toJSON(),
      explorerColumns: keys,
    });
    return html(await explorerHtml(ctx));
  }

  async function findStart(ctx: Ctx, form: URLSearchParams): Promise<Response> {
    const rejected = requestRejected(ctx.req, form);
    if (rejected) return rejectedFragment(ctx, rejected);
    const store = await storeFor(ctx);
    if (store === null) return unavailableFragment(ctx);
    const current = await store.snapshot();
    if (
      current.state !== "awaiting_review" ||
      current.request === null ||
      current.dimensions === null
    )
      return html(
        renderFragment(ctx, current, {
          error: "There is no plan waiting for review.",
          ...(await currentFragmentOptions(ctx, current)),
        }),
        409,
      );
    let snapshot: RunSnapshot;
    try {
      const request = runRequest(form, state.settings, {
        anchor: current.request.population,
        queryFallback: current.request.query,
      });
      const dimensions = current.dimensions.map((dimension, index) =>
        compiledFromForm(dimension, form, `d${index}_`),
      );
      snapshot = await store.start(request, dimensions, { wait: false });
    } catch (error) {
      return html(
        renderFragment(ctx, current, {
          error: errorText(error),
          ...(await currentFragmentOptions(ctx, current)),
        }),
        422,
      );
    }
    return html(
      await withExplorer(
        ctx,
        renderFragment(
          ctx,
          snapshot,
          await currentFragmentOptions(ctx, snapshot),
        ),
      ),
    );
  }

  async function findCancelOrReset(
    ctx: Ctx,
    form: URLSearchParams,
    action: "cancel" | "reset",
  ): Promise<Response> {
    const rejected = requestRejected(ctx.req, form);
    if (rejected) return rejectedFragment(ctx, rejected);
    const store = await storeFor(ctx);
    let snapshot = new RunSnapshot();
    if (store !== null) {
      snapshot =
        action === "cancel" ? await store.cancel() : await store.reset();
      if (action === "reset" && store.explorer !== null) {
        await store.explorer.restoreNarrowed();
        await store.explorer.clearAiViewState();
      }
    }
    return html(
      await withExplorer(
        ctx,
        renderFragment(ctx, snapshot, {
          apiAvailable: store !== null,
          ...(await currentFragmentOptions(ctx, snapshot)),
        }),
      ),
    );
  }

  async function findTraceSpans(ctx: Ctx): Promise<Response> {
    const traceId = ctx.url.searchParams.get("trace_id") ?? "";
    const store = await storeFor(ctx);
    const explorer = store?.explorer ?? null;
    if (explorer === null || !traceId)
      return html(
        '<p class="finder-empty">Span loading is unavailable.</p>',
        404,
      );
    if ((await explorer.row(traceId)) === null)
      return html(
        '<p class="finder-empty">This trace is not in the loaded table.</p>',
        404,
      );
    return html(
      await spanTreeFragment(traceId, {
        loadSpans: (id) => explorer.spans(id),
        loadFirstErrorMessage: (id, spans) =>
          explorer.firstErrorMessage(id, spans as never),
      }),
    );
  }

  async function findTrace(ctx: Ctx, traceId: string): Promise<Response> {
    const store = await storeFor(ctx);
    if (store === null)
      return html(
        '<p class="finder-empty">Trace finding is unavailable.</p>',
        404,
      );
    const rawMsg = ctx.url.searchParams.get("msg") ?? "";
    const msg =
      /^\d+$/.test(rawMsg) && rawMsg.length <= 4300 ? Number(rawMsg) : null;
    const tracesLayout = ctx.url.searchParams.get("surface") === "traces";
    const explorer = store.explorer;
    const row = explorer !== null ? await explorer.row(traceId) : null;
    const snapshot = await store.snapshot();
    let detail: TraceDetail | null =
      row === null || snapshot.withinResults
        ? await store.traceDetail(traceId)
        : null;
    // A within-results run can narrow the visible rows while this request is in flight, so
    // recover the record from the explorer cache even when the row has left the visible set.
    if (
      detail === null &&
      explorer !== null &&
      (row !== null || snapshot.withinResults)
    ) {
      const record = (await explorer.records([traceId]))[traceId] ?? null;
      if (record !== null) detail = new TraceDetail(record, null, null);
      else if (row !== null || (await explorer.hasCachedRecord(traceId))) {
        console.warn(
          `Find drawer could not load messages for explorer trace ${traceId}`,
        );
        return html(
          await missingTraceDrawer(traceId, {
            reason:
              "The messages could not be loaded for this trace. Open it in Orq instead.",
            tracesLayout,
          }),
        );
      }
    }
    if (detail === null) {
      // htmx does not swap a 4xx body, so a 404 here would leave the click silently doing nothing.
      console.warn(
        `Find drawer requested trace ${traceId} that is not in the current run`,
      );
      return html(await missingTraceDrawer(traceId));
    }
    const found = detail;
    return html(
      await cliSlugRenderScope(() => drawer(found, { msg, row, tracesLayout })),
    );
  }

  async function findExport(ctx: Ctx): Promise<Response> {
    const store = await storeFor(ctx);
    if (store === null) return text("Not found", 404);
    const snapshot = await store.snapshot();
    if (
      snapshot.state !== "completed" ||
      snapshot.request === null ||
      snapshot.dimensions === null
    )
      return text("Not found", 404);
    const exportName = exportFilename(snapshot);
    const requested = ctx.url.searchParams.get("export");
    if (requested !== null && requested !== exportName)
      return text(
        "This Finder result changed. Refresh the page to download the current result.",
        409,
      );
    const payload = exportJson(snapshot);
    try {
      await saveFinderExport(
        getStoreDir("finder-exports"),
        exportName,
        payload,
      );
    } catch (error) {
      console.warn(
        `Could not save Finder export for Insights: ${errorText(error)}`,
      );
      return text("Could not save Finder export for Insights.", 500);
    }
    return new Response(payload, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${exportName}"`,
      },
    });
  }

  /** Re-render the filter menu from the controls the client sends, so it never lags the page. */
  async function findFacets(ctx: Ctx): Promise<Response> {
    const settings = state.settings;
    const params = ctx.url.searchParams;
    const parsedWindow = FinderRunFormSchema.pick({
      windowDays: true,
    }).safeParse({
      windowDays: params.get("window_days") || settings.windowDays,
    });
    if (!parsedWindow.success)
      console.warn(
        `Find facet menu uses the configured window because the request was invalid: ${errorText(parsedWindow.error)}`,
      );
    const windowDays = parsedWindow.success
      ? parsedWindow.data.windowDays
      : settings.windowDays;
    const catalogue = await state.catalogueForWindow(windowDays);
    const rowScoped = params.get("counts") === "loaded";
    const allowed = new Set(["finder-query-form", "finder-start-form"]);
    // Only the Traces surface requests row-scoped counts, and its toolbar checkboxes submit with the reload form.
    if (rowScoped) allowed.add("explorer-load-form");
    let formId = params.get("form_id");
    if (formId === null || !allowed.has(formId)) formId = "finder-query-form";
    const selection = facetSelection(params);
    const numericValues: Record<string, number | null> = {};
    for (const name of NUMERIC_FIELDS) {
      const raw = optional(params, name);
      if (raw === null) {
        numericValues[name] = null;
        continue;
      }
      try {
        const value = pyInt(raw);
        if (value < 0) throw new Error("must be nonnegative");
        numericValues[name] = value;
      } catch {
        console.warn(`Find facet menu ignores invalid ${name}=${raw}`);
        numericValues[name] = null;
      }
    }
    for (const facet of NUMERIC_FACET_NAMES) {
      const lower = numericValues[`${facet}_min`] ?? null;
      const upper = numericValues[`${facet}_max`] ?? null;
      if (lower !== null && upper !== null && lower > upper) {
        console.warn(
          `Find facet menu ignores ${facet}_max because it is below ${facet}_min`,
        );
        numericValues[`${facet}_max`] = null;
      }
    }
    const numeric = new NumericFilters(
      Object.fromEntries(
        Object.entries(numericValues).map(([key, value]) => [
          camel(key),
          value,
        ]),
      ),
    );
    let loadedRows = null;
    if (rowScoped) {
      const store = await tracesStore(ctx);
      const explorer = store?.explorer ?? null;
      loadedRows = explorer !== null ? (await explorer.view()).rows : null;
    }
    return html(
      facetMenu(catalogue, {
        numeric,
        open: params.get("open") === "1",
        formId,
        selection,
        loadedRows,
        rowScoped,
        windowDays,
      }),
    );
  }

  return async (req, url) => {
    const path = url.pathname;
    const method = req.method;
    const ctx: Ctx = { req, url, surface: null };
    if (method === "GET") {
      if (path === "/find") return findPage();
      if (path === "/traces") return tracesPage(ctx);
      if (path === "/traces/export.csv") return tracesExportCsv(ctx);
      if (path === "/find/poll") return findPoll(ctx);
      if (path === "/find/rows") return findRows(ctx);
      if (path === "/find/trace-spans") return findTraceSpans(ctx);
      if (path.startsWith("/find/trace/"))
        return findTrace(
          ctx,
          decodeURIComponent(path.slice("/find/trace/".length)),
        );
      if (path === "/find/export.json") return findExport(ctx);
      if (path === "/find/facets") return findFacets(ctx);
      if (path === "/find/dismiss") return html("");
      return null;
    }
    if (method !== "POST") return null;
    const handlers: Record<
      string,
      (ctx: Ctx, form: URLSearchParams) => Promise<Response>
    > = {
      "/find/run": findRun,
      "/find/load": findLoad,
      "/find/columns": findColumns,
      "/find/start": findStart,
      "/find/cancel": (c, f) => findCancelOrReset(c, f, "cancel"),
      "/find/reset": (c, f) => findCancelOrReset(c, f, "reset"),
    };
    const handler = handlers[path];
    if (!handler) return null;
    const form = await formParams(req);
    if (path !== "/find/load" && path !== "/find/columns")
      ctx.surface = form.get("surface");
    return handler(ctx, form);
  };
}

/** Wrap a dashboard handler so /find and /traces requests carry a signed browser session. */
export function withFinderSessions(
  state: FinderState,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return withTraceSession(handler, {
    signingKey: state.signingKey,
    registry: state.sessions,
  });
}
