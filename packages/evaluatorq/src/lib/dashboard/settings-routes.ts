import { z } from "zod/v4";

import {
  listOauthSessions as cliOauthSessions,
  type OAuthSession,
  OrqCLIError,
} from "../common/cli-oauth.js";
import { defaultRoots } from "../common/dashboard/library.js";
import {
  DEFAULT_ORQ_BASE_URL,
  report as envReport,
  maskSecret,
} from "../common/env-config.js";
import { MissingLLMCredentialsError } from "../common/llm-client.js";
import { type ModelKind, modelsByProvider } from "../common/model-catalogue.js";
import { listOrqProfiles, type OrqProfile } from "../common/orq-client.js";
import {
  AUTH_SETTINGS_FIELDS,
  credentialFingerprint,
  type DashboardSettings,
  effectiveDashboardSettings,
  loadDashboardSettings,
  saveDashboardSettings,
  storeDashboardApiKey,
} from "../trace-finder/settings.js";
import {
  type DashboardAuth,
  resolveDashboardAuth as resolveAuth,
} from "./auth.js";
import { catalogueClient } from "./model-choices.js";
import {
  discoverOauthScopes as discoverScopes,
  type OAuthScopes,
} from "./orq-scope.js";
import { classifyHost, resolveBaseUrl, resolveSlug } from "./orq-workspace.js";
import { CSRF_FIELD, requestRejected } from "./security.js";
import { currentSidebarHtml, page } from "./shell.js";
import type { FinderState } from "./trace-finder/routes.js";
import {
  MODEL_FIELDS,
  modelFieldSource,
  oauthScopeField,
  oauthSessionField,
  settingsBody,
  settingsModelControl,
} from "./view.js";

type Row = Record<string, unknown>;
type Config = Array<[string, string | string[]]>;

export interface SettingsRouteDeps {
  roots?: () => string[] | null;
  finder?: FinderState | null;
  listProfiles?: () => Promise<OrqProfile[]>;
  listOauthSessions?: () => OAuthSession[] | Promise<OAuthSession[]>;
  discoverOauthScopes?: (
    server: string,
    options: { workspace?: string },
  ) => Promise<OAuthScopes>;
  resolveDashboardAuth?: (
    settings: DashboardSettings,
    options: { profiles?: readonly OrqProfile[] },
  ) => Promise<DashboardAuth>;
  loadModels?: (
    auth: DashboardAuth,
    kind: ModelKind,
  ) => Promise<Record<string, string[]>>;
}

const MODEL_FIELD_KINDS: Readonly<Record<string, ModelKind>> = {
  fast_model: "chat",
  smart_model: "chat",
  classifier_model: "classify",
  embedding_model: "embedding",
};

const AUTH_INPUTS = [
  "orq_auth_method",
  "orq_profile",
  "orq_oauth_server",
  "orq_workspace",
  "orq_project_id",
  "orq_api_key_entry",
  "orq_stored_key_host",
];

const snake = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (key: string): string =>
  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const stripSlash = (value: string): string => value.replace(/\/+$/, "");

export function settingsValues(settings: DashboardSettings): Row {
  return Object.fromEntries(
    Object.entries(settings.toJSON()).map(([key, value]) => [
      snake(key),
      value,
    ]),
  );
}

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const settingsPage = async (body: string, status = 200) =>
  html(await page("Settings", body, { activeNav: "settings" }), status);

export async function settingsConfig(
  roots: string[] | null,
  profile: OrqProfile | null = null,
  settings?: DashboardSettings,
): Promise<Config> {
  const scanRoots = roots ?? defaultRoots();
  const effective = settings ?? (await effectiveDashboardSettings());
  const config: Config = [
    ["Run stores", scanRoots.length ? [...scanRoots] : ["\u2014"]],
    ["Authentication method", effective.orqAuthMethod.replaceAll("_", " ")],
  ];
  if (
    effective.orqAuthMethod === "cli_profile" &&
    effective.orqProfile !== null &&
    profile === null
  )
    config.push([
      "Orq profile status",
      "unavailable \u2014 choose Environment or another profile",
    ]);
  if (profile !== null)
    config.push(
      ["Selected profile API key", maskSecret(profile.apiKey)],
      ["Selected profile host", profile.server || DEFAULT_ORQ_BASE_URL],
    );
  const env = new Map(envReport().map((row) => [row.name, row]));
  for (const [label, name] of [
    ["ORQ API key", "ORQ_API_KEY"],
    ["OpenAI API key", "OPENAI_API_KEY"],
  ] as const)
    config.push([label, env.get(name)?.value || "not set"]);
  const host = await resolveBaseUrl();
  config.push(
    ["Orq host", `${host} (${classifyHost(host)})`],
    ["Orq workspace", (await resolveSlug()) || "from experiment URL"],
    ["Orq project", effective.orqProjectName || "all accessible projects"],
  );
  return config;
}

function modelAuthFailure(error: unknown): boolean {
  if (error instanceof MissingLLMCredentialsError) return true;
  const status = (error as { status?: unknown; statusCode?: unknown } | null)
    ?.status;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (status === 401 || status === 403) return true;
  if (statusCode === 401 || statusCode === 403) return true;
  return (
    error instanceof OrqCLIError &&
    (error.failureKind === "authentication" || error.failureKind === "setup")
  );
}

export function modelAuthRecovery(method: string): string {
  const detail =
    {
      environment: "Set ORQ_API_KEY in the environment.",
      stored_api_key: "Update the saved API key under Authentication.",
      cli_profile:
        "Choose or update a CLI API-key profile under Authentication.",
      cli_oauth:
        "Install the Orq CLI if needed, then sign in with orq auth login and select its session.",
    }[method] ?? "Choose a working credential under Authentication.";
  return `Orq credentials need attention, so the model list cannot load. ${detail} You can still type a model id.`;
}

const formText = (form: FormData, name: string): string | null => {
  const value = form.get(name);
  return value === null ? null : String(value);
};

function submittedValues(form: FormData, current: DashboardSettings): Row {
  const saved = settingsValues(current);
  const values: Row = { model_overrides: current.modelOverrides };
  for (const name of Object.keys(MODEL_FIELDS)) {
    if (!form.has(name)) {
      values[name] = saved[name];
      continue;
    }
    const submitted = (formText(form, name) ?? "").trim() || null;
    values[name] =
      submitted && submitted === modelFieldSource(name)[0]
        ? saved[name]
        : submitted;
  }
  values.orq_profile = form.has("orq_profile")
    ? formText(form, "orq_profile")
    : current.orqProfile;
  let method = formText(form, "orq_auth_method");
  if (method === null && form.has("orq_profile"))
    method = formText(form, "orq_profile") ? "cli_profile" : "environment";
  values.orq_auth_method = method || current.orqAuthMethod;
  if (values.orq_auth_method !== "cli_profile") values.orq_profile = null;
  values.orq_profile_host = form.has("orq_stored_key_host")
    ? formText(form, "orq_stored_key_host")
    : current.orqProfileHost;
  values.orq_api_key_ciphertext = current.orqApiKeyCiphertext;
  values.orq_oauth_server = form.has("orq_oauth_server")
    ? formText(form, "orq_oauth_server")
    : current.orqOauthServer;
  values.orq_credential_fingerprint = current.orqCredentialFingerprint;
  const oauth = values.orq_auth_method === "cli_oauth";
  values.orq_workspace = oauth ? formText(form, "orq_workspace") : null;
  values.orq_project_id = oauth ? formText(form, "orq_project_id") : null;
  values.orq_project_name = null;
  values.ask_ai_mode = form.has("ask_ai_mode")
    ? formText(form, "ask_ai_mode")
    : current.askAiMode;
  values.filter_selection = form.has("filter_selection")
    ? formText(form, "filter_selection")
    : current.filterSelection;
  const inspector = formText(form, "compression_inspector_enabled");
  values.compression_inspector_enabled =
    inspector === "on" || inspector === "true";
  const rawCap = formText(form, "trace_input_chars");
  if (rawCap === null) values.trace_input_chars = current.traceInputChars;
  else
    values.trace_input_chars = /^\s*[+-]?\d+\s*$/.test(rawCap)
      ? Number.parseInt(rawCap, 10)
      : rawCap;
  values.window_days = current.windowDays;
  values.limit = current.limit;
  values.parallelism = current.parallelism;
  values.explorer_columns = current.explorerColumns;
  return values;
}

function changedFieldsFor(
  form: FormData,
  current: DashboardSettings,
): Set<string> {
  const allowed = new Set([
    ...Object.keys(MODEL_FIELDS),
    "ask_ai_mode",
    "filter_selection",
    "trace_input_chars",
    "compression_inspector_enabled",
    ...AUTH_INPUTS,
  ]);
  const marker = formText(form, "settings_changed_fields");
  if (marker !== null) {
    const names = new Set(marker.split(",").filter(Boolean));
    if ([...names].some((name) => !allowed.has(name)))
      throw new RangeError("invalid settings changed-field list");
    return names;
  }
  const saved = settingsValues(current);
  const changed = new Set<string>();
  for (const name of allowed) {
    if (name === "orq_api_key_entry" || name === "orq_stored_key_host")
      continue;
    if (!form.has(name)) continue;
    const value = formText(form, name);
    const was = saved[name];
    let normalized: unknown = value;
    if (name === "compression_inspector_enabled")
      normalized = value === "on" || value === "true";
    else if (typeof was === "number")
      normalized = /^\s*[+-]?\d+\s*$/.test(value ?? "")
        ? Number.parseInt(value as string, 10)
        : value;
    else if (was === null && name.endsWith("_model"))
      normalized = (value ?? "").trim() || null;
    if (normalized !== was) changed.add(name);
  }
  if ((formText(form, "orq_api_key_entry") ?? "").trim())
    changed.add("orq_api_key_entry");
  if (
    form.has("orq_stored_key_host") &&
    formText(form, "orq_stored_key_host") !== current.orqProfileHost
  )
    changed.add("orq_stored_key_host");
  return changed;
}

function validationErrors(error: unknown): Record<string, string> | null {
  if (!(error instanceof z.ZodError)) return null;
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const head = issue.path[0];
    errors[head === undefined ? "form" : snake(String(head))] =
      issue.message || "Invalid value";
  }
  return errors;
}

export function settingsRoutes(deps: SettingsRouteDeps = {}) {
  const roots = deps.roots ?? (() => null);
  const listProfiles = deps.listProfiles ?? (() => listOrqProfiles());
  const listSessions = async () =>
    (deps.listOauthSessions ?? (() => cliOauthSessions()))();
  const discover =
    deps.discoverOauthScopes ??
    ((server: string, options: { workspace?: string }) =>
      discoverScopes(server, options));
  const authFor = deps.resolveDashboardAuth ?? resolveAuth;
  const loadModels =
    deps.loadModels ??
    (async (auth: DashboardAuth, kind: ModelKind) =>
      modelsByProvider(await catalogueClient(auth), { kind, strict: true }));
  const autosaving = (req: Request) => req.headers.get("x-autosave") === "1";
  const signedInServers = async () =>
    new Set(
      (await listSessions())
        .filter((session) => session.status !== "unreadable")
        .map((session) => stripSlash(session.server)),
    );

  const show = async (url: URL): Promise<Response> => {
    let settings = await effectiveDashboardSettings();
    const profiles = await listProfiles();
    const query = url.searchParams;
    if (query.has("profile")) {
      const requested = query.get("profile") ?? "";
      if (
        !requested ||
        profiles.some(
          (profile) =>
            profile.name === requested && !profile.apiKey.includes("*"),
        )
      )
        settings = settings.withUpdates(
          {
            orqAuthMethod: requested ? "cli_profile" : "environment",
            orqProfile: requested || null,
            orqProfileHost: null,
            orqWorkspace: null,
            orqProjectId: null,
            orqProjectName: null,
          },
          { persistent: false },
        );
    }
    const selected =
      profiles.find(
        (profile) =>
          settings.orqAuthMethod === "cli_profile" &&
          profile.name === settings.orqProfile,
      ) ?? null;
    const body = settingsBody(
      await settingsConfig(roots(), selected, settings),
      settingsValues(settings),
      {
        saved: query.get("saved") === "1",
        preview: query.has("profile"),
        profiles,
      },
    );
    return settingsPage(body);
  };

  const oauthSessions = async (url: URL): Promise<Response> =>
    html(
      oauthSessionField(
        url.searchParams.get("value") || DEFAULT_ORQ_BASE_URL,
        await listSessions(),
      ),
    );

  const oauthScope = async (url: URL): Promise<Response> => {
    const query = url.searchParams;
    const server = query.get("orq_oauth_server") || DEFAULT_ORQ_BASE_URL;
    const workspace = query.get("orq_workspace") ?? "";
    const scope = (await signedInServers()).has(stripSlash(server))
      ? await discover(server, { workspace })
      : {
          workspaces: [],
          projects: [],
          error:
            "Sign in to this Orq server to choose a workspace and project.",
        };
    return html(
      oauthScopeField(scope, workspace, query.get("orq_project_id") ?? ""),
    );
  };

  const models = async (url: URL): Promise<Response> => {
    const params = url.searchParams;
    const field = params.get("field") ?? "";
    if (!Object.hasOwn(MODEL_FIELDS, field)) return html("");
    const value = params.get(field) ?? "";
    const name = params.get("orq_profile") || params.get("profile") || "";
    let settings = await effectiveDashboardSettings();
    const [pinned, pinnedNote] = modelFieldSource(field);
    const envNote = pinned && value === pinned ? pinnedNote : "";
    const kind = MODEL_FIELD_KINDS[field] as ModelKind;
    const requested =
      params.get("orq_auth_method") || params.get("auth_method");
    const update: Row = {};
    if (
      requested === "environment" ||
      requested === "cli_profile" ||
      requested === "stored_api_key" ||
      requested === "cli_oauth"
    ) {
      update.orqAuthMethod = requested;
      update.orqProfile = name || null;
    } else if (name) {
      update.orqAuthMethod = "cli_profile";
      update.orqProfile = name;
    }
    let server: string | null =
      params.get("orq_oauth_server") || settings.orqOauthServer;
    const method =
      (update.orqAuthMethod as string | undefined) ?? settings.orqAuthMethod;
    if (
      server &&
      (method === "cli_oauth" || server !== settings.orqOauthServer)
    ) {
      const known = new Set((await listSessions()).map((s) => s.server));
      if (!known.has(server)) server = null;
    }
    update.orqOauthServer = server;
    settings = settings.withUpdates(update, { persistent: false });
    let notice = "";
    let note = "";
    let groups: Record<string, string[]> = {};
    const profiles =
      settings.orqAuthMethod === "cli_profile" ? await listProfiles() : [];
    let auth: DashboardAuth | null = null;
    try {
      auth = await authFor(settings, { profiles });
    } catch (error) {
      console.warn(
        `Could not resolve dashboard credentials for ${field}: ${error}`,
      );
      if (field === "fast_model")
        notice = modelAuthRecovery(settings.orqAuthMethod);
    }
    if (auth !== null) {
      try {
        groups = await loadModels(auth, kind);
        note =
          Object.keys(groups).length > 0
            ? ""
            : "Orq returned no models for this field. Type a model id.";
      } catch (error) {
        groups = {};
        console.warn(
          `Could not load the model catalogue for ${field}: ${error}`,
        );
        if (field === "fast_model")
          notice = modelAuthFailure(error)
            ? modelAuthRecovery(settings.orqAuthMethod)
            : "The Orq model list is temporarily unavailable. Check your connection or Orq status, then try again; you can still type a model id.";
      }
    }
    const noticeHtml =
      field === "fast_model"
        ? `<p id="models-warning" hx-swap-oob="innerHTML">${notice}</p>`
        : "";
    const joined = [envNote, note].filter(Boolean).join(" ");
    return html(
      settingsModelControl(field, value, groups, joined) + noticeHtml,
    );
  };

  const formError = async (
    req: Request,
    status: number,
    errors: Record<string, string>,
    values: Row,
    profiles?: OrqProfile[],
  ): Promise<Response> => {
    if (autosaving(req)) return Response.json({ errors }, { status });
    return settingsPage(
      settingsBody(await settingsConfig(roots()), values, {
        errors,
        profiles: profiles ?? [],
      }),
      status,
    );
  };

  const save = async (req: Request): Promise<Response> => {
    const form = (await req.formData()) as unknown as FormData;
    const rejected = requestRejected(req, form);
    if (rejected)
      return formError(
        req,
        403,
        { form: rejected },
        settingsValues(await effectiveDashboardSettings()),
      );
    const current = await loadDashboardSettings();
    const values = submittedValues(form, current);
    let changed: Set<string>;
    try {
      changed = changedFieldsFor(form, current);
    } catch {
      return formError(
        req,
        422,
        { form: "The submitted changed-field list is invalid." },
        values,
      );
    }
    const keys = [...form.keys()];
    const legacyFullForm = Object.keys(MODEL_FIELDS).every((name) =>
      form.has(name),
    );
    if (
      !form.has("settings_changed_fields") &&
      !form.has("compression_inspector_enabled") &&
      current.compressionInspectorEnabled &&
      (legacyFullForm || keys.every((key) => key === CSRF_FIELD))
    )
      changed.add("compression_inspector_enabled");
    const rendered = new Set(changed);
    if (
      !form.has("settings_changed_fields") &&
      AUTH_INPUTS.some((name) => form.has(name))
    )
      for (const name of [
        "orq_auth_method",
        "orq_profile",
        "orq_profile_host",
        "orq_oauth_server",
        "orq_workspace",
        "orq_project_id",
        "orq_project_name",
        "orq_credential_fingerprint",
      ])
        changed.add(name);
    if (changed.has("orq_profile") && !form.has("orq_auth_method"))
      changed.add("orq_auth_method");
    const add = (...names: string[]) => {
      for (const name of names) changed.add(name);
    };
    if (changed.has("orq_auth_method")) {
      add("orq_auth_method", "orq_profile", "orq_project_name");
      const method = String(values.orq_auth_method);
      if (method === "cli_profile")
        add("orq_profile_host", "orq_credential_fingerprint");
      if (method === "cli_oauth")
        add("orq_oauth_server", "orq_workspace", "orq_project_id");
      else add("orq_workspace", "orq_project_id");
    }
    if (changed.has("orq_profile"))
      add("orq_profile_host", "orq_credential_fingerprint");
    if (
      ["orq_oauth_server", "orq_workspace", "orq_project_id"].some((name) =>
        changed.has(name),
      )
    )
      add("orq_project_name");
    if (changed.has("orq_api_key_entry"))
      add(
        "orq_auth_method",
        "orq_api_key_ciphertext",
        "orq_profile_host",
        "orq_credential_fingerprint",
      );
    if (changed.has("orq_stored_key_host"))
      add("orq_profile_host", "orq_credential_fingerprint");
    changed.delete("orq_api_key_entry");
    changed.delete("orq_stored_key_host");
    const authGroup = [...changed].some((name) =>
      AUTH_SETTINGS_FIELDS.has(camel(name)),
    );
    values.settings_changed_fields = [...rendered].sort().join(",");
    const profiles = await listProfiles();
    let errors: Record<string, string> = {};
    let settings: DashboardSettings | null = null;
    try {
      const { settings_changed_fields: _, ...updates } = values;
      settings = current.withUpdates(updates, { persistent: false });
    } catch (error) {
      const found = validationErrors(error);
      if (found === null) throw error;
      errors = found;
    }
    if (authGroup && settings?.orqAuthMethod === "stored_api_key") {
      const entered = (formText(form, "orq_api_key_entry") ?? "").trim();
      if (entered) {
        try {
          settings = await storeDashboardApiKey(settings, entered);
        } catch (error) {
          console.warn(
            `Could not save dashboard API key securely: ${error instanceof Error ? error.name : typeof error}`,
          );
          errors.orq_api_key_entry =
            "Could not encrypt this key. Check the local Keychain and try again.";
        }
      } else if (!settings.orqApiKeyCiphertext)
        errors.orq_api_key_entry = "Enter an API key to use this method.";
    }
    const profileSubmitted =
      form.has("orq_auth_method") || form.has("orq_profile");
    if (
      settings !== null &&
      authGroup &&
      settings.orqAuthMethod === "cli_profile" &&
      profileSubmitted &&
      settings.orqProfile !== null &&
      !profiles.some((profile) => profile.name === settings?.orqProfile)
    )
      errors.orq_profile = "The orq CLI does not know this profile";
    const selected =
      settings?.orqAuthMethod === "cli_profile"
        ? (profiles.find((profile) => profile.name === settings?.orqProfile) ??
          null)
        : null;
    if (
      settings !== null &&
      authGroup &&
      settings.orqAuthMethod === "cli_profile" &&
      selected === null &&
      profileSubmitted
    )
      errors.orq_profile ??= "Choose an Orq CLI API-key profile.";
    if (authGroup && selected !== null && selected.apiKey.includes("*"))
      errors.orq_profile =
        "The installed orq CLI masks this profile key; use Environment credentials.";
    if (authGroup && settings?.orqAuthMethod === "cli_oauth") {
      const server = settings.orqOauthServer || DEFAULT_ORQ_BASE_URL;
      if (settings.orqWorkspace || settings.orqProjectId) {
        if (!(await signedInServers()).has(stripSlash(server)))
          errors.orq_project_id =
            "Sign in to this Orq server before choosing a workspace or project.";
        else {
          const scopes = await discover(server, {
            workspace: settings.orqWorkspace || "",
          });
          if (scopes.error) errors.orq_project_id = scopes.error;
          else {
            const workspace = settings.orqWorkspace;
            const projectId = settings.orqProjectId;
            const chosen =
              scopes.workspaces.find((item) => item.key === workspace) ?? null;
            const project =
              scopes.projects.find((item) => item.id === projectId) ?? null;
            if (workspace && chosen === null)
              errors.orq_workspace =
                "Choose a workspace on the selected server.";
            else if (
              projectId &&
              (chosen === null ||
                project === null ||
                project.workspaceId !== chosen.id)
            )
              errors.orq_project_id =
                "Choose a project in the selected workspace.";
            else
              settings = settings.withUpdates(
                { orqProjectName: project ? project.name : null },
                { persistent: false },
              );
          }
        }
      }
    }
    if (authGroup && settings !== null) {
      if (settings.orqAuthMethod !== "cli_oauth")
        settings = settings.withUpdates(
          { orqWorkspace: null, orqProjectId: null, orqProjectName: null },
          { persistent: false },
        );
      let auth: DashboardAuth | null = null;
      try {
        auth = await authFor(settings, { profiles });
      } catch {
        auth = null;
      }
      settings = settings.withUpdates(
        {
          orqProfileHost: selected
            ? selected.server || DEFAULT_ORQ_BASE_URL
            : settings.orqAuthMethod === "stored_api_key"
              ? settings.orqProfileHost
              : null,
          orqCredentialFingerprint: credentialFingerprint(
            auth?.apiKey ?? null,
            auth?.baseUrl ?? null,
          ),
        },
        { persistent: false },
      );
    }
    if (settings === null || Object.keys(errors).length > 0)
      return formError(req, 422, errors, values, profiles);
    try {
      await saveDashboardSettings(settings, undefined, {
        changedFields: new Set([...changed].map(camel)),
      });
    } catch (error) {
      console.warn(
        `Could not save dashboard settings: ${error instanceof Error ? error.name : typeof error}`,
      );
      return formError(
        req,
        422,
        {
          form: "Could not save settings because the saved file is unreadable or invalid. Fix or restore the JSON settings file, then try again.",
        },
        values,
        profiles,
      );
    }
    await resetFinder(deps.finder ?? null, selected);
    if (autosaving(req))
      return Response.json({ sidebar: await currentSidebarHtml("settings") });
    return new Response(null, {
      status: 303,
      headers: { location: "/settings?saved=1" },
    });
  };

  return async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (req.method === "GET" && path === "/settings") return show(url);
    if (req.method === "POST" && path === "/settings") return save(req);
    if (req.method === "GET" && path === "/settings/models") return models(url);
    if (req.method === "GET" && path === "/settings/oauth-sessions")
      return oauthSessions(url);
    if (req.method === "GET" && path === "/settings/oauth-scope")
      return oauthScope(url);
    return null;
  };
}

async function resetFinder(
  finder: FinderState | null,
  selected: OrqProfile | null,
): Promise<void> {
  if (finder === null) return;
  const retired = await finder.lock.run(async () => {
    finder.profile = selected;
    finder.settings = await effectiveDashboardSettings();
    if (finder.settings.orqAuthMethod === "cli_profile" && selected === null)
      console.warn(
        `Saved Orq profile ${finder.settings.orqProfile} is unavailable; select another profile or Environment`,
      );
    const stores: Array<{ close(): unknown }> = [
      ...finder.sessions.detachAll(),
    ];
    if (finder.searchStore !== null) stores.push(finder.searchStore);
    finder.generation += 1;
    finder.searchStore = null;
    finder.catalogueCache = null;
    finder.catalogueWarmup = null;
    return stores;
  });
  const results = await Promise.allSettled(
    retired.map(async (store) => store.close()),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected")
      console.warn(
        `Could not close retired finder store ${retired[index]?.constructor.name}: ${result.reason}`,
      );
  });
  finder.unavailableReason = null;
}
