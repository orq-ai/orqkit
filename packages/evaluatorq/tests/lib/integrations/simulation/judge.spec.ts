import { describe, expect, test } from "bun:test";

import {
  DEFAULT_JUDGE_PROMPT,
  JUDGE_TOOLS,
} from "../../../../src/lib/integrations/simulation/agents/judge.js";

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
