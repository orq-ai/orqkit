import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportId } from "../../../src/lib/common/dashboard/library.js";
import {
  createDashboardHandler,
  paging,
  serveDashboard,
} from "../../../src/lib/dashboard/app.js";
import { dashboardCssVersion } from "../../../src/lib/dashboard/shell.js";

// Ported from tests/dashboard/test_integration.py. The three /view/breakdown and
// /redteam/attack tests move with the redteam view routes.
process.env.EVALUATORQ_DASHBOARD_SETTINGS = "/nonexistent/settings.json";
let dir: string;
let handle: (req: Request) => Promise<Response>;
const rid = (sub: string, file: string) => reportId(join(dir, sub, file));
const get = (path: string) => handle(new Request(`http://local${path}`));
const post = (path: string, data: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) form.append(k, v);
  return handle(
    new Request(`http://local${path}`, { method: "POST", body: form }),
  );
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eq-app-"));
  cpSync(join(import.meta.dir, "fixtures", "integration"), dir, {
    recursive: true,
  });
  handle = createDashboardHandler({
    roots: ["runs", "sim-runs", "runs_multi"].map((d) => join(dir, d)),
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("kind sniffing routes each report to its renderer", () => {
  it("renders a sim with a stray pipeline key as sim", async () => {
    const r = await get(`/r/${rid("runs", "sim_with_stray_pipeline.json")}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body.toLowerCase()).toContain("<section");
    expect(body).not.toContain("report-broken");
  });
  it("renders a valid red team report as red team", async () => {
    const r = await get(`/r/${rid("runs", "redteam_valid.json")}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body.toLowerCase()).toContain("<section");
    expect(body).not.toContain("report-broken");
  });
});

describe("malformed and partially valid JSON", () => {
  it("skips unparseable files and flags the broken one on the index", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body.toLowerCase()).not.toContain("unparseable");
    expect(body).toContain("card-error");
  });
  it("renders a broken report as an error page, not a 500", async () => {
    const r = await get(`/r/${rid("runs", "redteam_broken_partial.json")}`);
    expect(r.status).not.toBe(500);
    const body = await r.text();
    expect(body).toContain("report-broken");
    expect(body.toLowerCase()).not.toContain("traceback");
  });
});

describe("multi target red team", () => {
  const multi = () => rid("runs_multi", "redteam_multi_agent.json");
  it("renders agent comparison and disagreements", async () => {
    const r = await get(`/r/${multi()}`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("section-agent_comparison");
    expect(body).toContain("section-agent_disagreements");
  });
  it("keeps the agent comparison through the filter POST", async () => {
    for (const data of [{}, { result: "VULNERABLE" }] as Record<
      string,
      string
    >[]) {
      const r = await post(`/r/${multi()}/filter`, data);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("section-agent_comparison");
    }
  });
  it("ships chart elements", async () => {
    for (const id of [multi(), rid("runs", "redteam_valid.json")]) {
      const body = await (await get(`/r/${id}`)).text();
      expect(body.includes("<svg") || body.includes("data-vega-for")).toBe(
        true,
      );
    }
  });
});

describe("filter wiring", () => {
  it("emits the filter-changed trigger and panels include the form", async () => {
    const id = rid("runs", "redteam_valid.json");
    const r = await post(`/r/${id}/filter`);
    expect(r.status).toBe(200);
    expect(r.headers.get("hx-trigger")).toContain("orq:filter-changed");
    expect(await (await get(`/r/${id}`)).text()).toContain(
      'hx-include="#filter-form"',
    );
  });
});

describe("core routes", () => {
  it("caches the stylesheet forever only under its current hash", async () => {
    const current = await get(
      `/static/dashboard.css?v=${dashboardCssVersion()}`,
    );
    expect(current.headers.get("cache-control")).toContain("immutable");
    expect(current.headers.get("content-type")).toContain("text/css");
    const stale = await get("/static/dashboard.css?v=old");
    expect(stale.headers.get("cache-control")).toBe("no-cache");
  });
  it("serves static assets and refuses traversal", async () => {
    expect((await get("/static/dashboard.js")).status).toBe(200);
    expect((await get("/static/..%2Fpackage.json")).status).toBe(404);
    expect((await get("/static/missing.js")).status).toBe(404);
  });
  it("renders the surface screens and search", async () => {
    for (const s of ["sim", "redteam", "pairwise"])
      expect((await get(`/?surface=${s}&page=x&per_page=99`)).status).toBe(200);
    expect((await get("/search?q=valid")).status).toBe(200);
    expect((await get("/r/missing")).status).toBe(404);
  });
  it("parses paging like _paging", () => {
    expect(paging(new URLSearchParams("page=3&per_page=15"))).toEqual([3, 15]);
    expect(paging(new URLSearchParams("page=x&per_page=99"))).toEqual([1, 8]);
    expect(paging(new URLSearchParams(""))).toEqual([1, 8]);
  });
});

it("malformed encoded paths are bad requests", async () => {
  for (const path of ["/static/%E0%A4%A", "/r/%E0%A4%A", "/r/%FF/export"]) {
    expect((await get(path)).status).toBe(400);
  }
});
it("rejects untrusted hosts before routing or returning the readiness nonce", async () => {
  const server = await serveDashboard({
    roots: [],
    host: "127.0.0.1",
    port: 0,
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const request = (host: string, path = "/static/dashboard.css") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          headers: { Host: host },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    for (const host of [
      `evil.example:${address.port}`,
      `evil@localhost:${address.port}`,
      `localhost:${address.port + 1}`,
    ]) {
      for (const path of ["/", "/static/dashboard.css"])
        expect((await request(host, path)).status).toBe(403);
    }
    for (const host of [
      `localhost:${address.port}`,
      `127.0.0.1:${address.port}`,
    ])
      expect((await request(host)).status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("rejects unsafe binds and occupied ports before reporting startup success", async () => {
  await expect(
    serveDashboard({ roots: [], host: "0.0.0.0", port: 0 }),
  ).rejects.toThrow("loopback");
  const server = await serveDashboard({ roots: [], port: 0 });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    await expect(
      serveDashboard({ roots: [], port: address.port }),
    ).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
