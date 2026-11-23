import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PairwiseRun } from "../../src/lib/pairwise-run.js";
import { keyDiff } from "./python-interop.js";

const goldenPath = join(
  import.meta.dir,
  "fixtures",
  "pairwise-run-python-golden.json",
);
const golden = JSON.parse(await readFile(goldenPath, "utf8"));
const dir = async () =>
  resolve(await mkdtemp(join(tmpdir(), "eq-pairwise-interop-")));

describe("pairwise run interop with Python", () => {
  test("loads a Python-written run", async () => {
    const run = await PairwiseRun.load(goldenPath);
    expect(run.runName).toBe("py pairwise");
    expect(run.labelA).toBe("Old");
    const entry = run.entries[0];
    expect(entry?.comparison.tokenUsage?.cacheCreation1hTokens).toBe(2);
    expect(entry?.comparison.votes[0]?.repetitionFailures).toBe(1);
    expect(entry?.comparison.votes[0]?.observations[0]?.rawOutput).toEqual({
      Raw_Key: 1,
      camelKey: 2,
    });
    expect(entry?.metricsA?.latencyMs).toBe(3);
    expect(Object.keys(run.report?.btSigma?.judgeSigmas ?? {}).sort()).toEqual([
      "judge-two",
      "judge_one",
    ]);
  });

  test("saves Python's snake_case key set", async () => {
    const run = await PairwiseRun.load(goldenPath);
    const path = await run.save(join(await dir(), "run.json"), "bt-sigma");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(keyDiff(golden, written)).toEqual({ onlyPython: [], onlyTs: [] });
    expect(written.report.bt_sigma.judge_sigmas).toHaveProperty("judge_one");
  });

  test("still reads a camelCase run", async () => {
    const run = await PairwiseRun.load(goldenPath);
    const path = join(await dir(), "camel.json");
    await writeFile(path, JSON.stringify(run));
    const again = await PairwiseRun.load(path);
    expect(again.entries).toEqual(run.entries);
    expect(again.report).toEqual(run.report);
  });
});

const savedValues = (
  await import("./fixtures/saved-run-scalars-python-golden.json", {
    with: { type: "json" },
  })
).default;
for (const [index, row] of savedValues.datetimes.entries())
  test(`pairwise accepts pinned datetime shape ${index}`, async () => {
    const path = join(await dir(), "run.json");
    await writeFile(
      path,
      JSON.stringify({ run_name: "time fixture", created_at: row.input }),
    );
    if (row.error) await expect(PairwiseRun.load(path)).rejects.toThrow();
    else
      expect((await PairwiseRun.load(path)).createdAt).toBe(
        row.expected as string,
      );
  });
for (const [index, row] of savedValues.booleans.entries())
  test(`pairwise accepts pinned swap shape ${index}`, () => {
    const load = () =>
      new PairwiseRun({ runName: "swap fixture", swap: row.input });
    if (row.error) expect(load).toThrow();
    else expect(load().swap).toBe(row.expected as boolean);
  });
test("pairwise defaults a missing creation time to now", () => {
  const before = Date.now();
  const run = new PairwiseRun({ runName: "missing time" });
  expect(Date.parse(run.createdAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(run.createdAt)).toBeLessThanOrEqual(Date.now());
});
