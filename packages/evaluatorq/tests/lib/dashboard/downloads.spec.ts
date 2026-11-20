import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportId } from "../../../src/lib/common/dashboard/library.js";
import { createDashboardHandler } from "../../../src/lib/dashboard/app.js";
import golden from "./fixtures/downloads/golden.json" with { type: "json" };

// Ported from tests/dashboard/test_downloads.py; fixtures and golden bodies come from the Python app.
const FIXTURES = join(import.meta.dir, "fixtures", "downloads");
let dir: string;
let rt: string;
let sim: string;
let handle: (req: Request) => Promise<Response>;
const get = (path: string) => handle(new Request(`http://local${path}`));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eq-downloads-"));
  mkdirSync(join(dir, "runs"));
  mkdirSync(join(dir, "sim-runs"));
  copyFileSync(join(FIXTURES, "rt.json"), join(dir, "runs", "rt_dl_test.json"));
  copyFileSync(
    join(FIXTURES, "sim.json"),
    join(dir, "sim-runs", "sim_dl_test.json"),
  );
  rt = reportId(join(dir, "runs", "rt_dl_test.json"));
  sim = reportId(join(dir, "sim-runs", "sim_dl_test.json"));
  handle = createDashboardHandler({
    roots: [join(dir, "runs"), join(dir, "sim-runs")],
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim());

describe("export.html", () => {
  it("serves the red team report as an attachment", async () => {
    const r = await get(`/r/${rt}/export.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect((await r.text()).length).toBeGreaterThan(0);
  });
  it("serves the sim report", async () => {
    expect((await get(`/r/${sim}/export.html`)).status).toBe(200);
  });
  it("404s a missing report", async () => {
    expect((await get("/r/nonexistent123/export.html")).status).toBe(404);
  });
});

describe("export.md", () => {
  for (const [label, rid] of [
    ["red team", () => rt],
    ["sim", () => sim],
  ] as const)
    it(`serves the ${label} markdown as an attachment`, async () => {
      const r = await get(`/r/${rid()}/export.md`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/markdown");
      expect(r.headers.get("content-disposition")).toContain("attachment");
      expect((await r.text()).length).toBeGreaterThan(0);
    });
  it("404s a missing report", async () => {
    expect((await get("/r/nonexistent123/export.md")).status).toBe(404);
  });
});

describe("export.csv", () => {
  it("matches the Python body byte for byte", async () => {
    const r = await get(`/r/${rt}/export.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const body = await r.text();
    expect(body).toBe(golden.rt_csv);
    expect(lines(body)[0]).toContain("ID");
    expect(lines(body)).toHaveLength(5);
  });
  it("honours the filter query", async () => {
    const body = await (await get(`/r/${rt}/export.csv?category=ASI01`)).text();
    expect(body).toBe(golden.rt_csv_asi);
    expect(lines(body).length).toBeLessThan(5);
  });
  it("has no CSV for sim and 404s a missing report", async () => {
    expect((await get(`/r/${sim}/export.csv`)).status).toBe(404);
    expect((await get("/r/nonexistent123/export.csv")).status).toBe(404);
  });
});

describe("export.json", () => {
  it("matches the Python bodies (sim floats like 1.0 compare as values)", async () => {
    for (const [path, key] of [
      [`/r/${rt}/export.json`, "rt_json"],
      [`/r/${sim}/export.json`, "sim_json"],
    ] as const) {
      const r = await get(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(r.headers.get("content-disposition")).toContain("attachment");
      const body = await r.text();
      if (key === "rt_json") expect(body).toBe(golden[key]);
      else expect(JSON.parse(body)).toEqual(JSON.parse(golden[key]));
    }
    expect(JSON.parse(golden.rt_json)).toHaveLength(4);
    expect(JSON.parse(golden.sim_json)).toHaveLength(2);
  });
  it("honours the filter query", async () => {
    expect(
      JSON.parse(
        await (await get(`/r/${sim}/export.json?persona=alice`)).text(),
      ),
    ).toEqual(JSON.parse(golden.sim_json_alice));
    const rtRows = JSON.parse(
      await (await get(`/r/${rt}/export.json?category=ASI01`)).text(),
    );
    expect(rtRows.length).toBeLessThan(4);
  });
  it("404s a missing report", async () => {
    expect((await get("/r/nonexistent123/export.json")).status).toBe(404);
  });
});
