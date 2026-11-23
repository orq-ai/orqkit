import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  insightsRunJson,
  loadRun,
  saveRun,
} from "../../src/lib/insights/store.js";
import { keyDiff } from "./python-interop.js";

const goldenPath = join(
  import.meta.dir,
  "fixtures",
  "insights-run-file-python-golden.json",
);
const goldenText = await readFile(goldenPath, "utf8");
const golden = JSON.parse(goldenText);
const dir = async () =>
  resolve(await mkdtemp(join(tmpdir(), "eq-insights-interop-")));

describe("insights run interop with Python", () => {
  test("loads a Python-written run", async () => {
    const run = await loadRun(goldenPath);
    expect(run.runName).toBe(golden.run_name);
    expect(run.traces.length).toBe(golden.traces.length);
    expect(run.traces[0]?.traceId).toBe(golden.traces[0].trace_id);
  });

  test("saves Python's model_dump_json key set", async () => {
    const path = await saveRun(await loadRun(goldenPath), await dir());
    const text = await readFile(path, "utf8");
    expect(keyDiff(golden, JSON.parse(text))).toEqual({
      onlyPython: [],
      onlyTs: [],
    });
    expect(text).toContain(golden.run_name);
  });

  test("still reads a camelCase run", async () => {
    const run = await loadRun(goldenPath);
    const path = join(await dir(), "camel.json");
    await writeFile(path, JSON.stringify(run));
    expect(await loadRun(path)).toEqual(run);
    expect(insightsRunJson(await loadRun(path))).toBe(insightsRunJson(run));
  });
});
