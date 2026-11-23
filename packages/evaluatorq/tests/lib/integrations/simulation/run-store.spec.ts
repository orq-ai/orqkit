import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listManifests } from "../../../../src/lib/common/run-manifest.js";
import { AgentResponse, UsageSchema } from "../../../../src/lib/contracts.js";
import { agentInfoFromResponse } from "../../../../src/lib/integrations/simulation/agent-snapshot.js";
import {
  autoSaveSimulationRun,
  buildSimulationRun,
  generateAndSimulate,
  loadSimulationReplay,
  ReplayError,
  SimulationCancelledError,
  SimulationRun,
  sanitiseRunName,
  simulate,
} from "../../../../src/lib/integrations/simulation/index.js";
import {
  parseSavedDatapoint,
  parseSimulationResult,
} from "../../../../src/lib/integrations/simulation/run-store.js";
import { usageDelta } from "../../../../src/lib/integrations/simulation/usage.js";
import fixtures from "../../fixtures/simulation-run-python-goldens.json" with {
  type: "json",
};
import { continueTurn, makeFakeClient } from "./fake-client.js";

let dir: string;
let previous: Record<string, string | undefined>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "res1863-run-"));
  previous = {
    EVALUATORQ_DIR: process.env.EVALUATORQ_DIR,
    ORQ_API_KEY: process.env.ORQ_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.EVALUATORQ_DIR = dir;
  delete process.env.ORQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  warn.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});
const dp = () => parseSavedDatapoint(fixtures.run.datapoints?.[0]);
const result = () => parseSimulationResult(fixtures.run.results[0]);
const run = () =>
  new SimulationRun(fixtures.run as unknown as Record<string, unknown>);
const runFiles = async () => {
  try {
    return (await readdir(join(dir, "sim-runs"))).filter((name) =>
      name.endsWith(".json"),
    );
  } catch {
    return [];
  }
};
const options = () => ({
  client: makeFakeClient().client,
  target: () => "mango",
  datapoints: [dp()],
  maxTurns: 1,
  uploadResults: false,
  executiveSummary: false,
  recommendations: false,
});

it.each(fixtures.names)(
  "matches pinned Python filename sanitization: $name",
  (entry) => {
    expect(sanitiseRunName(entry.name)).toBe(entry.expected);
  },
);
it("reads the Python run fixture and preserves priced usage, transcript content, tool calls and free metadata", () => {
  const saved = run();
  expect(saved.runName).toBe("Saved case");
  expect(saved.maxTurns).toBe(3);
  expect(saved.replayVersion).toBe(1);
  expect(saved.tokenUsageTotal).toMatchObject({
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    cachedTokens: 1,
    reasoningTokens: 1,
    totalCost: 0.03,
    calls: 1,
    pricedCalls: 1,
  });
  expect(saved.results[0]?.messages[1]?.content).toBeNull();
  expect(
    saved.results[0]?.messages[1]?.tool_calls?.[0]?.function.arguments,
  ).toBe("{}");
  expect(saved.results[0]?.messages[2]?.tool_call_id).toBe("c");
  expect(saved.results[0]?.metadata.custom_under_score).toEqual({
    keep_key: true,
  });
  expect(saved.results[0]?.response_traces).toEqual([
    { traceId: "trace", spanId: "span" },
  ]);
  expect(saved.manifestSummary()).toEqual({
    mode: fixtures.summary.mode,
    targetKind: fixtures.summary.target_kind,
    totalResults: fixtures.summary.total_results,
    scorerAverages: fixtures.summary.scorer_averages,
  });
});
it("writes Python's snake_case model fields and reads them back without mutating protocol data or metadata", async () => {
  const original = run();
  const path = join(dir, "explicit.json");
  await original.save(path);
  const raw = JSON.parse(await readFile(path, "utf8"));
  expect(raw).toHaveProperty("run_name");
  expect(raw).not.toHaveProperty("runName");
  expect(raw).toHaveProperty("replay_version", 1);
  expect(raw.results[0]).toHaveProperty("token_usage.total_cost", 0.03);
  expect(raw.results[0]).not.toHaveProperty("tokenUsage");
  expect(raw.results[0].turn_metrics[0].token_usage.total_cost).toBe(0.03);
  expect(raw.results[0].messages[1].tool_calls[0].function.arguments).toBe(
    "{}",
  );
  expect(raw.datapoints[0].persona.communication_style).toBe("casual");
  expect(raw.datapoints[0]).toHaveProperty("first_message", "Reply mango");
  expect(raw.results[0].metadata.custom_under_score.keep_key).toBe(true);
  const loaded = await SimulationRun.load(path);
  expect(loaded.toJSON()).toEqual(original.toJSON());
  expect(loaded.results[0]?.messages[1]?.content).toBeNull();
});
it("preserves multimodal messages and unknown metadata when loading a saved run", () => {
  const input = structuredClone(fixtures.run) as unknown as Record<
    string,
    unknown
  >;
  const content = [
    { type: "input_text" as const, text: "all text" },
    {
      type: "input_image" as const,
      image_url: "https://image.test/image.png",
      detail: "high" as const,
    },
  ];
  (input.results as { messages: unknown[] }[])[0] = {
    messages: [{ role: "user", content }],
    ...(input.results as Record<string, unknown>[])[0],
  };
  (
    (input.results as { messages: unknown[] }[])[0] as { messages: unknown[] }
  ).messages = [{ role: "user", content }];
  const loaded = new SimulationRun(input);
  expect(loaded.results[0]?.messages[0]?.content).toEqual(content);
});

it("matches Python aggregation and ignores non-numeric scores with a warning", () => {
  const saved = buildSimulationRun({
    runName: "x",
    mode: "simulate",
    targetKind: "callback",
    evaluatorNames: ["good"],
    results: [result()],
    datapoints: [dp()],
  });
  expect(saved.scorerAverages).toEqual(fixtures.run.scorer_averages);
  expect(saved.totalResults).toBe(1);
  expect(saved.replayVersion).toBe(1);
  expect(saved.orqBaseUrl).toBeNull();
  expect(warn).toHaveBeenCalled();
  const empty = buildSimulationRun({
    runName: "x",
    mode: "generate",
    targetKind: "callback",
    evaluatorNames: [],
    results: [],
  });
  expect(empty.scorerAverages).toEqual({});
  expect(empty.datapoints).toBeNull();
  const prototype = result();
  prototype.metadata.evaluator_scores = JSON.parse(
    '{"__proto__":0.5,"constructor":1}',
  );
  expect(
    buildSimulationRun({
      runName: "x",
      mode: "simulate",
      targetKind: "callback",
      evaluatorNames: [],
      results: [prototype],
    }).scorerAverages,
  ).toEqual(JSON.parse('{"__proto__":0.5,"constructor":1}'));
});
it("matches the Python agent snapshot and excludes instructions", () => {
  const snapshot = agentInfoFromResponse(fixtures.agentResponse, "key", {
    baseUrl: "https://my.orq.ai",
    workspaceKey: "test-workspace",
  });
  const expected = fixtures.snapshot;
  expect(snapshot).toEqual({
    key: expected.key,
    id: expected.id,
    role: expected.role,
    description: expected.description,
    model: expected.model,
    version: expected.version,
    tools: expected.tools,
    skills: expected.skills,
    knowledgeBases: expected.knowledge_bases,
    memoryStores: expected.memory_stores,
    subAgents: expected.sub_agents,
    agentType: expected.agent_type,
    engine: expected.engine,
    workspaceId: expected.workspace_id,
    workspaceKey: expected.workspace_key,
    baseUrl: expected.base_url,
    url: expected.url,
  });
  expect(JSON.stringify(snapshot)).not.toContain("DO NOT SAVE");
  expect(snapshot).not.toHaveProperty("instructions");
  expect(
    agentInfoFromResponse({}, "key", {
      workspaceKey: "00000000-0000-0000-0000-000000000000",
    }).url,
  ).toBeNull();
});
it("uses exclusive creation for concurrent filename collisions", async () => {
  const saved = run(),
    now = new Date("2026-01-01T00:00:00Z");
  const paths = await Promise.all(
    Array.from({ length: 8 }, () =>
      autoSaveSimulationRun(saved, { runsDir: dir, now }),
    ),
  );
  expect(new Set(paths).size).toBe(8);
  expect(
    paths.some((path) => path.endsWith("saved_case_20260101-000000.json")),
  ).toBe(true);
  for (const path of paths)
    expect((await SimulationRun.load(path)).runName).toBe("Saved case");
});
it("bounds automatic filename collision search at 1000 attempts", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  for (let index = 0; index < 1000; index++)
    await writeFile(
      join(
        dir,
        `saved_case_20260101-000000${index ? `_${String(index).padStart(3, "0")}` : ""}.json`,
      ),
      "existing",
    );
  await expect(
    autoSaveSimulationRun(run(), { runsDir: dir, now }),
  ).rejects.toThrow("1000 attempts");
  expect(
    await readFile(join(dir, "saved_case_20260101-000000.json"), "utf8"),
  ).toBe("existing");
});
it("resolves replay by explicit file, name and latest, preserving all cases and the stored cap", async () => {
  const path = await autoSaveSimulationRun(run(), { runsDir: dir });
  for (const reference of [path, "saved_case", "latest"]) {
    const replay = await loadSimulationReplay(reference, dir);
    expect(replay.datapoints).toHaveLength(1);
    expect(replay.datapoints[0]?.first_message).toBe("Reply mango");
    expect(replay.maxTurns).toBe(3);
  }
});
it.each(["camel", "snake", "conflicting"] as const)(
  "rejects newer or conflicting %s replay versions before model calls",
  async (style) => {
    const payload = run().toJSON();
    if (style === "camel") payload.replayVersion = 2;
    else if (style === "snake") {
      delete payload.replayVersion;
      payload.replay_version = 2;
    } else payload.replay_version = 2;
    const path = join(dir, "newer.json");
    await writeFile(path, JSON.stringify(payload));
    await expect(loadSimulationReplay(path, dir)).rejects.toBeInstanceOf(
      ReplayError,
    );
  },
);
it.each(["missing", "empty", "redteam", "invalid", "blank-opening"] as const)(
  "rejects %s replay data with a useful error",
  async (style) => {
    const payload = run().toJSON();
    if (style === "missing") delete payload.datapoints;
    if (style === "empty") payload.datapoints = [];
    if (style === "redteam") payload.pipeline = "redteam";
    if (style === "invalid") payload.datapoints = [{ id: "bad" }];
    if (style === "blank-opening")
      payload.datapoints = [
        {
          ...(payload.datapoints as Record<string, unknown>[])[0],
          firstMessage: "",
        },
      ];
    const path = join(dir, "old.json");
    await writeFile(path, JSON.stringify(payload));
    await expect(loadSimulationReplay(path, dir)).rejects.toBeInstanceOf(
      ReplayError,
    );
  },
);
it("keeps save opt-in and validates explicit report aliases", async () => {
  await simulate({
    ...options(),
    save: false,
    reportPath: join(dir, "ignored.json"),
  });
  expect(await runFiles()).toEqual([]);
  expect(await readdir(dir)).toEqual([]);
  await expect(
    simulate({ ...options(), save: true, report: "a", reportPath: "b" }),
  ).rejects.toThrow("must match");
});
it("saves exact lazy-generated cases and replays without generation", async () => {
  const { client, requests } = makeFakeClient({
    firstMessage: () => "exact generated opener",
  });
  const point = dp();
  await simulate({
    client,
    target: () => "mango",
    personas: [point.persona],
    scenarios: [point.scenario],
    maxTurns: 1,
    save: true,
    uploadResults: false,
    executiveSummary: false,
    recommendations: false,
    runName: "lazy",
  });
  const files = await runFiles();
  expect(files).toHaveLength(1);
  const saved = await SimulationRun.load(
    join(dir, "sim-runs", files[0] as string),
  );
  expect(saved.datapoints?.[0]?.first_message).toBe("exact generated opener");
  expect(saved.datapoints?.[0]?.id).toBe(
    String(saved.results[0]?.metadata.datapoint_id),
  );
  const seen: string[] = [];
  await simulate({
    client,
    target: (messages) => {
      seen.push(messages[0]?.content ?? "");
      return "mango";
    },
    previousRun: join(dir, "sim-runs", files[0] as string),
    uploadResults: false,
    executiveSummary: false,
    recommendations: false,
  });
  expect(seen).toEqual(["exact generated opener"]);
  expect(requests.firstMessage).toHaveLength(1);
  expect(requests.generator).toHaveLength(0);
  const manifests = await listManifests(join(dir, "sim-runs"));
  expect(manifests).toHaveLength(1);
  expect(manifests[0]?.status).toBe("completed");
  expect(manifests[0]?.summary?.totalResults).toBe(1);
  const replay = await loadSimulationReplay(
    String(saved.runId),
    join(dir, "sim-runs"),
  );
  expect(replay.datapoints[0]?.first_message).toBe("exact generated opener");
});
it("restores the previous turn cap unless explicitly overridden", async () => {
  const source = run();
  source.maxTurns = 2;
  const path = join(dir, "source.json");
  await source.save(path);
  const { client, requests } = makeFakeClient({
    judge: () => continueTurn([]),
  });
  for (const [maxTurns, expected] of [
    [undefined, 2],
    [1, 1],
  ] as const) {
    let calls = 0;
    const rows = await simulate({
      client,
      target: () => {
        calls++;
        return "mango";
      },
      previousRun: path,
      maxTurns,
      uploadResults: false,
      executiveSummary: false,
      recommendations: false,
    });
    expect(calls).toBe(expected);
    expect(rows[0]?.turn_count).toBe(expected);
  }
  expect(requests.firstMessage).toHaveLength(0);
  expect(requests.generator).toHaveLength(0);
});
it("rejects replay combined with another source before execution", async () => {
  const { client, requests } = makeFakeClient();
  await expect(
    simulate({
      ...options(),
      client,
      previousRun: "missing",
      datapoints: [dp()],
    }),
  ).rejects.toThrow("exactly one");
  expect(requests.judge).toHaveLength(0);
});
it("keeps completed results and completes the manifest if saving fails", async () => {
  const blocked = join(dir, "directory.json");
  await mkdir(blocked);
  const rows = await simulate({
    ...options(),
    save: true,
    reportPath: blocked,
  });
  expect(rows).toHaveLength(1);
  expect(
    warn.mock.calls.some((call) =>
      String(call[0]).includes("completed results are still returned"),
    ),
  ).toBe(true);
  expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
  const manifests = await listManifests(dir);
  expect(manifests[0]?.status).toBe("completed");
  expect(manifests[0]?.reportPath).toBeNull();
});
it("records cancellation and execution failure without leaving running manifests", async () => {
  await expect(
    simulate({ ...options(), save: true, hooks: { onConfirm: () => false } }),
  ).rejects.toBeInstanceOf(SimulationCancelledError);
  const failed = makeFakeClient();
  await expect(
    simulate({
      ...options(),
      client: failed.client,
      runName: "failed",
      save: true,
      maxTargetRetries: 0,
      target: () => {
        throw new Error("target failed");
      },
    }),
  ).rejects.toThrow("Simulation execution failed");
  const statuses = (await listManifests(join(dir, "sim-runs")))
    .map((m) => m.status)
    .sort();
  expect(statuses).toEqual(["cancelled", "error"]);
  expect(await runFiles()).toEqual([]);
});
it("records generation failure before simulate and saves generated runs with both stages", async () => {
  const point = dp();
  const bad = makeFakeClient({
    generator: () => {
      throw new Error("generation failed");
    },
  });
  await expect(
    generateAndSimulate({
      client: bad.client,
      target: () => "mango",
      agentDescription: "echo",
      save: true,
      uploadResults: false,
      executiveSummary: false,
      recommendations: false,
    }),
  ).rejects.toThrow("generation failed");
  const good = makeFakeClient({
    generator: (request) => ({
      content: JSON.stringify(
        request.response_format?.type === "json_schema" &&
          request.response_format.json_schema.name === "personas"
          ? { personas: [point.persona] }
          : { scenarios: [point.scenario] },
      ),
    }),
  });
  await generateAndSimulate({
    client: good.client,
    target: () => "mango",
    agentDescription: "echo",
    numPersonas: 1,
    numScenarios: 1,
    save: true,
    uploadResults: false,
    executiveSummary: false,
    recommendations: false,
    maxTurns: 1,
  });
  const files = await runFiles();
  expect(files).toHaveLength(1);
  const saved = await SimulationRun.load(
    join(dir, "sim-runs", files[0] as string),
  );
  expect(saved.mode).toBe("run");
  expect(saved.datapoints).toHaveLength(1);
  expect(saved.tokenUsageTotal?.totalTokens).toBe(
    (saved.results[0]?.usage?.totalTokens ?? 0) + 6,
  );
  const manifests = await listManifests(join(dir, "sim-runs"));
  expect(manifests.map((m) => m.status).sort()).toEqual(["completed", "error"]);
  const completed = manifests.find((m) => m.status === "completed");
  expect(completed?.stages.map((stage) => [stage.name, stage.status])).toEqual([
    ["generate", "completed"],
    ["simulate", "completed"],
  ]);
});
it("retains priced target usage in turn, conversation and persisted totals", async () => {
  const usage = UsageSchema.parse({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedTokens: 3,
    reasoningTokens: 2,
    totalCost: 0.25,
    inputCost: 0.1,
    outputCost: 0.15,
    calls: 1,
    pricedCalls: 1,
  });
  const { client } = makeFakeClient();
  const rows = await simulate({
    client,
    targetAgent: {
      respond: async () =>
        new AgentResponse({ text: "mango", usage, model: "recorded-model" }),
    },
    datapoints: [dp()],
    maxTurns: 1,
    save: true,
    uploadResults: false,
    executiveSummary: false,
    recommendations: false,
  });
  expect(rows[0]?.token_usage.total_tokens).toBe(20);
  expect(rows[0]?.usage).toMatchObject({
    totalTokens: 20,
    totalCost: 0.25,
    pricedCalls: 1,
    calls: 2,
    cachedTokens: 3,
    reasoningTokens: 2,
  });
  expect(rows[0]?.turn_metrics[0]?.usage).toMatchObject({
    totalTokens: 20,
    totalCost: 0.25,
    pricedCalls: 1,
    calls: 2,
  });
  const saved = await SimulationRun.load(
    join(dir, "sim-runs", (await runFiles())[0] as string),
  );
  expect(saved.tokenUsageTotal).toEqual(rows[0]?.usage ?? null);
  expect(saved.targetModel).toBe("recorded-model");
  expect(saved.results[0]?.turn_metrics[0]?.usage?.totalCost).toBe(0.25);
  expect(usageDelta(usage, usage)).toMatchObject({
    totalTokens: 0,
    totalCost: 0,
    calls: 0,
  });
});

it("retains model-side judge costs and cache counters", async () => {
  const { client } = makeFakeClient({
    judgeResponse: (reply) => ({
      ...reply,
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        input_cost: 0.01,
        output_cost: 0.02,
        total_cost: 0.03,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }),
  });
  const rows = await simulate({ ...options(), client, save: true });
  expect(rows[0]?.usage).toMatchObject({
    totalTokens: 5,
    totalCost: 0.03,
    calls: 1,
    pricedCalls: 1,
    cachedTokens: 1,
    reasoningTokens: 1,
  });
  const saved = await SimulationRun.load(
    join(dir, "sim-runs", (await runFiles())[0] as string),
  );
  expect(saved.tokenUsageTotal?.totalCost).toBe(0.03);
});

it("persists the uploaded experiment link without changing returned results", async () => {
  const before = process.env.ORQ_BASE_URL;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (
        new URL(request.url).pathname === "/v2/spreadsheets/evaluations/receive"
      )
        return Response.json({
          sheet_id: "s",
          manifest_id: "r",
          experiment_name: "test",
          rows_created: 1,
          experiment_url: "https://my.orq.ai/workspace/experiments/s/r",
        });
      return new Response("missing", { status: 404 });
    },
  });
  process.env.ORQ_API_KEY = "test-key";
  process.env.ORQ_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    const rows = await simulate({
      ...options(),
      save: true,
      uploadResults: true,
      executiveSummary: false,
      recommendations: false,
    });
    expect(rows).toHaveLength(1);
    const saved = await SimulationRun.load(
      join(dir, "sim-runs", (await runFiles())[0] as string),
    );
    expect(saved.experimentUrl).toBe(
      "https://my.orq.ai/workspace/experiments/s/r",
    );
  } finally {
    server.stop(true);
    if (before === undefined) delete process.env.ORQ_BASE_URL;
    else process.env.ORQ_BASE_URL = before;
  }
});

const savedValues = (
  await import("../../fixtures/saved-run-scalars-python-golden.json", {
    with: { type: "json" },
  })
).default;
for (const [index, row] of savedValues.datetimes.entries())
  it(`simulation accepts pinned datetime shape ${index}`, () => {
    const load = () =>
      new SimulationRun({ ...fixtures.run, created_at: row.input });
    if (row.error) expect(load).toThrow();
    else expect(load().createdAt).toBe(row.expected as string);
  });
it("simulation still requires a creation time", () => {
  const raw = { ...fixtures.run } as Record<string, unknown>;
  delete raw.created_at;
  expect(() => new SimulationRun(raw)).toThrow();
});
