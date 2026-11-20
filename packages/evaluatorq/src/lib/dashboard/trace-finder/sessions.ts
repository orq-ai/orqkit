import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "evaluatorq_dashboard_session";
export const SESSION_TTL_SECONDS = 30 * 60;
export const MAX_SESSIONS = 32;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

export interface ClosableStore {
  close(): unknown;
}

function signature(sessionId: string, signingKey: Uint8Array): string {
  return createHmac("sha256", signingKey)
    .update(sessionId, "ascii")
    .digest("base64url");
}

export function signedSessionCookie(
  sessionId: string,
  signingKey: Uint8Array,
): string {
  return `${sessionId}.${signature(sessionId, signingKey)}`;
}

export function verifiedSessionId(
  cookie: string | null | undefined,
  signingKey: Uint8Array,
): string | null {
  if (!cookie || !cookie.includes(".")) return null;
  const dot = cookie.lastIndexOf(".");
  const sessionId = cookie.slice(0, dot);
  if (!SESSION_ID.test(sessionId)) return null;
  const supplied = Buffer.from(cookie.slice(dot + 1));
  const expected = Buffer.from(signature(sessionId, signingKey));
  if (supplied.length !== expected.length) return null;
  return timingSafeEqual(supplied, expected) ? sessionId : null;
}

export class SessionEntry<S extends ClosableStore = ClosableStore> {
  store: S | null = null;
  activeRequests = 0;
  retired = false;
  creating: Promise<void> = Promise.resolve();
  constructor(
    readonly sessionId: string,
    public lastAccess: number,
  ) {}
}

export interface RequestSessionState {
  dashboardSessionId?: string;
  traceSessionEntries?: SessionEntry[];
}

const monotonicSeconds = () => performance.now() / 1000;

async function closeStores(stores: ClosableStore[]): Promise<void> {
  const results = await Promise.allSettled(
    stores.map(async (store) => store.close()),
  );
  for (const result of results)
    if (result.status === "rejected")
      console.warn(
        "Could not close a retired Traces session store:",
        result.reason,
      );
}

export class TraceSessionRegistry<S extends ClosableStore = ClosableStore> {
  readonly maxSessions: number;
  readonly ttlSeconds: number;
  private readonly monotonic: () => number;
  private entries = new Map<string, SessionEntry<S>>();
  private waiters = new Set<() => void>();

  constructor(
    options: {
      maxSessions?: number;
      ttlSeconds?: number;
      monotonic?: () => number;
    } = {},
  ) {
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.ttlSeconds = options.ttlSeconds ?? SESSION_TTL_SECONDS;
    this.monotonic = options.monotonic ?? monotonicSeconds;
  }

  async get(
    sessionId: string,
    factory: () => Promise<S | null>,
    requestState?: RequestSessionState,
  ): Promise<S | null> {
    for (;;) {
      const [entry, retired] = this.entryFor(sessionId, this.monotonic());
      let waiter: Promise<void> | null = null;
      if (entry === null)
        waiter = new Promise<void>((resolve) => this.waiters.add(resolve));
      else if (requestState) {
        requestState.traceSessionEntries ??= [];
        const active = requestState.traceSessionEntries;
        if (!active.includes(entry as SessionEntry)) {
          entry.activeRequests += 1;
          active.push(entry as SessionEntry);
        }
      }
      await closeStores(retired);
      if (entry === null) {
        await waiter;
        continue;
      }

      const previous = entry.creating;
      let unlock!: () => void;
      entry.creating = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      try {
        if (this.entries.get(sessionId) !== entry) continue;
        entry.lastAccess = this.monotonic();
        if (entry.store !== null) return entry.store;
        const store = await factory();
        if (this.entries.get(sessionId) === entry) {
          entry.lastAccess = this.monotonic();
          if (store !== null) entry.store = store;
          return store;
        }
        if (store !== null) await closeStores([store]);
      } finally {
        unlock();
      }
    }
  }

  private entryFor(
    sessionId: string,
    now: number,
  ): [SessionEntry<S> | null, S[]] {
    const retired: S[] = [];
    for (const [key, entry] of [...this.entries])
      if (
        entry.activeRequests === 0 &&
        now - entry.lastAccess >= this.ttlSeconds
      ) {
        this.entries.delete(key);
        entry.retired = true;
        if (entry.store !== null) retired.push(entry.store);
      }

    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastAccess = now;
      return [existing, retired];
    }

    while (this.entries.size >= this.maxSessions) {
      let oldest: SessionEntry<S> | null = null;
      for (const candidate of this.entries.values())
        if (
          candidate.activeRequests === 0 &&
          (oldest === null || candidate.lastAccess < oldest.lastAccess)
        )
          oldest = candidate;
      if (oldest === null) return [null, retired];
      this.entries.delete(oldest.sessionId);
      oldest.retired = true;
      if (oldest.store !== null) retired.push(oldest.store);
    }

    const entry = new SessionEntry<S>(sessionId, now);
    this.entries.set(sessionId, entry);
    return [entry, retired];
  }

  async release(entry: SessionEntry<S>): Promise<void> {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    const expired = this.monotonic() - entry.lastAccess >= this.ttlSeconds;
    if (
      expired &&
      entry.activeRequests === 0 &&
      this.entries.get(entry.sessionId) === entry
    ) {
      this.entries.delete(entry.sessionId);
      entry.retired = true;
    }
    let store: S | null = null;
    if (entry.retired && entry.activeRequests === 0) {
      store = entry.store;
      entry.store = null;
    }
    this.wakeWaiters();
    if (store !== null) await closeStores([store]);
  }

  private wakeWaiters(): void {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const wake of waiters) wake();
  }

  detachAll(): S[] {
    const stores: S[] = [];
    for (const entry of this.entries.values()) {
      entry.retired = true;
      if (entry.store !== null && entry.activeRequests === 0) {
        stores.push(entry.store);
        entry.store = null;
      }
    }
    this.entries.clear();
    this.wakeWaiters();
    return stores;
  }

  async closeAll(): Promise<void> {
    const stores: S[] = [];
    for (const entry of this.entries.values()) {
      entry.retired = true;
      if (entry.store !== null) stores.push(entry.store);
      entry.store = null;
    }
    this.entries.clear();
    this.wakeWaiters();
    await closeStores(stores);
  }

  get size(): number {
    return this.entries.size;
  }
}

const requestStates = new WeakMap<Request, RequestSessionState>();

export function requestSessionState(req: Request): RequestSessionState {
  let state = requestStates.get(req);
  if (!state) {
    state = {};
    requestStates.set(req, state);
  }
  return state;
}

const isTracePath = (path: string) =>
  path === "/traces" ||
  path.startsWith("/traces/") ||
  path === "/find" ||
  path.startsWith("/find/");

function cookieValue(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`))
      return trimmed.slice(trimmed.indexOf("=") + 1);
  }
  return null;
}

export function withTraceSession(
  handler: (req: Request) => Response | Promise<Response>,
  options: { signingKey: Uint8Array; registry: TraceSessionRegistry },
): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (!isTracePath(url.pathname)) return handler(req);
    const { signingKey, registry } = options;
    let sessionId = verifiedSessionId(
      cookieValue(req.headers.get("cookie")),
      signingKey,
    );
    const fresh = sessionId === null;
    if (sessionId === null) sessionId = randomBytes(32).toString("base64url");
    const state = requestSessionState(req);
    state.dashboardSessionId = sessionId;
    try {
      const response = await handler(req);
      if (!fresh) return response;
      let cookie = `${SESSION_COOKIE}=${signedSessionCookie(sessionId, signingKey)}; Path=/; HttpOnly; SameSite=Lax`;
      if (url.protocol === "https:") cookie += "; Secure";
      const headers = new Headers(response.headers);
      headers.append("set-cookie", cookie);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      const entries = state.traceSessionEntries ?? [];
      state.traceSessionEntries = [];
      for (const entry of entries) await registry.release(entry);
    }
  };
}
