import { createHash } from "node:crypto";

import { buildCliOauthClients, oauthSubject } from "../common/cli-oauth.js";
import { DEFAULT_ORQ_BASE_URL, envRaw, envText } from "../common/env-config.js";
import { resolveLlmClient } from "../common/llm-client.js";
import {
  listOrqProfiles,
  type OrqProfile,
  resolveOrqClient,
} from "../common/orq-client.js";
import {
  type DashboardSettings,
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
      envRaw("ORQ_BASE_URL", DEFAULT_ORQ_BASE_URL),
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
      profile.server || DEFAULT_ORQ_BASE_URL,
      profile,
    );
  }
  if (method === "stored_api_key") {
    let key: string | null;
    try {
      key = await readStoredDashboardApiKey(settings);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    if (!key)
      throw new Error("No saved API key is available. Enter one in Settings.");
    return new DashboardAuth(
      method,
      key,
      settings.orqProfileHost || DEFAULT_ORQ_BASE_URL,
    );
  }
  if (method === "cli_oauth")
    return new DashboardAuth(
      method,
      null,
      settings.orqOauthServer || DEFAULT_ORQ_BASE_URL,
    );
  throw new Error(
    "Unknown dashboard authentication method. Choose one in Settings.",
  );
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Python json.dumps(sort_keys=True): ", " and ": " separators, ASCII escapes.
function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${pyJson(k)}: ${pyJson((value as Record<string, unknown>)[k])}`,
      )
      .join(", ")}}`;
  if (typeof value === "string")
    return JSON.stringify(value).replace(
      /[\u007f-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return JSON.stringify(value);
}

const hashFields = (fields: Record<string, unknown>) => sha256(pyJson(fields));

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
  const url = new URL(auth.baseUrl);
  const baseUrl = `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
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
