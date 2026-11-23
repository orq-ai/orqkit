import { describe, expect, it } from "bun:test";

import type { ReportCard } from "../../../src/lib/common/dashboard/library.js";
import type {
  Landing,
  RedTeamOverview,
  RedTeamRunRow,
  RunRow,
  SimOverview,
  SimRunRow,
} from "../../../src/lib/dashboard/metrics.js";
import {
  headAssets,
  landingBody,
  redteamOverviewBody,
  reportActions,
  reportBackLink,
  runCompareControl,
  runsScreenBody,
  searchResults,
  simOverviewBody,
} from "../../../src/lib/dashboard/view.js";
import golden from "./fixtures/view-golden.json" with { type: "json" };

// Golden HTML rendered by the Python view.py from the same fixtures (frozen at NOW).
const NOW = new Date("2026-11-13T12:00:00Z");

const rr = (k: Partial<RunRow> = {}): RunRow => ({
  id: "r1",
  surface: "redteam",
  name: "Job <a>",
  when: "2h ago",
  headline: "12 attacks",
  score: 0.85,
  status: "finished",
  error: false,
  evaluated: 10,
  attacks: 12,
  storedScore: null,
  ...k,
});

const recent = [
  rr(),
  rr({
    id: "s1",
    surface: "sim",
    score: 0.5,
    status: "error",
    error: true,
    storedScore: 0.61,
    attacks: 0,
  }),
  rr({ id: "p1", surface: "pairwise", score: null, status: "weird" }),
];

const landing = {
  totalRuns: 3,
  tokensByKind: [
    ["Red team", 1_234_567],
    ["Agent sim", 3],
  ],
  totalCost: 1.5,
  costedRuns: 2,
  totalInputCost: 1.0,
  totalOutputCost: null,
  pricedCalls: 3,
  costCalls: 10,
  unknownCalls: 2,
  byKind: [
    ["Red team", 328],
    ["Agent sim", 1],
  ],
  severity: [
    ["critical", 0],
    ["high", 5],
    ["unknown", 1],
  ],
  costByKind: [
    ["Red team", 1234.5],
    ["Pairwise", 0.0001],
  ],
  recent,
} as unknown as Landing;

const simrow = (k: Partial<SimRunRow> = {}): SimRunRow => ({
  rid: "s1",
  name: "Sim A",
  when: new Date("2026-11-13T10:00:00Z"),
  targets: [["agent-1", "orq_agent"]],
  status: "finished",
  score: null,
  cases: 10,
  cost: 0.0123,
  error: false,
  achieved: 7,
  errors: 1,
  ...k,
});

const rtrow = (k: Partial<RedTeamRunRow> = {}): RedTeamRunRow => ({
  rid: "t1",
  name: "RT A",
  when: new Date("2026-10-01T10:00:00Z"),
  targets: [
    ["dep", "orq_deployment"],
    ["x", "callback"],
  ],
  status: "finished",
  score: null,
  cases: 1200,
  cost: 12.5,
  error: false,
  vulnerable: 3,
  evaluated: 10,
  ...k,
});

const sim = {
  totalRuns: 30,
  goalCompletion: 0.7,
  achieved: 7,
  simulationsRun: 10,
  errors: 1,
  avgTurns: 3.25,
  totalCost: 2.0,
  pricedCalls: 4,
  costCalls: 5,
  unknownCalls: 0,
  page: 2,
  perPage: 8,
  recent: [
    simrow(),
    simrow({
      rid: "s2",
      cases: 2,
      errors: 2,
      status: "error",
      error: true,
      targets: [],
      when: new Date("2025-01-02T00:00:00Z"),
    }),
  ],
} as unknown as SimOverview;

const rt = {
  totalRuns: 12,
  breakRate: 0.3,
  criticalFindings: 0,
  attacksRun: 1500,
  totalCost: null,
  pricedCalls: 0,
  costCalls: 0,
  unknownCalls: 0,
  page: 1,
  perPage: 8,
  recent: [
    rtrow(),
    rtrow({
      rid: "t2",
      evaluated: 0,
      status: "running",
      targets: [["m", "openai_model"]],
    }),
    rtrow({ rid: "t3", vulnerable: 1, evaluated: 10, targets: [] }),
    rtrow({ rid: "t4", vulnerable: 2, evaluated: 10, status: "error" }),
  ],
} as unknown as RedTeamOverview;

const cards = [
  { id: "a", name: "Alpha", surface: "redteam" },
  { id: "b", name: "beta", surface: "sim" },
] as unknown as ReportCard[];

const g = golden as Record<string, string>;

describe("dashboard view parity with view.py", () => {
  it("renders the landing page", () => {
    expect(landingBody(landing)).toBe(g.landing);
    expect(landingBody({ ...landing, totalRuns: 0 })).toBe(g.landing_empty);
    expect(
      landingBody({
        ...landing,
        totalCost: null,
        totalInputCost: null,
        severity: [],
        costByKind: [],
        tokensByKind: [],
        byKind: [],
      }),
    ).toBe(g.landing_bare);
  });

  it("renders the agent sim overview", () => {
    expect(simOverviewBody(sim, NOW)).toBe(g.sim);
    expect(
      simOverviewBody(
        {
          ...sim,
          totalRuns: 1,
          page: 1,
          goalCompletion: null,
          errors: 0,
          avgTurns: null,
          totalCost: 0.5,
          unknownCalls: 3,
        },
        NOW,
      ),
    ).toBe(g.sim_small);
    expect(simOverviewBody({ ...sim, totalRuns: 0 }, NOW)).toBe(g.sim_empty);
  });

  it("renders the red team overview", () => {
    expect(redteamOverviewBody(rt, NOW)).toBe(g.rt);
    expect(
      redteamOverviewBody(
        {
          ...rt,
          totalRuns: 1,
          breakRate: 0.05,
          criticalFindings: 2,
          totalCost: 3.0,
          pricedCalls: 2,
          costCalls: 4,
          unknownCalls: 1,
        },
        NOW,
      ),
    ).toBe(g.rt_one);
  });

  it("renders run lists, search, compare and report chrome", () => {
    expect(runsScreenBody(recent, "sim")).toBe(g.runs);
    expect(runsScreenBody([], "pairwise")).toBe(g.runs_empty);
    expect(searchResults(cards, " red ")).toBe(g.search_red);
    expect(searchResults(cards, "zzz")).toBe(g.search_none);
    expect(searchResults(cards, "")).toBe(g.search_blank);
    expect(
      runCompareControl(
        "a",
        [
          ["a", "A"],
          ["b", "B<"],
        ],
        "/compare/sim",
      ),
    ).toBe(g.cmp);
    expect(runCompareControl("a", [["a", "A"]], "/x")).toBe(g.cmp_none);
    expect(reportBackLink("redteam")).toBe(g.back_rt);
    expect(reportBackLink("zzz")).toBe(g.back_other);
    expect(reportActions("r/1")).toBe(g.actions);
  });

  it("only ships the vega scripts with charts", () => {
    expect(headAssets()).toHaveLength(2);
    expect(headAssets({ charts: true })).toHaveLength(5);
  });
});
