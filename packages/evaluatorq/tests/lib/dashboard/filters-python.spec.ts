// Ported from res-697 tests/dashboard/test_filter.py (FilterDef, goal outcome,
// red team result/turns and sim metric threshold unit tests).
import { describe, expect, it } from "bun:test";

import { FILTERS } from "../../../src/lib/dashboard/filters.js";

type Obj = Record<string, unknown>;

const rtResult = (
  category: string,
  passed: boolean | null,
  extra: Obj = {},
): Obj => ({
  attack: {
    id: `${category}-${passed}`,
    category,
    attackTechnique: "indirect-injection",
    deliveryMethods: ["direct-request"],
    turnType: "single",
    severity: "medium",
    vulnerability: "",
    source: "test",
  },
  agent: { key: "agent-a", displayName: null },
  vulnerable: passed === false,
  error: null,
  execution: null,
  ...extra,
});

const withSeverity = (r: Obj, severity: string): Obj => ({
  ...r,
  attack: { ...(r.attack as Obj), severity },
});

const rtReport = () => ({
  results: [
    rtResult("ASI01", true),
    rtResult("ASI01", false),
    rtResult("LLM01", false),
    withSeverity(rtResult("LLM01", true), "high"),
  ],
});

const rtResults = () => ({
  results: [
    rtResult("ASI01", false),
    rtResult("ASI01", true),
    rtResult("LLM01", null, { error: "boom" }),
    rtResult("LLM02", false),
    rtResult("ASI01", false, { execution: { turns: 3 } }),
  ],
});

const tokens = (total: number) => ({ total_tokens: total });

const simResult = (persona: string, k: Obj = {}): Obj => ({
  terminated_by: "judge",
  goal_achieved: true,
  goal_completion_score: 1,
  rules_broken: [],
  turn_count: 2,
  turn_metrics: [],
  token_usage: tokens(15),
  metadata: { persona, scenario: "billing" },
  ...k,
});

const simRun = () => ({
  results: [
    simResult("alice"),
    simResult("alice", { goal_achieved: false, goal_completion_score: 0 }),
    simResult("bob"),
  ],
});

const metricRun = () => ({
  results: [
    simResult("alice", {
      goal_completion_score: 0.9,
      rules_broken: ["criteria_0"],
      turn_count: 3,
      token_usage: tokens(150),
      turn_metrics: [
        {
          response_quality: 0.8,
          hallucination_risk: 0.2,
          tone_appropriateness: 0.9,
          factual_accuracy: 0.85,
        },
      ],
    }),
    simResult("risky", {
      goal_achieved: false,
      goal_completion_score: 0.3,
      turn_count: 5,
      token_usage: tokens(500),
      turn_metrics: [
        {
          response_quality: 0.6,
          hallucination_risk: 0.9,
          tone_appropriateness: 0.5,
          factual_accuracy: 0.4,
        },
      ],
    }),
    simResult("unscored", { turn_count: 1 }),
  ],
});

const rt = FILTERS.redteam as NonNullable<typeof FILTERS.redteam>;
const sim = FILTERS.sim as NonNullable<typeof FILTERS.sim>;
const personas = (rs: unknown[]) =>
  new Set(rs.map((r) => ((r as Obj).metadata as Obj).persona));

describe("FilterDef unit (test_filter.py)", () => {
  it("registers redteam and sim", () => {
    expect(FILTERS.redteam).toBeDefined();
    expect(FILTERS.sim).toBeDefined();
  });

  it("redteam options keys and delivery values", () => {
    const opts = rt.options(rtReport());
    for (const k of [
      "result",
      "category",
      "severity",
      "technique",
      "delivery_method",
      "vulnerability",
      "agent",
    ])
      expect(opts).toHaveProperty(k);
    expect(opts.delivery_method).toEqual(["direct-request"]);
  });

  it("redteam delivery, category and empty filters", () => {
    const r = rtReport();
    expect(rt.apply(r, { delivery_method: ["direct-request"] })).toHaveLength(
      4,
    );
    expect(rt.apply(r, { delivery_method: ["base64"] })).toEqual([]);
    const cat = rt.apply(r, { category: ["ASI01"] }) as Obj[];
    expect(cat).toHaveLength(2);
    expect(cat.every((x) => (x.attack as Obj).category === "ASI01")).toBe(true);
    expect(rt.apply(r, {})).toHaveLength(4);
  });

  it("options stay full after filtering", () => {
    const r = rtReport();
    const full = rt.options(r);
    expect(full.category).toEqual(["ASI01", "LLM01"]);
    rt.apply(r, { category: ["ASI01"] });
    expect(rt.options(r).category).toEqual(full.category ?? []);
    const s = simRun();
    expect(sim.options(s).persona).toEqual(["alice", "bob"]);
  });

  it("sim persona and goal outcome", () => {
    const s = simRun();
    expect(personas(sim.apply(s, { persona: ["alice"] }))).toEqual(
      new Set(["alice"]),
    );
    expect(sim.apply(s, { persona: ["alice"] })).toHaveLength(2);
    expect(
      (sim.apply(s, { goal_outcome: ["Achieved"] }) as Obj[]).every(
        (r) => r.goal_achieved,
      ),
    ).toBe(true);
    expect(
      (sim.apply(s, { goal_outcome: ["Not achieved"] }) as Obj[]).every(
        (r) => !r.goal_achieved,
      ),
    ).toBe(true);
    expect(sim.apply(s, { goal_outcome: [] })).toHaveLength(3);
    expect(
      sim.apply(s, { goal_outcome: ["Achieved", "Not achieved"] }),
    ).toHaveLength(3);
    expect(sim.options(s).goal_outcome).toEqual(["Achieved", "Not achieved"]);
  });
});

describe("red team result and turns (test_filter.py)", () => {
  it("zero or all result classes means all", () => {
    const r = rtResults();
    expect(rt.apply(r, { result: [] })).toHaveLength(5);
    expect(
      rt.apply(r, {
        result: ["Vulnerable", "Resistant", "Not evaluated", "Error"],
      }),
    ).toHaveLength(5);
  });

  it("single Vulnerable and min turns", () => {
    const r = rtResults();
    const v = rt.apply(r, { result: ["Vulnerable"] }) as Obj[];
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.vulnerable && !x.error)).toBe(true);
    expect(rt.apply(r, { min_turns: ["2"] })).toHaveLength(1);
    expect(rt.apply(r, { min_turns: ["1"] })).toHaveLength(5);
    const opts = rt.options(r);
    expect(opts.result).toEqual([
      "Vulnerable",
      "Resistant",
      "Not evaluated",
      "Error",
    ]);
    expect(opts.max_turns).toEqual(["3"]);
  });
});

describe("sim metric filters (test_filter.py)", () => {
  it("rule broken is opt in", () => {
    const s = metricRun();
    expect(
      (sim.apply(s, { rule_broken: ["yes"] }) as Obj[]).map(
        (r) => r.rules_broken,
      ),
    ).toEqual([["criteria_0"]]);
    expect(sim.apply(s, {})).toHaveLength(3);
  });

  it("thresholds use the worst turn and keep unscored results", () => {
    const s = metricRun();
    const p = (sel: Record<string, string[]>) => personas(sim.apply(s, sel));
    expect(p({ min_hallucination_risk: ["0.70"] })).toEqual(
      new Set(["risky", "unscored"]),
    );
    expect(p({ max_response_quality: ["0.70"] })).toEqual(
      new Set(["risky", "unscored"]),
    );
    expect(p({ max_goal_score: ["0.5"] })).toEqual(new Set(["risky"]));
    expect(p({ min_turns: ["3"] })).toEqual(new Set(["alice", "risky"]));
    expect(p({ min_total_tokens: ["100"] })).toEqual(
      new Set(["alice", "risky"]),
    );
  });

  it("bad and non-positive inputs are no-ops", () => {
    const s = metricRun();
    expect(sim.apply(s, { max_goal_score: ["not-a-number"] })).toHaveLength(3);
    for (const bad of ["0", "-5"]) {
      expect(sim.apply(s, { min_turns: [bad] })).toHaveLength(3);
      expect(sim.apply(s, { min_total_tokens: [bad] })).toHaveLength(3);
    }
  });

  it("full options expose raw maxima and available metrics", () => {
    const opts = sim.options(metricRun());
    expect(opts.max_turns).toEqual(["5"]);
    expect(opts.max_total_tokens).toEqual(["500"]);
    expect(new Set(opts.metrics)).toEqual(
      new Set([
        "response_quality",
        "hallucination_risk",
        "tone_appropriateness",
        "factual_accuracy",
      ]),
    );
    expect(sim.options({ results: [simResult("x")] }).metrics).toEqual([]);
  });
});
