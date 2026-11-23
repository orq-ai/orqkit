import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { manifestJson } from "../../src/lib/common/run-manifest.js";
import { RunManifestSchema } from "../../src/lib/contracts.js";
import { SimulationRun } from "../../src/lib/integrations/simulation/run-store.js";
import { PairwiseRun } from "../../src/lib/pairwise-run.js";
import { RedTeamReport } from "../../src/lib/redteam/reports/models.js";
import { autoSaveRedteamRun } from "../../src/lib/redteam/run-store.js";

// Opt-in: EVALUATORQ_PYTHON is a Python with the evaluatorq package installed.
const python = process.env.EVALUATORQ_PYTHON;
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

const LOADER = `
import importlib, json, sys
for spec, path in json.loads(sys.argv[1]):
    module, name = spec.rsplit(".", 1)
    model = getattr(importlib.import_module(module), name)
    with open(path, encoding="utf-8") as f:
        model.model_validate_json(f.read())
    print("ok", name)
`;

describe.skipIf(!python)("Python loads TS-written files", () => {
  test("redteam, simulation, pairwise and manifest files validate", async () => {
    const directory = resolve(await mkdtemp(join(tmpdir(), "eq-py-load-")));
    const redteam = await autoSaveRedteamRun(
      new RedTeamReport(
        JSON.parse(
          await readFile(fixture("redteam-run-python-golden.json"), "utf8"),
        ),
      ),
      { name: "ts run", runsDir: directory },
    );
    const simulation = join(directory, "sim.json");
    await (
      await SimulationRun.load(
        fixture("simulation-run-file-python-golden.json"),
      )
    ).save(simulation);
    const pairwise = await (
      await PairwiseRun.load(fixture("pairwise-run-python-golden.json"))
    ).save(join(directory, "pairwise.json"), "bt-sigma");
    const manifest = join(directory, "manifest.json");
    await writeFile(
      manifest,
      manifestJson(
        RunManifestSchema.parse(
          JSON.parse(
            await readFile(
              join(
                import.meta.dir,
                "dashboard",
                "fixtures",
                "run-manifest-golden.json",
              ),
              "utf8",
            ),
          ),
        ),
      ),
    );
    const pairs = [
      ["evaluatorq.redteam.contracts.RedTeamReport", redteam],
      ["evaluatorq.simulation.contracts.SimulationRun", simulation],
      ["evaluatorq.pairwise_run.PairwiseRun", pairwise],
      ["evaluatorq.contracts.RunManifest", manifest],
    ];
    const result = spawnSync(
      python as string,
      ["-c", LOADER, JSON.stringify(pairs)],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(pairs.length);
  }, 30_000);
});
