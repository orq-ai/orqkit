import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

import { serveDashboard } from "./app.js";
import type { FinderState } from "./trace-finder/routes.js";

export const ROOTS_ENV = "EVALUATORQ_DASHBOARD_ROOTS";
export const BROWSER_NONCE_ENV = "EVALUATORQ_DASHBOARD_LAUNCH_NONCE";

export function loadLocalEnv(cwd = process.cwd()): void {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  const values = new Map<string, string | null>();
  let cursor = 0;
  const read = (pattern: RegExp): RegExpExecArray => {
    const match = pattern.exec(source.slice(cursor));
    if (!match) throw new Error("Invalid dotenv statement");
    cursor += match[0].length;
    return match;
  };
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
  };
  while (cursor < source.length) {
    read(/^\s*/);
    if (cursor === source.length) break;
    const line = source.slice(0, cursor).split(/\r\n|\r|\n/).length;
    try {
      read(/^(?:export[^\S\r\n]+)?/);
      const key =
        source[cursor] === "#"
          ? null
          : source[cursor] === "'"
            ? (read(/^'([^']+)'/)[1] as string)
            : (read(/^([^=#\s]+)/)[1] as string);
      read(/^[^\S\r\n]*/);
      let value: string | null = null;
      if (source[cursor] === "=") {
        read(/^=[^\S\r\n]*/);
        if (source[cursor] === "'")
          value = (read(/^'((?:\\'|[^'])*)'/)[1] as string).replace(
            /\\([\\'])/g,
            (_match, escaped: string) => escaped,
          );
        else if (source[cursor] === '"')
          value = (read(/^"((?:\\"|[^"])*)"/)[1] as string).replace(
            /\\([\\'"abfnrtv])/g,
            (_match, escaped: string) => escapes[escaped] as string,
          );
        else
          value = read(/^[^\r\n]*/)[0]
            .replace(/\s+#.*/, "")
            .trimEnd();
      }
      read(/^(?:[^\S\r\n]*#[^\r\n]*)?/);
      read(/^[^\S\r\n]*(?:\r\n|\n|\r|$)/);
      if (key !== null)
        values.set(
          key,
          value === null
            ? null
            : value.replace(
                /\$\{([^}:]*)(?::-([^}]*))?\}/g,
                (_match, name: string, fallback?: string) =>
                  process.env[name] ??
                  (values.has(name)
                    ? (values.get(name) ?? "")
                    : (fallback ?? "")),
              ),
        );
    } catch {
      console.warn(`Could not parse .env statement at line ${line}.`);
      read(/^[^\r\n]*(?:\r\n|\r|\n)?/);
    }
  }
  for (const [key, value] of values)
    if (value !== null && process.env[key] === undefined)
      process.env[key] = value;
}

export function browserHost(host: string): string {
  return (
    (
      { "0.0.0.0": "127.0.0.1", "::": "::1", "[::1]": "::1" } as Record<
        string,
        string
      >
    )[host] ?? host
  );
}

export interface LaunchDeps {
  canConnect: (host: string, port: number) => Promise<boolean>;
  fetchText: (url: string) => Promise<string>;
  openUrl: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  warn: (message: string) => void;
}

const defaultDeps: LaunchDeps = {
  canConnect: (host, port) =>
    new Promise((done) => {
      const socket = connect({ host, port, timeout: 200 });
      const finish = (ok: boolean) => {
        socket.destroy();
        done(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
    }),
  fetchText: async (url) =>
    (await fetch(url, { signal: AbortSignal.timeout(200) })).text(),
  openUrl: (url) =>
    new Promise((done, fail) => {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
      const child = spawn(command, [url], { stdio: "ignore", detached: true });
      child.once("error", fail);
      child.once("spawn", () => {
        child.unref();
        done(true);
      });
    }),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  warn: (message) => console.warn(message),
};

export async function openBrowserWhenReady(
  host: string,
  port: number,
  stop: AbortSignal,
  nonce: string | null = null,
  deps: Partial<LaunchDeps> = {},
): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const target = browserHost(host);
  const urlHost = target.includes(":") ? `[${target}]` : target;
  const url = `http://${urlHost}:${port}/`;
  for (let attempt = 0; attempt < 100; attempt++) {
    await d.sleep(100);
    if (stop.aborted) return;
    try {
      if (nonce === null) {
        if (!(await d.canConnect(target, port))) continue;
      } else if ((await d.fetchText(`${url}_dashboard-ready`)) !== nonce) {
        continue;
      }
    } catch {
      continue;
    }
    try {
      if (!(await d.openUrl(url))) {
        d.warn(`Could not open a browser automatically; open ${url}`);
      }
    } catch (exc) {
      d.warn(
        `Could not open a browser automatically: ${(exc as Error).message}; open ${url}`,
      );
    }
    return;
  }
  d.warn(
    `Dashboard did not become ready for browser launch; open ${url} when it starts`,
  );
}

export function buildServerFromEnv(
  options: { host?: string; port?: number; finder?: FinderState | null } = {},
  start: (
    options: Parameters<typeof serveDashboard>[0],
  ) => Server | Promise<Server> = serveDashboard,
): Server | Promise<Server> {
  loadLocalEnv();
  const raw = process.env[ROOTS_ENV];
  const roots = raw ? (JSON.parse(raw) as string[]) : null;
  return start({
    roots,
    host: options.host,
    port: options.port,
    finder: options.finder ?? null,
    readyNonce: process.env[BROWSER_NONCE_ENV] || null,
  });
}

export async function serve(
  roots: string[] | null,
  {
    host = "127.0.0.1",
    port = 8080,
    openBrowser = true,
    finder = null,
  }: {
    host?: string;
    port?: number;
    openBrowser?: boolean;
    finder?: FinderState | null;
  } = {},
  deps: Partial<LaunchDeps> & {
    start?: (
      options: Parameters<typeof serveDashboard>[0],
    ) => Server | Promise<Server>;
  } = {},
): Promise<{
  server: Server;
  browser: Promise<void> | null;
  stop: () => void;
}> {
  const d = { ...defaultDeps, ...deps };
  loadLocalEnv();
  const nonce = openBrowser ? randomBytes(24).toString("base64url") : null;
  const controller = new AbortController();
  const server = await (deps.start ?? serveDashboard)({
    roots,
    host,
    port,
    finder,
    readyNonce: nonce,
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  const browser = openBrowser
    ? openBrowserWhenReady(host, actualPort, controller.signal, nonce, d)
    : null;
  const stop = () => {
    controller.abort();
    server.close();
  };
  return { server, browser, stop };
}
