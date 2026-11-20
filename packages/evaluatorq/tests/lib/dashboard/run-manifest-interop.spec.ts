import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  listManifests,
  manifestJson,
  startManifest,
} from "../../../src/lib/common/run-manifest.js";
import { RunManifestSchema } from "../../../src/lib/contracts.js";

const golden = readFileSync(
  join(import.meta.dir, "fixtures", "run-manifest-golden.json"),
  "utf8",
);
const goldenKeys = (value: unknown): string[] =>
  Object.keys(value as Record<string, unknown>);

describe("run manifest sidecar interop with Python", () => {
  test("parses a Python-written sidecar", () => {
    const manifest = RunManifestSchema.parse(JSON.parse(golden));
    expect(manifest.runId).toBe("py-golden");
    expect(manifest.runName).toBe("golden run \u00e9");
    expect(manifest.stages[0]?.startedAt.toISOString()).toBe(
      "2026-11-17T10:04:01.250Z",
    );
    expect(manifest.stageLabels).toEqual({
      Attacking: "Attack",
      my_key: "Kept",
    });
    expect(manifest.summary?.vulnerabilityRate).toBe(0.25);
    expect(manifest.summary?.scorerAverages).toEqual({ a_b: 0.5 });
    expect(manifest.summaryVersion).toBe(1);
  });

  test("writes back byte-identical to Python's model_dump_json", () => {
    expect(manifestJson(RunManifestSchema.parse(JSON.parse(golden)))).toBe(
      golden,
    );
  });

  test("still reads a camelCase sidecar", () => {
    const camel = RunManifestSchema.parse(JSON.parse(golden));
    expect(RunManifestSchema.parse(JSON.parse(JSON.stringify(camel)))).toEqual(
      camel,
    );
  });

  test("a TS-written sidecar uses Python's field set", async () => {
    const runsDir = resolve(
      await mkdtemp(join(process.env.TMPDIR ?? ".", "mi-")),
    );
    const writer = await startManifest({
      runId: "ts-run",
      surface: "sim",
      runName: "from-ts",
      runsDir,
    });
    await writer.startStage("Simulating");
    const written = JSON.parse(await readFile(writer.path, "utf8"));
    const expected = JSON.parse(golden);
    expect(goldenKeys(written)).toEqual(goldenKeys(expected));
    expect(goldenKeys(written.stages[0])).toEqual(
      goldenKeys(expected.stages[0]),
    );
    expect(written.started_at).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?Z$/,
    );
    expect((await listManifests(runsDir))[0]?.runId).toBe("ts-run");
  });
});
