import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import { AgentContextSchema } from "../../../src/lib/contracts.js";
import {
  AttackStrategySchema,
  adaptPromptToTools,
  generateAttackPrompt,
  generateObjective,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/planner-attack-python-goldens.json" with {
  type: "json",
};

let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());
for (const fixture of goldens.adaptations)
  it(`matches Python tool adaptation and prompt: ${fixture.label}`, async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            return {
              model: "echo",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({ tools: fixture.tools }),
                  },
                },
              ],
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
    const context = AgentContextSchema.parse(fixture.context),
      strategy = AttackStrategySchema.parse(goldens.strategy);
    expect(
      await adaptPromptToTools("Base {tool_list}", context, strategy, client, {
        model: "echo",
      }),
    ).toBe(fixture.expected);
    expect(requests.map((request) => request.messages)).toEqual(fixture.calls);
  });
it("fills attack and objective templates once, and returns empty for an absent opening template", () => {
  const context = AgentContextSchema.parse({
    key: "key",
    displayName: "{tool_name}",
    tools: [{ name: "lookup" }],
  });
  const strategy = AttackStrategySchema.parse({
    ...goldens.strategy,
    prompt_template: "{agent_name}/{tool_name}",
    objective_template: "{tool_names}/{agent_name}",
  });
  expect(generateAttackPrompt(strategy, context)).toBe("{tool_name}/lookup");
  expect(generateObjective(strategy, context)).toBe("lookup/{tool_name}");
  expect(
    generateAttackPrompt(
      AttackStrategySchema.parse({
        ...goldens.strategy,
        prompt_template: null,
      }),
      context,
    ),
  ).toBe("");
});
it("propagates adaptation HTTP errors and cancellation instead of quietly removing targeting", async () => {
  let calls = 0;
  const error = Object.assign(new Error("forbidden"), { status: 403 });
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          throw error;
        },
      },
    },
  } as unknown as OpenAI;
  const context = AgentContextSchema.parse({
      key: "echo",
      tools: [{ name: "lookup" }],
    }),
    strategy = AttackStrategySchema.parse(goldens.strategy);
  await expect(
    adaptPromptToTools("Base", context, strategy, client, { model: "echo" }),
  ).rejects.toBe(error);
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    adaptPromptToTools("Base", context, strategy, client, {
      model: "echo",
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
