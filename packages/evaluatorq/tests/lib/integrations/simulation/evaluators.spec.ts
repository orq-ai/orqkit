import { describe, expect, test } from "bun:test";

import {
  conversationQualityScorer,
  criteriaMetScorer,
  failureReason,
  getAllEvaluators,
  getEvaluator,
  goalAchievedScorer,
  turnEfficiencyScorer,
  unverifiedReason,
} from "../../../../src/lib/integrations/simulation/evaluators/index.js";
import type { SimulationResult } from "../../../../src/lib/integrations/simulation/types.js";

function makeResult(
  overrides: Partial<SimulationResult> = {},
): SimulationResult {
  return {
    messages: [],
    terminated_by: "judge",
    reason: "test",
    goal_achieved: false,
    goal_completion_score: 0,
    rules_broken: [],
    turn_count: 1,
    token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    turn_metrics: [],
    metadata: {},
    ...overrides,
  };
}

describe("goalAchievedScorer", () => {
  test("returns 1 when goal achieved", () => {
    expect(goalAchievedScorer(makeResult({ goal_achieved: true }))).toBe(1);
  });

  test("returns 0 when goal not achieved", () => {
    expect(goalAchievedScorer(makeResult({ goal_achieved: false }))).toBe(0);
  });
});

describe("criteriaMetScorer", () => {
  test("returns 1.0 when no criteria", () => {
    expect(criteriaMetScorer(makeResult())).toBe(1.0);
  });

  test("returns 1.0 when all criteria met", () => {
    expect(
      criteriaMetScorer(makeResult({ criteria_results: { a: true, b: true } })),
    ).toBe(1.0);
  });

  test("returns 0.5 when half met", () => {
    expect(
      criteriaMetScorer(
        makeResult({ criteria_results: { a: true, b: false } }),
      ),
    ).toBe(0.5);
  });

  test("returns 0 when none met", () => {
    expect(
      criteriaMetScorer(
        makeResult({ criteria_results: { a: false, b: false } }),
      ),
    ).toBe(0);
  });

  test("returns 0 for an errored run even when criteria look met", () => {
    expect(
      criteriaMetScorer(
        makeResult({ terminated_by: "error", criteria_results: { a: true } }),
      ),
    ).toBe(0);
  });

  test("returns 0 for a timed out run", () => {
    expect(
      criteriaMetScorer(
        makeResult({ terminated_by: "timeout", criteria_results: { a: true } }),
      ),
    ).toBe(0);
  });

  test("returns 0 when the judge never audited the criteria", () => {
    expect(
      criteriaMetScorer(
        makeResult({
          criteria_verified: false,
          criteria_results: { a: true },
        }),
      ),
    ).toBe(0);
  });

  test("a criterion that passed without an audit does not count as met", () => {
    const entry = {
      id: "criteria_0",
      description: "a",
      type: "must_not_happen",
      passed: true,
      evidence: "",
    };
    expect(
      criteriaMetScorer(
        makeResult({
          criteria_verified: true,
          metadata: {
            criteria_meta: [
              { ...entry, audited: true },
              { ...entry, id: "criteria_1", audited: false },
            ],
          },
        }),
      ),
    ).toBe(0.5);
  });

  test("returns 0 for malformed criteria_meta", () => {
    expect(
      criteriaMetScorer(makeResult({ metadata: { criteria_meta: "broken" } })),
    ).toBe(0);
    expect(
      criteriaMetScorer(makeResult({ metadata: { criteria_meta: [{}] } })),
    ).toBe(0);
  });
});

describe("unverifiedReason", () => {
  test("names why a run cannot vouch for its criteria", () => {
    expect(unverifiedReason(makeResult({ terminated_by: "error" }))).toBe(
      "terminated_by=error",
    );
    expect(unverifiedReason(makeResult({ criteria_verified: false }))).toBe(
      "criteria_verified=False",
    );
    expect(unverifiedReason(makeResult())).toBeNull();
  });
});

describe("failureReason", () => {
  test("is null unless the run errored or timed out", () => {
    expect(failureReason(makeResult())).toBeNull();
    expect(failureReason(makeResult({ criteria_verified: false }))).toBeNull();
  });

  test("prefers metadata.error, then the reason", () => {
    expect(
      failureReason(
        makeResult({
          terminated_by: "error",
          reason: "fallback",
          metadata: { error: "exact" },
        }),
      ),
    ).toBe("exact");
    expect(
      failureReason(makeResult({ terminated_by: "timeout", reason: "late" })),
    ).toBe("late");
  });
});

describe("turnEfficiencyScorer", () => {
  test("returns 0 when goal not achieved", () => {
    expect(
      turnEfficiencyScorer(makeResult({ goal_achieved: false, turn_count: 1 })),
    ).toBe(0);
  });

  test("returns 1.0 for 1-2 turns when goal achieved", () => {
    expect(
      turnEfficiencyScorer(makeResult({ goal_achieved: true, turn_count: 1 })),
    ).toBe(1.0);
    expect(
      turnEfficiencyScorer(makeResult({ goal_achieved: true, turn_count: 2 })),
    ).toBe(1.0);
  });

  test("returns 0.9 for 3-4 turns", () => {
    expect(
      turnEfficiencyScorer(makeResult({ goal_achieved: true, turn_count: 3 })),
    ).toBe(0.9);
  });

  test("returns 0.7 for 5-6 turns", () => {
    expect(
      turnEfficiencyScorer(makeResult({ goal_achieved: true, turn_count: 5 })),
    ).toBe(0.7);
  });

  test("degrades for many turns but floors at 0.3", () => {
    expect(
      turnEfficiencyScorer(makeResult({ goal_achieved: true, turn_count: 20 })),
    ).toBe(0.3);
  });
});

describe("conversationQualityScorer", () => {
  test("perfect score when goal achieved in 1 turn with all criteria met", () => {
    const result = makeResult({
      goal_achieved: true,
      turn_count: 1,
      criteria_results: { a: true },
    });
    expect(conversationQualityScorer(result)).toBe(1.0);
  });

  test("zero when nothing achieved", () => {
    const result = makeResult({
      goal_achieved: false,
      turn_count: 10,
      criteria_results: { a: false },
    });
    expect(conversationQualityScorer(result)).toBe(0);
  });
});

describe("getEvaluator", () => {
  test("returns known evaluators", () => {
    expect(typeof getEvaluator("goal_achieved")).toBe("function");
    expect(typeof getEvaluator("criteria_met")).toBe("function");
    expect(typeof getEvaluator("turn_efficiency")).toBe("function");
    expect(typeof getEvaluator("conversation_quality")).toBe("function");
  });

  test("throws on unknown evaluator", () => {
    expect(() => getEvaluator("nonexistent")).toThrow("Unknown evaluator");
  });
});

describe("getAllEvaluators", () => {
  test("returns all 4 evaluators", () => {
    const all = getAllEvaluators();
    expect(Object.keys(all)).toHaveLength(4);
  });

  test("returns a copy (not the original)", () => {
    const a = getAllEvaluators();
    const b = getAllEvaluators();
    expect(a).not.toBe(b);
  });
});
