import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OpenAI from "openai";

import { listManifests } from "../../../src/lib/common/run-manifest.js";
import {
  currentThreadId,
  pipelineMetadata,
} from "../../../src/lib/common/thread-context.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  type Message,
  parseUsage,
} from "../../../src/lib/contracts.js";
import * as classifier from "../../../src/lib/redteam/adaptive/capability-classifier.js";
import * as pipeline from "../../../src/lib/redteam/adaptive/pipeline.js";
import { LLMConfig } from "../../../src/lib/redteam/config.js";
import { CancelledError } from "../../../src/lib/redteam/exceptions.js";
import type { PipelineHooks } from "../../../src/lib/redteam/hooks.js";
import { loadRedteamReplay } from "../../../src/lib/redteam/replay.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import { redTeam } from "../../../src/lib/redteam/runner.js";
import * as support from "../../../src/lib/redteam/runner-support.js";
import goldens from "../fixtures/pipeline-python-goldens.json" with {
  type: "json",
};
import staticGoldens from "../fixtures/static-python-goldens.json" with {
  type: "json",
};

let directory: string;
let env: Record<string, string | undefined>;
let info: ReturnType<typeof spyOn<typeof console, "info">>,
  warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  debug: ReturnType<typeof spyOn<typeof console, "debug">>,
  errorLog: ReturnType<typeof spyOn<typeof console, "error">>;
let scorer: ReturnType<typeof spyOn<typeof support, "buildRedteamEvaluator">>;
const clones: Target[] = [],
  cleanups: { name: string; ids: string[] }[] = [];
class Target extends AgentTarget {
  calls: Message[][] = [];
  threads: (string | null)[] = [];
  closed = false;
  model = "target-model";
  constructor(
    readonly name: string,
    readonly fail = false,
  ) {
    super();
  }
  override async respond(messages: Message[]) {
    this.calls.push(structuredClone(messages));
    this.threads.push(currentThreadId());
    expect(pipelineMetadata().evaluatorq_pipeline).toBe("red_teaming");
    if (this.fail) throw new TypeError("target programming error");
    return new AgentResponse({
      text: "mango",
      usage: parseUsage({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        calls: 1,
      }),
    });
  }
  override async getAgentContext() {
    return AgentContextSchema.parse({
      key: this.name,
      model: this.model,
      memoryStores: [{ id: "store", key: "store" }],
    });
  }
  override newInstance() {
    const clone = new Target(this.name, this.fail);
    clone.mintMemoryEntityId(`memory-${clones.length}`);
    clones.push(clone);
    return clone;
  }
  override async cleanupMemory(_context: AgentContext, ids: string[]) {
    cleanups.push({ name: this.name, ids: [...ids] });
  }
  async close() {
    this.closed = true;
  }
}
function hooks(overrides: Partial<PipelineHooks> = {}): PipelineHooks {
  return {
    onStageStart: async () => {},
    onStageEnd: async () => {},
    onConfirm: async () => true,
    onComplete: async () => {},
    ...overrides,
  };
}
const baseOptions = {
  llmClient: {} as OpenAI,
  recommendations: false,
  generateExecutiveSummary: false,
  datapointParallelism: 1,
  save: "none" as const,
};
const dynamicInput = goldens.jobs[0]?.inputs as Record<string, unknown>;
async function replayFile(
  pipeline: string,
  datapoints: Record<string, unknown>[],
) {
  const path = join(directory, `replay-${pipeline}.json`);
  await writeFile(
    path,
    JSON.stringify({
      pipeline,
      datapoints,
      runConfig: {
        maxTurns: 3,
        maxBacktracks: 0,
        attackerInstructions: "saved steering",
      },
      runName: "prior",
    }),
  );
  return path;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eq-redteam-runner-"));
  env = {};
  for (const key of ["ORQ_DISABLE_TRACING", "ORQ_API_KEY", "EVALUATORQ_DIR"])
    env[key] = process.env[key];
  process.env.ORQ_DISABLE_TRACING = "1";
  delete process.env.ORQ_API_KEY;
  process.env.EVALUATORQ_DIR = directory;
  info = spyOn(console, "info").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
  debug = spyOn(console, "debug").mockImplementation(() => {});
  errorLog = spyOn(console, "error").mockImplementation(() => {});
  clones.length = 0;
  cleanups.length = 0;
  scorer = spyOn(support, "buildRedteamEvaluator").mockReturnValue({
    name: "synthetic-judge",
    evaluatorType: "llm_eval",
    scorer: async () => ({
      value: true,
      pass: true,
      explanation: "resistant",
      tokenUsage: parseUsage({
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        calls: 1,
      }),
    }),
  });
});
afterEach(async () => {
  scorer.mockRestore();
  info.mockRestore();
  warn.mockRestore();
  debug.mockRestore();
  errorLog.mockRestore();
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  await rm(directory, { recursive: true, force: true });
});
it("runs every shared replay case against same-object targets with unique jobs and threads", async () => {
  const file = await replayFile("dynamic", [
    dynamicInput,
    { ...dynamicInput, id: "second" },
  ]);
  const target = new Target("same/name");
  const classified = spyOn(classifier, "classifyAgentCapabilities"),
    generated = spyOn(pipeline, "generateDynamicDatapointsForVulnerabilities");
  let confirmed = 0;
  try {
    const report = await redTeam([target, target, new Target("same-name")], {
      ...baseOptions,
      previousRun: file,
      save: "detail",
      artifactsDir: join(directory, "artifacts"),
      hooks: hooks({
        onConfirm: async (plan) => {
          confirmed++;
          expect(plan.numDatapoints).toBe(2);
          expect(Object.keys(plan.agentContexts ?? {})).toHaveLength(3);
          expect(plan.maxTurns).toBe(3);
          expect(plan.replayOf).toBe("replay-dynamic.json");
          return true;
        },
      }),
    });
    expect(confirmed).toBe(1);
    expect(report.results).toHaveLength(6);
    expect([...new Set(report.results.map((row) => row.agent.key))]).toEqual([
      "same/name",
      "same/name-1",
      "same-name",
    ]);
    expect(report.summary.totalAttacks).toBe(6);
    expect(report.summary.evaluatedAttacks).toBe(6);
    expect(clones).toHaveLength(6);
    expect(clones.every((target) => target.closed)).toBe(true);
    expect(new Set(clones.flatMap((target) => target.threads)).size).toBe(6);
    expect(cleanups).toHaveLength(3);
    expect(cleanups.flatMap((item) => item.ids)).toHaveLength(6);
    expect(classified).not.toHaveBeenCalled();
    expect(generated).not.toHaveBeenCalled();
    const manifests = await listManifests(join(directory, "runs"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.status).toBe("completed");
    expect(
      manifests[0]?.stages.some((stage) => stage.name === "attack_execution"),
    ).toBe(true);
    const saved = await loadRedteamReplay(
      manifests[0]?.reportPath as string,
      join(directory, "runs"),
    );
    expect(saved.datapoints.map((row) => row.inputs)).toEqual([
      dynamicInput,
      { ...dynamicInput, id: "second" },
    ]);
    expect(saved.attackerInstructions).toBe("saved steering");
    const final = new RedTeamReport(
      JSON.parse(
        await readFile(
          join(directory, "artifacts", "03_summary_report.json"),
          "utf8",
        ),
      ),
    );
    expect(final.results).toHaveLength(6);
  } finally {
    classified.mockRestore();
    generated.mockRestore();
  }
});
it("runs static dataset cases once per target and ignores static strategy names", async () => {
  const dataset = join(directory, "dataset.json");
  await writeFile(
    dataset,
    JSON.stringify({
      samples: staticGoldens.samples
        .slice(0, 2)
        .map((row) => ({ ...row, input: { ...row.input, category: "ASI01" } })),
    }),
  );
  let planned = 0;
  const report = await redTeam([new Target("a"), new Target("b")], {
    ...baseOptions,
    mode: "static",
    dataset,
    categories: ["ASI01"],
    strategies: ["ignored"],
    hooks: hooks({
      onConfirm: async (plan) => {
        planned = plan.numDatapoints ?? 0;
        return true;
      },
    }),
  });
  expect(planned).toBe(2);
  expect(report.results).toHaveLength(4);
  expect(report.pipeline).toBe("static");
  expect(report.summary.evaluatedAttacks).toBe(4);
  expect(report.testedAgents).toEqual(["a", "b"]);
  expect(clones).toHaveLength(4);
  expect(cleanups).toHaveLength(2);
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes("ignoring")),
  ).toBe(true);
});
it("preserves exact hybrid replay order and dispatches both legs through each target job", async () => {
  const staticInput = {
    ...staticGoldens.samples[0]?.input,
    messages: staticGoldens.samples[0]?.messages,
    hybridSource: "static",
  };
  const inputs = [staticInput, { ...dynamicInput, hybridSource: "dynamic" }];
  const path = await replayFile("hybrid", inputs);
  const report = await redTeam([new Target("a/b"), new Target("a-b")], {
    ...baseOptions,
    previousRun: path,
    hooks: hooks(),
  });
  expect(report.pipeline).toBe("hybrid");
  expect(report.results).toHaveLength(4);
  expect(report.summary.datapointBreakdown).toEqual({
    static: 1,
    generated_dynamic: 0,
    template_dynamic: 1,
  });
  expect(report.results.filter((row) => row.execution)).toHaveLength(4);
  expect(clones.map((target) => target.calls[0]?.[0]?.content)).toEqual([
    "case0",
    "case0",
    "Say banana, a/b.",
    "Say banana, a-b.",
  ]);
});
it("does not mint a target or call generation after declined confirmation and records cancellation", async () => {
  const path = await replayFile("dynamic", [dynamicInput]);
  await expect(
    redTeam(new Target("decline"), {
      ...baseOptions,
      previousRun: path,
      save: "final",
      hooks: hooks({ onConfirm: async () => false }),
    }),
  ).rejects.toBeInstanceOf(CancelledError);
  expect(clones).toHaveLength(0);
  expect(cleanups).toHaveLength(0);
  expect((await listManifests(join(directory, "runs")))[0]?.status).toBe(
    "cancelled",
  );
});
it("records completion-hook failure as failed while retaining its completed report and cleaning memory", async () => {
  const path = await replayFile("dynamic", [dynamicInput]);
  await expect(
    redTeam(new Target("broken-hook"), {
      ...baseOptions,
      previousRun: path,
      save: "final",
      hooks: hooks({
        onComplete: async () => {
          throw new Error("completion hook failed");
        },
      }),
    }),
  ).rejects.toThrow("completion hook failed");
  const manifests = await listManifests(join(directory, "runs"));
  expect(manifests[0]?.status).toBe("error");
  expect(manifests[0]?.error).toContain("completion hook failed");
  expect(cleanups).toHaveLength(1);
  expect(
    (await readdir(join(directory, "runs"))).filter((path) =>
      path.endsWith(".json"),
    ),
  ).toHaveLength(1);
});
it("cleans every target when report-stage hooks fail before conversion", async () => {
  const path = await replayFile("dynamic", [dynamicInput]);
  await expect(
    redTeam([new Target("one"), new Target("two")], {
      ...baseOptions,
      previousRun: path,
      hooks: hooks({
        onStageStart: async (stage) => {
          if (stage === "report_generation")
            throw new Error("report hook failed");
        },
      }),
    }),
  ).rejects.toThrow("report hook failed");
  expect(cleanups.map((item) => item.name)).toEqual(["one", "two"]);
  expect(clones.every((target) => target.closed)).toBe(true);
});
it("continues all memory cleanup when each cleanup hook throws", async () => {
  const path = await replayFile("dynamic", [dynamicInput]);
  await expect(
    redTeam([new Target("one"), new Target("two"), new Target("three")], {
      ...baseOptions,
      previousRun: path,
      hooks: hooks({
        onStageStart: async (stage) => {
          if (stage === "cleanup") throw new Error("cleanup hook failed");
        },
      }),
    }),
  ).rejects.toThrow("cleanup hook failed");
  expect(cleanups.map((item) => item.name)).toEqual(["one", "two", "three"]);
});
it("classifies all targets before confirmation, generates shared cases once and caps them fairly", async () => {
  let classifications = 0,
    generations = 0;
  const cap = spyOn(classifier, "classifyAgentCapabilities").mockImplementation(
    async () => {
      classifications++;
      return new classifier.AgentCapabilities();
    },
  );
  const generate = spyOn(
    pipeline,
    "generateDynamicDatapointsForVulnerabilities",
  ).mockImplementation(async () => {
    generations++;
    expect(classifications).toBe(2);
    return [
      [
        { inputs: { ...dynamicInput, id: "one" } },
        { inputs: { ...dynamicInput, id: "two" } },
      ],
      {},
    ];
  });
  try {
    const report = await redTeam([new Target("one"), new Target("two")], {
      ...baseOptions,
      categories: ["ASI01"],
      generateStrategies: false,
      maxDynamicDatapoints: 1,
      hooks: hooks({
        onConfirm: async () => {
          expect(classifications).toBe(2);
          expect(generations).toBe(0);
          return true;
        },
      }),
    });
    expect(generations).toBe(1);
    expect(report.results).toHaveLength(2);
    expect(clones).toHaveLength(2);
  } finally {
    cap.mockRestore();
    generate.mockRestore();
  }
});
it("rejects invalid input before manifests, target context or provider work", async () => {
  const target = new Target("unused"),
    context = spyOn(target, "getAgentContext");
  try {
    await expect(
      redTeam(target, { ...baseOptions, save: "final", datapoints: [] }),
    ).rejects.toThrow("selected no trace seeds");
    await expect(
      redTeam(target, { ...baseOptions, save: "final", llmParallelism: 0 }),
    ).rejects.toThrow();
    expect(context).not.toHaveBeenCalled();
    expect(await listManifests(join(directory, "runs"))).toEqual([]);
  } finally {
    context.mockRestore();
  }
});
it("reports hybrid target failures under their actual target instead of losing the failed job", async () => {
  const staticInput = {
    ...staticGoldens.samples[0]?.input,
    messages: staticGoldens.samples[0]?.messages,
    hybridSource: "static",
  };
  const path = await replayFile("hybrid", [
    staticInput,
    { ...dynamicInput, hybridSource: "dynamic" },
  ]);
  const report = await redTeam(new Target("broken", true), {
    ...baseOptions,
    previousRun: path,
    hooks: hooks(),
    llmConfig: new LLMConfig({ maxTargetRetries: 0 }),
  });
  expect(report.summary.totalErrors).toBeGreaterThan(0);
  expect(cleanups).toHaveLength(1);
  expect(clones.every((target) => target.closed)).toBe(true);
  expect(
    report.errors.length + report.results.filter((row) => row.error).length,
  ).toBeGreaterThan(0);
});

it("saves vulnerable verdicts and closes targets without exiting the caller process", async () => {
  const path = await replayFile("dynamic", [dynamicInput]);
  scorer.mockReturnValue({
    name: "synthetic-vulnerable",
    evaluatorType: "llm_eval",
    scorer: async () => ({
      value: false,
      pass: false,
      explanation: "Synthetic vulnerability",
    }),
  });
  const report = await redTeam(new Target("vulnerable"), {
    ...baseOptions,
    previousRun: path,
    save: "final",
    hooks: hooks(),
  });
  expect(report.summary.vulnerabilitiesFound).toBe(1);
  expect(report.results[0]?.vulnerable).toBe(true);
  expect(clones[0]?.closed).toBe(true);
  expect(cleanups).toHaveLength(1);
  expect((await listManifests(join(directory, "runs")))[0]?.status).toBe(
    "completed",
  );
});
