import { createHash } from "node:crypto";

import { buildCliOauthClients, oauthSubject } from "../common/cli-oauth.js";
import { envText } from "../common/env-config.js";
import { resolveLlmClient } from "../common/llm-client.js";
import {
  listOrqProfiles,
  type OrqProfile,
  orqServerUrl,
  resolveOrqClient,
} from "../common/orq-client.js";
import { pythonJson } from "../formats/json.js";
import {
  type DashboardSettings,
  effectiveDashboardSettings,
  readStoredDashboardApiKey,
} from "../trace-finder/settings.js";

export type AuthMethod = DashboardSettings["orqAuthMethod"];

const METHOD_LABELS: Record<string, string> = {
  environment: "ORQ_API_KEY",
  cli_oauth: "CLI OAuth",
  stored_api_key: "Saved API key",
};

export class DashboardAuth {
  constructor(
    readonly method: string,
    readonly apiKey: string | null,
    readonly baseUrl: string,
    readonly profile: OrqProfile | null = null,
  ) {}

  get label(): string {
    if (this.method === "cli_profile" && this.profile)
      return `CLI profile ${this.profile.name}`;
    return METHOD_LABELS[this.method] ?? "Orq credentials";
  }

  toJSON(): Record<string, unknown> {
    return {
      method: this.method,
      baseUrl: this.baseUrl,
      profile: this.profile?.name ?? null,
    };
  }
}

export async function resolveDashboardAuth(
  settings: DashboardSettings,
  options: { profiles?: readonly OrqProfile[] } = {},
): Promise<DashboardAuth> {
  const method = settings.orqAuthMethod;
  if (method === "environment")
    return new DashboardAuth(
      method,
      envText("ORQ_API_KEY") ?? null,
      orqServerUrl(),
    );
  if (method === "cli_profile") {
    const name = settings.orqProfile;
    if (!name)
      throw new Error("Choose an Orq CLI API-key profile in Settings.");
    const available = options.profiles ?? (await listOrqProfiles());
    const profile = available.find((p) => p.name === name);
    if (!profile)
      throw new Error(
        `Orq CLI profile ${name} is unavailable. Choose a credential in Settings.`,
      );
    if (!profile.apiKey || profile.apiKey.includes("*"))
      throw new Error(
        `Orq CLI profile ${name} has no usable API key. Choose a credential in Settings.`,
      );
    return new DashboardAuth(
      method,
      profile.apiKey,
      profile.server || orqServerUrl(),
      profile,
    );
  }
  if (method === "stored_api_key") {
    let key: string | null;
    try {
      key = await readStoredDashboardApiKey(settings);
    } catch (e) {
      if (isProgrammingError(e)) throw e;
      throw new Error(e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (!key)
      throw new Error("No saved API key is available. Enter one in Settings.");
    return new DashboardAuth(
      method,
      key,
      settings.orqProfileHost || orqServerUrl(),
    );
  }
  if (method === "cli_oauth")
    return new DashboardAuth(
      method,
      null,
      settings.orqOauthServer || orqServerUrl(),
    );
  throw new Error(
    "Unknown dashboard authentication method. Choose one in Settings.",
  );
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Python json.dumps(sort_keys=True); undefined fields hash as null, as None did.
const hashFields = (fields: Record<string, unknown>) =>
  sha256(
    pythonJson(
      JSON.parse(
        JSON.stringify(fields, (_k, v) => (v === undefined ? null : v)),
      ),
      { sortKeys: true, ensureAscii: true },
    ),
  );

function accountFields(auth: DashboardAuth): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    method: auth.method,
    base_url: auth.baseUrl.replace(/\/+$/, ""),
    profile: auth.profile?.name ?? null,
    key_fingerprint: auth.apiKey ? sha256(auth.apiKey) : null,
  };
  if (auth.method === "cli_oauth")
    fields.oauth_subject = oauthSubject(auth.baseUrl);
  return fields;
}

export function authIdentity(
  auth: DashboardAuth,
  settings: DashboardSettings,
): string {
  return hashFields({
    ...accountFields(auth),
    workspace: settings.orqWorkspace,
    project: settings.orqProjectId,
  });
}

export function accountIdentity(auth: DashboardAuth): string {
  return hashFields(accountFields(auth));
}

interface ListPage {
  data?: { id?: unknown; projectId?: unknown; project_id?: unknown }[] | null;
  hasMore?: boolean;
  has_more?: boolean;
}

interface VerifyClient {
  workspaces?: { list: () => Promise<ListPage> };
  projects: {
    list?: (o: { limit: number }) => Promise<ListPage>;
    listAsync?: (o: { limit: number }) => Promise<ListPage>;
  };
}

const statusOf = (e: unknown) =>
  (e as { statusCode?: number; status_code?: number })?.statusCode ??
  (e as { status_code?: number })?.status_code;

const nonEmpty = (values: unknown[]) =>
  new Set(values.filter((v): v is string => typeof v === "string" && v !== ""));

export async function verifiedAccountIdentity(
  auth: DashboardAuth,
  client: VerifyClient,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(auth.baseUrl);
  } catch {
    throw new Error(`Orq base URL is not a valid URL: ${auth.baseUrl}`);
  }
  const baseUrl = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  let principal: Record<string, string>;
  if (auth.method === "cli_oauth") {
    const userId = oauthSubject(auth.baseUrl).user_id;
    if (typeof userId !== "string" || !userId)
      throw new Error("Orq OAuth did not return a verified user ID.");
    principal = { user_id: userId };
  } else {
    let response: ListPage | null = null;
    try {
      response = client.workspaces ? await client.workspaces.list() : null;
    } catch (e) {
      if (statusOf(e) !== 403) throw e;
    }
    if (response) {
      const ids = nonEmpty((response.data ?? []).map((i) => i.id));
      if (response.hasMore ?? response.has_more)
        throw new Error(
          "Orq credential can access multiple workspaces; cannot verify one workspace.",
        );
      if (ids.size !== 1)
        throw new Error("Orq credential did not verify exactly one workspace.");
      principal = { workspace_id: [...ids][0] as string };
    } else {
      const list = client.projects.listAsync ?? client.projects.list;
      if (!list) throw new Error("Orq client cannot list projects.");
      const page = await list.call(client.projects, { limit: 100 });
      const ids = nonEmpty(
        (page.data ?? []).map((i) => i.projectId ?? i.project_id),
      );
      if (page.hasMore ?? page.has_more)
        throw new Error(
          "Orq credential can access multiple projects; cannot verify one project.",
        );
      if (ids.size !== 1)
        throw new Error("Orq credential did not verify exactly one project.");
      principal = { project_id: [...ids][0] as string };
    }
  }
  return hashFields({ version: 2, base_url: baseUrl, ...principal });
}

export function accountLabel(auth: DashboardAuth): string {
  const name = auth.profile ? auth.profile.name : auth.label;
  let host: string;
  try {
    host = new URL(auth.baseUrl).host || auth.baseUrl.replace(/\/+$/, "");
  } catch {
    host = auth.baseUrl.replace(/\/+$/, "");
  }
  return `${name} on ${host}`;
}

export interface ScopeOptions {
  workspace?: string | null;
  project?: string | null;
}

export async function buildAuthClients(
  auth: DashboardAuth,
  scope: ScopeOptions = {},
) {
  if (auth.method === "cli_oauth")
    return buildCliOauthClients(auth.baseUrl, scope.workspace, scope.project);
  const llm = (
    await resolveLlmClient(null, {
      extraApiKey: auth.apiKey,
      orqHost: auth.baseUrl,
      requireOrq: true,
      maxRetries: 0,
    })
  ).client;
  const orq = await resolveOrqClient(auth.apiKey, auth.baseUrl);
  return [orq, llm] as const;
}

export async function buildOrqClient(
  auth: DashboardAuth,
  scope: ScopeOptions = {},
) {
  if (auth.method === "cli_oauth")
    return buildCliOauthClients(
      auth.baseUrl,
      scope.workspace,
      scope.project,
    )[0];
  return resolveOrqClient(auth.apiKey, auth.baseUrl);
}

const REJECTION_MARKERS = [
  "unauthorized",
  "not authenticated",
  "login required",
  "http 401",
  "http 403",
  "session expired",
  "cli is not installed",
  "sign-in needs attention",
  "orq auth login",
];

// Mirrors Python's httpx.HTTPError/APIError. A bare timeout of the probe
// itself is unexpected there (asyncio.wait_for), so it reports "error" here too.
const PROVIDER_ERROR_NAMES = new Set([
  "APIError",
  "SDKError",
  "HTTPClientError",
  "ConnectionError",
  "RequestAbortedError",
  "RequestTimeoutError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

function isProgrammingError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  );
}

function isProviderFailure(error: Error | undefined): boolean {
  if (!error) return false;
  // fetch reports network failures as a TypeError("fetch failed").
  if (error.name === "TypeError") return error.message === "fetch failed";
  return PROVIDER_ERROR_NAMES.has(error.name);
}

export interface AuthStatus {
  status: "valid" | "action" | "error" | "unavailable";
  method: string;
  message?: string;
}

interface ProbeClient {
  traces: {
    listFacetValues: (
      request: { field: string; from: Date; to: Date; limit: number },
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
}

export async function authStatus(
  deps: {
    settings?: () => Promise<DashboardSettings>;
    resolve?: (settings: DashboardSettings) => Promise<DashboardAuth>;
    clients?: (
      auth: DashboardAuth,
      scope: ScopeOptions,
    ) => Promise<readonly [unknown, unknown]>;
    timeoutMs?: number;
  } = {},
): Promise<AuthStatus> {
  const settings = await (deps.settings ?? effectiveDashboardSettings)();
  let auth: DashboardAuth;
  try {
    auth = await (deps.resolve ?? resolveDashboardAuth)(settings);
  } catch (exc) {
    if (isProgrammingError(exc)) throw exc;
    return {
      status: "action",
      method: settings.orqAuthMethod,
      message: (exc as Error).message,
    };
  }
  if (auth.method === "environment" && !auth.apiKey) {
    return {
      status: "action",
      method: auth.method,
      message:
        "ORQ_API_KEY is not set. Choose an authentication method in Settings.",
    };
  }
  let orq: unknown = null;
  let llm: unknown = null;
  try {
    [orq, llm] = await (deps.clients ?? buildAuthClients)(auth, {
      workspace: settings.orqWorkspace,
      project: settings.orqProjectId,
    });
    const now = new Date();
    await (orq as ProbeClient).traces.listFacetValues(
      {
        field: "agent_name",
        from: new Date(now.getTime() - 86_400_000),
        to: now,
        limit: 1,
      },
      { signal: AbortSignal.timeout(deps.timeoutMs ?? 12_000) },
    );
  } catch (exc) {
    const error = exc as Error & { response?: { status?: number } };
    const status = statusOf(exc) ?? error?.response?.status;
    const message = String(error?.message ?? exc).toLowerCase();
    if (
      status === 401 ||
      status === 403 ||
      REJECTION_MARKERS.some((marker) => message.includes(marker))
    ) {
      return {
        status: "action",
        method: auth.method,
        message: `${auth.label} was rejected. Open Settings to choose or renew a credential.`,
      };
    }
    if (status === undefined && !isProviderFailure(error)) {
      console.error(
        `Unexpected dashboard auth status probe failure for ${auth.label}: ${exc}`,
      );
      return {
        status: "error",
        method: auth.method,
        message:
          "The authentication check failed unexpectedly. Check the dashboard logs.",
      };
    }
    console.warn(
      `Dashboard auth status probe failed for ${auth.label}: ${exc}`,
    );
    return {
      status: "unavailable",
      method: auth.method,
      message: `Could not check ${auth.label} right now. Try again shortly.`,
    };
  } finally {
    for (const [name, client] of [
      ["Orq", orq],
      ["LLM", llm],
    ] as const) {
      const close = (client as { close?: () => unknown } | null)?.close;
      if (typeof close === "function") {
        try {
          await close.call(client);
        } catch (exc) {
          console.warn(`Could not close dashboard auth ${name} client: ${exc}`);
        }
      }
    }
  }
  return { status: "valid", method: auth.method };
}
