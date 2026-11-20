import { describe, expect, it } from "bun:test";

import {
  applyOrAll,
  FILTERS,
  parseSelections,
} from "../../../src/lib/dashboard/filters.js";

const sim = (k: Record<string, unknown>) => ({
  terminated_by: "judge",
  goal_achieved: true,
  goal_completion_score: 1,
  rules_broken: [],
  turn_count: 3,
  token_usage: { total_tokens: 100 },
  turn_metrics: [],
  metadata: { persona: "p1", scenario: "s1" },
  ...k,
});

const run = {
  results: [
    sim({}),
    sim({
      goal_achieved: false,
      goal_completion_score: 0.2,
      turn_count: 8,
      metadata: { persona: "p2" },
      turn_metrics: [{ hallucination_risk: 0.9 }, { hallucination_risk: 0.1 }],
    }),
    sim({ rules_broken: ["r"], turn_metrics: [{ response_quality: 0.3 }] }),
  ],
};

describe("dashboard filters", () => {
  it("returns everything with no selections", () => {
    expect(applyOrAll(run, "sim", {})).toHaveLength(3);
    expect(applyOrAll({ results: [1] }, "zzz", { a: ["b"] })).toEqual([1]);
  });

  it("narrows sim runs per dimension", () => {
    const n = (s: Record<string, string[]>) => applyOrAll(run, "sim", s).length;
    expect(n({ persona: ["unknown", "p1"] })).toBe(2);
    expect(n({ goal_outcome: ["Not achieved"] })).toBe(1);
    expect(n({ goal_outcome: ["Achieved", "Not achieved"] })).toBe(3);
    expect(n({ rule_broken: ["yes"] })).toBe(1);
    expect(n({ max_goal_score: ["0.5"] })).toBe(1);
    expect(n({ min_turns: ["5"] })).toBe(1);
    expect(n({ min_turns: ["junk"] })).toBe(3);
    expect(n({ min_hallucination_risk: ["0.5"] })).toBe(3);
    expect(n({ min_hallucination_risk: ["0.95"] })).toBe(2);
    expect(n({ max_response_quality: ["0.2"] })).toBe(2);
  });

  it("lists options from the full run", () => {
    const o = FILTERS.sim?.options(run) ?? {};
    expect(o.persona).toEqual(["p1", "p2"]);
    expect(o.scenario).toEqual(["s1", "unknown"]);
    expect(o.max_turns).toEqual(["8"]);
    expect(o.metrics).toEqual(["response_quality", "hallucination_risk"]);
  });

  it("parses only registered dimensions from the query", () => {
    const q = new URLSearchParams("persona=a&persona=b&bogus=1");
    expect(parseSelections(q, "sim")).toEqual({ persona: ["a", "b"] });
    expect(parseSelections(q, "zzz")).toEqual({});
  });
});
