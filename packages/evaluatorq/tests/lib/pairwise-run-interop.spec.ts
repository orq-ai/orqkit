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
