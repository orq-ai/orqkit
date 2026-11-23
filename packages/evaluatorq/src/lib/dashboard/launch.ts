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
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
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
