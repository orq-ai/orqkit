import { describe, expect, spyOn, test } from "bun:test";

import OpenAI from "openai";

import { responsesTextConfig } from "../../../../src/lib/common/responses.js";
import {
  DEFAULT_JUDGE_PROMPT,
  JudgeAgent,
  JudgeDecisionSchema,
} from "../../../../src/lib/integrations/simulation/agents/judge.js";
import {
  continueTurn,
  expectStrictSchema,
  finishTurn,
  makeFakeClient,
} from "./fake-client.js";

// ---------------------------------------------------------------------------
// JUDGE_TOOLS structure
// ---------------------------------------------------------------------------

describe("JudgeDecisionSchema", () => {
  const format = responsesTextConfig("JudgeDecision", JudgeDecisionSchema, {
    scrub: true,
  }).format;
  test("sends one closed decision schema", () => {
    expect(format.name).toBe("JudgeDecision");
    expect(format.strict).toBe(true);
    expectStrictSchema(format.schema);
    const schema = format.schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("should_terminate");
    expect(schema.properties).toHaveProperty("criteria_verdicts");
    expect(schema.properties).not.toHaveProperty("rules_broken");
  });
  test("keeps parser defaults off the wire", () => {
    const schema = format.schema as {
      properties: Record<string, Record<string, unknown>>;
    };
    for (const property of Object.values(schema.properties))
      expect(property).not.toHaveProperty("default");
  });
});

describe("JudgeAgent with strict answers", () => {
  const criteria = [
    { description: "offers a refund", type: "must_happen" as const },
  ];
  const messages = [{ role: "user" as const, content: "hi" }];

  test.each([
    ["continue", continueTurn],
    ["finish", finishTurn],
  ])(
    "%s: a null quality score stays unscored, not zero",
    async (_label, turn) => {
      const { client } = makeFakeClient({
        judge: () =>
          turn(
            [{ criterion_id: "criteria_0", occurred: false, evidence: null }],
            {
              response_quality: 0.9,
              hallucination_risk: null,
              tone_appropriateness: null,
              factual_accuracy: null,
            },
          ),
      });

      const judgment = await new JudgeAgent({ client, criteria }).evaluate(
        messages,
      );

      expect(judgment.response_quality).toBe(0.9);
      expect(judgment.hallucination_risk).toBeUndefined();
      expect(judgment.tone_appropriateness).toBeUndefined();
      expect(judgment.factual_accuracy).toBeUndefined();
      expect(judgment.criteria_verdicts).toBeNull();
    },
  );

  test("sends one strict decision schema", async () => {
    const { client, requests } = makeFakeClient();

    await new JudgeAgent({ client, criteria }).evaluate(messages);

    expect(requests.judge).toHaveLength(1);
    expect(requests.judge[0]?.text?.format?.strict).toBe(true);
    expect(requests.judge[0]?.tools).toBeUndefined();
  });

  const REJECTED_SCHEMA =
    "[openai] Invalid schema for function 'finish_conversation': In context=(), 'additionalProperties' is required to be supplied and to be false.";

  const rejecting = (status: number, message = REJECTED_SCHEMA) =>
    makeFakeClient({
      judge: (_call, request) => {
        if (request.text?.format?.strict) {
          throw new OpenAI.APIError(status, { message }, message, {});
        }
        return finishTurn([
          { criterion_id: "criteria_0", occurred: true, evidence: "q" },
        ]);
      },
    });

  test("a rejected judge decision schema surfaces without changing the decision contract", async () => {
    const { client, requests } = rejecting(400);
    await expect(
      new JudgeAgent({ client, criteria }).evaluate(messages),
    ).rejects.toThrow("Invalid schema");
    expect(requests.judge).toHaveLength(1);
  });

  test("a schema request error is not retried", async () => {
    const { client, requests } = makeFakeClient({
      judge: () => {
        throw new OpenAI.APIError(
          400,
          { message: REJECTED_SCHEMA },
          REJECTED_SCHEMA,
          {},
        );
      },
    });

    await expect(
      new JudgeAgent({ client, criteria }).evaluate(messages),
    ).rejects.toThrow("Invalid schema");
    expect(requests.judge).toHaveLength(1);
  });

  test("a 400 that does not name the schema does not drop strict", async () => {
    const { client, requests } = rejecting(
      400,
      "This model's maximum context length is 8192 tokens",
    );

    await expect(
      new JudgeAgent({ client, criteria }).evaluate(messages),
    ).rejects.toThrow("maximum context length");
    expect(requests.judge).toHaveLength(1);
  });

  const scoresFrom = (
    scores: Record<string, unknown>,
    groundTruth?: string,
  ) => {
    const { client } = makeFakeClient({
      judge: () =>
        continueTurn(
          [{ criterion_id: "criteria_0", occurred: false, evidence: null }],
          scores,
        ),
    });
    return new JudgeAgent({ client, criteria, groundTruth }).evaluate(messages);
  };

  test("factual_accuracy with no ground truth is dropped, not reported", async () => {
    const judgment = await scoresFrom({
      response_quality: 0.5,
      factual_accuracy: 0.9,
    });

    expect(judgment.response_quality).toBe(0.5);
    expect(judgment.factual_accuracy).toBeUndefined();
  });

  test("factual_accuracy with a ground truth is kept", async () => {
    const judgment = await scoresFrom(
      { factual_accuracy: 0.9 },
      "Refunds take 5 days",
    );

    expect(judgment.factual_accuracy).toBe(0.9);
  });

  test.each([[""], ["  "], [true], [[]]])(
    "a quality score of %j stays unscored",
    async (raw) => {
      const judgment = await scoresFrom({ response_quality: raw });

      expect(judgment.response_quality).toBeUndefined();
    },
  );

  test("a blank goal score on an achieved goal is not a perfect score", async () => {
    const { client } = makeFakeClient({
      judge: () =>
        finishTurn(
          [{ criterion_id: "criteria_0", occurred: true, evidence: "q" }],
          { goal_achieved: true, goal_completion_score: "" },
        ),
    });

    const judgment = await new JudgeAgent({ client, criteria }).evaluate(
      messages,
    );

    expect(judgment.goal_completion_score).toBe(0);
  });

  test.each([["high"], [true], ["Infinity"], ["0x1"], [""]])(
    "a goal score of %p scores 0 on both tools, achieved or not",
    async (raw) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const turn of [
          () =>
            finishTurn(
              [{ criterion_id: "criteria_0", occurred: true, evidence: "q" }],
              { goal_achieved: true, goal_completion_score: raw },
            ),
          () =>
            finishTurn(
              [{ criterion_id: "criteria_0", occurred: true, evidence: "q" }],
              { goal_achieved: false, goal_completion_score: raw },
            ),
          () =>
            continueTurn(
              [{ criterion_id: "criteria_0", occurred: false, evidence: null }],
              { goal_completion_score: raw },
            ),
        ]) {
          const { client } = makeFakeClient({ judge: turn });
          const judgment = await new JudgeAgent({ client, criteria }).evaluate(
            messages,
          );
          expect(judgment.goal_completion_score).toBe(0);
        }
        const scoreWarnings = warn.mock.calls.filter((call) =>
          String(call[0]).includes("goal_completion_score"),
        );
        expect(scoreWarnings).toHaveLength(3);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test.each([
    [7, 1],
    ["0.4", 0.4],
    [" 5e-1 ", 0.5],
    [-2, 0],
  ])("a numeric goal score %p is clamped to %p", async (raw, expected) => {
    const { client } = makeFakeClient({
      judge: () =>
        continueTurn(
          [{ criterion_id: "criteria_0", occurred: false, evidence: null }],
          { goal_completion_score: raw },
        ),
    });
    const judgment = await new JudgeAgent({ client, criteria }).evaluate(
      messages,
    );
    expect(judgment.goal_completion_score).toBe(expected);
  });

  test("an achieved finish with no score is a full score", async () => {
    const { client } = makeFakeClient({
      judge: () =>
        finishTurn(
          [{ criterion_id: "criteria_0", occurred: true, evidence: "q" }],
          { goal_achieved: true, goal_completion_score: null },
        ),
    });
    const judgment = await new JudgeAgent({ client, criteria }).evaluate(
      messages,
    );
    expect(judgment.goal_completion_score).toBe(1);
  });

  test("a quality score sent as a numeric string is read", async () => {
    const judgment = await scoresFrom({ response_quality: "0.8" });

    expect(judgment.response_quality).toBe(0.8);
  });

  test("an error that is not a 400 does not drop strict", async () => {
    const { client, requests } = rejecting(401);

    await expect(
      new JudgeAgent({ client, criteria }).evaluate(messages),
    ).rejects.toThrow("Invalid schema");
    expect(requests.judge).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_JUDGE_PROMPT
// ---------------------------------------------------------------------------

describe("DEFAULT_JUDGE_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof DEFAULT_JUDGE_PROMPT).toBe("string");
    expect(DEFAULT_JUDGE_PROMPT.length).toBeGreaterThan(100);
  });

  test("asks for a structured decision", () => {
    expect(DEFAULT_JUDGE_PROMPT).toContain("should_terminate");
  });

  test("mentions goal evaluation", () => {
    expect(DEFAULT_JUDGE_PROMPT).toContain("goal");
  });
});
