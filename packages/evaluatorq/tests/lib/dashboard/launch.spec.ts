import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BROWSER_NONCE_ENV,
  browserHost,
  buildServerFromEnv,
  loadLocalEnv,
  openBrowserWhenReady,
  ROOTS_ENV,
  serve,
} from "../../../src/lib/dashboard/launch.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const saved = { ...process.env };
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

async function tmp(): Promise<string> {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-launch-")));
  dirs.push(dir);
  return dir;
}

const fakeServer = () => ({ close: mock(() => {}) }) as unknown as Server;
const noSleep = async () => {};
const env = (key: string): string | undefined => process.env[key];

describe("browserHost", () => {
  it("maps wildcard binds to loopback", () => {
    expect(browserHost("0.0.0.0")).toBe("127.0.0.1");
    expect(browserHost("::")).toBe("::1");
    expect(browserHost("localhost")).toBe("localhost");
  });
});

describe("loadLocalEnv", () => {
  it("reads .env without overriding the shell", async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, ".env"),
      "EQ_TEST_WORKSPACE=orq-research\nEQ_TEST_BASE=https://wrong.example\n",
    );
    delete process.env.EQ_TEST_WORKSPACE;
    process.env.EQ_TEST_BASE = "https://right.example";
    loadLocalEnv(dir);
    expect(env("EQ_TEST_WORKSPACE")).toBe("orq-research");
    expect(process.env.EQ_TEST_BASE).toBe("https://right.example");
  });
});

describe("openBrowserWhenReady", () => {
  it("retries a refused connection before opening once", async () => {
    const calls: boolean[] = [];
    const connect = mock(async () => {
      const ok = calls.length > 0;
      calls.push(ok);
      return ok;
    });
    const openUrl = mock(async (_url: string) => true);
    await openBrowserWhenReady(
      "0.0.0.0",
      8125,
      new AbortController().signal,
      null,
      {
        canConnect: connect,
        openUrl,
        sleep: noSleep,
      },
    );
    expect(connect).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl.mock.calls[0]).toEqual(["http://127.0.0.1:8125/"]);
  });

  it("waits for this dashboard instance's nonce", async () => {
    const answers = ["other-instance", "our-instance"];
    const fetchText = mock(async (_url: string) => answers.shift() as string);
    const openUrl = mock(async (_url: string) => true);
    await openBrowserWhenReady(
      "127.0.0.1",
      8125,
      new AbortController().signal,
      "our-instance",
      { fetchText, openUrl, sleep: noSleep },
    );
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(fetchText.mock.calls[0]).toEqual([
      "http://127.0.0.1:8125/_dashboard-ready",
    ]);
    expect(openUrl.mock.calls).toEqual([["http://127.0.0.1:8125/"]]);
  });

  it("reports a launch error as a single warning", async () => {
    const warn = mock(() => {});
    await openBrowserWhenReady(
      "127.0.0.1",
      8125,
      new AbortController().signal,
      null,
      {
        canConnect: async () => true,
        openUrl: async () => {
          throw new Error("no browser");
        },
        sleep: noSleep,
        warn,
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("brackets IPv6 hosts and stops when aborted", async () => {
    const openUrl = mock(async (_url: string) => true);
    await openBrowserWhenReady("::", 9, new AbortController().signal, null, {
      canConnect: async () => true,
      openUrl,
      sleep: noSleep,
    });
    expect(openUrl.mock.calls).toEqual([["http://[::1]:9/"]]);
    const stopped = new AbortController();
    stopped.abort();
    const never = mock(async () => true);
    await openBrowserWhenReady("::", 9, stopped.signal, null, {
      canConnect: never,
      sleep: noSleep,
    });
    expect(never).not.toHaveBeenCalled();
  });
});

describe("buildServerFromEnv", () => {
  it("reads roots, local env and the readiness nonce", async () => {
    const dir = await tmp();
    await writeFile(join(dir, ".env"), "EQ_TEST_WORKER=yes\n");
    process.chdir(dir);
    delete process.env.EQ_TEST_WORKER;
    process.env[ROOTS_ENV] = JSON.stringify(["/a", "/b"]);
    process.env[BROWSER_NONCE_ENV] = "test-nonce";
    const start = mock((_opts: Record<string, unknown>) => fakeServer());
    buildServerFromEnv({ port: 1 }, start);
    expect(env("EQ_TEST_WORKER")).toBe("yes");
    expect(start.mock.calls[0]?.[0]).toEqual({
      roots: ["/a", "/b"],
      host: undefined,
      port: 1,
      finder: null,
      readyNonce: "test-nonce",
    });
  });
});

describe("serve", () => {
  it("starts the server with host and port and launches the browser", async () => {
    const dir = await tmp();
    process.chdir(dir);
    const start = mock((_opts: Record<string, unknown>) => fakeServer());
    const openUrl = mock(async (_url: string) => true);
    let probes = 0;
    const { browser, stop } = await serve(
      [dir],
      { host: "0.0.0.0", port: 9999 },
      {
        start,
        canConnect: async () => probes++ > 0,
        fetchText: async () => process.env[BROWSER_NONCE_ENV] as string,
        openUrl,
        sleep: noSleep,
      },
    );
    await browser;
    const args = start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.host).toBe("0.0.0.0");
    expect(args.port).toBe(9999);
    expect(args.roots).toEqual([dir]);
    expect(typeof args.readyNonce).toBe("string");
    expect(openUrl).toHaveBeenCalledTimes(1);
    stop();
    expect(process.env[BROWSER_NONCE_ENV]).toBeUndefined();
  });

  it("does not open a port that is already in use", async () => {
    process.chdir(await tmp());
    const warn = mock(() => {});
    const openUrl = mock(async (_url: string) => true);
    const { browser, stop } = await serve(
      null,
      {},
      {
        start: () => fakeServer(),
        canConnect: async () => true,
        openUrl,
        warn,
      },
    );
    expect(browser).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(process.env[ROOTS_ENV]).toBeUndefined();
    stop();
  });

  it("skips the probe and nonce when the browser is off", async () => {
    process.chdir(await tmp());
    const canConnect = mock(async () => false);
    const start = mock((_opts: Record<string, unknown>) => fakeServer());
    const { browser, stop } = await serve(
      null,
      { openBrowser: false },
      {
        start,
        canConnect,
      },
    );
    expect(browser).toBeNull();
    expect(canConnect).not.toHaveBeenCalled();
    expect(
      (start.mock.calls[0]?.[0] as { readyNonce: unknown }).readyNonce,
    ).toBeNull();
    stop();
  });
});

describe("readiness route", () => {
  it("answers the nonce on /_dashboard-ready", async () => {
    process.chdir(await tmp());
    process.env[BROWSER_NONCE_ENV] = "test-nonce";
    const server = buildServerFromEnv({ host: "127.0.0.1", port: 0 });
    await new Promise((done) => server.once("listening", done));
    const { port } = server.address() as { port: number };
    const body = await (
      await fetch(`http://127.0.0.1:${port}/_dashboard-ready`)
    ).text();
    server.close();
    expect(body).toBe("test-nonce");
  });
});
