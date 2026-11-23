import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { OrqCLIError } from "../../../src/lib/common/cli-oauth.js";
import {
  compressionInspectorRoutes,
  DocumentCache,
  SESSION_REF_MAX_LENGTH,
  TRACE_ID_MAX_LENGTH,
} from "../../../src/lib/dashboard/compression-inspector.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";
import type { OrqSourceClient } from "../../../src/lib/trace-finder/orq-source.js";
import {
  DashboardSettings,
  saveDashboardSettings,
} from "../../../src/lib/trace-finder/settings.js";
import { type Fixture, fake } from "../common/orq-source-fake.js";

const ENV = [
  "EVALUATORQ_DASHBOARD_SETTINGS",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
let home = mkdtempSync(join(tmpdir(), "compression-routes-"));
const realHomedir = os.homedir;
mock.module("node:os", () => ({ ...os, homedir: () => home }));

async function enable(enabled = true) {
  await saveDashboardSettings(
    new DashboardSettings({ compressionInspectorEnabled: enabled }),
  );
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "compression-routes-"));
  process.env.HOME = home;
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(home, "settings.json");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  process.env.CODEX_HOME = join(home, "codex");
  await enable();
});
afterAll(() => {
  mock.module("node:os", () => ({ ...os, homedir: realHomedir }));
  for (const key of ENV)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const sourceCase = (
  JSON.parse(
    readFileSync(
      new URL("../fixtures/orq-source-python-goldens.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: { input: Fixture }[] }
).cases[25]?.input as Fixture;

interface Harness {
  call: (
    method: string,
    path: string,
    fields?: Record<string, string>,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  clientBuilds: () => number;
  queries: { from: Date; to: Date; oql: string }[];
}

function harness(
  options: { client?: OrqSourceClient; failBuild?: unknown } = {},
): Harness {
  let builds = 0;
  const queries: Harness["queries"] = [];
  const base = options.client ?? fake(sourceCase).client;
  const query = base.traces.query.bind(base.traces);
  const client = {
    ...base,
    traces: {
      ...base.traces,
      query: (
        args: { from: Date; to: Date; oql: string },
        ...rest: never[]
      ) => {
        queries.push(args);
        return (query as (...a: unknown[]) => unknown)(args, ...rest);
      },
    },
  } as unknown as OrqSourceClient;
  const handle = compressionInspectorRoutes({
    documents: new DocumentCache(),
    buildClient: async () => {
      builds++;
      if (options.failBuild)
        throw options.failBuild === true
          ? new Error("credential at /private/key")
          : options.failBuild;
      return client;
    },
  });
  return {
    clientBuilds: () => builds,
    queries,
    call: async (method, path, fields, headers = {}) => {
      const url = `http://127.0.0.1${path}`;
      const body = fields ? new URLSearchParams(fields) : undefined;
      const response = await handle(
        new Request(url, { method, body, headers }),
        new URL(url),
      );
      if (!response) throw new Error(`no route for ${method} ${path}`);
      return response;
    },
  };
}

const csrf = () => ({ csrf: csrfToken() });
const tokenOf = (body: string) =>
  /name="token" value="([^"]+)"/.exec(body)?.[1] as string;

function writeJsonl(path: string, records: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function claudeSession(id: string, prompt: string, answer: string) {
  const base = {
    sessionId: id,
    cwd: "/work/private-project",
    version: "2.0",
    entrypoint: "cli",
  };
  return writeJsonl(
    join(home, "claude", "projects", "-work-private-project", `${id}.jsonl`),
    [
      {
        ...base,
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: "2026-10-01T10:00:00+00:00",
        message: { role: "user", content: prompt },
      },
      {
        ...base,
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: "2026-10-01T10:01:00+00:00",
        message: { id: "message-1", model: "claude-test", content: answer },
      },
    ],
  );
}

function codexSession(id: string, prompt: string, answer: string) {
  const timestamp = "2026-10-01T10:00:00.000Z";
  return writeJsonl(
    join(
      home,
      "codex",
      "sessions",
      "2026",
      "10",
      "01",
      `rollout-2026-10-01T10-00-00-${id}.jsonl`,
    ),
    [
      {
        timestamp,
        type: "session_meta",
        payload: { id, timestamp, cwd: "/work/codex" },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: answer }],
        },
      },
    ],
  );
}

const ROUTES: [string, string][] = [
  ["GET", "/compression-inspector"],
  ["POST", "/compression-inspector/source/orq"],
  ["POST", "/compression-inspector/sessions/search"],
  ["POST", "/compression-inspector/sessions/load"],
  ["POST", "/compression-inspector/preview"],
];

test("every route returns not found when the persisted switch is off", async () => {
  await enable(false);
  const h = harness();
  for (const [method, path] of ROUTES) {
    const response = await h.call(
      method,
      path,
      method === "POST" ? csrf() : undefined,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  }
  expect(h.clientBuilds()).toBe(0);
});

test("unrelated paths fall through to the dashboard", async () => {
  const handle = compressionInspectorRoutes();
  const url = "http://127.0.0.1/compression-inspector/other";
  expect(await handle(new Request(url), new URL(url))).toBeNull();
});

test("the page offers Orq and local sources with limits and no question", async () => {
  const response = await harness().call("GET", "/compression-inspector");
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).toContain("Load Orq trace");
  expect(body).toContain("Search local sessions");
  expect(body).toContain("Global cap: <strong>500,000</strong>");
  expect(body).toContain(`maxlength="${TRACE_ID_MAX_LENGTH}"`);
  expect(body).toContain("This preview includes no question");
});

test("every POST rejects a missing csrf token before any source work", async () => {
  const h = harness();
  for (const [method, path] of ROUTES.filter(([m]) => m === "POST")) {
    const response = await h.call(method, path, { trace_id: "t" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Stale or missing form token");
  }
  expect(h.clientBuilds()).toBe(0);
});

test("an Orq load searches the last seven days and renders the preview", async () => {
  const h = harness();
  const response = await h.call("POST", "/compression-inspector/source/orq", {
    ...csrf(),
    trace_id: "t",
  });
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain('id="compression-output"');
  expect(body).toContain("Original, ATIF trajectory");
  expect(body).not.toContain('<option value="source"');
  const [query] = h.queries;
  expect(query && query.to.getTime() - query.from.getTime()).toBe(
    7 * 86_400_000,
  );
});

test("explicit dates set a whole-day window and failures never echo the trace id", async () => {
  const h = harness();
  await h.call("POST", "/compression-inspector/source/orq", {
    ...csrf(),
    trace_id: "t",
    start_date: "2026-01-01",
    end_date: "2026-01-02",
  });
  expect(h.queries[0]?.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(h.queries[0]?.to.toISOString()).toBe("2026-01-03T00:00:00.000Z");

  const failing = harness({ failBuild: true });
  const body = await (
    await failing.call("POST", "/compression-inspector/source/orq", {
      ...csrf(),
      trace_id: "secret-trace-id",
    })
  ).text();
  expect(body).toContain("The Orq trace could not be loaded.");
  expect(body).not.toContain("secret-trace-id");
  expect(body).not.toContain("/private/key");
});

test("a missing Orq trace shows a safe message", async () => {
  const { client } = fake({
    ...sourceCase,
    pages: [{ search: { data: [], has_more: false } }],
  });
  const body = await (
    await harness({ client }).call(
      "POST",
      "/compression-inspector/source/orq",
      {
        ...csrf(),
        trace_id: "not-present-id",
      },
    )
  ).text();
  expect(body).toContain(
    "No Orq trace matched that ID in the selected date range.",
  );
  expect(body).not.toContain("not-present-id");
});

test("one-sided, invalid, inverted or overflowing dates are refused before loading", async () => {
  const h = harness();
  for (const dates of [
    { start_date: "2026-01-01" },
    { end_date: "2026-01-01" },
    { start_date: "2026-02-30", end_date: "2026-03-01" },
    { start_date: "2026-03-02", end_date: "2026-03-01" },
    { start_date: "9999-12-31", end_date: "99999-01-01" },
  ] as Record<string, string>[]) {
    const response = await h.call("POST", "/compression-inspector/source/orq", {
      ...csrf(),
      trace_id: "t",
      ...dates,
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(
      "Enter both valid dates, with the start date on or before the end date.",
    );
  }
  expect(h.clientBuilds()).toBe(0);
});

test("an empty or over-long trace id is refused before loading", async () => {
  const h = harness();
  for (const traceId of ["  ", "x".repeat(TRACE_ID_MAX_LENGTH + 1)]) {
    const response = await h.call("POST", "/compression-inspector/source/orq", {
      ...csrf(),
      trace_id: traceId,
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Enter a valid Orq trace ID.");
  }
  expect(h.clientBuilds()).toBe(0);
});

test("local search and load use the real readers and escape content", async () => {
  claudeSession(
    "claude-1",
    "Claude <script>alert(1)</script> prompt",
    "Claude answer",
  );
  codexSession("codex-1", "Codex prompt", "Codex answer");
  const h = harness();
  const search = await (
    await h.call("POST", "/compression-inspector/sessions/search", csrf())
  ).text();
  expect(search).toContain("2 local sessions");
  expect(search).toContain("<strong>Claude Code</strong>");
  expect(search).toContain("<strong>Codex</strong>");
  expect(search).not.toContain("<script>alert(1)</script>");
  expect(search).toContain('datetime="2026-10-01T10:01:00+00:00"');
  const refs = [...search.matchAll(/name="session" value="([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  expect(refs).toHaveLength(2);
  const claudeRef = refs.find((ref) =>
    ref.startsWith("claude-code:"),
  ) as string;
  const loaded = await (
    await h.call("POST", "/compression-inspector/sessions/load", {
      ...csrf(),
      session: claudeRef.replaceAll("&amp;", "&"),
    })
  ).text();
  expect(loaded).toContain('<option value="source"');
  expect(loaded).toContain("Original, ATIF trajectory");
  expect(loaded).not.toContain("<script>alert(1)</script>");
  expect(loaded).toContain("&lt;script&gt;");
});

test("an empty search names the searched folders and bad selections are safe", async () => {
  const h = harness();
  const empty = await (
    await h.call("POST", "/compression-inspector/sessions/search", csrf())
  ).text();
  expect(empty).toContain("No local sessions were found.");
  mkdirSync(join(home, "claude", "projects"), { recursive: true });
  const rooted = await (
    await h.call("POST", "/compression-inspector/sessions/search", csrf())
  ).text();
  expect(rooted).toContain(
    "No local sessions matched the available source folders.",
  );
  for (const session of [
    "",
    "codex",
    "omp:/x.jsonl",
    "claude-code:",
    "x".repeat(SESSION_REF_MAX_LENGTH + 1),
  ]) {
    const response = await h.call(
      "POST",
      "/compression-inspector/sessions/load",
      {
        ...csrf(),
        session,
      },
    );
    expect(response.status).toBe(422);
  }
  const outside = await h.call("POST", "/compression-inspector/sessions/load", {
    ...csrf(),
    session: `claude-code:${join(home, "elsewhere.jsonl")}`,
  });
  expect(outside.status).toBe(200);
  const text = await outside.text();
  expect(text).toContain("That local session could not be loaded");
  expect(text).not.toContain("elsewhere.jsonl");
});

async function loadedToken(h: Harness) {
  const body = await (
    await h.call("POST", "/compression-inspector/source/orq", {
      ...csrf(),
      trace_id: "t",
    })
  ).text();
  return { token: tokenOf(body), body };
}

const defaultsForm = (body: string) => {
  const fields: Record<string, string> = {};
  const form = body.slice(body.indexOf('<form class="compression-knobs"'));
  for (const m of form.matchAll(
    /<input type="number" name="([^"]+)" value="([^"]+)"/g,
  ))
    fields[m[1] as string] = m[2] as string;
  for (const m of form.matchAll(
    /<input type="checkbox" name="([^"]+)" value="1" checked/g,
  ))
    fields[m[1] as string] = "1";
  for (const m of form.matchAll(
    /<select name="([^"]+)"[^>]*>(?:(?!<\/select>).)*?<option value="([^"]+)" selected/g,
  ))
    fields[m[1] as string] = m[2] as string;
  return fields;
};

test("htmx gets only the live region and a plain post gets the page", async () => {
  const h = harness();
  const { token, body } = await loadedToken(h);
  const fields = { ...defaultsForm(body), ...csrf(), token };
  const live = await (
    await h.call("POST", "/compression-inspector/preview", fields, {
      "HX-Request": "true",
    })
  ).text();
  expect(live.startsWith('<div id="compression-output"')).toBe(true);
  expect(live).not.toContain("<html");
  const full = await (
    await h.call("POST", "/compression-inspector/preview", fields)
  ).text();
  expect(full).toContain("<!DOCTYPE html>");
  expect(full).toContain('id="compression-output"');
});

test("wrap sets the wrapped class and readable view switches the original", async () => {
  const h = harness();
  const { token, body } = await loadedToken(h);
  const live = await (
    await h.call(
      "POST",
      "/compression-inspector/preview",
      {
        ...defaultsForm(body),
        ...csrf(),
        token,
        wrap: "1",
        original_view: "readable",
      },
      { "HX-Request": "true" },
    )
  ).text();
  expect(live).toContain('class="compression-output is-wrapped"');
  expect(live).toContain("Original, readable text");
});

test("invalid knobs, an Orq raw source request and an unknown token show a notice", async () => {
  const h = harness();
  const { token, body } = await loadedToken(h);
  const form = { ...defaultsForm(body), ...csrf(), token };
  const post = (fields: Record<string, string>) =>
    h
      .call("POST", "/compression-inspector/preview", fields, {
        "HX-Request": "true",
      })
      .then((r) => r.text());
  const invalid = await post({ ...form, view_budget: "<b>nope</b>" });
  expect(invalid).toContain('role="alert"');
  expect(invalid).not.toContain("<b>nope</b>");
  expect(invalid).not.toContain("compression-metrics");
  expect(await post({ ...form, original_view: "source" })).toContain(
    "the raw source is only available for local sessions",
  );
  expect(await post({ ...form, original_view: "bogus" })).toContain(
    'role="alert"',
  );
  expect(await post({ ...form, token: "unknown" })).toContain(
    "Load the trace again to adjust it.",
  );
});

test("the oldest loaded trace expires after eight newer ones", async () => {
  const h = harness();
  const { token: first, body } = await loadedToken(h);
  for (let i = 0; i < 8; i++) await loadedToken(h);
  const live = await (
    await h.call(
      "POST",
      "/compression-inspector/preview",
      { ...defaultsForm(body), ...csrf(), token: first },
      { "HX-Request": "true" },
    )
  ).text();
  expect(live).toContain("Load the trace again to adjust it.");
});

test("source failures retain safe diagnostics and actionable CLI notices", async () => {
  await enable();
  for (const [kind, notice] of [
    ["setup", "Install the orq CLI"],
    ["authentication", "Run orq auth login"],
  ] as const) {
    const h = harness({
      failBuild: new OrqCLIError("api_key=private-source-token", {
        failureKind: kind,
      }),
    });
    const response = await h.call("POST", "/compression-inspector/source/orq", {
      ...csrf(),
      trace_id: "trace-id",
    });
    const body = await response.text();
    expect(body).toContain(notice);
    expect(body).not.toContain("private-source-token");
  }
  const logged = warn.mock.calls.flat().join(" ");
  expect(logged).toContain("OrqCLIError");
  expect(logged).not.toContain("private-source-token");
});
