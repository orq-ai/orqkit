import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { reportId } from "../../../src/lib/common/dashboard/library.js";
import {
  OVERRIDES_ENV,
  setCliModels,
} from "../../../src/lib/common/model-roles.js";
import {
  DASHBOARD_HELP,
  executeDashboard,
} from "../../../src/lib/dashboard/cli.js";
import type { FinderState } from "../../../src/lib/dashboard/trace-finder/routes.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  setCliModels();
});

async function tmp(): Promise<string> {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-dash-cli-")));
  dirs.push(dir);
  return dir;
}

const finder = {} as FinderState;
type ServeArgs = [string[] | null, Record<string, unknown>];
function harness() {
  const serve = mock(async (..._args: ServeArgs) => ({}) as never);
  const printed: string[] = [];
  return {
    serve,
    printed,
    io: {
      print: (m: string) => printed.push(m),
      serve: serve as never,
      createFinder: async () => finder,
    },
  };
}

describe("eq dashboard", () => {
  it("help names all three stores", () => {
    for (const store of [
      ".evaluatorq/runs/",
      ".evaluatorq/sim-runs/",
      ".evaluatorq/pairwise-runs/",
    ]) {
      expect(DASHBOARD_HELP).toContain(store);
    }
  });

  for (const [noBrowser, expected] of [
    [undefined, true],
    [true, false],
  ] as const) {
    it(`passes openBrowser=${expected} to the launcher`, async () => {
      const h = harness();
      expect(await executeDashboard({ noBrowser }, h.io)).toBe(0);
      const [roots, opts] = h.serve.mock.calls[0] as ServeArgs;
      expect(roots).toBeNull();
      expect(opts.openBrowser).toBe(expected);
      expect(opts.finder).toBe(finder);
    });
  }

  it("passes the port through", async () => {
    const h = harness();
    await executeDashboard({ port: 8125, noBrowser: true }, h.io);
    expect((h.serve.mock.calls[0] as ServeArgs)[1].port).toBe(8125);
  });

  it("merges multiple directories into one roots list", async () => {
    const base = await tmp();
    const a = join(base, "repo-a");
    const b = join(base, "repo-b");
    await mkdir(a);
    await mkdir(b);
    const h = harness();
    await executeDashboard({ paths: [a, b] }, h.io);
    const roots = (h.serve.mock.calls[0] as ServeArgs)[0] as string[];
    for (const p of [
      a,
      b,
      join(a, ".evaluatorq", "runs"),
      join(b, ".evaluatorq", "sim-runs"),
      join(a, "pairwise-runs"),
      join(b, ".evaluatorq", "pairwise-runs"),
    ]) {
      expect(roots).toContain(p);
    }
  });

  it("rejects a nonexistent path without serving", async () => {
    const h = harness();
    await expect(
      executeDashboard({ paths: [join(await tmp(), "no-such-dir")] }, h.io),
    ).rejects.toThrow("does not exist");
    expect(h.serve).not.toHaveBeenCalled();
  });

  it("prints the direct report URL for a file path", async () => {
    const dir = await tmp();
    const file = join(dir, "redteam_20260101_000000.json");
    await writeFile(file, "{}");
    const h = harness();
    await executeDashboard({ paths: [file], port: 9000 }, h.io);
    expect(h.printed).toEqual([
      `Direct report URL: http://127.0.0.1:9000/r/${reportId(file)}`,
    ]);
    expect((h.serve.mock.calls[0] as ServeArgs)[0]).toEqual([dir]);
  });

  it("exports finder flags and model overrides", async () => {
    const h = harness();
    await executeDashboard(
      {
        windowDays: 7,
        limit: 50,
        parallelism: 4,
        compilerModel: "openai/x",
        classifierModel: "openai/y",
      },
      h.io,
    );
    expect(process.env.EVALUATORQ_FINDER_WINDOW_DAYS).toBe("7");
    expect(process.env.EVALUATORQ_FINDER_LIMIT).toBe("50");
    expect(process.env.EVALUATORQ_FINDER_PARALLELISM).toBe("4");
    expect(JSON.parse(process.env[OVERRIDES_ENV] as string)).toEqual({
      roles: { classifier: "openai/y" },
      overrides: { "finder.compiler": "openai/x" },
    });
  });

  it("rejects out-of-range finder flags", async () => {
    const h = harness();
    await expect(executeDashboard({ windowDays: 91 }, h.io)).rejects.toThrow(
      "--window-days",
    );
    await expect(executeDashboard({ limit: 0 }, h.io)).rejects.toThrow(
      "--limit",
    );
    expect(h.serve).not.toHaveBeenCalled();
  });
});
