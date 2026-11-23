import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SimulationRun } from "../../src/lib/integrations/simulation/run-store.js";
import { keyDiff } from "./python-interop.js";

const goldenPath = join(
  import.meta.dir,
  "fixtures",
  "simulation-run-file-python-golden.json",
);
const golden = JSON.parse(await readFile(goldenPath, "utf8"));
const dir = async () =>
  resolve(await mkdtemp(join(tmpdir(), "eq-sim-interop-")));
const at = (value: unknown, path: string): unknown[] => {
  const [head, ...rest] = path.split("/").filter(Boolean);
  if (head === undefined) return [value];
  const many = head.endsWith("[]"),
    key = many ? head.slice(0, -2) : head;
  const child = (value as Record<string, unknown>)[key];
  return many
    ? (child as unknown[]).flatMap((item) => at(item, rest.join("/")))
    : at(child, rest.join("/"));
};

describe("simulation run interop with Python", () => {
  test("loads a Python-written run", async () => {
    const run = await SimulationRun.load(goldenPath);
    expect(run.runName).toBe(golden.run_name);
    expect(run.agentInfo?.knowledgeBases).toEqual(["kb"]);
    expect(run.results.length).toBe(golden.results.length);
  });

  test("saves Python's model_dump_json key set", async () => {
    const path = join(await dir(), "run.json");
    await (await SimulationRun.load(goldenPath)).save(path);
    const written = JSON.parse(await readFile(path, "utf8"));
    const diff = keyDiff(golden, written);
    expect(diff.onlyTs).toEqual([]);
    for (const missing of diff.onlyPython)
      expect(at(golden, missing).every((value) => value === null)).toBe(true);
    expect(written.agent_info).toEqual(golden.agent_info);
  });

  test("still reads a camelCase run", async () => {
    const run = await SimulationRun.load(goldenPath);
    const path = join(await dir(), "camel.json");
    await writeFile(path, JSON.stringify(run));
    expect((await SimulationRun.load(path)).toJSON()).toEqual(run.toJSON());
  });
});
