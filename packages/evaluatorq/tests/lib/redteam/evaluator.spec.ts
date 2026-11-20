import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import type OpenAI from "openai";

import {
  EvaluatorResponsePayload,
  type JudgeEndpoint,
  type JudgeError,
  type JudgeOutcome,
} from "../../../src/lib/common/judge.js";
import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
} from "../../../src/lib/common/model-catalogue.js";
import { renderTemplate } from "../../../src/lib/common/template-engine.js";
import {
  AgentResponse,
  LLMCallConfig,
  MessageSchema,
  parseUsage,
} from "../../../src/lib/contracts.js";
import {
  AttackEvaluationResult,
  AttackEvaluationResultSchema,
  getEvaluatorForCategory,
  OWASPEvaluator,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/evaluator-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>,
  errors: ReturnType<typeof spyOn<typeof console, "error">>,
  oldTracing: string | undefined;
beforeEach(() => {
  oldTracing = process.env.ORQ_DISABLE_TRACING;
  process.env.ORQ_DISABLE_TRACING = "1";
  warn = spyOn(console, "warn").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  for (const model of ["judge", "other", "third", "standby"])
    registerModel(
      model,
      new ModelInfo({
        inputCostPer1k: null,
        outputCostPer1k: null,
        provider: "test",
        supportsResponses: false,
      }),
    );
});
afterEach(() => {
  warn.mockRestore();
  errors.mockRestore();
  clearModelOverrides();
  if (oldTracing === undefined) delete process.env.ORQ_DISABLE_TRACING;
  else process.env.ORQ_DISABLE_TRACING = oldTracing;
});
const cfg = () =>
  new LLMCallConfig({
    model: "judge",
    api: "chat_completions",
    timeoutMs: 5,
    retryCount: 0,
  });
function canonicalExpected(raw: unknown): AttackEvaluationResult {
  const result = new AttackEvaluationResult(raw);
  result.explanation = result.explanation.replace(/^\[TIE - /, "[TIE: ");
  if (typeof result.rawOutput?.explanation === "string")
    result.rawOutput.explanation = result.rawOutput.explanation.replace(
      /^\[TIE - /,
      "[TIE: ",
    );
  const failure = result.rawOutput?.evaluation_error;
  if (failure && typeof failure === "object") {
    const value = failure as Record<string, unknown>;
    const alias = (object: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(object).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
          value,
        ]),
      );
    result.rawOutput = {
      ...result.rawOutput,
      evaluation_error: {
        ...alias(value),
        details:
          value.details && typeof value.details === "object"
            ? alias(value.details as Record<string, unknown>)
            : value.details,
      },
    };
  }
  return result;
}
for (const fixture of goldens.mapper)
  it(`matches pinned single-judge result mapping ${fixture.label}`, () => {
    const raw = fixture.outcome;
    const outcome: JudgeOutcome = {
      payload:
        raw.payload === null ? null : new EvaluatorResponsePayload(raw.payload),
      tokenUsage: raw.tokenUsage === null ? null : parseUsage(raw.tokenUsage),
      rawContent: raw.rawContent,
      rawOutput: null,
      errorKind: raw.errorKind as JudgeError | null,
      errorMessage: raw.errorMessage,
      errorExc: null,
      timeoutMs: raw.timeoutMs,
      endpoint: raw.endpoint as JudgeEndpoint | null,
    };
    const result = new OWASPEvaluator({
      evaluatorModel: "judge",
      llmClient: {} as OpenAI,
      cfg: cfg(),
    }).singleOutcomeToResult(outcome, "goal_hijacking");
    expect(result.toJSON()).toEqual(
      canonicalExpected(fixture.expected).toJSON(),
    );
  });
for (const fixture of goldens.flows)
  it(`matches pinned OWASP judge panel ${fixture.label}`, async () => {
    const queues: Record<string, unknown[]> = Object.fromEntries(
      Object.entries(fixture.results).map(([model, values]) => [
        model,
        [...values],
      ]),
    );
    const requests: Record<string, unknown>[] = [];
    const client = {
      baseURL: "https://native.test",
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            const value = queues[String(request.model)]?.shift();
            if (typeof value === "string")
              throw Object.assign(new Error(`synthetic ${value}`), {
                status: 503,
              });
            return {
              model: String(request.model),
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      explanation: "Synthetic verdict",
                      abstain: false,
                      value,
                    }),
                  },
                  finish_reason: "stop",
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
    const evaluator = new OWASPEvaluator({
      evaluatorModel: "judge",
      llmClient: client,
      cfg: cfg(),
      judges: fixture.judges,
      repetitions: fixture.repetitions,
      replacementJudges: fixture.replacements,
      minSuccessfulJudges: fixture.quorum,
    });
    const messages = goldens.messages.map((message) =>
        MessageSchema.parse(message),
      ),
      output = AgentResponse.fromJSON({ output: goldens.output }).output;
    const result = await evaluator.evaluate("ASI01", messages, output);
    expect(result.toJSON()).toEqual(
      canonicalExpected(fixture.expected).toJSON(),
    );
    expect(requests.map((request) => request.model)).toEqual(
      fixture.calls.map((call) => call.model),
    );
    const call = fixture.calls[0];
    if (!call) throw new Error("Missing source request");
    for (const request of requests)
      expect((request.messages as { content: string }[])[1]?.content).toBe(
        renderTemplate(call.prompt, call.replacements),
      );
    expect(getEvaluatorForCategory("ASI01", "judge")?.prompt).toBe(
      fixture.calls[0]?.prompt,
    );
  });
it("loads and resaves Python jury models without altering free diagnostic keys", () => {
  const fixture = goldens.flows.find((flow) => flow.label === "repetitions");
  if (!fixture) throw new Error("Missing jury");
  const result = new AttackEvaluationResult({
    ...fixture.expected,
    raw_output: { under_score: { free_key: true } },
  });
  expect(result.jury?.judgesConfigured).toBe(1);
  expect(result.jury?.votes[0]?.repetitions).toHaveLength(3);
  expect(result.toJSON()).toMatchObject({
    rawOutput: { under_score: { free_key: true } },
  });
  expect(result.toJSON()).not.toHaveProperty("evaluator_id");
  expect(
    AttackEvaluationResultSchema.safeParse({
      passed: null,
      explanation: "Missing id",
    }).success,
  ).toBe(false);
});
it("de-duplicates panel/replacements, validates the effective quorum and rejects strict self-judging", () => {
  const evaluator = new OWASPEvaluator({
    evaluatorModel: "judge",
    llmClient: {} as OpenAI,
    cfg: cfg(),
    judges: ["judge", "other", "other"],
    replacementJudges: ["judge", "standby", "standby"],
    repetitions: 0,
    minSuccessfulJudges: 0,
  });
  expect(evaluator.panel).toEqual(["judge", "other"]);
  expect(evaluator.replacementJudges).toEqual(["standby"]);
  expect(evaluator.repetitions).toBe(1);
  expect(evaluator.minSuccessfulJudges).toBe(1);
  expect(
    () =>
      new OWASPEvaluator({
        evaluatorModel: "judge",
        llmClient: {} as OpenAI,
        judges: ["judge"],
        minSuccessfulJudges: 2,
      }),
  ).toThrow("effective panel size");
  expect(
    () =>
      new OWASPEvaluator({
        evaluatorModel: "openai/judge",
        llmClient: {} as OpenAI,
        targetModels: ["openai/target"],
        strictPanel: true,
      }),
  ).toThrow();
});
it("preserves generic unknown-category results, aliases to the vulnerability evaluator and constructor request extras", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          return {
            model: "judge",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Resisted",
                    abstain: false,
                    value: true,
                  }),
                },
                finish_reason: "stop",
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
  const base = cfg();
  const evaluator = new OWASPEvaluator({
    evaluatorModel: "judge",
    llmClient: client,
    cfg: base,
    llmKwargs: { seed: 7 },
  });
  expect((await evaluator.evaluate("future", [], [])).toJSON()).toMatchObject({
    passed: null,
    evaluatorId: "none",
    rawOutput: null,
  });
  expect(requests).toHaveLength(0);
  const result = await evaluator.evaluate("LLM03", [], []);
  expect(result.evaluatorId).toBe("supply_chain");
  expect(result.passed).toBe(true);
  expect(requests[0]).toMatchObject({ seed: 7 });
  expect(base.extraKwargs).toEqual({});
});

it("coerces typed content and retains non-null input tool fields for judging", async () => {
  let request: Record<string, unknown> | undefined;
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          request = body;
          return {
            model: "judge",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    explanation: "Resisted",
                    abstain: false,
                    value: true,
                  }),
                },
                finish_reason: "stop",
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
  const messages = [
    MessageSchema.parse({
      role: "user",
      content: [{ type: "input_text", text: "Structured text" }],
    }),
    MessageSchema.parse({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    }),
  ];
  await new OWASPEvaluator({
    evaluatorModel: "judge",
    llmClient: client,
    cfg: cfg(),
  }).evaluate("ASI01", messages, []);
  const prompt = String(
    (request?.messages as { content: string }[])[1]?.content,
  );
  expect(prompt).toContain('"content": "Structured text"');
  expect(prompt).toContain('"name": "lookup"');
  expect(prompt).not.toContain('"name": null');
});
it("reads Python repetition diagnostics without renaming provider metadata", () => {
  const result = new AttackEvaluationResult({
    passed: true,
    explanation: "Resisted",
    evaluator_id: "fixture",
    jury: {
      judges_configured: 1,
      judges_succeeded: 1,
      judges_failed: 0,
      votes: [
        {
          model: "judge",
          success: true,
          value: true,
          repetitions: [
            { value: true, raw_output: { provider_key: { under_score: 1 } } },
          ],
        },
      ],
    },
  });
  expect(result.jury?.votes[0]?.repetitions[0]?.rawOutput).toEqual({
    provider_key: { under_score: 1 },
  });
  expect(
    new AttackEvaluationResult(JSON.parse(JSON.stringify(result))).toJSON(),
  ).toEqual(result.toJSON());
});
