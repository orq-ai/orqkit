import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import {
  evaluatorqPipeline,
  evaluatorqRunId,
} from "../../../src/lib/common/thread-context.js";
import {
  DecompositionResultSchema,
  formatPlanForPrompt,
  LLMConfig,
  safeSubstitute,
  ToolCallStepSchema,
  ToolChainingPlanner,
  ToolChainingVerifier,
  VerificationResultSchema,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/tool-chaining-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const fixture of goldens.cases)
  it(`matches pinned verification and prompt for ${JSON.stringify(fixture.names)}`, () => {
    const [valid, results] = new ToolChainingVerifier(fixture.names).verifyAll(
      goldens.steps.map((step) => ToolCallStepSchema.parse(step)),
    );
    expect(valid).toEqual(
      fixture.valid.map((step) => ToolCallStepSchema.parse(step)),
    );
    expect(results).toEqual(
      fixture.results.map((result) => VerificationResultSchema.parse(result)),
    );
    expect(formatPlanForPrompt(valid)).toBe(fixture.prompt);
  });
for (const fixture of goldens.substitutions)
  it(`substitutes literal prompt placeholders once: ${fixture.template}`, () => {
    expect(
      safeSubstitute(
        fixture.template,
        fixture.replacements as Record<string, string>,
      ),
    ).toBe(fixture.expected);
  });
const parsed = {
  objective: "Synthetic lookup",
  steps: [
    {
      step_index: 5,
      tool_name: "lookup",
      argument_description: "city",
      benign_framing: "look it up",
    },
    {
      step_index: 0,
      tool_name: "convert",
      argument_description: "temperature",
      benign_framing: "convert it",
    },
  ],
  reasoning: "Lookup then convert",
};
function fake(content = JSON.stringify(parsed), finish = "stop") {
  const requests: Record<string, unknown>[] = [];
  const options: Record<string, unknown>[] = [];
  const client = {
    baseURL: "https://native.test",
    chat: {
      completions: {
        create: async (
          request: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => {
          requests.push(request);
          options.push(opts);
          return {
            model: "echo",
            choices: [{ finish_reason: finish, message: { content } }],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
              total_cost: 0.01,
            },
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, requests, options };
}
it("plans strict tool steps, uses emit order and retains role config, metadata and cost", async () => {
  const f = fake();
  const cfg = new LLMConfig({
    attacker: {
      api: "chat_completions",
      maxTokens: 4000,
      timeoutMs: 1000,
      reasoningEffort: "low",
      temperature: 0.2,
      extraKwargs: { seed: 7, metadata: { caller_key: "value" } },
      extraBody: { custom_key: { inner_key: true } },
    },
  });
  const result = await evaluatorqPipeline("redteam", () =>
    evaluatorqRunId("run", () =>
      new ToolChainingPlanner(f.client, "echo", cfg).decompose(
        "{agent_name}",
        "Target",
        "Description {tool_list}",
        ["lookup", "convert"],
      ),
    ),
  );
  expect(result.steps.map((step) => step.stepIndex)).toEqual([5, 0]);
  expect(result.tokenUsage).toMatchObject({
    totalTokens: 5,
    totalCost: 0.01,
    calls: 1,
  });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({
    model: "echo",
    max_completion_tokens: 4000,
    reasoning_effort: "low",
    temperature: 0.2,
    seed: 7,
    custom_key: { inner_key: true },
    metadata: {
      caller_key: "value",
      evaluatorq_pipeline: "redteam",
      evaluatorq_run_id: "run",
    },
  });
  const request = f.requests[0];
  if (!request) throw new Error("Missing request");
  const prompts = request.messages as { content: string }[];
  expect(prompts[1]?.content).toContain(
    "Malicious objective (T*): {agent_name}",
  );
  expect(prompts[1]?.content).toContain(
    "Agent description: Description {tool_list}",
  );
  const schema = JSON.stringify(request.response_format);
  expect(schema).toContain('"additionalProperties":false');
  expect(schema).toContain("step_index");
  expect(schema).not.toContain("token_usage");
  expect(f.options[0]).not.toHaveProperty("headers");
  expect(formatPlanForPrompt(result.steps)).toContain("1. Elicit the `lookup`");
});
it("does not drop rejected reasoning effort or retry the planner", async () => {
  let calls = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          throw Object.assign(new Error("reasoning_effort rejected"), {
            status: 400,
          });
        },
      },
    },
  } as unknown as OpenAI;
  await expect(
    new ToolChainingPlanner(
      client,
      "echo",
      new LLMConfig({ attacker: { reasoningEffort: "low" } }),
    ).decompose("Objective", "Target", "", ["lookup"]),
  ).rejects.toThrow("reasoning_effort");
  expect(calls).toBe(1);
});
for (const [content, finish] of [
  ["{", "stop"],
  [JSON.stringify(parsed), "length"],
  [JSON.stringify(parsed), "content_filter"],
  ["", "stop"],
])
  it(`retains billed usage on invalid planner response ${finish}/${content.slice(0, 2)}`, async () => {
    const f = fake(content, finish);
    try {
      await new ToolChainingPlanner(f.client, "echo").decompose(
        "Objective",
        "Target",
        "",
        ["lookup"],
      );
      throw new Error("Expected failure");
    } catch (error) {
      expect((error as { usage?: unknown }).usage).toMatchObject({
        calls: 1,
        totalCost: 0.01,
      });
    }
  });
it("times out and aborts a stuck planner without leaving timers or a retry", async () => {
  let signal: AbortSignal | undefined,
    calls = 0;
  const client = {
    chat: {
      completions: {
        create: (_request: unknown, opts: { signal: AbortSignal }) => {
          calls++;
          signal = opts.signal;
          return new Promise(() => {});
        },
      },
    },
  } as unknown as OpenAI;
  const cfg = new LLMConfig({ attacker: { timeoutMs: 5 } });
  await expect(
    new ToolChainingPlanner(client, "echo", cfg).decompose(
      "Objective",
      "Target",
      "",
      ["lookup"],
    ),
  ).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
});
it("loads Python saved decomposition records and writes canonical fields", () => {
  const result = DecompositionResultSchema.parse({
    ...parsed,
    token_usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 9,
      cached_tokens: 1,
      calls: 1,
    },
  });
  expect(result.tokenUsage).toMatchObject({ totalTokens: 9, cachedTokens: 1 });
  expect(result.steps[0]).toEqual({
    stepIndex: 5,
    toolName: "lookup",
    argumentDescription: "city",
    benignFraming: "look it up",
  });
  expect(JSON.stringify(result)).not.toContain("step_index");
});
