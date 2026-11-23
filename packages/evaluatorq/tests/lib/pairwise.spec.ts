import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Prediction } from "../../src/lib/common/jury.js";
import {
  btSigmaAggregation,
  buildReport,
  hasRepeatedOrdering,
  type PairwiseComparison,
  PairwiseComparisonSchema,
  type PairwiseVoteInput,
  pairwiseConsensus,
  reconcilePair,
  repetitionConsistency,
  repetitionConsistencyRaw,
  runPairwise,
} from "../../src/lib/pairwise.js";
import { newRun, PairwiseRun } from "../../src/lib/pairwise-run.js";

let silenced: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  silenced = [
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const spy of silenced) {
    spy.mockRestore();
  }
});

const comparison = (
  winner: string,
  votes: PairwiseVoteInput[],
): PairwiseComparison => PairwiseComparisonSchema.parse({ winner, votes });

const v = (
  model: string,
  vote: "A" | "B" | "tie" | null,
  extra: Partial<PairwiseVoteInput> = {},
): PairwiseVoteInput => ({ model, vote, ...extra });

// Picks the response whose text is "good", wherever it sits.
const honest = async (first: string, second: string): Promise<Prediction> => ({
  value: first === "good" ? "A" : second === "good" ? "B" : "tie",
  explanation: "because",
});

describe("reconcile and consensus", () => {
  test("reconcilePair", () => {
    expect(reconcilePair("A", "A")).toEqual({ vote: "A", flipped: false });
    expect(reconcilePair("A", "B")).toEqual({ vote: null, flipped: true });
    expect(reconcilePair(null, "B")).toEqual({ vote: null, flipped: false });
  });

  test("pairwiseConsensus", () => {
    expect(pairwiseConsensus(["A", "A", "B", null])).toBe("A");
    expect(pairwiseConsensus(["A", "B"])).toBe("inconclusive");
    expect(pairwiseConsensus([null])).toBe("inconclusive");
  });
});

describe("runPairwise", () => {
  test("an honest judge wins for the good response in both orderings", async () => {
    const result = await runPairwise({
      panel: ["j1", "j2", "j3"],
      responseA: "bad",
      responseB: "good",
      judgeFn: honest,
    });
    expect(result.winner).toBe("B");
    expect(result.votes.every((x) => x.completed && !x.flipped)).toBe(true);
    expect(result.votes[0]?.observations.map((o) => o.verdict)).toEqual([
      "B",
      "B",
    ]);
    expect(result.judgeLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("partial token usage from a judge is summed across orderings", async () => {
    const result = await runPairwise({
      panel: ["j"],
      responseA: "good",
      responseB: "bad",
      judgeFn: async (first, second) => ({
        ...(await honest(first, second)),
        tokenUsage: { inputTokens: 10, totalTokens: 12 },
      }),
    });
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 20,
      totalTokens: 24,
      outputTokens: 0,
    });
  });

  test("a slot follower flips and abstains", async () => {
    const result = await runPairwise({
      panel: ["slot"],
      responseA: "x",
      responseB: "y",
      judgeFn: async () => ({ value: "A" }),
    });
    expect(result.winner).toBe("inconclusive");
    expect(result.votes[0]).toMatchObject({ vote: null, flipped: true });
  });

  test("without swap nothing can flip or complete", async () => {
    const result = await runPairwise({
      panel: ["slot"],
      responseA: "x",
      responseB: "y",
      swap: false,
      judgeFn: async () => ({ value: "A" }),
    });
    expect(result.winner).toBe("A");
    expect(result.votes[0]).toMatchObject({
      vote: "A",
      flipped: false,
      completed: false,
    });
  });

  test("a stand-in runs in both orderings for a judge failing one", async () => {
    const seen: string[] = [];
    const result = await runPairwise({
      panel: ["down"],
      replacementJudges: ["r"],
      responseA: "good",
      responseB: "bad",
      judgeFn: async (first, second, model) => {
        seen.push(model);
        if (model === "down" && first === "bad") {
          throw new Error("x");
        }
        return honest(first, second);
      },
    });
    expect(seen.filter((m) => m === "r")).toHaveLength(2);
    expect(result.votes.map((x) => x.model)).toEqual(["down", "r"]);
    expect(result.votes[1]).toMatchObject({ vote: "A", replacement: true });
    expect(result.winner).toBe("A");
  });

  test("an off-contract verdict raises", async () => {
    await expect(
      runPairwise({
        panel: ["j"],
        responseA: "x",
        responseB: "y",
        judgeFn: async () => ({ value: true }),
      }),
    ).rejects.toThrow("expected 'A', 'B', or 'tie'");
  });

  test("minSuccessfulJudges gates the winner", async () => {
    const result = await runPairwise({
      panel: ["j"],
      minSuccessfulJudges: 2,
      responseA: "good",
      responseB: "bad",
      judgeFn: honest,
    });
    expect(result.winner).toBe("inconclusive");
  });
});

const observed = (ordering: "ab" | "ba", ...verdicts: ("A" | "B" | null)[]) =>
  verdicts.map((verdict, repetition) => ({ ordering, repetition, verdict }));

describe("repetition consistency", () => {
  test("raw is pure agreement and the weight is discounted and shrunk", () => {
    const data = [
      comparison("A", [
        v("clean", "A", { observations: observed("ab", "A", "A") }),
        v("flaky", "A", {
          observations: observed("ab", "A", "A", null, null),
          repetitionFailures: 2,
        }),
      ]),
    ];
    expect(repetitionConsistencyRaw(data)).toEqual({ clean: 1, flaky: 1 });
    const shrunk = repetitionConsistency(data);
    expect(shrunk.clean as number).toBeGreaterThan(shrunk.flaky as number);
    expect(shrunk.clean as number).toBeLessThan(1);
    expect(shrunk.clean).toBeCloseTo(0.875);
    expect(shrunk.flaky).toBeCloseTo(0.625);
  });

  test("hasRepeatedOrdering needs one ordering run twice", () => {
    const single = [
      comparison("A", [
        v("j", "A", {
          observations: [...observed("ab", "A"), ...observed("ba", "A")],
        }),
      ]),
    ];
    const repeated = [
      comparison("A", [
        v("j", "A", { observations: observed("ab", "A", null) }),
      ]),
    ];
    expect(hasRepeatedOrdering(single)).toBe(false);
    expect(hasRepeatedOrdering(repeated)).toBe(true);
    expect(repetitionConsistency(repeated)).toEqual({});
  });
});

describe("btSigmaAggregation", () => {
  test("single-ordering data falls back to plurality", () => {
    const result = btSigmaAggregation([
      comparison("A", [v("j", "A", { completed: false })]),
    ]);
    expect(result.fitWarnings.join()).toContain("single-ordering");
    expect(result.winners).toEqual(["A"]);
  });

  test("no decisive votes", () => {
    const result = btSigmaAggregation([
      comparison("inconclusive", [v("j", null)]),
    ]);
    expect(result.inconclusiveRate).toBe(1);
    expect(result.fitWarnings).toEqual(["no decisive votes to fit on"]);
  });

  test("a unanimous judge loses its sigma and is flagged", () => {
    const data = ["A", "A", "A", "A", "B", "B", "A", "A", "A", "B"].map(
      (vote) =>
        comparison(vote, [
          v("mixed1", vote as "A"),
          v("mixed2", vote as "A"),
          v("always", "A"),
        ]),
    );
    const result = btSigmaAggregation(data);
    expect(result.judgeSigmas.always).toBeUndefined();
    expect(result.judgeSigmas.mixed1).toBeDefined();
    expect(result.fitWarnings.join()).toContain("judge 'always' voted 'A'");
    expect(result.pABeatsB).toBeGreaterThan(0.5);
    expect(result.winners).toHaveLength(10);
  });

  test("repetition consistency decides weights when two judges are measured", () => {
    const steady = observed("ab", "A", "A");
    const shaky = observed("ab", "A", "B");
    const data = [
      comparison("A", [
        v("steady", "A", { observations: steady }),
        v("shaky", "B", { observations: shaky }),
      ]),
    ];
    const result = btSigmaAggregation(data);
    expect(result.winners).toEqual(["A"]);
    expect(result.fitWarnings.join()).toContain(
      "within-datapoint repetition consistency (2 judge(s), 1 datapoint(s)",
    );
  });
});

describe("buildReport", () => {
  test("rolls up headline and per-judge rates", () => {
    const report = buildReport([
      comparison("A", [v("x", "A"), v("y", "A")]),
      comparison("B", [v("x", "B"), v("y", "A")]),
      comparison("tie", [v("x", "tie"), v("y", null, { flipped: true })]),
      comparison("inconclusive", [v("x", null, { completed: false })]),
    ]);
    expect(report).toMatchObject({
      comparisons: 4,
      aWinRate: 0.5,
      bWinRate: 0.5,
      tieRate: 0.25,
      inconclusiveRate: 0.25,
      btSigma: null,
    });
    expect(report.meanAgreement).toBeCloseTo(0.75);
    const y = report.perJudge.find((j) => j.model === "y");
    expect(y).toMatchObject({ aRate: 1, positionBias: 1 / 3 });
    expect(report.perJudge.find((j) => j.model === "x")?.tieRate).toBe(0.25);
  });

  test("rejects an unknown aggregation", () => {
    expect(() => buildReport([], "nope" as "plurality")).toThrow("unknown");
  });
});

describe("PairwiseRun", () => {
  let dir: string;
  const previous = process.env.EVALUATORQ_DIR;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pairwise-"));
    process.env.EVALUATORQ_DIR = dir;
  });
  afterEach(async () => {
    if (previous === undefined) {
      delete process.env.EVALUATORQ_DIR;
    } else {
      process.env.EVALUATORQ_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const filled = () => {
    const run = newRun({ runName: "My Run: ünï!", judges: ["j"] });
    run.add(comparison("A", [v("j", "A")]), {
      question: "q",
      responseA: "a",
      responseB: "b",
    });
    return run;
  };

  test("saves, never overwrites, and round-trips", async () => {
    const run = filled();
    const first = await run.save();
    const second = await run.save();
    expect(first).not.toBe(second);
    expect(first).toContain("my-run-ünï.json");
    expect(await readdir(join(dir, "pairwise-runs"))).toHaveLength(2);
    const loaded = await PairwiseRun.load(first);
    expect(loaded.report?.aWinRate).toBe(1);
    expect(loaded.comparisons()).toEqual(run.comparisons());
    expect(loaded.judging).toBe("pairwise");
  });

  test("rollup recomputes when the stored report lacks bt-sigma", async () => {
    const run = filled();
    await run.save();
    expect(run.report?.btSigma).toBeNull();
    expect(run.rollup("bt-sigma").btSigma).not.toBeNull();
  });

  test("warns when the fit pools different tasks", () => {
    const run = filled();
    run.add(comparison("A", [v("j", "A")]), {
      question: "other",
      responseA: "a",
      responseB: "b",
    });
    expect(run.rollup("bt-sigma").btSigma?.fitWarnings.join()).toContain(
      "2 distinct question/response pairs",
    );
  });
});
