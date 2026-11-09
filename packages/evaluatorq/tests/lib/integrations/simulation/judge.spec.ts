import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  DEFAULT_JUDGE_PROMPT,
  JUDGE_TOOLS,
  JudgeAgent,
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

describe("JUDGE_TOOLS", () => {
  test("has exactly 2 tools", () => {
    expect(JUDGE_TOOLS).toHaveLength(2);
  });

  test("first tool is continue_conversation", () => {
    const tool = JUDGE_TOOLS[0];
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("continue_conversation");
    expect(tool.function.parameters).toBeDefined();
  });

  test("second tool is finish_conversation", () => {
    const tool = JUDGE_TOOLS[1];
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("finish_conversation");
  });

  test("finish_conversation requires goal_achieved, criteria_verdicts, goal_completion_score", () => {
    const tool = JUDGE_TOOLS[1];
    const required = (tool.function.parameters as { required?: string[] })
      .required;
    expect(required).toContain("goal_achieved");
    expect(required).toContain("criteria_verdicts");
    expect(required).toContain("goal_completion_score");
    expect(required).toContain("reason");
  });

  test("continue_conversation requires criteria_verdicts and offers a progress score", () => {
    const parameters = JUDGE_TOOLS[0].function.parameters as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(parameters.required).toContain("criteria_verdicts");
    expect(parameters.properties).toHaveProperty("goal_completion_score");
  });

  test.each([0, 1])(
    "tool %d is a strict schema every model can enforce",
    (i) => {
      const fn = JUDGE_TOOLS[i].function;
      expect(fn.strict).toBe(true);
      expectStrictSchema(fn.parameters);
    },
  );

  test.each([0, 1])(
    "tool %d lets the judge leave a quality score unscored",
    (i) => {
      const props = (
        JUDGE_TOOLS[i].function.parameters as {
          properties: Record<string, { anyOf?: { type: string }[] }>;
        }
      ).properties;
      for (const field of [
        "response_quality",
        "hallucination_risk",
        "tone_appropriateness",
        "factual_accuracy",
      ]) {
        expect(props[field]?.anyOf?.map((option) => option.type)).toEqual([
          "number",
          "null",
        ]);
      }
    },
  );

  test.each([0, 1])("tool %d lets a verdict carry no evidence", (i) => {
    const props = (
      JUDGE_TOOLS[i].function.parameters as {
        properties: {
          criteria_verdicts: {
            items: {
              properties: { evidence: { anyOf?: { type: string }[] } };
            };
          };
        };
      }
    ).properties;
    expect(
      props.criteria_verdicts.items.properties.evidence.anyOf?.map(
        (option) => option.type,
      ),
    ).toEqual(["string", "null"]);
  });

  test.each([0, 1])("tool %d keeps the field descriptions", (i) => {
    const props = (
      JUDGE_TOOLS[i].function.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(props.reason?.description).toBeTruthy();
    expect(props.goal_completion_score?.description).toContain("0.0");
    expect(props.criteria_verdicts?.description).toContain("Occurrence audit");
    expect(props.factual_accuracy?.description).toContain("ground truth");
  });

  test("neither tool lets the judge report pass or fail", () => {
    for (const tool of JUDGE_TOOLS) {
      const props = (
        tool.function.parameters as { properties: Record<string, unknown> }
      ).properties;
      expect(props).not.toHaveProperty("rules_broken");
    }
  });

  test("both tools have quality score properties", () => {
    const qualityFields = [
      "response_quality",
      "hallucination_risk",
      "tone_appropriateness",
      "factual_accuracy",
    ];
    for (const tool of JUDGE_TOOLS) {
      const props = (
        tool.function.parameters as {
          properties: Record<string, unknown>;
        }
      ).properties;
      for (const field of qualityFields) {
        expect(props).toHaveProperty(field);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Strict answers
// ---------------------------------------------------------------------------

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
      expect(judgment.criteria_verdicts?.[0]?.evidence).toBe("");
    },
  );

  test("sends strict tools and stops there when the model accepts them", async () => {
    const { client, requests } = makeFakeClient();

    await new JudgeAgent({ client, criteria }).evaluate(messages);

    expect(requests.judge).toHaveLength(1);
    expect(requests.judge[0]?.tools?.map((tool) => tool.strict)).toEqual([
      true,
      true,
    ]);
  });

  const REJECTED_SCHEMA =
    "[openai] Invalid schema for function 'finish_conversation': In context=(), 'additionalProperties' is required to be supplied and to be false.";

  const rejecting = (status: number, message = REJECTED_SCHEMA) =>
    makeFakeClient({
      judge: (_call, request) => {
        if (request.tools?.some((tool) => tool.strict)) {
          throw new OpenAI.APIError(status, { message }, message, {});
        }
        return finishTurn([
          { criterion_id: "criteria_0", occurred: true, evidence: "q" },
        ]);
      },
    });

  test("a 400 on strict tools retries once with the same schema, not strict", async () => {
    const { client, requests } = rejecting(400);

    const judgment = await new JudgeAgent({ client, criteria }).evaluate(
      messages,
    );

    expect(judgment.should_terminate).toBe(true);
    expect(judgment.criteria_verdicts?.[0]?.occurred).toBe(true);
    expect(requests.judge).toHaveLength(2);
    expect(requests.judge[1]?.tools?.map((tool) => tool.strict)).toEqual([
      false,
      false,
    ]);
    expect(requests.judge[1]?.tools?.map((tool) => tool.parameters)).toEqual(
      requests.judge[0]?.tools?.map((tool) => tool.parameters) as never,
    );
  });

  test("a 400 on both attempts raises", async () => {
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
    expect(requests.judge).toHaveLength(2);
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

  test("mentions tool calling", () => {
    expect(DEFAULT_JUDGE_PROMPT).toContain("tool");
  });

  test("mentions goal evaluation", () => {
    expect(DEFAULT_JUDGE_PROMPT).toContain("goal");
  });
});
