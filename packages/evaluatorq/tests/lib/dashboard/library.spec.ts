import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readJsonCached,
  reportId,
  resolve,
  resolveManifest,
  scan,
} from "../../../src/lib/common/dashboard/library.js";
import { startManifest } from "../../../src/lib/common/run-manifest.js";
import { RUN_SUMMARY_VERSION } from "../../../src/lib/contracts.js";

const golden = (await import("./fixtures/library-golden.json")).default as {
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
};

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function runsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eq-library-"));
  dirs.push(dir);
  const rt = join(dir, "runs");
  await mkdir(rt);
  return rt;
}

const write = (path: string, payload: unknown) =>
  writeFile(path, JSON.stringify(payload));

function redteamPayload(): Record<string, unknown> {
  return {
    version: "2.0.0",
    created_at: new Date().toISOString(),
    pipeline: "static",
    categories_tested: ["ASI01"],
    total_results: 0,
    results: [],
    summary: {},
  };
}

const rtSummary = (total: number) => ({
  pipeline: "static",
  totalResults: total,
  totalAttacks: total,
  vulnerabilityRate: 0,
  resistanceRate: 1,
  testedAgents: [],
});

describe("resolve", () => {
  it("round-trips a report id and misses to null", async () => {
    const rt = await runsDir();
    const p = join(rt, "redteam_20260101_000000.json");
    await write(p, redteamPayload());
    expect(await resolve(reportId(p), [rt])).toBe(p);
    expect(await resolve("deadbeef", [rt])).toBeNull();
  });
});

describe("readJsonCached", () => {
  it("reuses the parsed object until the mtime changes", async () => {
    const rt = await runsDir();
    const p = join(rt, "m.json");
    await writeFile(p, '{"a": 1}');
    const first = await readJsonCached(p);
    expect(await readJsonCached(p)).toBe(first);
    await writeFile(p, '{"a": 2}');
    const { mtime } = await stat(p);
    await utimes(p, mtime, new Date(mtime.getTime() + 1000));
    const third = await readJsonCached(p);
    expect(third).not.toBe(first);
    expect(third).toEqual({ a: 2 });
  });
});

describe("scan backfill", () => {
  it("writes a sidecar that serves the card without the report", async () => {
    const rt = await runsDir();
    const report = join(rt, "redteam_20260101_000000.json");
    await write(report, { ...redteamPayload(), total_results: 4 });
    const first = await scan([rt]);
    await stat(join(rt, ".manifests", "redteam_20260101_000000.json"));
    await unlink(report);
    const second = await scan([rt]);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id as string);
    expect(second[0]?.name).toBe(first[0]?.name as string);
    expect(first[0]?.headline).toBe("4 attacks");
    expect(second[0]?.headline).toBe("4 attacks");
    expect(second[0]?.status).toBe("completed");
  });

  it("skips a broken report", async () => {
    const rt = await runsDir();
    const { summary: _, ...payload } = redteamPayload();
    await write(join(rt, "redteam_20260101_000000.json"), payload);
    const cards = await scan([rt]);
    expect(cards[0]?.error).toBeTruthy();
    await expect(stat(join(rt, ".manifests"))).rejects.toThrow();
  });

  it("carries the full writer summary", async () => {
    const rt = await runsDir();
    await write(join(rt, "redteam_20260101_000000.json"), golden.payload);
    await scan([rt]);
    const written = JSON.parse(
      await readFile(
        join(rt, ".manifests", "redteam_20260101_000000.json"),
        "utf8",
      ),
    );
    expect(written.summary).toEqual(golden.summary);
  });

  it("rewrites a thin sidecar in place", async () => {
    const rt = await runsDir();
    const stem = "redteam_20260101_000000";
    const report = join(rt, `${stem}.json`);
    await write(report, {
      ...redteamPayload(),
      total_results: 4,
      summary: {
        total_attacks: 4,
        vulnerability_rate: 0.25,
        resistance_rate: 0.75,
      },
    });
    const w = await startManifest({
      runId: stem,
      surface: "redteam",
      runName: "thin",
      runsDir: rt,
    });
    await w.complete(report, { totalResults: 4 });
    const mpath = join(rt, ".manifests", `${stem}.json`);
    const aged = JSON.parse(await readFile(mpath, "utf8"));
    delete aged.summary_version;
    await writeFile(mpath, JSON.stringify(aged));
    const cards = await scan([rt]);
    expect(cards).toHaveLength(1);
    const written = JSON.parse(await readFile(mpath, "utf8"));
    expect(written.summary.total_attacks).toBe(4);
    expect(written.summary.pipeline).toBe("static");
    expect(written.summary_version).toBe(RUN_SUMMARY_VERSION);
    expect(written.started_at).toBe(aged.started_at);
  });
});

describe("scan manifests", () => {
  it("dedups a covered report against its manifest", async () => {
    const rt = await runsDir();
    const report = join(rt, "covered_20260101_000000.json");
    await write(report, redteamPayload());
    const w = await startManifest({
      runId: "cov",
      surface: "redteam",
      runName: "covered",
      runsDir: rt,
    });
    await w.complete(report, rtSummary(3));
    await write(join(rt, "legacy_20250101_000000.json"), redteamPayload());
    const cards = await scan([rt]);
    expect(cards.map((c) => c.name).sort()).toEqual([
      "covered",
      "legacy_20250101_000000",
    ]);
    expect(cards.find((c) => c.name === "covered")?.status).toBe("completed");
  });

  it("lists an in-flight run and resolves it to its manifest", async () => {
    const rt = await runsDir();
    const w = await startManifest({
      runId: "live",
      surface: "sim",
      runName: "in-flight",
      runsDir: rt,
    });
    await w.startStage("Simulating");
    const cards = await scan([rt]);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.path).toBeNull();
    expect(card?.status).toBe("running");
    expect(card?.stage).toBe("Simulating");
    expect(await resolve(card?.id as string, [rt])).toBeNull();
    const manifest = await resolveManifest(card?.id as string, [rt]);
    expect(manifest?.runName).toBe("in-flight");
  });

  it("lists an errored run with no report", async () => {
    const rt = await runsDir();
    const w = await startManifest({
      runId: "boom",
      surface: "redteam",
      runName: "errored",
      runsDir: rt,
    });
    await w.fail("kaboom");
    const cards = await scan([rt]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.status).toBe("error");
    expect(cards[0]?.path).toBeNull();
  });
});
