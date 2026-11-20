import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";

import { DEFAULT_ORQ_BASE_URL, envRaw } from "../common/env-config.js";
import { codepointCompare, pythonCasefold } from "../common/sanitize.js";

export interface OrqProject {
  id: string;
  name: string;
  workspaceId: string;
}
export interface OrqScope {
  workspaceKey: string | null;
  workspaceId: string | null;
  projects: OrqProject[];
  error: string | null;
}
export interface OrqWorkspace {
  id: string;
  key: string;
}
export interface OAuthScopes {
  workspaces: OrqWorkspace[];
  projects: OrqProject[];
  error: string | null;
}
type Row = Record<string, unknown>;
const record = (v: unknown): v is Row =>
  v != null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && Boolean(v);
const emptyScope = (error: string | null = null): OrqScope => ({
  workspaceKey: null,
  workspaceId: null,
  projects: [],
  error,
});
const emptyOAuth = (
  error: string | null = null,
  workspaces: OrqWorkspace[] = [],
): OAuthScopes => ({ workspaces, projects: [], error });
export async function findOrqCli(): Promise<string | null> {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory, `orq${extension}`);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  return null;
}
interface CliOptions {
  profile: string | null;
  timeoutMs: number;
  useCliSession?: boolean;
  server?: string;
  workspace?: string;
}
export async function scopeCliJson(
  args: string[],
  options: CliOptions,
): Promise<Row | null> {
  const binary = await findOrqCli();
  if (!binary) return null;
  const command: string[] = [],
    env = { ...process.env };
  delete env.ORQ_VERBOSE;
  delete env.ORQ_JMESPATH;
  const drop = (names: string[]) => {
    for (const name of names) delete env[name];
  };
  if (options.profile !== null) {
    command.push("--profile", options.profile);
    drop([
      "ORQ_API_KEY",
      "ORQ_BASE_URL",
      "ORQ_SERVER",
      "ORQ_WORKSPACE",
      "ORQ_WORKSPACE_SLUG",
      "ORQ_PROJECT",
    ]);
  } else {
    drop(["ORQ_WORKSPACE", "ORQ_WORKSPACE_SLUG", "ORQ_PROJECT"]);
    if (!options.useCliSession) {
      command.push("--profile", "");
      env.ORQ_SERVER = envRaw("ORQ_BASE_URL", DEFAULT_ORQ_BASE_URL);
    }
  }
  if (options.server) command.push("--server", options.server);
  if (options.workspace) command.push("--workspace", options.workspace);
  command.push(...args, "-o", "json", "--no-input");
  return new Promise((resolve) => {
    execFile(
      binary,
      command,
      {
        env,
        cwd: tmpdir(),
        timeout: Math.max(1, Math.ceil(options.timeoutMs)),
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          if (typeof (error as { code?: unknown }).code !== "number")
            console.warn("Could not inspect Orq scope through the CLI");
          resolve(null);
          return;
        }
        try {
          const value: unknown = JSON.parse(stdout);
          resolve(record(value) ? value : null);
        } catch {
          console.warn(
            "Could not inspect Orq scope through the CLI: invalid JSON",
          );
          resolve(null);
        }
      },
    );
  });
}
function remainingTimeout(deadline: number, perCall: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Orq scope discovery timed out.");
  return Math.min(perCall, remaining);
}
function projectsFrom(rows: unknown[]): OrqProject[] {
  return rows.flatMap((row) =>
    record(row) &&
    text(row.project_id) &&
    text(row.name) &&
    text(row.workspace_id)
      ? [{ id: row.project_id, name: row.name, workspaceId: row.workspace_id }]
      : [],
  );
}
function sortProjects(projects: OrqProject[]): OrqProject[] {
  return projects.sort((a, b) =>
    codepointCompare(pythonCasefold(a.name), pythonCasefold(b.name)),
  );
}
async function profileWorkspaceRows(
  profile: string,
  workspaceId: string | null,
  timeoutMs: number,
  deadline: number,
  useCliSession: boolean,
): Promise<Row[]> {
  const rows: Row[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const args = ["workspaces", "list", "--limit", "200"];
    if (cursor) args.push("--starting-after", cursor);
    const listing = await scopeCliJson(args, {
      profile,
      timeoutMs: remainingTimeout(deadline, timeoutMs),
      useCliSession,
    });
    const page = listing?.data;
    if (!Array.isArray(page))
      throw new Error(
        "The orq CLI could not list workspaces for this credential.",
      );
    rows.push(...page.filter(record));
    if (rows.some((row) => row.id === workspaceId) || !listing?.has_more)
      return rows;
    const last: unknown = page.at(-1);
    const next = record(last) ? last.id : null;
    if (!text(next) || seen.has(next))
      throw new Error("The orq CLI returned an invalid workspace page cursor.");
    seen.add(next);
    cursor = next;
  }
  throw new Error(
    "The orq CLI returned too many workspace pages to choose safely.",
  );
}
export async function discoverOrqScope(
  profile: string | null = null,
  options: { timeoutMs?: number; useCliSession?: boolean } = {},
): Promise<OrqScope> {
  const timeoutMs = options.timeoutMs ?? 5000,
    deadline = performance.now() + 3 * timeoutMs;
  const projects: OrqProject[] = [],
    seen = new Set<string>();
  let cursor: string | null = null,
    complete = false;
  for (let i = 0; i < 50; i++) {
    const args = ["projects", "list", "--limit", "200"];
    if (cursor) args.push("--starting-after", cursor);
    let page: Row | null;
    try {
      page = await scopeCliJson(args, {
        profile,
        timeoutMs: remainingTimeout(deadline, timeoutMs),
        useCliSession: options.useCliSession,
      });
    } catch (error) {
      return emptyScope((error as Error).message);
    }
    const rows = page?.data;
    if (!Array.isArray(rows))
      return emptyScope(
        "The orq CLI could not list projects for this credential.",
      );
    projects.push(...projectsFrom(rows));
    if (!page?.has_more) {
      complete = true;
      break;
    }
    const last: unknown = rows.at(-1),
      next = record(last) ? last.project_id : null;
    if (!text(next) || seen.has(next))
      return emptyScope("The orq CLI returned an invalid project page cursor.");
    seen.add(next);
    cursor = next;
  }
  if (!complete)
    return emptyScope(
      "The orq CLI returned too many project pages to choose safely.",
    );
  const workspaceIds = new Set(projects.map((project) => project.workspaceId));
  if (workspaceIds.size > 1)
    return emptyScope(
      "This credential returned projects from multiple workspaces.",
    );
  const workspaceId = workspaceIds.values().next().value ?? null;
  let rows: unknown;
  try {
    const listing = await scopeCliJson(["workspace", "list"], {
      profile,
      timeoutMs: remainingTimeout(deadline, timeoutMs),
      useCliSession: options.useCliSession,
    });
    rows = listing?.workspaces;
    if (profile && (!Array.isArray(rows) || !rows.length))
      rows = await profileWorkspaceRows(
        profile,
        workspaceId,
        timeoutMs,
        deadline,
        options.useCliSession ?? false,
      );
  } catch (error) {
    return emptyScope((error as Error).message);
  }
  const match = Array.isArray(rows)
    ? (rows.find(
        (row: unknown) =>
          record(row) && row.id === workspaceId && typeof row.key === "string",
      ) as Row | undefined)
    : undefined;
  const workspaceKey = typeof match?.key === "string" ? match.key : null;
  if (workspaceId && !workspaceKey)
    console.warn(
      "The orq CLI listed projects but could not resolve their workspace slug",
    );
  return {
    workspaceKey,
    workspaceId,
    projects: sortProjects(projects),
    error: null,
  };
}
export async function discoverOauthScopes(
  server: string,
  options: { workspace?: string; timeoutMs?: number } = {},
): Promise<OAuthScopes> {
  const timeoutMs = options.timeoutMs ?? 5000,
    deadline = performance.now() + 3 * timeoutMs;
  let listing: Row | null;
  try {
    listing = await scopeCliJson(["workspace", "list"], {
      profile: "",
      server,
      timeoutMs: remainingTimeout(deadline, timeoutMs),
    });
  } catch (error) {
    return emptyOAuth((error as Error).message);
  }
  const rows = listing?.workspaces;
  if (!Array.isArray(rows))
    return emptyOAuth(
      "The orq CLI could not list workspaces for this session.",
    );
  const workspaces = rows
    .flatMap((row: unknown) =>
      record(row) && text(row.id) && text(row.key)
        ? [{ id: row.id, key: row.key }]
        : [],
    )
    .sort((a, b) =>
      codepointCompare(pythonCasefold(a.key), pythonCasefold(b.key)),
    );
  if (
    !options.workspace ||
    !workspaces.some((row) => row.key === options.workspace)
  )
    return emptyOAuth(null, workspaces);
  const projects: OrqProject[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const args = ["projects", "list", "--limit", "200"];
    if (cursor) args.push("--starting-after", cursor);
    let page: Row | null;
    try {
      page = await scopeCliJson(args, {
        profile: "",
        server,
        workspace: options.workspace,
        timeoutMs: remainingTimeout(deadline, timeoutMs),
      });
    } catch (error) {
      return emptyOAuth((error as Error).message, workspaces);
    }
    const data = page?.data;
    if (!Array.isArray(data))
      return emptyOAuth(
        "The orq CLI could not list projects for this workspace.",
        workspaces,
      );
    projects.push(...projectsFrom(data));
    if (!page?.has_more)
      return { workspaces, projects: sortProjects(projects), error: null };
    const last: unknown = data.at(-1),
      next = record(last) ? last.project_id : null;
    if (!text(next) || seen.has(next))
      return emptyOAuth(
        "The orq CLI returned an invalid project page cursor.",
        workspaces,
      );
    seen.add(next);
    cursor = next;
  }
  return emptyOAuth("The orq CLI returned too many project pages.", workspaces);
}
