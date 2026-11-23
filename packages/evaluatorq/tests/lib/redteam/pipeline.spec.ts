import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import { currentThreadId } from "../../../src/lib/common/thread-context.js";
import {
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  type Message,
} from "../../../src/lib/contracts.js";
import * as orchestratorModule from "../../../src/lib/redteam/adaptive/orchestrator.js";
import {
  AgentCapabilities,
  AttackEvaluationResult,
  Backend,
  BareTargetBackend,
  cleanupMemoryEntities,
  createDynamicEvaluator,
  createDynamicRedteamJob,
  expandTraceSeedDatapoints,
  generateDynamicDatapoints,
  LLMConfig,
  OWASPEvaluator,
  withAttackProgress,
} from "../../../src/lib/redteam/index.js";
import type { DataPoint } from "../../../src/lib/types.js";
import goldens from "../fixtures/pipeline-python-goldens.json" with {
  type: "json",
};

let warning: ReturnType<typeof spyOn<typeof console, "warn">>,
  errors: ReturnType<typeof spyOn<typeof console, "error">>,
  oldTracing: string | undefined;
beforeEach(() => {
  oldTracing = process.env.ORQ_DISABLE_TRACING;
  process.env.ORQ_DISABLE_TRACING = "1";
  warning = spyOn(console, "warn").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warning.mockRestore();
  errors.mockRestore();
  if (oldTracing === undefined) delete process.env.ORQ_DISABLE_TRACING;
  else process.env.ORQ_DISABLE_TRACING = oldTracing;
});
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const context = () => AgentContextSchema.parse(goldens.context);
class Target extends AgentTarget {
  readonly calls: Message[][] = [];
  readonly threads: (string | null)[] = [];
  closed = 0;
  model = "old";
  constructor(
    readonly responses: unknown[] = [{ text: "answer" }],
    readonly history: "target" | "caller" = "caller",
  ) {
    super("memory");
    this.historyMode = history;
  }
  override readonly historyMode: "target" | "caller";
  override async respond(messages: Message[]) {
    this.calls.push(structuredClone(messages));
    this.threads.push(currentThreadId());
    return AgentResponse.fromJSON(this.responses.shift());
  }
  override newInstance() {
    return new Target([...this.responses]);
  }
  async close() {
    this.closed++;
  }
}
class FakeBackend extends Backend {
  readonly targets: Target[] = [];
  constructor(readonly responses: unknown[] = [{ text: "answer" }]) {
    super("fake");
  }
  override createTarget(_key: string) {
    const target = new Target(structuredClone(this.responses));
    this.targets.push(target);
    return target;
  }
  override async cleanupMemory() {}
}
for (const fixture of goldens.jobs)
  it(`matches pinned fixed-template job ${fixture.label}`, async () => {
    const backend = new FakeBackend(fixture.responses),
      memoryEntityIds: string[] = [],
      finished: unknown[] = [];
    const run = createDynamicRedteamJob({
      agentKey: "agent/key",
      agentContext: context(),
      maxTurns: 4,
      backend,
      memoryEntityIds,
      pipelineConfig: new LLMConfig({ maxTargetRetries: 0 }),
      runId: "run",
    });
    const actual = await withAttackProgress(
      {
        startAttack: () => null,
        updateAttack: () => {},
        finishAttack: (id) => {
          finished.push(id);
        },
      },
      () => run({ inputs: fixture.inputs }, 2),
    );
    const output = actual.output as Record<string, unknown>;
    output.durationSeconds = 0;
    const expected = structuredClone(fixture.expected);
    const details = expected.output.errorDetails as Record<
      string,
      unknown
    > | null;
    if (details)
      for (const [snake, camel] of [
        ["raw_message", "rawMessage"],
        ["response_error_type", "responseErrorType"],
      ]) {
        if (snake && camel && Object.hasOwn(details, snake)) {
          details[camel] = details[snake];
          delete details[snake];
        }
      }
    expect(plain(actual)).toEqual(expected);
    expect(plain(backend.targets[0]?.calls)).toEqual(fixture.calls);
    expect(backend.targets[0]?.closed).toBe(fixture.closed);
    expect(backend.targets[0]?.model).toBe("synthetic-model");
    expect(memoryEntityIds).toEqual(fixture.memory);
    expect(
      backend.targets[0]?.threads.every(
        (thread) => thread === "run:agent-key:2",
      ),
    ).toBe(true);
    expect(finished).toEqual([null]);
  });
for (const fixture of goldens.plans)
  it(`matches pinned dynamic datapoints ${JSON.stringify(fixture.categories)}`, async () => {
    const [data, metadata] = await generateDynamicDatapoints(
      AgentContextSchema.parse({ key: "agent" }),
      fixture.categories,
      {
        maxPerCategory: 1,
        maxTurns: 1,
        generateAdditionalStrategies: false,
        agentCapabilities: new AgentCapabilities(),
      },
    );
    expect(plain(data)).toEqual(fixture.expected);
    if (fixture.categories.includes("unknown"))
      expect(metadata._unresolved_categories).toEqual(["unknown"]);
  });
for (const fixture of goldens.scorers)
  it(`matches pinned scorer evidence policy ${fixture.label}`, async () => {
    const calls: unknown[] = [];
    const result = new AttackEvaluationResult({
      passed: fixture.passed,
      explanation: "synthetic verdict",
      evaluatorId: "judge",
      tokenUsage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        calls: 1,
      },
      rawOutput: { provider_key: 1 },
      jury: fixture.jury,
    });
    const vulnerable = spyOn(
      OWASPEvaluator.prototype,
      "evaluateVulnerability",
    ).mockImplementation(async (key, messages, output) => {
      calls.push({ kind: "category", key, messages, output });
      return result;
    });
    const category = spyOn(
      OWASPEvaluator.prototype,
      "evaluate",
    ).mockImplementation(async (key, messages, output) => {
      calls.push({ kind: "category", key, messages, output });
      return result;
    });
    try {
      const scorer = createDynamicEvaluator({
        evaluatorModel: "judge",
        llmClient: {} as OpenAI,
      });
      const score = await scorer.scorer({
        data: {
          inputs: { category: "ASI01", vulnerability: "goal_hijacking" },
        },
        output: fixture.raw,
      });
      const actual = {
        value: score.value,
        explanation: score.explanation ?? null,
        pass: score.pass ?? null,
        tokenUsage: score.tokenUsage ?? null,
        rawOutput: score.rawOutput ?? null,
      };
      const { pass_: savedPass, ...expected } = fixture.expected;
      expect(plain(actual)).toEqual({ ...expected, pass: savedPass ?? null });
      expect(plain(calls)).toEqual(fixture.calls);
      expect(scorer.evaluatorType).toBe("llm_eval");
    } finally {
      vulnerable.mockRestore();
      category.mockRestore();
    }
  });
it("crosses trace seeds with selected strategies while projecting only consumed metadata", () => {
  const attacks: DataPoint[] = [
    {
      inputs: { id: "attack", traceSeedMessages: "wrong", keep: 1 },
      expectedOutput: "expected",
    },
  ];
  expect(expandTraceSeedDatapoints(null, attacks)).toBe(attacks);
  expect(expandTraceSeedDatapoints([], attacks)).toEqual([]);
  expect(
    expandTraceSeedDatapoints(
      [
        {
          inputs: {
            traceSeedMessages: [{ role: "user", content: "legacy" }],
            traceStartFrom: "last_assistant",
          },
        },
      ],
      attacks,
    )[0]?.inputs,
  ).toMatchObject({
    trace_seed_messages: [{ role: "user", content: "legacy" }],
    trace_start_from: "last_assistant",
  });
  const expanded = expandTraceSeedDatapoints(
    [
      {
        inputs: {
          id: "seed",
          source_trace_id: "trace",
          trace_seed_messages: [{ role: "user", content: "seed" }],
          trace_start_from: "first_user",
          recordedOutput: "omit",
          hugeUnused: "omit",
        },
      },
    ],
    attacks,
  );
  expect(expanded).toEqual([
    {
      inputs: {
        id: "trace_trace_0_attack",
        sourceTraceId: "trace",
        trace_seed_messages: [{ role: "user", content: "seed" }],
        trace_start_from: "first_user",
        keep: 1,
      },
      expectedOutput: "expected",
    },
  ]);
  expect(attacks[0]?.inputs.traceSeedMessages).toBe("wrong");
});
it("closes targets when trace metadata validation fails", async () => {
  const backend = new FakeBackend();
  const first = goldens.jobs[0];
  if (!first) throw new Error("Missing fixture");
  const run = createDynamicRedteamJob({
    agentKey: "key",
    agentContext: context(),
    backend,
  });
  await expect(
    run({ inputs: { ...first.inputs, traceSeedMessages: [] } }, 0),
  ).rejects.toThrow("non-empty");
  expect(backend.targets[0]?.closed).toBe(1);
});
it("isolates memory and closes every target across concurrent fixed rows", async () => {
  const backend = new FakeBackend(),
    first = goldens.jobs[0];
  if (!first) throw new Error("Missing fixture");
  const run = createDynamicRedteamJob({
    agentKey: "key",
    agentContext: context(),
    backend,
    runId: "run",
  });
  await Promise.all([
    run({ inputs: first.inputs }, 0),
    run({ inputs: first.inputs }, 1),
  ]);
  expect(backend.targets).toHaveLength(2);
  expect(backend.targets.every((target) => target.closed === 1)).toBe(true);
  expect(backend.targets.map((target) => target.threads)).toEqual([
    ["run:key:0"],
    ["run:key:1"],
  ]);
});
it("routes generated attacks through the orchestrator and closes on programming errors", async () => {
  const backend = new FakeBackend(),
    first = goldens.jobs[0];
  if (!first) throw new Error("Missing fixture");
  const strategy = {
    ...first.inputs.strategy,
    promptTemplate: null,
    prompt_template: null,
    turnType: "multi",
    turn_type: "multi",
  };
  const mock = spyOn(
    orchestratorModule.MultiTurnOrchestrator.prototype,
    "runAttack",
  ).mockRejectedValue(new TypeError("bug"));
  try {
    const run = createDynamicRedteamJob({
      agentKey: "key",
      agentContext: context(),
      backend,
      attackLlmClient: {} as OpenAI,
    });
    await expect(
      run({ inputs: { ...first.inputs, strategy } }, 0),
    ).rejects.toThrow("bug");
    expect(backend.targets[0]?.closed).toBe(1);
  } finally {
    mock.mockRestore();
  }
});
it("times out memory cleanup, aborts cooperative targets and reports failures without throwing", async () => {
  let signal: AbortSignal | undefined;
  class MemoryTarget extends Target {
    override async cleanupMemory(
      _ctx: unknown,
      _ids: string[],
      options?: { signal?: AbortSignal },
    ) {
      signal = options?.signal;
      return new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        ),
      );
    }
  }
  const warning = await cleanupMemoryEntities(context(), ["memory"], {
    memoryCleanup: new BareTargetBackend(new MemoryTarget()),
    pipelineConfig: new LLMConfig({ cleanupTimeoutMs: 5 }),
  });
  expect(warning).toContain("timed out");
  expect(signal?.aborted).toBe(true);
  class Broken extends FakeBackend {
    override async cleanupMemory() {
      throw new Error("cleanup broke");
    }
  }
  expect(
    await cleanupMemoryEntities(context(), [], { memoryCleanup: new Broken() }),
  ).toBe("Memory cleanup failed: cleanup broke");
});
it("passes cleanup success through unchanged", async () => {
  expect(
    await cleanupMemoryEntities(context(), [], {
      memoryCleanup: new FakeBackend(),
    }),
  ).toBeNull();
});

it("preserves dynamic result turns and budgets through the existing engine adapter", async () => {
  const first = goldens.jobs[0];
  if (!first) throw new Error("Missing fixture");
  const backend = new FakeBackend(),
    { OrchestratorResult } = await import("../../../src/lib/redteam/result.js");
  const result = new OrchestratorResult({
    turns: [{ attacker: { text: "ask" }, target: { text: "answer" } }],
    objectiveAchieved: false,
    maxTurns: 3,
  });
  const runAttack = spyOn(
    orchestratorModule.MultiTurnOrchestrator.prototype,
    "runAttack",
  ).mockResolvedValue(result);
  try {
    const run = createDynamicRedteamJob({
      agentKey: "key",
      agentContext: context(),
      backend,
      attackLlmClient: {} as OpenAI,
      maxTurns: 3,
      runId: "run",
    });
    const strategy = {
      ...first.inputs.strategy,
      promptTemplate: null,
      prompt_template: null,
      turnType: "multi",
      turn_type: "multi",
    };
    const actual = await run({ inputs: { ...first.inputs, strategy } }, 4);
    expect((actual.output as Record<string, unknown>).maxTurns).toBe(3);
    expect((actual.output as Record<string, unknown>).threadId).toBe(
      "run:key:4",
    );
    expect((actual.output as Record<string, unknown>).turns).toHaveLength(1);
    expect(runAttack.mock.calls[0]?.[4]).toBe(3);
    expect(backend.targets[0]?.closed).toBe(1);
  } finally {
    runAttack.mockRestore();
  }
});
it("propagates cancellation and closes the active target", async () => {
  const first = goldens.jobs[0];
  if (!first) throw new Error("Missing fixture");
  const backend = new FakeBackend(),
    controller = new AbortController();
  const runAttack = spyOn(
    orchestratorModule.MultiTurnOrchestrator.prototype,
    "runAttack",
  ).mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
  });
  try {
    const run = createDynamicRedteamJob({
      agentKey: "key",
      agentContext: context(),
      backend,
      attackLlmClient: {} as OpenAI,
      signal: controller.signal,
    });
    const strategy = {
      ...first.inputs.strategy,
      promptTemplate: null,
      prompt_template: null,
      turnType: "multi",
      turn_type: "multi",
    };
    await expect(
      run({ inputs: { ...first.inputs, strategy } }, 0),
    ).rejects.toThrow("Cancelled");
    expect(backend.targets[0]?.closed).toBe(1);
  } finally {
    runAttack.mockRestore();
  }
});
