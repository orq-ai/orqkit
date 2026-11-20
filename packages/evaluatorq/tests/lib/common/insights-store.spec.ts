import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
      if (process.platform !== "win32")
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      const loaded = await loadRun(path);
      expect(loaded.runId).toBe(run.runId);
      expect(
        (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)
          .runName,
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
