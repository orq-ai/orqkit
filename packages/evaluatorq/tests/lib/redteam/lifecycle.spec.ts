import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composeRunHooks } from "../../../src/lib/common/hook-compose.js";
import { startManifest } from "../../../src/lib/common/run-manifest.js";
import {
  CompositePipelineHooks,
  DefaultHooks,
  loadRedteamReplay,
  ManifestStageHooks,
  PIPELINE_HOOK_METHODS,
  type PipelineHooks,
  PipelineStage,
  RedTeamReport,
  ReplayError,
} from "../../../src/lib/redteam/index.js";
import goldenReplay from "../fixtures/redteam-replay-python-goldens.json" with {
  type: "json",
};
import goldenReports from "../fixtures/redteam-report-python-goldens.json" with {
  type: "json",
};

let warnings: ReturnType<typeof spyOn<typeof console, "warn">>,
  info: ReturnType<typeof spyOn<typeof console, "info">>,
  errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  info = spyOn(console, "info").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnings.mockRestore();
  info.mockRestore();
  errors.mockRestore();
});
function hooks(overrides: Partial<PipelineHooks> = {}): PipelineHooks {
  return {
    onStageStart: async () => {},
    onStageEnd: async () => {},
    onConfirm: async () => true,
    onComplete: async () => {},
    ...overrides,
  };
}
for (const fixture of goldenReplay.cases)
  it(`matches pinned saved replay ${fixture.label}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "res1863-replay-")),
      path = join(directory, "res1863-replay-fixture.json");
    try {
      await writeFile(path, JSON.stringify(fixture.payload));
      if ("error" in fixture)
        await expect(loadRedteamReplay(path, directory)).rejects.toBeInstanceOf(
          ReplayError,
        );
      else {
        const actual = await loadRedteamReplay(path, directory),
          { path: actualPath, ...rest } = actual;
        expect(actualPath).toBe(path);
        expect(rest as unknown).toEqual(fixture.expected);
        expect(Object.isFrozen(actual)).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });
it("reads native camelCase saved replay settings and hybrid source tags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "res1863-replay-")),
    path = join(directory, "run.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        replayVersion: 1,
        runName: "native",
        pipeline: "dynamic",
        datapoints: [
          {
            id: "static",
            category: "ASI01",
            hybridSource: "static",
            messages: [{ role: "user", content: "attack" }],
          },
          {
            id: "dynamic",
            category: "ASI02",
            hybridSource: "dynamic",
            strategy: {},
          },
        ],
        runConfig: {
          maxTurns: 9,
          attackerInstructions: "Synthetic",
          maxBacktracks: 1,
        },
      }),
    );
    const replay = await loadRedteamReplay(path, directory);
    expect(replay.pipeline).toBe("hybrid");
    expect(replay.runName).toBe("native");
    expect(replay.maxTurns).toBe(9);
    expect(replay.maxBacktracks).toBe(1);
    expect(replay.attackerInstructions).toBe("Synthetic");
  } finally {
    await rm(directory, { recursive: true });
  }
});
it("runs later hooks after an earlier exception and preserves the first failure", async () => {
  const calls: string[] = [],
    failure = new Error("first");
  const composite = new CompositePipelineHooks([
    hooks({
      onStageStart: async () => {
        calls.push("first");
        throw failure;
      },
    }),
    hooks({
      onStageStart: async () => {
        calls.push("later");
        throw new Error("later");
      },
    }),
  ]);
  await expect(
    composite.onStageStart(PipelineStage.ATTACK_EXECUTION, {}),
  ).rejects.toBe(failure);
  expect(calls).toEqual(["first", "later"]);
});
it("combines every confirmation and never skips later veto/approval callbacks", async () => {
  const calls: number[] = [],
    composite = new CompositePipelineHooks([
      hooks({
        onConfirm: async () => {
          calls.push(1);
          return false;
        },
      }),
      hooks({
        onConfirm: async () => {
          calls.push(2);
          return true;
        },
      }),
    ]);
  expect(await composite.onConfirm({ numDatapoints: 2 })).toBe(false);
  expect(calls).toEqual([1, 2]);
});
it("persists a stage before a user hook throws, without duplicating default logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "res1863-hook-manifest-"));
  try {
    const writer = await startManifest({
      runId: "run",
      surface: "redteam",
      runName: "synthetic",
      runsDir: directory,
    });
    const composite = new CompositePipelineHooks([
      new ManifestStageHooks(writer),
      hooks({
        onStageStart: async () => {
          const saved = JSON.parse(await readFile(writer.path, "utf8"));
          expect(saved.stages[0].name).toBe("attack_execution");
          expect(saved.stages[0].target).toBe("target");
          throw new Error("user hook failed");
        },
      }),
    ]);
    await expect(
      composite.onStageStart(PipelineStage.ATTACK_EXECUTION, {
        target: "target",
      }),
    ).rejects.toThrow("user hook failed");
    await composite.onStageEnd(PipelineStage.ATTACK_EXECUTION, {
      target: "target",
      error: "user hook failed",
    });
    const saved = JSON.parse(await readFile(writer.path, "utf8"));
    expect(saved.stages[0].status).toBe("error");
    expect(info).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true });
  }
});
it("validates hooks before minting a manifest", () => {
  let minted = false;
  expect(() =>
    composeRunHooks(
      {},
      {
        methodNames: PIPELINE_HOOK_METHODS,
        composite: (children) => children,
        defaultHooks: () => new DefaultHooks(),
        manifest: () => {
          minted = true;
          return {};
        },
        manifestHook: (writer) => writer,
      },
    ),
  ).toThrow("lifecycle methods");
  expect(minted).toBe(false);
});
it("reports no-verdict runs explicitly and quotes a dashboard path", async () => {
  const report = new RedTeamReport({
    ...goldenReports.merge.expected,
    results: [],
    totalResults: 0,
    summary: { totalAttacks: 2, evaluatedAttacks: 0 },
    pipelineWarnings: ["Synthetic warning"],
  });
  const defaults = new DefaultHooks();
  expect(
    await defaults.onConfirm({ categories: ["ASI01"], numDatapoints: 2 }),
  ).toBe(true);
  await defaults.onComplete(report, { outputDir: "a'b folder" });
  expect(errors.mock.calls[0]?.[0]).toContain("NO VERDICT");
  expect(warnings.mock.calls[0]?.[0]).toContain("Synthetic warning");
  expect(info.mock.calls.at(-1)?.[0]).toContain("'a'\"'\"'b folder'");
});
