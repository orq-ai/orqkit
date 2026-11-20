import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { toPythonKeys } from "../../../src/lib/common/python-json.js";
import { vlAvailable } from "../../../src/lib/common/reports/vega.js";
import { InsightsRunSchema } from "../../../src/lib/insights/models.js";
import {
  insightsRunSlug,
  listRunPaths,
  listRuns,
  loadRun,
  saveRun,
} from "../../../src/lib/insights/store.js";

test("run saves are complete and collision-safe, with corrupt files retained in listings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insights-store-"));
  try {
    const gold = JSON.parse(
      await readFile(
        new URL(
          "../fixtures/insights-run-python-goldens.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { runs: { input: unknown; valid: boolean }[] };
    const input = gold.runs.find((item) => item.valid)?.input;
    const run = InsightsRunSchema.parse(input);
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => saveRun(run, directory)),
    );
    expect(new Set(paths).size).toBe(8);
    for (const path of paths) {
      const loaded = await loadRun(path);
      expect(loaded.runId).toBe(run.runId);
      expect(
        (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)
          .run_name,
      ).toBe(run.runName);
    }
    expect(await listRunPaths(directory)).toHaveLength(8);
    const corrupt = join(directory, "insights_corrupt.json");
    await writeFile(corrupt, "{");
    const listing = await listRuns(directory);
    expect(listing).toHaveLength(9);
    expect(typeof listing.find(([path]) => path === corrupt)?.[1]).toBe(
      "string",
    );
    expect(paths.every((path) => basename(path).startsWith("insights_"))).toBe(
      true,
    );
    expect(insightsRunSlug(" !!! ")).toBe("insights");
    expect(insightsRunSlug("Test Topic")).toBe("test-topic");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chart loading cannot change saved Set fields into strings", async () => {
  expect(await vlAvailable()).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "insights-chart-save-"));
  try {
    const base = await loadRun(
      new URL(
        "../fixtures/insights-run-file-python-golden.json",
        import.meta.url,
      ).pathname,
    );
    const run = InsightsRunSchema.parse({
      ...base,
      config: { ...base.config, signals: { emptyValues: new Set(["", "[]"]) } },
    });
    const path = await saveRun(run, root);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.config.signals.empty_values).toEqual(["", "[]"]);
    expect((await loadRun(path)).config.signals?.emptyValues).toEqual(
      new Set(["", "[]"]),
    );
    expect(toPythonKeys(new Set(["a"]), "SignalsConfig")).toEqual(["a"]);
    expect(toPythonKeys({ nested: [new Set(["b"])] }, "SignalsConfig")).toEqual(
      { nested: [["b"]] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
