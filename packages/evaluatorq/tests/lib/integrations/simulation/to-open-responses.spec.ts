import { describe, expect, test } from "bun:test";

import type {
  InputTextContent,
  Message,
  OutputTextContent,
} from "../../../../src/lib/integrations/openresponses/index.js";
import { toOpenResponses } from "../../../../src/lib/integrations/simulation/convert.js";
import type { SimulationResult } from "../../../../src/lib/integrations/simulation/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  overrides: Partial<SimulationResult> = {},
): SimulationResult {
  return {
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    terminated_by: "judge",
    reason: "Goal achieved",
    goal_achieved: true,
    goal_completion_score: 1.0,
    rules_broken: [],
    turn_count: 1,
    token_usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    turn_metrics: [],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toOpenResponses", () => {
  test("1. returns a valid ResponseResource shape", () => {
    const res = toOpenResponses(makeResult());

    expect(res.object).toBe("response");
    expect(res.id).toMatch(/^resp_/);
    expect(typeof res.created_at).toBe("number");
  });

  test("2. user messages → input with input_text content", () => {
    const res = toOpenResponses(makeResult());

    expect(res.input).toHaveLength(1);
    const msg = res.input[0] as Message;
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("user");
    expect(msg.status).toBe("completed");
    expect(msg.id).toMatch(/^msg_/);
    const content = msg.content[0] as InputTextContent;
    expect(content.type).toBe("input_text");
    expect(content.text).toBe("Hello");
  });

  test("3. assistant messages → output with output_text content", () => {
    const res = toOpenResponses(makeResult());

    expect(res.output).toHaveLength(1);
    const msg = res.output[0] as Message;
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.status).toBe("completed");
    const content = msg.content[0] as OutputTextContent;
    expect(content.type).toBe("output_text");
    expect(content.text).toBe("Hi there!");
    expect(content.annotations).toEqual([]);
    expect(content.logprobs).toEqual([]);
  });

  test("4. system messages → input", () => {
    const res = toOpenResponses(
      makeResult({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
      }),
    );

    expect(res.input).toHaveLength(2);
    const systemMsg = res.input[0] as Message;
    expect(systemMsg.role).toBe("system");
    const content = systemMsg.content[0] as InputTextContent;
    expect(content.text).toBe("You are helpful");

    const userMsg = res.input[1] as Message;
    expect(userMsg.role).toBe("user");
  });

  test("5. multi-turn conversation preserves message order", () => {
    const res = toOpenResponses(
      makeResult({
        messages: [
          { role: "user", content: "msg1" },
          { role: "assistant", content: "msg2" },
          { role: "user", content: "msg3" },
          { role: "assistant", content: "msg4" },
        ],
      }),
    );

    expect(res.input).toHaveLength(2);
    expect(res.output).toHaveLength(2);
    expect((res.input[0] as Message).content[0]).toMatchObject({
      text: "msg1",
    });
    expect((res.input[1] as Message).content[0]).toMatchObject({
      text: "msg3",
    });
    expect((res.output[0] as Message).content[0]).toMatchObject({
      text: "msg2",
    });
    expect((res.output[1] as Message).content[0]).toMatchObject({
      text: "msg4",
    });
  });

  test("6. terminated_by 'judge' → status 'completed'", () => {
    const res = toOpenResponses(makeResult({ terminated_by: "judge" }));

    expect(res.status).toBe("completed");
    expect(res.completed_at).not.toBeNull();
    expect(res.incomplete_details).toBeNull();
  });

  test("7. terminated_by 'max_turns' → status 'incomplete'", () => {
    const res = toOpenResponses(
      makeResult({ terminated_by: "max_turns", reason: "Max turns reached" }),
    );

    expect(res.status).toBe("incomplete");
    expect(res.completed_at).toBeNull();
    expect(res.incomplete_details).toEqual({
      reason: "max_turns: Max turns reached",
    });
  });

  test("8. terminated_by 'error' → status 'incomplete' + error field", () => {
    const res = toOpenResponses(
      makeResult({ terminated_by: "error", reason: "LLM call failed" }),
    );

    expect(res.status).toBe("incomplete");
    expect(res.error).toEqual({ message: "LLM call failed" });
  });

  test("9. terminated_by 'timeout' → status 'incomplete'", () => {
    const res = toOpenResponses(
      makeResult({ terminated_by: "timeout", reason: "Timed out" }),
    );

    expect(res.status).toBe("incomplete");
    expect(res.incomplete_details).toEqual({ reason: "timeout: Timed out" });
    expect(res.error).toBeNull();
  });

  test("10. token_usage mapped to Usage", () => {
    const res = toOpenResponses(
      makeResult({
        token_usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      }),
    );

    expect(res.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 150,
    });
  });

  test("11. zero token_usage → usage is null", () => {
    const res = toOpenResponses(
      makeResult({
        token_usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }),
    );

    expect(res.usage).toBeNull();
  });

  test("12. metadata includes simulation-specific fields", () => {
    const res = toOpenResponses(
      makeResult({
        goal_achieved: true,
        goal_completion_score: 0.8,
        terminated_by: "judge",
        reason: "Goal achieved",
        turn_count: 3,
        rules_broken: ["rule1"],
        criteria_results: { "criterion A": true, "criterion B": false },
      }),
    );

    expect(res.metadata).toMatchObject({
      framework: "simulation",
      goal_achieved: true,
      goal_completion_score: 0.8,
      terminated_by: "judge",
      reason: "Goal achieved",
      turn_count: 3,
      rules_broken: ["rule1"],
      criteria_results: { "criterion A": true, "criterion B": false },
    });
  });

  test("13. criteria_results omitted from metadata when undefined", () => {
    const res = toOpenResponses(makeResult({ criteria_results: undefined }));

    expect(res.metadata).not.toHaveProperty("criteria_results");
  });

  test("14. turn_metrics omitted from metadata when empty", () => {
    const res = toOpenResponses(makeResult({ turn_metrics: [] }));

    expect(res.metadata).not.toHaveProperty("turn_metrics");
  });

  test("15. turn_metrics included when non-empty", () => {
    const metrics = [
      {
        turn_number: 1,
        token_usage: {
          prompt_tokens: 5,
          completion_tokens: 5,
          total_tokens: 10,
        },
        response_quality: 0.9,
        hallucination_risk: 0.1,
        tone_appropriateness: 0.8,
        factual_accuracy: null,
        judge_reason: "Good response",
      },
    ];
    const res = toOpenResponses(makeResult({ turn_metrics: metrics }));

    expect(res.metadata).toHaveProperty("turn_metrics");
    expect((res.metadata as Record<string, unknown>).turn_metrics).toEqual(
      metrics,
    );
  });

  test("16. custom model name is used", () => {
    const res = toOpenResponses(makeResult(), "gpt-4o");

    expect(res.model).toBe("gpt-4o");
  });

  test("17. default model is 'simulation'", () => {
    const res = toOpenResponses(makeResult());

    expect(res.model).toBe("simulation");
  });

  test("18. empty messages → empty input and output", () => {
    const res = toOpenResponses(makeResult({ messages: [] }));

    expect(res.input).toEqual([]);
    expect(res.output).toEqual([]);
  });

  test("19. each message gets a unique ID", () => {
    const res = toOpenResponses(
      makeResult({
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "assistant", content: "c" },
          { role: "assistant", content: "d" },
        ],
      }),
    );

    const allIds = [
      ...(res.input as Message[]).map((m) => m.id),
      ...(res.output as Message[]).map((m) => m.id),
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  test("20. non-error terminated_by has null error field", () => {
    for (const terminated_by of ["judge", "max_turns", "timeout"] as const) {
      const res = toOpenResponses(
        makeResult({ terminated_by, reason: "test" }),
      );
      expect(res.error).toBeNull();
    }
  });
});
