import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type OpenAI from "openai";

import { responsesTranscript } from "../../../../src/lib/common/output-adapters.js";
import {
  AgentResponse,
  AgentTarget,
  LLMCallConfig,
  type Message,
  UsageSchema,
} from "../../../../src/lib/contracts.js";
import { evaluatorq } from "../../../../src/lib/evaluatorq.js";
import { OrqResponsesTarget } from "../../../../src/lib/integrations/openresponses/target.js";
import { JudgeAgent } from "../../../../src/lib/integrations/simulation/agents/judge.js";
import { UserSimulatorAgent } from "../../../../src/lib/integrations/simulation/agents/user-simulator.js";
import { simRoleConfig } from "../../../../src/lib/integrations/simulation/config.js";
import { toOpenResponses } from "../../../../src/lib/integrations/simulation/convert.js";
import {
  conversationQualityScorer,
  SimulationScoringConfig,
  turnEfficiencyScorer,
} from "../../../../src/lib/integrations/simulation/evaluators/index.js";
import { CompositeSimulationHooks } from "../../../../src/lib/integrations/simulation/hooks.js";
import {
  invertRolesForSimulator,
  SimulationRunner,
} from "../../../../src/lib/integrations/simulation/runner/simulation.js";
import {
  PersonaSchema,
  ScenarioSchema,
} from "../../../../src/lib/integrations/simulation/schemas.js";
import { wrapSimulationScorer } from "../../../../src/lib/integrations/simulation/scorer-adapter.js";
import {
  generateAndSimulate,
  simulate,
} from "../../../../src/lib/integrations/simulation/simulation/index.js";
import * as simTracing from "../../../../src/lib/integrations/simulation/tracing.js";
import type { SimulationResult } from "../../../../src/lib/integrations/simulation/types.js";
import { wrapSimulationAgent } from "../../../../src/lib/integrations/simulation/wrap-agent.js";
import { continueTurn, finishTurn, makeFakeClient } from "./fake-client.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "../../fixtures", name), "utf8"),
  );
const camel = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      entry,
    ]),
  );
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};
const persona = {
  name: "Dana",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual" as const,
  background: "Customer",
};
const scenario = { name: "Refund", goal: "Get a refund", criteria: [] };
const datapoint = {
  id: "one",
  persona,
  scenario,
  user_system_prompt: "Act as the customer",
  first_message: "Refund please",
};

function response(text: string) {
  return {
    id: "response",
    model: "fixture",
    status: "completed",
    output_text: text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  };
}
function wireClient(
  create: (
    body: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<unknown>,
): OpenAI {
  return { responses: { create } } as unknown as OpenAI;
}

describe("simulation migration goldens", () => {
  test("model roles and model fieldsSet match pinned Python", () => {
    for (const row of fixture("simulation-python-goldens.json").models) {
      const config = new LLMCallConfig(camel(row.options));
      for (const [task, model] of Object.entries(row.models))
        expect(simRoleConfig(config, task).model).toBe(model as string);
    }
  });
  test("persona and scenario validation match pinned Python", () => {
    for (const row of fixture("simulation-python-goldens.json").schemas) {
      const result = (
        row.kind === "persona" ? PersonaSchema : ScenarioSchema
      ).safeParse(row.input);
      expect(result.success ? result.data : null).toEqual(row.output);
    }
  });
  test("judge parsing matches pinned Python with the existing JSON text convention", async () => {
    for (const row of fixture("simulation-judge-goldens.json")) {
      const client = wireClient(async () =>
        response(JSON.stringify(row.input)),
      );
      const actual = await new JudgeAgent({
        client,
        criteria: [
          { description: "offers refund", type: "must_happen" },
          { description: "insults user", type: "must_not_happen" },
        ],
        groundTruth: "10 EUR",
      }).evaluate([]);
      expect(canonical(actual)).toEqual(canonical(row.output));
    }
  });
  test("150 scoring cases match pinned Python, including custom policies", () => {
    for (const row of fixture("simulation-score-goldens.json")) {
      const config = new SimulationScoringConfig(camel(row.config));
      const result: SimulationResult = {
        messages: [],
        terminated_by: "judge",
        reason: "done",
        goal_achieved: row.achieved,
        goal_completion_score: 0.5,
        rules_broken: [],
        turn_count: row.turns,
        turn_metrics: [],
        token_usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        criteria_results: { a: true, b: false },
        metadata: {},
      };
      expect(turnEfficiencyScorer(result, config)).toBe(row.efficiency);
      expect(conversationQualityScorer(result, config)).toBe(row.quality);
    }
  });
});

describe("simulation controls", () => {
  test("explicit configuration beats call defaults and null omits sampling controls", async () => {
    let sent: Record<string, unknown> = {};
    const client = wireClient(async (body) => {
      sent = body;
      return response("hello");
    });
    const agent = new UserSimulatorAgent({
      client,
      llmConfig: new LLMCallConfig({
        temperature: null,
        maxTokens: 111,
        reasoningEffort: null,
        extraBody: { probe: 123 },
      }),
    });
    expect(
      await agent.respondAsync(
        [{ role: "assistant", content: "earlier reply" }],
        { temperature: 0.9, maxTokens: 5 },
      ),
    ).toBe("hello");
    expect(sent.max_output_tokens).toBe(111);
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("reasoning");
    expect(sent.probe).toBe(123);
    expect((sent.input as { content: unknown }[])[0]?.content).toEqual([
      { type: "output_text", text: "earlier reply" },
    ]);
    expect(sent.instructions).toContain("user simulator");
  });
  test("caller cancellation aborts the in-flight request without retrying", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const client = wireClient(async (_body, options) => {
      calls++;
      signal = options.signal;
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    });
    const controller = new AbortController();
    const result = new UserSimulatorAgent({ client }).respondAsync([], {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(Object.assign(new Error("stop"), { name: "AbortError" }));
    await expect(result).rejects.toThrow("stop");
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
  });
  test("configured timeout aborts a hung provider request", async () => {
    let signal: AbortSignal | undefined;
    const client = wireClient(async (_body, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    await expect(
      new UserSimulatorAgent({
        client,
        llmConfig: new LLMCallConfig({ timeoutMs: 5 }),
      }).respondAsync([]),
    ).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });
  test("all hook children receive terminal events before the first error propagates", async () => {
    const calls: string[] = [];
    const hooks = new CompositeSimulationHooks([
      {
        onRunComplete: async () => {
          calls.push("first");
          throw new Error("hook failed");
        },
      },
      {
        onRunComplete: async () => {
          calls.push("second");
        },
      },
    ]);
    await expect(hooks.onRunComplete([])).rejects.toThrow("hook failed");
    expect(calls).toEqual(["first", "second"]);
  });
  test("one auth failure stops queued first-message calls", async () => {
    const { client, requests } = makeFakeClient({
      firstMessage: () => {
        throw Object.assign(new Error("bad key"), { status: 401 });
      },
    });
    const results = await simulate({
      client,
      targetCallback: () => "reply",
      personas: [persona, { ...persona, name: "Other" }],
      scenarios: [scenario],
      datapointParallelism: 1,
      raiseOnExecutionFailure: false,
      uploadResults: false,
    });
    expect(results).toHaveLength(0);
    expect(requests.firstMessage).toHaveLength(1);
  });
  test("scorer errors preserve completed conversations", async () => {
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });
    const evaluators = await import(
      "../../../../src/lib/integrations/simulation/evaluators/index.js"
    );
    evaluators.SIMULATION_EVALUATORS.broken = () => {
      throw new Error("scorer down");
    };
    try {
      const [result] = await simulate({
        client,
        targetCallback: () => "reply",
        datapoints: [datapoint],
        evaluators: ["broken"],
        uploadResults: false,
      });
      expect(result?.terminated_by).toBe("judge");
      expect(JSON.stringify(result?.evaluator_details)).toContain(
        "scorer down",
      );
    } finally {
      delete evaluators.SIMULATION_EVALUATORS.broken;
    }
  });
  test("the wrapper scoring adapter receives the complete original result", async () => {
    const { client } = makeFakeClient({ judge: () => finishTurn([]) });
    const job = wrapSimulationAgent({ client, targetCallback: () => "reply" });
    try {
      const rows = await evaluatorq("wrapper-adapter", {
        data: Array.from({ length: 5 }, (_, index) => ({
          inputs: { datapoint: { ...datapoint, id: String(index) } },
        })),
        jobs: [job],
        evaluators: [
          {
            name: "conversation",
            scorer: wrapSimulationScorer((result) =>
              result.messages.length === 2 ? 1 : 0,
            ),
          },
        ],
        sendResults: false,
        print: false,
      });
      expect(
        rows.map(
          (row) => row.jobResults?.[0]?.evaluatorScores?.[0]?.score.value,
        ),
      ).toEqual([1, 1, 1, 1, 1]);
    } finally {
      await job.close();
    }
  });
  test("each target retry gets its own timeout budget", async () => {
    let calls = 0;
    const { client } = makeFakeClient();
    const runner = new SimulationRunner({
      client,
      targetAgentTimeoutMs: 5,
      maxTargetRetries: 2,
      targetCallback: () => {
        calls++;
        return new Promise(() => {});
      },
    });
    try {
      const result = await runner.run({ datapoint });
      expect(result.terminated_by).toBe("error");
      expect(calls).toBe(3);
      expect(result.reason).toContain("3 attempt(s)");
      expect(result.messages.at(-1)?.role).toBe("assistant");
      expect(result.messages.at(-1)?.content).toContain("ERROR");
    } finally {
      await runner.close();
    }
  });
  test("generation usage is included in the pipeline total", async () => {
    const usage = spyOn(simTracing, "recordTokenUsage");
    const { client } = makeFakeClient({
      generator: (request) => ({
        content:
          request.response_format?.type === "json_schema" &&
          request.response_format.json_schema.name === "personas"
            ? JSON.stringify({
                personas: Array.from({ length: 5 }, (_, index) => ({
                  ...persona,
                  name: String(index),
                })),
              })
            : JSON.stringify({ scenarios: [scenario] }),
      }),
    });
    try {
      const results = await generateAndSimulate({
        client,
        targetCallback: () => "reply",
        agentDescription: "A test bot",
        numPersonas: 5,
        numScenarios: 1,
        uploadResults: false,
      });
      expect(results).toHaveLength(5);
      const total = usage.mock.calls.at(-1)?.[1];
      expect(total?.totalTokens).toBe(
        results.reduce(
          (sum, result) => sum + result.token_usage.total_tokens,
          0,
        ) +
          2 * 2 +
          results.length * 2,
      );
    } finally {
      usage.mockRestore();
    }
  });
  test("conflicting aliases reject before any provider request", async () => {
    const { client, requests } = makeFakeClient();
    await expect(
      simulate({
        client,
        targetCallback: () => "reply",
        datapoints: [datapoint],
        evaluatorNames: ["goal_achieved"],
        evaluators: ["criteria_met"],
        uploadResults: false,
      }),
    ).rejects.toThrow("must match");
    await expect(
      simulate({
        client,
        targetCallback: () => "reply",
        datapoints: [datapoint],
        timeoutPerSimulation: 10,
        perSimulationTimeoutMs: 20,
        uploadResults: false,
      }),
    ).rejects.toThrow("must match");
    expect(requests.judge).toHaveLength(0);
  });
  test("invalid scoring curves and unnormalized weights reject", () => {
    expect(
      () =>
        new SimulationScoringConfig({
          turnEfficiencyCliffs: [
            [2, 0.5],
            [4, 0.9],
          ],
        }),
    ).toThrow();
    expect(
      () => new SimulationScoringConfig({ goalAchievedWeight: 0.9 }),
    ).toThrow();
    expect(
      () => new SimulationScoringConfig({ turnEfficiencyFloor: 0.8 }),
    ).toThrow();
  });
});

describe("Responses target", () => {
  test("preserves usage, tools, telemetry and model", async () => {
    const client = wireClient(async () => ({
      ...response(""),
      model: "served-model",
      telemetry: { trace_id: "trace", span_id: "span" },
      output: [
        {
          type: "function_call",
          call_id: "call",
          name: "refund",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call", output: "done" },
      ],
    }));
    const target = new OrqResponsesTarget(
      new LLMCallConfig({ model: "configured-model" }),
      { client },
    );
    const result = await target.respond([]);
    expect(result.model).toBe("served-model");
    expect(result.usage?.totalTokens).toBe(5);
    expect(result.toolCalls[0]?.result).toBe("done");
    expect(result.traceId).toBe("trace");
    expect(result.spanId).toBe("span");
  });
  test("runner clones and closes targets and counts target usage", async () => {
    let clones = 0;
    let closes = 0;
    class Target extends AgentTarget {
      override newInstance() {
        clones++;
        return new Target();
      }
      override async respond(_messages: Message[]) {
        return new AgentResponse({
          text: "done",
          usage: UsageSchema.parse({
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          }),
        });
      }
      async close() {
        closes++;
      }
    }
    const { client } = makeFakeClient({
      judge: (call) => (call ? finishTurn([]) : continueTurn([])),
    });
    const runner = new SimulationRunner({ client, targetAgent: new Target() });
    const result = await runner.run({ datapoint });
    expect(result.terminated_by).toBe("judge");
    expect(result.token_usage.total_tokens).toBe(2 * 5 + 2 * 5 + 2);
    expect(
      result.turn_metrics.reduce(
        (sum, turn) => sum + turn.token_usage.total_tokens,
        0,
      ),
    ).toBe(result.token_usage.total_tokens);
    expect(clones).toBe(1);
    expect(closes).toBe(1);
    await runner.close();
  });
});

describe("simulation tool transcripts", () => {
  test("reused tool call ids stay paired to their own turns", () => {
    const call = {
      id: "reused",
      type: "function" as const,
      incomplete: false,
      item_id: null,
      function: { name: "lookup", arguments: "{}" },
    };
    const result = invertRolesForSimulator([
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "first", tool_call_id: "reused" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "second", tool_call_id: "reused" },
    ]);
    expect(result[0]?.content).toContain("first");
    expect(result[0]?.content).not.toContain("second");
    expect(result[1]?.content).toContain("second");
  });
  test("tool-only turns survive OpenResponses export and reconstruction", async () => {
    const { client } = makeFakeClient();
    const result = await new SimulationRunner({
      client,
      targetCallback: () => "reply",
    }).run({ datapoint });
    result.messages = [
      { role: "user", content: "buy" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call",
            type: "function",
            incomplete: false,
            item_id: "fc_real",
            function: { name: "buy", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "done", tool_call_id: "call" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "finished" },
    ];
    const exported = toOpenResponses(result);
    expect(exported.output.map((item) => item.type)).toEqual([
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(exported.metadata.item_order).toEqual([
      "input",
      "output",
      "output",
      "input",
      "output",
    ]);
    expect(
      responsesTranscript(exported)?.map((message) => [
        message.role,
        message.content,
      ]),
    ).toEqual(
      result.messages.map((message) => [message.role, message.content]),
    );
    expect(exported.output[0]?.id).toBe("fc_real");
  });
});

test("emits reusable generated cases before execution and bills dropped first-message attempts", async () => {
  const { client, requests } = makeFakeClient({
    generator: (request) => ({
      content: JSON.stringify(
        request.response_format?.type === "json_schema" &&
          request.response_format.json_schema.name === "personas"
          ? {
              personas: [
                {
                  ...persona,
                  name: JSON.stringify(request.messages).includes("BrokenSeed")
                    ? "BrokenSeed"
                    : "WorkingSeed",
                },
              ],
            }
          : { scenarios: [scenario] },
      ),
    }),
    firstMessage: (request) =>
      JSON.stringify(request.messages).includes("BrokenSeed")
        ? ""
        : "saved opener",
  });
  let emitted: import("../../../../src/lib/integrations/simulation/types.js").Datapoint[] =
    [];
  let total: number | undefined;
  const results = await generateAndSimulate({
    client,
    agentDescription: "Support",
    personaSeeds: ["WorkingSeed", "BrokenSeed"],
    numScenarios: 1,
    generationInstructions: "Use Dutch",
    edgeCasePercentage: 0,
    targetCallback: () => {
      expect(emitted).toHaveLength(1);
      return "reply";
    },
    emitDatapoints: (datapoints) => {
      emitted = datapoints;
    },
    onRun: (run) => {
      total = run.tokenUsageTotal?.totalTokens;
    },
    uploadResults: false,
    executiveSummary: false,
    recommendations: false,
    maxTurns: 1,
  });
  expect(results).toHaveLength(1);
  expect(emitted[0]?.first_message).toBe("saved opener");
  expect(results[0]?.messages[0]?.content).toBe("saved opener");
  expect(requests.firstMessage).toHaveLength(4);
  const billedTokens =
    2 *
      (requests.generator.length +
        requests.firstMessage.length +
        requests.userSimulator.length) +
    5 * requests.judge.length;
  expect(total).toBe(billedTokens);
});
