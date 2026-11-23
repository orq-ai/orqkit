import { randomBytes } from "node:crypto";

import type OpenAI from "openai";

import {
  type AgentInstructionsClient,
  type ApplyRecommendationsResult,
  readInstructions,
  writeInstructions,
} from "../common/apply.js";
import { defaultRoots, resolve } from "../common/dashboard/library.js";
import { roleModel } from "../common/model-roles.js";
import { esc } from "../common/reports/html-helpers.js";
import { pythonStrip } from "../common/sanitize.js";
import { applySimulationSuggestions } from "../integrations/simulation/reports/apply.js";
import type {
  SimulationRecommendation,
  SimulationRun,
} from "../integrations/simulation/run-store.js";
import { applyRedteamRecommendations } from "../redteam/reports/apply.js";
import type {
  FocusAreaRecommendation,
  RedTeamReport,
} from "../redteam/reports/models.js";
import {
  type DashboardSettings,
  effectiveDashboardSettings,
} from "../trace-finder/settings.js";
import {
  isSimApplyEnabled,
  recordAppliedOnReport,
  renderAppliedDrawer,
  renderErrorDrawer,
  renderPreviewDrawer,
  simBreakdownHtml,
} from "./apply-ui.js";
import {
  authIdentity,
  buildAuthClients,
  type DashboardAuth,
  resolveDashboardAuth,
} from "./auth.js";
import { loadReport, notFoundFragment } from "./redteam-views.js";
import { requestRejected } from "./security.js";
import { loadRun } from "./sim-views.js";
import type { FinderState } from "./trace-finder/routes.js";

export interface ApplyClients {
  orq: AgentInstructionsClient;
  llm: OpenAI;
  model: string;
}

type ApplyFn = (
  items: unknown[],
  agentKey: string,
  clients: ApplyClients,
  alreadyApplied: string[],
) => Promise<ApplyRecommendationsResult>;

export interface ApplyRouteDeps {
  roots?: () => string[] | null;
  finder?: FinderState | null;
  selectedAuth?: () => Promise<{
    auth: DashboardAuth;
    settings: DashboardSettings;
  }>;
  buildClients?: (
    auth: DashboardAuth,
    settings: DashboardSettings,
  ) => Promise<ApplyClients>;
  closeClients?: (clients: ApplyClients) => Promise<void>;
  applyRedteam?: ApplyFn;
  applySim?: ApplyFn;
}

interface PreviewEntry {
  rid: string;
  surface: string;
  agentKey: string;
  originalInstructions: string;
  newInstructions: string;
  recommendations: string[];
  credentialIdentity: string;
}

const PREVIEWS = new Map<string, PreviewEntry>();
const PREVIEWS_CAP = 32;

function storePreview(entry: PreviewEntry): string {
  const token = randomBytes(16).toString("base64url");
  while (PREVIEWS.size >= PREVIEWS_CAP) {
    const oldest = PREVIEWS.keys().next().value as string;
    PREVIEWS.delete(oldest);
  }
  PREVIEWS.set(token, entry);
  return token;
}

function popPreview(token: string): PreviewEntry | null {
  const entry = PREVIEWS.get(token) ?? null;
  PREVIEWS.delete(token);
  return entry;
}

export function clearApplyPreviews(): void {
  PREVIEWS.clear();
}

export function applyModel(): string {
  return roleModel("smart", { task: "apply" });
}

class ApplyConfigError extends Error {}

async function defaultBuildClients(
  auth: DashboardAuth,
  settings: DashboardSettings,
): Promise<ApplyClients> {
  if (auth.method !== "cli_oauth" && !auth.apiKey)
    throw new ApplyConfigError(
      "ORQ_API_KEY is not set; the dashboard cannot reach the Orq API to apply recommendations.",
    );
  const [orq, llm] = await buildAuthClients(auth, {
    workspace: settings.orqWorkspace,
    project: settings.orqProjectId,
  });
  return {
    orq: orq as unknown as AgentInstructionsClient,
    llm: llm as OpenAI,
    model: applyModel(),
  };
}

async function defaultCloseClients(clients: ApplyClients): Promise<void> {
  for (const [name, client] of [
    ["Orq", clients.orq],
    ["LLM", clients.llm],
  ] as const) {
    try {
      const close = (client as { close?: () => unknown }).close;
      if (typeof close === "function") await close.call(client);
    } catch (error) {
      console.warn(`apply_ui: could not close ${name} client: ${error}`);
    }
  }
}

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const errorDrawer = (message: string) => html(renderErrorDrawer(message));

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Narrowed = [
  unknown[],
  FocusAreaRecommendation | null,
  string,
  string | null,
];

function rtNarrow(form: FormData, report: RedTeamReport): Narrowed {
  const areas = [...(report.focusAreaRecommendations ?? [])];
  const single = pythonStrip(String(form.get("rec") ?? ""));
  if (!single) return [areas, null, "", null];
  const category = pythonStrip(String(form.get("category") ?? ""));
  const area = areas.find(
    (a) =>
      a.category === category &&
      a.recommendations.map((r) => pythonStrip(r)).includes(single),
  );
  if (!area)
    return [
      [],
      null,
      "",
      "That recommendation is no longer on the report; reload the page.",
    ];
  if (report.appliedRecommendations.some((r) => pythonStrip(r) === single))
    return [
      [],
      null,
      "",
      "That recommendation is already applied to the agent.",
    ];
  return [[{ ...area, recommendations: [single] }], area, "", null];
}

function simNarrow(form: FormData, run: SimulationRun): Narrowed {
  const recs: SimulationRecommendation[] = [...(run.recommendations ?? [])];
  const single = pythonStrip(String(form.get("rec") ?? ""));
  if (!single) return [recs, null, "", null];
  const rawIndex = pythonStrip(String(form.get("result_index") ?? ""));
  const idx = /^[+-]?\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
  const card = recs.find(
    (r) =>
      r.resultIndex === idx &&
      r.suggestions.map((s) => pythonStrip(s)).includes(single),
  );
  if (!card)
    return [
      [],
      null,
      "",
      "That suggestion is no longer on the report; reload the page.",
    ];
  if (run.appliedSuggestions.some((s) => pythonStrip(s) === single))
    return [[], null, "", "That suggestion is already applied to the agent."];
  return [
    [{ ...card, suggestions: [single] }],
    null,
    simBreakdownHtml(card),
    null,
  ];
}

export function applyRoutes(
  deps: ApplyRouteDeps = {},
): (req: Request, url: URL) => Promise<Response | null> {
  const roots = () => deps.roots?.() ?? defaultRoots();
  const selectedAuth =
    deps.selectedAuth ??
    (async () => {
      if (deps.finder)
        return {
          auth: await deps.finder.dashboardAuth(),
          settings: deps.finder.settings,
        };
      const settings = await effectiveDashboardSettings();
      return { auth: await resolveDashboardAuth(settings), settings };
    });
  const buildClients = deps.buildClients ?? defaultBuildClients;
  const closeClients = deps.closeClients ?? defaultCloseClients;
  const applyRedteam: ApplyFn =
    deps.applyRedteam ??
    ((items, agentKey, c, applied) =>
      applyRedteamRecommendations(
        items as FocusAreaRecommendation[],
        agentKey,
        c.orq,
        c.llm,
        c.model,
        { apply: false, alreadyApplied: applied },
      ));
  const applySim: ApplyFn =
    deps.applySim ??
    ((items, agentKey, c, applied) =>
      applySimulationSuggestions(
        items as SimulationRecommendation[],
        agentKey,
        c.orq,
        c.llm,
        c.model,
        { apply: false, alreadyApplied: applied },
      ));

  const authAndClients = async () => {
    const { auth, settings } = await selectedAuth();
    return { auth, settings, clients: await buildClients(auth, settings) };
  };

  async function preview<T>(
    rid: string,
    req: Request,
    options: {
      surface: string;
      obj: T | null;
      enableError: string | null;
      agentDefault: string;
      narrow: (form: FormData, obj: T) => Narrowed;
      applyFn: ApplyFn;
      alreadyApplied: string[];
      emptyMessage: string;
    },
  ): Promise<Response> {
    if (options.obj === null)
      return html(notFoundFragment(`Report ${rid} not found`), 404);
    if (options.enableError) return errorDrawer(options.enableError);
    const form = (await req.formData()) as unknown as FormData;
    const rejected = requestRejected(req, form);
    if (rejected) return errorDrawer(rejected);
    const agentKey =
      pythonStrip(String(form.get("agent_key") ?? "")) || options.agentDefault;
    if (!agentKey)
      return errorDrawer(
        "This run does not record which agent it tested, so there is nothing to apply to.",
      );
    const [items, area, breakdown, narrowError] = options.narrow(
      form,
      options.obj,
    );
    if (narrowError) return errorDrawer(narrowError);
    let ctx: Awaited<ReturnType<typeof authAndClients>>;
    try {
      ctx = await authAndClients();
    } catch (error) {
      return errorDrawer(errorText(error));
    }
    let result: ApplyRecommendationsResult;
    try {
      result = await options.applyFn(
        items,
        agentKey,
        ctx.clients,
        options.alreadyApplied,
      );
    } catch (error) {
      await closeClients(ctx.clients);
      console.warn(`apply_ui: preview failed for ${agentKey}: ${error}`);
      return errorDrawer(`Preview failed: ${errorText(error)}`);
    }
    await closeClients(ctx.clients);
    if (result.mergeFailed)
      return errorDrawer(
        "The merge did not produce usable instructions; please try the preview again.",
      );
    if (!result.recommendations.length)
      return errorDrawer(options.emptyMessage);
    const token = storePreview({
      rid,
      surface: options.surface,
      agentKey: result.agentKey,
      originalInstructions: result.originalInstructions,
      newInstructions: result.newInstructions,
      recommendations: [...result.recommendations],
      credentialIdentity: await authIdentity(ctx.auth, ctx.settings),
    });
    return html(
      renderPreviewDrawer(rid, result, area, {
        surface: options.surface,
        breakdown,
        confirmToken: token,
      }),
    );
  }

  async function confirm(
    rid: string,
    req: Request,
    options: {
      surface: string;
      field: string;
      versionNote: string;
      expectedAgent: string | null;
      alreadyApplied: string[];
    },
  ): Promise<Response> {
    const form = (await req.formData()) as unknown as FormData;
    const rejected = requestRejected(req, form);
    if (rejected) return errorDrawer(rejected);
    const token = String(form.get("confirm_token") ?? "");
    const entry = token ? popPreview(token) : null;
    if (entry === null)
      return errorDrawer(
        "This preview has expired or was already applied; run the preview again.",
      );
    if (entry.rid !== rid || entry.surface !== options.surface)
      return errorDrawer(
        "This preview belongs to a different report; run the preview again.",
      );
    const { agentKey } = entry;
    if (options.expectedAgent && agentKey !== options.expectedAgent)
      return errorDrawer(
        "This preview was for a different agent; reload the page and preview again.",
      );
    const seen = new Set(options.alreadyApplied.map((r) => pythonStrip(r)));
    const recommendations = entry.recommendations.filter(
      (r) => !seen.has(pythonStrip(r)),
    );
    if (!recommendations.length)
      return errorDrawer(
        "These recommendations were already applied; reload the page.",
      );
    let clients: ApplyClients;
    try {
      const { auth, settings } = await selectedAuth();
      if (entry.credentialIdentity !== (await authIdentity(auth, settings)))
        return errorDrawer(
          "The Orq credentials changed after this preview; run the preview again.",
        );
      clients = await buildClients(auth, settings);
    } catch (error) {
      return errorDrawer(errorText(error));
    }
    let current: string;
    try {
      current = await readInstructions(clients.orq, agentKey);
    } catch (error) {
      await closeClients(clients);
      console.warn(`apply_ui: pre-write read failed for ${agentKey}: ${error}`);
      return errorDrawer(
        `Could not re-read the agent before writing: ${errorText(error)}`,
      );
    }
    if (pythonStrip(current) !== pythonStrip(entry.originalInstructions)) {
      await closeClients(clients);
      return errorDrawer(
        "The agent instructions changed after this preview was made; run the preview again so the diff reflects the current instructions.",
      );
    }
    let newVersion: string | null;
    try {
      newVersion = await writeInstructions(
        clients.orq,
        agentKey,
        entry.newInstructions,
        {
          versionDescription: `Applied ${recommendations.length} ${options.versionNote}`,
        },
      );
    } catch (error) {
      await closeClients(clients);
      console.warn(`apply_ui: agent update failed for ${agentKey}: ${error}`);
      return errorDrawer(`Agent update failed: ${errorText(error)}`);
    }
    await closeClients(clients);
    const unrecorded =
      " They will show as pending again, and applying them again would merge them into the agent twice.";
    const path = await resolve(rid, roots());
    let note = "";
    if (path !== null) {
      try {
        await recordAppliedOnReport(path, recommendations, options.field);
      } catch (error) {
        console.warn(
          `apply_ui: could not record applied recs on ${path}: ${error}`,
        );
        note = ` The agent was updated, but the report file could not be written.${unrecorded}`;
      }
    } else {
      console.warn(
        `apply_ui: could not resolve report path for ${rid}; applied recs not recorded`,
      );
      note = ` The agent was updated, but the report file could not be located.${unrecorded}`;
    }
    let body = renderAppliedDrawer(
      agentKey,
      recommendations.length,
      newVersion,
    );
    if (note) body = body.replace("</p>", `${esc(note)}</p>`);
    return html(body);
  }

  return async (req, url) => {
    const path = url.pathname;
    if (req.method === "GET" && path === "/apply/dismiss") return html("");
    if (req.method !== "POST") return null;
    const m = /^\/r\/([^/]+)\/(redteam|sim)\/apply\/(preview|confirm)$/.exec(
      path,
    );
    if (!m) return null;
    const rid = decodeURIComponent(m[1] as string);
    const surface = m[2] as "redteam" | "sim";
    const action = m[3] as "preview" | "confirm";
    if (surface === "redteam") {
      const report = await loadReport(rid, roots());
      if (action === "preview")
        return preview(rid, req, {
          surface,
          obj: report,
          enableError:
            report !== null && report.testedAgents.length > 1
              ? "Applying recommendations is available for single-agent runs; this run compared several agents."
              : null,
          agentDefault: "",
          narrow: rtNarrow,
          applyFn: applyRedteam,
          alreadyApplied: report ? [...report.appliedRecommendations] : [],
          emptyMessage:
            "No new recommendations to apply \u2014 everything is already applied.",
        });
      if (report === null)
        return errorDrawer(
          "That report is no longer available; reload the page.",
        );
      return confirm(rid, req, {
        surface,
        field: "applied_recommendations",
        versionNote: "red-team remediation recommendation(s)",
        expectedAgent:
          report.testedAgents.length === 1
            ? (report.testedAgents[0] ?? null)
            : null,
        alreadyApplied: [...report.appliedRecommendations],
      });
    }
    const run = await loadRun(rid, roots());
    if (action === "preview")
      return preview(rid, req, {
        surface,
        obj: run,
        enableError:
          run !== null && isSimApplyEnabled(run)
            ? null
            : "Applying suggestions needs a run that targeted an orq agent.",
        agentDefault: run?.target ?? "",
        narrow: simNarrow,
        applyFn: applySim,
        alreadyApplied: run ? [...run.appliedSuggestions] : [],
        emptyMessage:
          "No new suggestions to apply \u2014 everything is already applied.",
      });
    if (run === null)
      return errorDrawer(
        "That report is no longer available; reload the page.",
      );
    return confirm(rid, req, {
      surface,
      field: "applied_suggestions",
      versionNote: "simulation remediation suggestion(s)",
      expectedAgent: isSimApplyEnabled(run) ? (run.target ?? null) : null,
      alreadyApplied: [...run.appliedSuggestions],
    });
  };
}
