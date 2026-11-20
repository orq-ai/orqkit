import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  fromPythonKeys,
  pythonJsonDumps,
} from "../../src/lib/common/python-json.js";
import { loadRedteamReplay } from "../../src/lib/redteam/replay.js";
import { RedTeamReport } from "../../src/lib/redteam/reports/models.js";
import {
  autoSaveRedteamRun,
  saveRedteamStage,
} from "../../src/lib/redteam/run-store.js";
import { keyDiff } from "./python-interop.js";

const goldenPath = join(
  import.meta.dir,
  "fixtures",
  "redteam-run-python-golden.json",
);
const golden = JSON.parse(await readFile(goldenPath, "utf8"));
const dir = async () =>
  resolve(await mkdtemp(join(tmpdir(), "eq-redteam-interop-")));
const tsDatapoints = () =>
  golden.datapoints.map((row: Record<string, unknown>) => ({
    id: row.id,
    category: row.category,
    strategy: fromPythonKeys(row.strategy, "AttackStrategy"),
    objective: row.objective,
    hybridSource: row.hybrid_source,
    deliveryMethod: row.delivery_method,
  }));
const runConfig = {
  maxTurns: 7,
  attackerInstructions: "steer",
  maxBacktracks: 2,
};

describe("red team run interop with Python", () => {
  test("loads a Python-written run", async () => {
    const directory = await dir();
    await copyFile(goldenPath, join(directory, "py-run.json"));
    const replay = await loadRedteamReplay("py-run.json", directory);
    expect(replay.runName).toBe("py-run");
    expect(replay.maxTurns).toBe(7);
    expect(replay.attackerInstructions).toBe("steer");
    expect(replay.maxBacktracks).toBe(2);
    const report = new RedTeamReport(golden);
    expect(report.results.length).toBe(golden.results.length);
  });

  test("saves Python's snake_case key set", async () => {
    const directory = await dir();
    const path = await autoSaveRedteamRun(new RedTeamReport(golden), {
      name: "py run",
      datapoints: tsDatapoints(),
      runConfig,
      runsDir: directory,
    });
    const written = JSON.parse(await readFile(path as string, "utf8"));
    expect(keyDiff(golden, written)).toEqual({ onlyPython: [], onlyTs: [] });
    expect(written.datapoints).toEqual(golden.datapoints);
    expect(written.run_config).toEqual(golden.run_config);
    const replay = await loadRedteamReplay(path as string, directory);
    expect(replay.maxBacktracks).toBe(2);
    expect(replay.datapoints[0]?.inputs.hybrid_source).toBe("dynamic");
  });

  test("writes snake_case stage envelopes", async () => {
    const directory = await dir();
    await saveRedteamStage(directory, "02_attack_results.json", [
      {
        dataPoint: { inputs: { hybridSource: "static" }, expectedOutput: null },
        jobResults: [{ jobName: "j", output: null, evaluatorScores: [] }],
      },
    ]);
    const stage = JSON.parse(
      await readFile(join(directory, "02_attack_results.json"), "utf8"),
    );
    expect(Object.keys(stage)).toEqual(["saved_at", "data"]);
    expect(stage.data[0].dataPoint.inputs).toEqual({ hybrid_source: "static" });
    expect(stage.data[0].jobResults[0]).toHaveProperty("evaluatorScores");
    expect(stage.saved_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+\.\d{6}\+00:00$/);
  });

  test("writes the datapoints stage in Python's datapoint shape", async () => {
    const directory = await dir();
    await saveRedteamStage(directory, "01_datapoints.json", tsDatapoints());
    const stage = JSON.parse(
      await readFile(join(directory, "01_datapoints.json"), "utf8"),
    );
    expect(stage.data[0]).toEqual(golden.datapoints[0]);
  });

  test("matches json.dumps on DEL, astral characters and small floats", () => {
    expect(
      pythonJsonDumps({
        a: "\u007f \u00e9 \u{1f600}",
        skipped: undefined,
        n: 1e-5,
      }),
    ).toBe('{\n  "a": "\\u007f \\u00e9 \\ud83d\\ude00",\n  "n": 1e-05\n}');
  });

  test("escapes non-ASCII like Python's json.dumps", async () => {
    const directory = await dir();
    await saveRedteamStage(directory, "02_attack_results.json", [
      { prompt: "café" },
    ]);
    const raw = await readFile(
      join(directory, "02_attack_results.json"),
      "utf8",
    );
    expect(raw).toContain("caf\\u00e9");
  });
});
