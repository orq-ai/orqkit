import { expect, test } from "bun:test";

import {
  requestSessionState,
  SESSION_COOKIE,
  signedSessionCookie,
  TraceSessionRegistry,
  verifiedSessionId,
  withTraceSession,
} from "../../../src/lib/dashboard/trace-finder/sessions.js";

class Store {
  closed = false;
  constructor(readonly name: string) {}
  async close() {
    this.closed = true;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = new TextEncoder().encode("test signing key");

test("session cookie requires a valid signature", () => {
  const sessionId = "a".repeat(43);
  const cookie = signedSessionCookie(sessionId, key);
  expect(verifiedSessionId(cookie, key)).toBe(sessionId);
  expect(verifiedSessionId(`${cookie}tampered`, key)).toBeNull();
  expect(
    verifiedSessionId(cookie, new TextEncoder().encode("other key")),
  ).toBeNull();
  expect(verifiedSessionId("malformed", key)).toBeNull();
});

test("signature matches the Python urlsafe base64 HMAC without padding", () => {
  expect(signedSessionCookie("a".repeat(43), key)).toMatch(
    /^a{43}\.[A-Za-z0-9_-]{43}$/,
  );
});

test("registry expires idle entries and evicts the least recently used", async () => {
  let now = 0;
  const registry = new TraceSessionRegistry<Store>({
    maxSessions: 2,
    ttlSeconds: 10,
    monotonic: () => now,
  });
  const stores = Object.fromEntries(
    ["a", "b", "c", "a-new"].map((name) => [name, new Store(name)]),
  ) as Record<string, Store>;
  const build = (name: string) => async () => stores[name] as Store;

  await registry.get("a", build("a"));
  await registry.get("b", build("b"));
  now = 1;
  await registry.get("a", build("a-new"));
  await registry.get("c", build("c"));
  expect(stores.a?.closed).toBe(false);
  expect(stores.b?.closed).toBe(true);

  now = 12;
  await registry.get("a", build("a-new"));
  expect(stores["a-new"]?.closed).toBe(false);
  expect(stores.c?.closed).toBe(true);

  await registry.closeAll();
  expect(stores["a-new"]?.closed).toBe(true);
});

test("evicted in-flight creation cannot replace the current entry", async () => {
  const registry = new TraceSessionRegistry<Store>({ maxSessions: 1 });
  const oldStore = new Store("old");
  const currentStore = new Store("current");
  let entered!: () => void;
  const enteredP = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const releaseP = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const slow = async () => {
    calls += 1;
    if (calls === 1) {
      entered();
      await releaseP;
      return oldStore;
    }
    return currentStore;
  };

  const first = registry.get("session-a", slow);
  await enteredP;
  await registry.get("session-b", async () => new Store("other"));
  const current = await registry.get("session-a", async () => currentStore);
  release();

  expect(await first).toBe(currentStore);
  expect(current).toBe(currentStore);
  expect(oldStore.closed).toBe(true);
  expect(currentStore.closed).toBe(false);
});

test("settings retirement defers close until the active request releases the store", async () => {
  const registry = new TraceSessionRegistry<Store>();
  const store = new Store("active");
  const state: { traceSessionEntries?: never[] } = {};
  expect(await registry.get("session-a", async () => store, state)).toBe(store);
  expect(registry.detachAll()).toEqual([]);
  expect(store.closed).toBe(false);
  await registry.release(state.traceSessionEntries?.[0] as never);
  expect(store.closed).toBe(true);
});

test("expired active entry stays available until the last request releases", async () => {
  let now = 0;
  const registry = new TraceSessionRegistry<Store>({
    maxSessions: 2,
    ttlSeconds: 10,
    monotonic: () => now,
  });
  const store = new Store("active");
  const first: { traceSessionEntries?: never[] } = {};
  const second: { traceSessionEntries?: never[] } = {};
  expect(await registry.get("session-a", async () => store, first)).toBe(store);
  now = 1;
  expect(
    await registry.get(
      "session-a",
      async () => new Store("replacement"),
      second,
    ),
  ).toBe(store);
  now = 11;
  expect(store.closed).toBe(false);
  await registry.release(first.traceSessionEntries?.[0] as never);
  expect(store.closed).toBe(false);
  await registry.release(second.traceSessionEntries?.[0] as never);
  expect(store.closed).toBe(true);
});

test("capacity with only active entries preserves them until release", async () => {
  const registry = new TraceSessionRegistry<Store>({ maxSessions: 1 });
  const store = new Store("active");
  const state: { traceSessionEntries?: never[] } = {};
  expect(await registry.get("session-a", async () => store, state)).toBe(store);
  const replacement = new Store("other");
  let done = false;
  const waiting = registry
    .get("session-b", async () => replacement)
    .then((value) => {
      done = true;
      return value;
    });
  await tick();
  expect(done).toBe(false);
  expect(store.closed).toBe(false);
  await registry.release(state.traceSessionEntries?.[0] as never);
  expect(await waiting).toBe(replacement);
  expect(store.closed).toBe(true);
});

test("middleware sets a signed cookie once and releases request leases", async () => {
  const registry = new TraceSessionRegistry<Store>();
  const store = new Store("s");
  const seen: string[] = [];
  const handler = withTraceSession(
    async (req) => {
      const state = requestSessionState(req);
      seen.push(state.dashboardSessionId as string);
      await registry.get(
        state.dashboardSessionId as string,
        async () => store,
        state,
      );
      return new Response("ok");
    },
    { signingKey: key, registry: registry as TraceSessionRegistry },
  );
  const first = await handler(new Request("http://localhost/traces"));
  const setCookie = first.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(
    new RegExp(
      `^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax$`,
    ),
  );
  const cookie = setCookie.split(";")[0] as string;
  const second = await handler(
    new Request("https://localhost/find/run", { headers: { cookie } }),
  );
  expect(second.headers.get("set-cookie")).toBeNull();
  expect(seen[0]).toBe(seen[1]);
  registry.detachAll();
  expect(store.closed).toBe(false);
  await registry.closeAll();
});

test("middleware ignores other paths and marks https cookies Secure", async () => {
  const registry = new TraceSessionRegistry();
  const handler = withTraceSession(async () => new Response("ok"), {
    signingKey: key,
    registry,
  });
  expect(
    (await handler(new Request("http://localhost/settings"))).headers.get(
      "set-cookie",
    ),
  ).toBeNull();
  const forged = `${SESSION_COOKIE}=${"b".repeat(43)}.bad`;
  const response = await handler(
    new Request("https://localhost/traces/x", { headers: { cookie: forged } }),
  );
  expect(response.headers.get("set-cookie")).toEndWith("; Secure");
});
