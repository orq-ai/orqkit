// Ported from res-697 tests/dashboard/test_pairwise_filters.py (unit tests; route tests come with app.ts).
import { describe, expect, it } from "bun:test";

import {
  applyOrAll,
  FILTERS,
  type Selections,
} from "../../../src/lib/dashboard/filters.js";
import {
  type PairwiseComparison,
  PairwiseComparisonSchema,
  type PairwiseVoteInput,
} from "../../../src/lib/pairwise.js";
import {
  newRun,
  type PairwiseEntry,
  type PairwiseRun,
} from "../../../src/lib/pairwise-run.js";

const JUDGES = ["judge-one", "judge-two", "judge-three"];
type V = PairwiseVoteInput["vote"];

const vote = (
  model: string,
  value: V,
  k: { flipped?: boolean; failures?: number } = {},
) => ({
  model,
  vote: value,
  flipped: k.flipped ?? false,
  completed: true,
  repetitionFailures: k.failures ?? 0,
  explanation: `${model} says ${value}`,
});

const comparison = (
  values: V[],
  winner: string,
  k: { flipped?: boolean } = {},
) =>
  PairwiseComparisonSchema.parse({
    winner,
    votes: values.map((v, i) => vote(JUDGES[i] as string, v, k)),
  });

const raw = (
  winner: string,
  votes: ReturnType<typeof vote>[],
): PairwiseComparison => PairwiseComparisonSchema.parse({ winner, votes });

const add = (r: PairwiseRun, c: PairwiseComparison, question: string) =>
  r.add(c, { question, responseA: "a", responseB: "b" });

function fixture(): PairwiseRun {
  const r = newRun({
    runName: "v2 vs v3",
    labelA: "prompt-v2",
    labelB: "prompt-v3",
    judges: JUDGES,
    criteria: "accuracy",
  });
  add(r, comparison(["A", "A", "A"], "A"), "q1");
  add(r, comparison(["A", "B", "tie"], "tie"), "q2");
  add(r, comparison(["B", "B", "B"], "B"), "q3");
  add(
    r,
    comparison([null, null, null], "inconclusive", { flipped: true }),
    "q4",
  );
  return r;
}

const f = FILTERS.pairwise;
const apply = (r: PairwiseRun, s: Selections) =>
  f.apply(r, s) as PairwiseEntry[];
const qs = (entries: PairwiseEntry[]) => entries.map((e) => e.question);
const same = (label: string) =>
  newRun({ runName: label, labelA: "x", labelB: "x", judges: JUDGES });

describe("pairwise filters", () => {
  it("declares dimensions in rail order", () => {
    expect(f.dimensions).toEqual([
      "winner",
      "split",
      "thrown_out",
      "judge_failed",
      "judge",
    ]);
  });

  it("lists labels then outcomes and judges", () => {
    const opts = f.options(fixture());
    expect(opts.winner).toEqual([
      "prompt-v2",
      "prompt-v3",
      "tie",
      "inconclusive",
    ]);
    expect(opts.judge).toEqual(JUDGES);
    for (const dim of ["split", "thrown_out", "judge_failed"])
      expect(opts).not.toHaveProperty(dim);
  });

  it("falls back to slot letters for equal labels", () => {
    expect(f.options(same("same")).winner).toEqual([
      "A",
      "B",
      "tie",
      "inconclusive",
    ]);
  });

  it("returns every entry in order for empty selections", () => {
    const run = fixture();
    const out = apply(run, {});
    expect(qs(out)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(apply(run, { winner: [], judge: [] })).toEqual(out);
    expect(f.results(run)).toEqual(out);
  });

  it("preserves entry identity", () => {
    const run = fixture();
    const out = apply(run, { winner: ["prompt-v3", "tie"] });
    expect(out[0]).toBe(run.entries[1] as PairwiseEntry);
    expect(out[1]).toBe(run.entries[2] as PairwiseEntry);
  });

  it("maps winner labels back to sides", () => {
    const run = fixture();
    expect(qs(apply(run, { winner: ["prompt-v2"] }))).toEqual(["q1"]);
    expect(qs(apply(run, { winner: ["prompt-v3"] }))).toEqual(["q3"]);
    expect(qs(apply(run, { winner: ["tie"] }))).toEqual(["q2"]);
    expect(qs(apply(run, { winner: ["inconclusive"] }))).toEqual(["q4"]);
    expect(qs(apply(run, { winner: ["prompt-v2", "inconclusive"] }))).toEqual([
      "q1",
      "q4",
    ]);
    expect(
      qs(
        apply(run, {
          winner: ["prompt-v2", "prompt-v3", "tie", "inconclusive"],
        }),
      ),
    ).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("uses slot letters for winners with equal labels", () => {
    const r = same("same");
    add(r, comparison(["A", "A", "A"], "A"), "qa");
    add(r, comparison(["B", "B", "B"], "B"), "qb");
    expect(qs(apply(r, { winner: ["B"] }))).toEqual(["qb"]);
  });

  it("keeps split, inconclusive and thrown-out panels", () => {
    const run = fixture();
    expect(qs(apply(run, { split: ["yes"] }))).toEqual(["q2", "q4"]);
    expect(qs(apply(run, { thrown_out: ["yes"] }))).toEqual(["q4"]);
  });

  it("judge_failed covers repetition failures and missing judges", () => {
    const r = newRun({ runName: "fail", judges: JUDGES });
    add(r, comparison(["A", "A", "A"], "A"), "ok");
    add(
      r,
      raw("A", [
        vote("judge-one", "A", { failures: 1 }),
        vote("judge-two", "A"),
        vote("judge-three", "A"),
      ]),
      "retried",
    );
    add(
      r,
      raw("A", [vote("judge-one", "A"), vote("judge-two", "A")]),
      "absent",
    );
    expect(qs(apply(r, { judge_failed: ["yes"] }))).toEqual([
      "retried",
      "absent",
    ]);
  });

  it("judge keeps entries where a selected judge voted", () => {
    const r = newRun({ runName: "judges", judges: JUDGES });
    add(r, comparison(["A", "A", "A"], "A"), "all");
    add(r, raw("A", [vote("judge-two", "A")]), "two");
    add(r, raw("A", [vote("judge-one", "A")]), "one");
    expect(qs(apply(r, { judge: ["judge-two"] }))).toEqual(["all", "two"]);
    expect(qs(apply(r, { judge: ["judge-one", "judge-two"] }))).toEqual([
      "all",
      "two",
      "one",
    ]);
    expect(qs(apply(r, { judge: JUDGES }))).toEqual(["all", "two", "one"]);
  });

  it("judge filter needs a cast vote", () => {
    const r = newRun({ runName: "judges", judges: JUDGES });
    add(r, comparison(["A", "A", "A"], "A"), "voted");
    add(r, comparison(["A", "A", null], "A"), "abstained");
    expect(qs(apply(r, { judge: ["judge-three"] }))).toEqual(["voted"]);
    expect(qs(apply(r, { judge: ["judge-one"] }))).toEqual([
      "voted",
      "abstained",
    ]);
  });

  it("intersects winner and split, and dispatches through applyOrAll", () => {
    const run = fixture();
    expect(qs(apply(run, { winner: ["tie"], split: ["yes"] }))).toEqual(["q2"]);
    expect(apply(run, { winner: ["prompt-v2"], split: ["yes"] })).toEqual([]);
    expect(
      qs(
        applyOrAll(run, "pairwise", { thrown_out: ["yes"] }) as PairwiseEntry[],
      ),
    ).toEqual(["q4"]);
  });

  it("falls back to slot letters when a label collides with an outcome", () => {
    const r = newRun({
      runName: "collide",
      labelA: "tie",
      labelB: "B2",
      judges: JUDGES,
    });
    add(r, comparison(["A", "A", "A"], "A"), "qa");
    add(r, comparison(["A", "B", "tie"], "tie"), "qt");
    expect(f.options(r).winner).toEqual(["A", "B", "tie", "inconclusive"]);
    expect(qs(apply(r, { winner: ["tie"] }))).toEqual(["qt"]);
  });
});
