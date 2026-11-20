// Ported from res-697 tests/dashboard/test_pairwise_surface.py (sections, classify detail and rendering).
import { describe, expect, it } from "bun:test";

import {
  type PairwiseComparison,
  PairwiseComparisonSchema,
} from "../../src/lib/pairwise.js";
import { renderReportBody } from "../../src/lib/pairwise-reports/export-html.js";
import {
  buildReportSections,
  type ComparisonsData,
  type ConsensusData,
  type JudgesData,
} from "../../src/lib/pairwise-reports/sections.js";
import { newRun, type PairwiseRun } from "../../src/lib/pairwise-run.js";

const JUDGES = ["judge-one", "judge-two", "judge-three"];
type Verdict = "A" | "B" | "tie" | null;
type VoteOpts = {
  flipped?: boolean;
  replacement?: boolean;
  completed?: boolean;
};

const vote = (model: string, value: Verdict, k: VoteOpts = {}) => ({
  model,
  vote: value,
  flipped: k.flipped ?? false,
  completed: k.completed ?? true,
  replacement: k.replacement ?? false,
  explanation: `${model} says ${value}`,
});
const comparison = (values: Verdict[], winner: string, k: VoteOpts = {}) =>
  PairwiseComparisonSchema.parse({
    winner,
    votes: values.map((v, i) => vote(JUDGES[i] as string, v, k)),
  });
const raw = (winner: string, votes: object[]): PairwiseComparison =>
  PairwiseComparisonSchema.parse({ winner, votes });
const add = (
  r: PairwiseRun,
  c: PairwiseComparison,
  question = "q",
  a = "a",
  b = "b",
) => r.add(c, { question, responseA: a, responseB: b });

function fixture(): PairwiseRun {
  const r = newRun({
    runName: "v2 vs v3",
    labelA: "prompt-v2",
    labelB: "prompt-v3",
    judges: JUDGES,
    criteria: "accuracy",
  });
  add(r, comparison(["A", "A", "A"], "A"), "q1", "a1", "b1");
  add(r, comparison(["A", "B", "tie"], "tie"), "q2", "a2", "b2");
  add(r, comparison(["B", "B", "B"], "B"), "q3", "a3", "b3");
  add(
    r,
    comparison([null, null, null], "inconclusive", { flipped: true }),
    "q4",
    "a4",
    "b4",
  );
  return r;
}

function classifyRun(
  rawOutput: Record<string, unknown>,
  k: { labelA?: string; labelB?: string; model?: string } = {},
) {
  const model = k.model ?? "typesafe/jev-latest";
  const run = newRun({
    runName: "classify detail",
    labelA: k.labelA ?? "candidate",
    labelB: k.labelB ?? "baseline",
    judges: [model],
  });
  add(
    run,
    raw("A", [
      {
        model,
        vote: "A",
        observations: [
          { ordering: "ab", repetition: 0, verdict: "A", rawOutput },
        ],
      },
    ]),
  );
  return run;
}

function classifyFixture() {
  const run = classifyRun({
    type: "choice",
    choice: "A",
    confidence: 0.8,
    probabilities: { A: 0.8, B: 0.1, tie: 0.1 },
  });
  run.entries[0]?.comparison.votes[0]?.observations.push(
    {
      ordering: "ba",
      repetition: 0,
      verdict: "A",
      explanation: null,
      rawOutput: {
        type: "choice",
        choice: "B",
        confidence: 0.9,
        probabilities: { A: 0.05, B: 0.9, tie: 0.05 },
      },
    },
    {
      ordering: "ba",
      repetition: 1,
      verdict: "tie",
      explanation: null,
      rawOutput: {
        type: "choice",
        choice: "tie",
        probabilities: { tie: 0.7, other: 0.3 },
      },
    },
  );
  return run;
}

const sectionData = <T>(run: PairwiseRun, i: number) =>
  buildReportSections(run)[i]?.data as T;
const comparisons = (run: PairwiseRun) =>
  buildReportSections(run).find((s) => s.kind === "pairwise_comparisons")
    ?.data as ComparisonsData;
const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
const DETAILS = "<summary>Classifier details</summary>";

describe("pairwise sections", () => {
  it("builds sections in display order", () => {
    expect(buildReportSections(fixture()).map((s) => s.kind)).toEqual([
      "pairwise_consensus",
      "pairwise_judges",
      "pairwise_comparisons",
    ]);
  });

  it("normalizes each classify ordering without mutating storage", async () => {
    const run = classifyFixture();
    const observations =
      run.entries[0]?.comparison.votes[0]?.observations ?? [];
    const before = structuredClone(observations.map((o) => o.rawOutput));
    const details =
      comparisons(run).rows[0]?.votes[0]?.classifyObservations ?? [];
    expect(details).toEqual([
      {
        ordering: "ab",
        repetition: 0,
        choice: "candidate",
        confidence: 0.8,
        probabilities: { candidate: 0.8, baseline: 0.1, tie: 0.1 },
      },
      {
        ordering: "ba",
        repetition: 0,
        choice: "candidate",
        confidence: 0.9,
        probabilities: { baseline: 0.05, candidate: 0.9, tie: 0.05 },
      },
      {
        ordering: "ba",
        repetition: 1,
        choice: "tie",
        confidence: null,
        probabilities: { tie: 0.7, other: 0.3 },
      },
    ]);
    await renderReportBody(run);
    (details[0]?.probabilities as Record<string, number>).candidate = 0;
    expect(observations.map((o) => o.rawOutput)).toEqual(before);
  });

  it("shows each classify call and the full distribution", async () => {
    const html = await renderReportBody(classifyFixture());
    expect(html).toContain(DETAILS);
    for (const text of [
      "original order",
      "swapped order",
      "pass 1",
      "pass 2",
      "choice candidate",
      "choice tie",
      "confidence 80%",
      "confidence 90%",
      "candidate 80%",
      "baseline 10%",
      "tie 10%",
      "baseline 5%",
      "candidate 90%",
      "tie 5%",
      "tie 70%",
      "other 30%",
    ])
      expect(html).toContain(text);
  });

  it("gives prompted, absent and non-choice votes no classifier detail", async () => {
    const run = fixture();
    run.judges.push("absent-judge");
    expect(
      comparisons(run).rows.every((row) =>
        row.votes.every((v) => v.classifyObservations.length === 0),
      ),
    ).toBe(true);
    expect(await renderReportBody(run)).not.toContain(DETAILS);
    const score = classifyRun({ type: "score", score: 0.8, confidence: 0.9 });
    expect(comparisons(score).rows[0]?.votes[0]?.classifyObservations).toEqual(
      [],
    );
    expect(await renderReportBody(score)).not.toContain(DETAILS);
  });

  for (const optional of [{}, { probabilities: { A: 1.0 } }])
    it(`omits a missing classify confidence (${JSON.stringify(optional)})`, async () => {
      const html = await renderReportBody(
        classifyRun({ type: "choice", choice: "A", ...optional }),
      );
      expect(html).toContain(DETAILS);
      expect(html).not.toContain("confidence");
      if (!Object.keys(optional).length)
        expect(html).not.toContain('<div class="pw-classify__probabilities">');
    });

  for (const [probability, expected] of [
    [0, "0%"],
    [0.5, "50%"],
    [0.50001, "50.001%"],
    [0.49999, "49.999%"],
    [0.50002, "50.002%"],
    [0.500000000000001, "50.0000000000001%"],
    [0.123456, "12.35%"],
    [1e-12, "1e-10%"],
    [5e-324, "5e-322%"],
  ] as const)
    it(`keeps percentage ${probability} visible as ${expected}`, async () => {
      const html = await renderReportBody(
        classifyRun({
          type: "choice",
          choice: "A",
          confidence: probability,
          probabilities: { "precision-probe": probability },
        }),
      );
      expect(html).toContain(`precision-probe ${expected}</span>`);
      expect(html).toContain(`confidence ${expected}`);
    });

  it("omits invalid probability entries", async () => {
    const html = await renderReportBody(
      classifyRun({
        type: "choice",
        choice: "A",
        confidence: false,
        probabilities: {
          valid: 0.9,
          boolean: true,
          string: "0.1",
          missing: null,
          negative: -0.1,
          "too-large": 1.1,
          infinite: Infinity,
          nan: NaN,
        },
      }),
    );
    expect(html).toContain("valid 90%</span>");
    expect(html).not.toContain("confidence");
    for (const key of [
      "boolean",
      "string",
      "missing",
      "negative",
      "too-large",
      "infinite",
      "nan",
    ])
      expect(html).not.toContain(`<span>${key} `);
  });

  it("escapes external labels and keys", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const model = '<script>alert("model")</script>';
    const key = '<svg onload="alert(2)">';
    const run = classifyRun(
      {
        type: "choice",
        choice: "A",
        confidence: 0.9,
        probabilities: { A: 0.8, B: 0.1, [key]: 0.1 },
      },
      { labelA: hostile, labelB: 'baseline & "reference"', model },
    );
    run.entries[0]?.comparison.votes[0]?.observations.push({
      ordering: "ba",
      repetition: 1,
      verdict: null,
      explanation: null,
      rawOutput: { type: "choice", choice: key },
    });
    const html = await renderReportBody(run);
    for (const text of [hostile, model, key, 'baseline & "reference"']) {
      expect(html).not.toContain(text);
      expect(html).toContain(escapeHtml(text));
    }
    expect(html).toContain(`choice ${escapeHtml(hostile)}`);
    expect(html).toContain(`choice ${escapeHtml(key)}`);
    expect(html).toContain(`${escapeHtml(key)} 10%</span>`);
  });

  for (const [labelA, labelB] of [
    ["same", "same"],
    ["other", "baseline"],
    ["tie", "baseline"],
  ])
    it(`preserves every probability when labels collide (${labelA}/${labelB})`, async () => {
      const run = classifyRun(
        {
          type: "choice",
          choice: "A",
          probabilities: { A: 0.6, B: 0.2, tie: 0.15, other: 0.05 },
        },
        { labelA, labelB },
      );
      const detail =
        comparisons(run).rows[0]?.votes[0]?.classifyObservations[0];
      const probs = (detail?.probabilities ?? {}) as Record<string, number>;
      expect(Object.values(probs).sort()).toEqual([0.05, 0.15, 0.2, 0.6]);
      expect(probs.other).toBe(0.05);
      expect(probs[detail?.choice as string]).toBe(0.6);
      const html = await renderReportBody(run);
      for (const pct of ["60%", "20%", "15%", "5%"])
        expect(html).toContain(` ${pct}</span>`);
    });

  it("reports decided counts exactly", () => {
    const consensus = sectionData<ConsensusData>(fixture(), 0);
    expect([consensus.comparisons, consensus.decided]).toEqual([4, 2]);
    const r = newRun({ runName: "thirds", judges: JUDGES });
    add(r, comparison(["A", "A", "A"], "A"), "q1");
    add(r, comparison(["A", "B", "tie"], "tie"), "q2");
    add(r, comparison([null, null, null], "inconclusive"), "q3");
    const thirds = sectionData<ConsensusData>(r, 0);
    expect([thirds.comparisons, thirds.decided]).toEqual([3, 1]);
  });

  it("marks split rows and keeps judge columns fixed", () => {
    const data = sectionData<ComparisonsData>(fixture(), 2);
    expect(data.rows.map((r) => r.split)).toEqual([false, true, false, true]);
    expect(data.judges).toEqual(JUDGES);
    for (const row of data.rows)
      expect(row.votes.map((v) => v.model)).toEqual(JUDGES);
  });

  it("leaves position bias unmeasured without swap or completed pairs", async () => {
    const single = newRun({
      runName: "single ordering",
      judges: JUDGES,
      swap: false,
    });
    add(single, comparison(["A", "A", "A"], "A", { completed: false }));
    for (const row of sectionData<JudgesData>(single, 1).rows) {
      expect(row.positionBias).toBeNull();
      expect(row.biased).toBe(false);
    }
    const body = await renderReportBody(single);
    expect(body).toContain("n/a");
    expect(body).toContain("position bias was not measured");

    const r = newRun({
      runName: "swap on, nothing completed",
      judges: ["j1"],
      swap: true,
    });
    add(
      r,
      raw("A", [{ model: "j1", vote: "A", completed: false, explanation: "" }]),
    );
    const row = sectionData<JudgesData>(r, 1).rows[0];
    expect(row?.positionBias).toBeNull();
    expect(row?.biased).toBe(false);
    expect(await renderReportBody(r)).toContain("n/a");
  });

  it("flags position bias above the threshold and tags replacements", () => {
    const r = newRun({ runName: "biased panel", judges: ["flipper"] });
    for (let i = 0; i < 4; i++)
      add(r, raw("A", [vote("flipper", "A", { flipped: i < 2 })]), `q${i}`);
    const row = sectionData<JudgesData>(r, 1).rows[0];
    expect(row?.positionBias).toBeCloseTo(0.5);
    expect(row?.biased).toBe(true);
    const s = newRun({ runName: "with stand-in", judges: ["primary"] });
    add(s, raw("A", [vote("stand-in", "A", { replacement: true })]));
    expect(sectionData<JudgesData>(s, 1).rows[0]?.replacement).toBe(true);
  });
});

describe("pairwise rendering", () => {
  it("uses side labels, renders every section, responses and explanations", async () => {
    const body = await renderReportBody(fixture());
    expect(body).toContain("prompt-v2 rate");
    expect(body).toContain("prompt-v3 rate");
    expect(body).not.toContain(">A rate<");
    for (const anchor of [
      "pairwise_consensus",
      "pairwise_judges",
      "pairwise_comparisons",
    ])
      expect(body).toContain(`id="${anchor}"`);
    expect(body).toContain("a2");
    expect(body).toContain("b2");
    for (const judge of JUDGES) expect(body).toContain(`${judge} says`);
    expect(body).toContain("pw-chip--abstain");
  });

  it("renders empty and fully inconclusive runs", async () => {
    expect(
      await renderReportBody(newRun({ runName: "nothing here" })),
    ).toContain("No comparisons in this run.");
    const r = newRun({ runName: "all noise", judges: JUDGES });
    add(r, comparison([null, null, null], "inconclusive"));
    expect(await renderReportBody(r)).toContain("the 0 of 1 comparisons");
  });
});
