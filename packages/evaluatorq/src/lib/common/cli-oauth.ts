import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve } from "node:path";

import type { FacetClient } from "../trace-finder/facets.js";
import type {
  OrqSourceClient,
  SourceAfterSuccessHook,
  SourceRequestOptions,
} from "../trace-finder/orq-source.js";
import { DEFAULT_ORQ_BASE_URL } from "./env-config.js";

export const DECISIONS_PATH = "/decisions";

const OVERRIDE_ENV = [
  "ORQ_API_KEY",
  "ORQ_PROFILE",
  "ORQ_SERVER",
  "ORQ_WORKSPACE",
  "ORQ_PROJECT",
  "ORQ_VERBOSE",
  "ORQ_JMESPATH",
];

export type FailureKind = "authentication" | "setup" | "unavailable";

export interface ProcessResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function which(binary: string): string | null {
  const windows = process.platform === "win32";
  const suffixes =
    windows && !extname(binary)
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(
    delimiter,
  )) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = resolve(
        directory.replace(/^"(.*)"$/, "$1"),
        `${binary}${suffix}`,
      );
      try {
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function runAsync(
  command: string[],
  options: RunOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const [bin, ...args] = command as [string, ...string[]];
    const child = spawn(bin, args, {
      env: options.env,
      timeout: options.timeoutMs ?? 300_000,
      killSignal: "SIGKILL",
      signal: options.signal,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure = error;
    });
    child.stdin?.on("error", (error) => {
      failure = error;
      child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else
        resolve({
          returncode: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export const cliProcess = { which, runAsync };

function oauthEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !OVERRIDE_ENV.includes(k)) env[k] = v;
  return env;
}

const SECRET =
  /(bearer\s+)[A-Za-z0-9._~+/-]+=*|((?:api[_-]?key|access[_-]?token|refresh[_-]?token)["' :=]+)[^\s,;]+/gi;
const AUTHENTICATION_ERROR =
  /missing api key|authentication required|unauthori[sz]ed|not authenticated|not signed in|sign-in needs attention|expired or was revoked|invalid refresh token|run\s+['"]?orq auth login['"]?/i;
const SETUP_ERROR =
  /orq cli is not installed|install it and sign in before using cli oauth/i;
const SIGNED_OUT =
  /expired or was revoked|invalid refresh token|run 'orq auth login'/i;

export function safeError(value: string): string {
  return value
    .trim()
    .replace(
      SECRET,
      (_m, bearer?: string, key?: string) => `${bearer ?? key ?? ""}[redacted]`,
    )
    .slice(0, 1200);
}

const isAuthenticationError = (value: string): boolean =>
  AUTHENTICATION_ERROR.test(value);

function inferFailureKind(message: string): FailureKind {
  const s = safeError(message);
  if (SETUP_ERROR.test(s)) return "setup";
  if (isAuthenticationError(s)) return "authentication";
  return "unavailable";
}

export class OrqCLIError extends Error {
  readonly statusCode: number | null;
  readonly failureKind: FailureKind;
  constructor(
    message: string,
    options: { statusCode?: number | null; failureKind?: FailureKind } = {},
  ) {
    super(message);
    this.name = "OrqCLIError";
    this.statusCode = options.statusCode ?? null;
    this.failureKind = options.failureKind ?? inferFailureKind(message);
  }
}

const NOT_INSTALLED =
  "The orq CLI is not installed. Install it and sign in before using CLI OAuth.";

function requireBinary(): string {
  const binary = cliProcess.which("orq");
  if (!binary) throw new OrqCLIError(NOT_INSTALLED, { failureKind: "setup" });
  return binary;
}

export function jsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    const ms = iso.slice(20, 23);
    return `${iso.slice(0, 19)}${ms === "000" ? "" : `.${ms}000`}+00:00`;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      if (v !== null && v !== undefined) out[k] = jsonValue(v);
    return out;
  }
  return value;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export interface ResponseContext {
  operationId: string;
}
export interface CapturedResponse {
  json: () => unknown;
  request: { url: { path: string } };
}
export type ResponseHook =
  | ((context: ResponseContext, response: CapturedResponse) => void)
  | {
      afterSuccess: (
        context: ResponseContext,
        response: CapturedResponse,
      ) => void;
    };

class CLI {
  readonly binary: string;
  readonly responseHooks: ResponseHook[] = [];
  readonly sourceHooks: SourceAfterSuccessHook[] = [];
  constructor(
    readonly serverUrl: string | null,
    readonly workspace: string | null,
    readonly project: string | null,
  ) {
    this.binary = requireBinary();
  }

  async call(
    args: string[],
    payload?: unknown,
    capture?: [string, string],
    options: SourceRequestOptions = {},
  ): Promise<unknown> {
    options.signal?.throwIfAborted();
    const command = [
      this.binary,
      "--no-input",
      "--output-format",
      "json",
      "--profile",
      "",
    ];
    if (this.serverUrl) command.push("--server", this.serverUrl);
    if (this.workspace) command.push("--workspace", this.workspace);
    if (this.project) command.push("--project", this.project);
    command.push(...args);
    if (payload !== undefined) command.push("--stdin");
    let result: ProcessResult;
    try {
      result = await cliProcess.runAsync(command, {
        env: oauthEnv(),
        input: payload === undefined ? undefined : JSON.stringify(payload),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
    } catch (cause) {
      options.signal?.throwIfAborted();
      throw new OrqCLIError(`Could not start the orq CLI: ${String(cause)}`);
    }
    if (result.returncode) {
      const detail = safeError(result.stderr);
      throw new OrqCLIError(
        detail || `orq CLI exited with status ${result.returncode}`,
        {
          failureKind: isAuthenticationError(detail)
            ? "authentication"
            : "unavailable",
        },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new OrqCLIError(
        "The orq CLI returned an unreadable JSON response.",
      );
    }
    if (capture) {
      const [operationId, path] = capture;
      if (this.sourceHooks.length) {
        let response = new Response(result.stdout, {
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(response, "url", {
          value: `${(this.serverUrl || DEFAULT_ORQ_BASE_URL).replace(/\/+$/, "")}/v3${path}`,
        });
        for (const hook of [...this.sourceHooks]) {
          options.signal?.throwIfAborted();
          response = await hook.afterSuccess(
            { operationID: operationId },
            response,
          );
        }
        parsed = await response.json();
      }
      const response: CapturedResponse = {
        json: () => parsed,
        request: { url: { path: `/v3${path}` } },
      };
      for (const hook of [...this.responseHooks]) {
        const cb = typeof hook === "function" ? hook : hook.afterSuccess;
        if (typeof cb !== "function")
          throw new TypeError(
            "Orq CLI response hook has no callable after_success method.",
          );
        await cb.call(hook, { operationId }, response);
      }
    }
    return parsed;
  }
}

type Opt<T> = T | null | undefined;

class Traces {
  constructor(private readonly cli: CLI) {}

  query(
    p: Parameters<OrqSourceClient["traces"]["query"]>[0],
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    return this.queryAsync(p, options);
  }

  queryAsync(
    p: {
      from: unknown;
      to: unknown;
      oql: string;
      limit?: Opt<number>;
      pageToken?: Opt<string>;
      timeoutMs?: Opt<number>;
    },
    options: SourceRequestOptions = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      from: jsonValue(p.from),
      to: jsonValue(p.to),
      oql: p.oql,
    };
    if (p.limit != null) payload.limit = p.limit;
    if (p.pageToken != null) payload.page_token = p.pageToken;
    return this.cli.call(
      ["traces", "query-oql"],
      payload,
      ["TracesQueryOql", "/traces/query"],
      { ...options, timeoutMs: options.timeoutMs ?? p.timeoutMs ?? undefined },
    );
  }

  getSpan(
    p: Parameters<OrqSourceClient["traces"]["getSpan"]>[0],
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    return this.getSpanAsync(p, options);
  }

  getSpanAsync(
    p: { traceId: string; spanId: string },
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    return this.cli.call(
      ["traces", "get-span", p.traceId, p.spanId],
      undefined,
      ["TracesGetSpan", `/traces/${p.traceId}/spans/${p.spanId}`],
      options,
    );
  }

  listSpans(
    p: Parameters<OrqSourceClient["traces"]["listSpans"]>[0],
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    return this.listSpansAsync(p, options);
  }

  listSpansAsync(
    p: {
      traceId: string;
      limit?: Opt<number>;
      pageToken?: Opt<string>;
    },
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    const args = ["traces", "list-spans", p.traceId];
    if (p.limit != null) args.push("--limit", String(p.limit));
    if (p.pageToken != null) args.push("--page-token", p.pageToken);
    return this.cli.call(
      args,
      undefined,
      ["TracesListSpans", `/traces/${p.traceId}/spans`],
      options,
    );
  }

  listFacetValues(
    p: Parameters<FacetClient["traces"]["listFacetValues"]>[0],
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    return this.listFacetValuesAsync(p, options);
  }

  listFacetValuesAsync(
    p: {
      field: string;
      from?: unknown;
      to?: unknown;
      limit?: Opt<number>;
      filterOperator?: Opt<string>;
    },
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    const args = ["traces", "list-facet-values", p.field];
    for (const [key, value] of [
      ["--from", p.from],
      ["--to", p.to],
      ["--limit", p.limit],
      ["--filter-operator", p.filterOperator],
    ] as const)
      if (value != null) args.push(key, String(jsonValue(value)));
    return this.cli.call(args, undefined, undefined, options);
  }
}

class Projects {
  constructor(private readonly cli: CLI) {}
  list(
    p: Parameters<OrqSourceClient["projects"]["list"]>[0] = {},
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    return this.listAsync(p, options);
  }
  listAsync(
    p: { limit?: Opt<number>; startingAfter?: Opt<string> } = {},
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    const args = ["projects", "list"];
    if (p.limit != null) args.push("--limit", String(p.limit));
    if (p.startingAfter) args.push("--starting-after", p.startingAfter);
    return this.cli.call(args, undefined, undefined, options);
  }
}

export class CliOrqClient implements OrqSourceClient, FacetClient {
  readonly traces: Traces;
  readonly projects: Projects;
  readonly _baseURL: URL;
  readonly _options: OrqSourceClient["_options"];
  constructor(private readonly cli: CLI) {
    this.traces = new Traces(cli);
    this.projects = new Projects(cli);
    this._baseURL = new URL(cli.serverUrl || DEFAULT_ORQ_BASE_URL);
    this._options = {
      serverURL: this._baseURL.href,
      hooks: {
        registerAfterSuccessHook: (hook) => {
          if (!cli.sourceHooks.includes(hook)) cli.sourceHooks.push(hook);
        },
      },
    };
  }
  registerAfterSuccessHook(hook: ResponseHook): void {
    if (!this.cli.responseHooks.includes(hook))
      this.cli.responseHooks.push(hook);
  }
  unregisterAfterSuccessHook(hook: ResponseHook): void {
    const i = this.cli.responseHooks.indexOf(hook);
    if (i >= 0) this.cli.responseHooks.splice(i, 1);
  }
  async close(): Promise<void> {}
}

class Endpoint {
  constructor(
    private readonly cli: CLI,
    private readonly command: string[],
  ) {}

  create(
    params: Record<string, unknown>,
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    const { extra_body: extra, ...rest } = params;
    const body = isRecord(extra) ? { ...rest, ...extra } : rest;
    return this.cli.call(this.command, jsonValue(body), undefined, options);
  }

  async parse<T>(
    params: Record<string, unknown> & {
      responseParser?: (content: string) => T;
    },
    options?: SourceRequestOptions,
  ): Promise<unknown> {
    const { responseParser, ...rest } = params;
    const response = await this.create(rest, options);
    if (responseParser && isRecord(response)) {
      for (const choice of (response.choices as unknown[]) ?? []) {
        const message = isRecord(choice) ? choice.message : null;
        if (!isRecord(message)) continue;
        const content = message.content;
        message.parsed =
          typeof content === "string" && content
            ? responseParser(content)
            : null;
      }
    }
    return response;
  }
}

const isStatusEnvelope = (
  r: unknown,
): r is { status: unknown; body: unknown; ok?: unknown } =>
  isRecord(r) && "status" in r && "body" in r;

export class CliLlmClient {
  readonly chat: { completions: Endpoint };
  readonly embeddings: Endpoint;
  readonly responses: Endpoint;
  readonly baseURL: string;
  constructor(private readonly cli: CLI) {
    this.chat = { completions: new Endpoint(cli, ["chat", "create"]) };
    this.embeddings = new Endpoint(cli, ["embeddings", "create"]);
    this.responses = new Endpoint(cli, ["responses", "create"]);
    this.baseURL = `${(cli.serverUrl || DEFAULT_ORQ_BASE_URL).replace(/\/+$/, "")}/v3/router`;
  }

  async post(
    path: string,
    options: { body: unknown } & SourceRequestOptions,
  ): Promise<unknown> {
    if (path !== DECISIONS_PATH)
      throw new RangeError(`Unsupported CLI OAuth model endpoint: ${path}`);
    // Caller headers may carry credentials; argv is visible to process inspection.
    const result = await this.cli.call(
      ["request", "POST", `/v3/router${path}`, "--force"],
      jsonValue(options.body),
      undefined,
      options,
    );
    return isStatusEnvelope(result) ? result.body : result;
  }

  async getModelCatalogue(): Promise<unknown> {
    const result = await this.cli.call([
      "request",
      "GET",
      "/v2/models",
      "--force",
    ]);
    if (!isStatusEnvelope(result)) return result;
    const status = result.status;
    const numeric = typeof status === "number" && Number.isInteger(status);
    if (!numeric || status < 200 || status >= 300)
      throw new OrqCLIError(
        `Orq CLI model catalogue request failed with HTTP ${status}.`,
        {
          statusCode: numeric ? status : null,
          failureKind:
            status === 401 || status === 403 ? "authentication" : "unavailable",
        },
      );
    if (result.ok === false)
      throw new OrqCLIError("Orq CLI model catalogue request failed.");
    return result.body;
  }

  async close(): Promise<void> {}
}

export function buildCliOauthClients(
  serverUrl: string | null = null,
  workspace: string | null = null,
  project: string | null = null,
): [CliOrqClient, CliLlmClient] {
  const cli = new CLI(serverUrl, workspace, project);
  return [new CliOrqClient(cli), new CliLlmClient(cli)];
}

const WHOAMI_FIELDS =
  "{user_id:user.id,workspace:active_workspace_key,project:active_project_id," +
  "source:credential.source,authenticated:authenticated}";

function whoami(
  binary: string,
  serverUrl: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return cliProcess.runAsync(
    [
      binary,
      "--no-input",
      "--output-format",
      "json",
      "--profile",
      "",
      "--server",
      serverUrl,
      "--jmespath",
      WHOAMI_FIELDS,
      "auth",
      "whoami",
    ],
    { env: oauthEnv(), timeoutMs },
  );
}

const NEEDS_LOGIN =
  "The Orq CLI OAuth sign-in needs attention. Run orq auth login.";

export interface OAuthSubject {
  user_id: string | null;
  workspace: string | null;
  project: string | null;
}

export async function oauthSubject(serverUrl: string): Promise<OAuthSubject> {
  const binary = requireBinary();
  let result: ProcessResult;
  try {
    result = await whoami(binary, serverUrl, 10_000);
  } catch {
    throw new OrqCLIError("Could not check the Orq CLI OAuth sign-in.");
  }
  if (result.returncode) {
    const detail = safeError(result.stderr);
    if (isAuthenticationError(detail))
      throw new OrqCLIError(NEEDS_LOGIN, { failureKind: "authentication" });
    throw new OrqCLIError(
      `Could not check the Orq CLI OAuth sign-in: ${detail || "the CLI request failed"}. Try again shortly.`,
      { failureKind: "unavailable" },
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new OrqCLIError("The Orq CLI returned an unreadable OAuth identity.");
  }
  if (isRecord(data) && data.authenticated === false)
    throw new OrqCLIError(NEEDS_LOGIN, { failureKind: "authentication" });
  if (!isRecord(data) || data.authenticated !== true)
    throw new OrqCLIError(
      "The Orq CLI returned an unreadable OAuth identity. Try again shortly.",
    );
  const userId = data.user_id;
  if (typeof userId !== "string" || !userId)
    throw new OrqCLIError(
      "The Orq CLI did not identify the signed-in user. Try again shortly.",
    );
  const pick = (k: string) => (data as Record<string, unknown>)[k] ?? null;
  return {
    user_id: userId,
    workspace: pick("workspace") as string | null,
    project: pick("project") as string | null,
  };
}

export type SessionStatus = "valid" | "signed-out" | "unknown" | "unreadable";
const UNREADABLE = new Set(["invalid", "unreadable"]);

export interface OAuthSession {
  server: string;
  host: string;
  user: string | null;
  workspace: string | null;
  status: SessionStatus;
  active: boolean;
}

async function sessionStatus(
  binary: string,
  serverUrl: string,
  timeoutMs: number,
): Promise<SessionStatus> {
  let result: ProcessResult;
  try {
    result = await whoami(binary, serverUrl, timeoutMs);
  } catch {
    return "unknown";
  }
  if (result.returncode === 0) {
    try {
      const data: unknown = JSON.parse(result.stdout);
      return isRecord(data) && data.authenticated ? "valid" : "signed-out";
    } catch {
      return "unknown";
    }
  }
  return SIGNED_OUT.test(result.stderr) ? "signed-out" : "unknown";
}

export async function listOauthSessions(
  timeoutSeconds = 5,
): Promise<OAuthSession[]> {
  const binary = cliProcess.which("orq");
  if (!binary) return [];
  const timeoutMs = timeoutSeconds * 1000;
  let listing: unknown;
  let returncode = 0;
  try {
    const result = await cliProcess.runAsync(
      [binary, "--no-input", "--output-format", "json", "auth", "sessions"],
      { env: oauthEnv(), timeoutMs },
    );
    returncode = result.returncode;
    listing = returncode === 0 ? JSON.parse(result.stdout) : null;
  } catch (error) {
    console.warn(`Could not list Orq CLI OAuth sessions: ${String(error)}`);
    return [];
  }
  const raw = isRecord(listing) ? listing.sessions : null;
  if (!Array.isArray(raw)) {
    console.warn(`Could not list Orq CLI OAuth sessions (exit ${returncode})`);
    return [];
  }
  const nonEmpty = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0;
  const rows = raw.filter(
    (row): row is Record<string, string> =>
      isRecord(row) &&
      nonEmpty(row.host) &&
      typeof row.status === "string" &&
      (UNREADABLE.has(row.status) || nonEmpty(row.server)),
  );
  const servers = new Set(
    rows
      .filter((row) => !UNREADABLE.has(row.status) && row.status !== "ok")
      .map((row) => row.server),
  );
  const checked = new Map(
    await Promise.all(
      [...servers].map(
        async (server) =>
          [server, await sessionStatus(binary, server, timeoutMs)] as const,
      ),
    ),
  );
  return rows.map((row) => {
    const unreadable = UNREADABLE.has(row.status);
    return {
      server: unreadable ? "" : row.server,
      host: row.host,
      user: nonEmpty(row.user) ? row.user : null,
      workspace: nonEmpty(row.workspace) ? row.workspace : null,
      status: unreadable
        ? "unreadable"
        : (checked.get(row.server as string) ?? "valid"),
      active: Boolean((row as Record<string, unknown>).active),
    };
  });
}
