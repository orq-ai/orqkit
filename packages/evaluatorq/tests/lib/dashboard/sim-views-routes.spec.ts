import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { reportId } from "../../../src/lib/common/dashboard/library.js";
import { createDashboardHandler } from "../../../src/lib/dashboard/app.js";

const golden = (await import("./fixtures/sim-views-golden.json")).default as {
  run: unknown;
  cases: { q: string; status: number; html: string }[];
};

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const dir = resolve(await mkdtemp(join(tmpdir(), "eq-sim-views-")));
dirs.push(dir);
const path = join(dir, "sim_20261117_090130.json");
await writeFile(path, JSON.stringify(golden.run));
const rid = reportId(path);
const handle = createDashboardHandler({ roots: [dir] });

describe("sim view routes match Python", () => {
  for (const c of golden.cases) {
    it(c.q, async () => {
      const url = c.q.startsWith("missing-")
        ? `/r/deadbeef/sim/${c.q.slice("missing-".length).replace("rowlist", "row-list")}`
        : `/r/${rid}${c.q}`;
      const response = await handle(new Request(`http://127.0.0.1${url}`));
      expect(response.status).toBe(c.status);
      expect((await response.text()).replaceAll(rid, "RID")).toBe(c.html);
    });
  }
});
