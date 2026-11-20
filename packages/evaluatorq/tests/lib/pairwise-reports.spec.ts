import { describe, expect, test } from "bun:test";

import { exactSum, pythonFixed } from "../../src/lib/common/jury.js";
import {
  esc,
  htmlTable,
  kpiCards,
  statusBadge,
} from "../../src/lib/common/reports/html-helpers.js";
import { formatDate } from "../../src/lib/common/reports/render.js";
import type { PairwiseVoteInput } from "../../src/lib/pairwise.js";
import {
  buildReportSections,
  comparisonFlags,
  exportHtml,
  fleissKappa,
  judgeUsage,
  kappaLabel,
  lengthLean,
  renderReportBody,
  trustSignals,
  verdict,
  wilsonInterval,
} from "../../src/lib/pairwise-reports/index.js";
import type { JudgesData } from "../../src/lib/pairwise-reports/sections.js";
import { PairwiseRun } from "../../src/lib/pairwise-run.js";

function vote(model: string, value: "A" | "B" | "tie" | null, extra = {}) {
  return { model, vote: value, ...extra } satisfies PairwiseVoteInput;
}

function runOf(
  winners: { winner: string; votes: PairwiseVoteInput[]; a?: string }[],
  extra: Record<string, unknown> = {},
) {
  return new PairwiseRun({
    runName: "demo",
    createdAt: "2026-11-09T10:20:30Z",
    labelA: "Old",
    labelB: "New",
    judges: ["j1", "j2"],
    entries: winners.map(({ winner, votes, a }) => ({
      question: "Q?",
      responseA: a ?? "aa",
      responseB: "b",
      comparison: { winner, votes },
    })),
    ...extra,
  });
}

describe("number helpers", () => {
  test("pythonFixed rounds exact ties to even", () => {
    expect(pythonFixed(12.5, 0)).toBe("12");
    expect(pythonFixed(13.5, 0)).toBe("14");
    expect(pythonFixed(0.125, 2)).toBe("0.12");
  });

  test("exactSum is correctly rounded like math.fsum", () => {
    expect(exactSum([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe(
      1,
    );
    expect(exactSum([1e100, 1, -1e100])).toBe(1);
    expect(exactSum([])).toBe(0);
  });
});

describe("report primitives", () => {
  test("esc matches html.escape", () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;",
    );
  });

  test("htmlTable labels cells and rejects mismatched attrs", () => {
    expect(htmlTable(["H"], [["c", "extra"]])).toBe(
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td data-label="H">c</td><td>extra</td></tr></tbody></table>',
    );
    expect(() => htmlTable(["H"], [], { rowAttrs: ["x"] })).toThrow();
  });

  test("unknown statuses fall back to neutral", () => {
    expect(statusBadge("x", "odd")).toContain("status-badge--neutral");
    expect(kpiCards([{ label: "L", value: "V", status: "odd" }])).toContain(
      "kpi-card--neutral",
    );
    expect(kpiCards([])).toBe("");
  });

  test("formatDate keeps the stored wall clock", () => {
    expect(formatDate("2026-01-02T03:04:05+02:00")).toBe(
      "2026-01-02 03:04 UTC",
    );
    expect(formatDate(null)).toBe("unknown");
  });
});

describe("pairwise statistics", () => {
  test("wilsonInterval handles the empty case and stays in bounds", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    const { low, high } = wilsonInterval(9, 10);
    expect(low).toBeGreaterThan(0.5);
    expect(high).toBeLessThanOrEqual(1);
  });

  test("verdict needs the interval clear of 50% to name a winner", () => {
    const close = verdict(
      runOf([
        { winner: "A", votes: [] },
        { winner: "B", votes: [] },
        { winner: "A", votes: [] },
      ]),
    );
    expect(close.state).toBe("too_close");
    expect(close.leaderLabel).toBe("Old");
    const clear = verdict(
      runOf(Array.from({ length: 12 }, () => ({ winner: "B", votes: [] }))),
    );
    expect(clear.state).toBe("clear");
    expect(clear.leaderLabel).toBe("New");
    expect(verdict(runOf([{ winner: "tie", votes: [] }])).state).toBe(
      "no_decided",
    );
  });

  test("fleissKappa skips rows without the full panel", () => {
    const run = runOf([
      { winner: "A", votes: [vote("j1", "A"), vote("j2", "A")] },
      { winner: "B", votes: [vote("j1", "B"), vote("j2", "B")] },
      { winner: "A", votes: [vote("j1", "A")] },
      {
        winner: "A",
        votes: [
          vote("j1", "A"),
          vote("j2", "A"),
          vote("j2", "B", { replacement: true }),
        ],
      },
    ]);
    const result = fleissKappa(run);
    expect(result.rows).toBe(3);
    expect(result.kappa).toBe(1);
    expect(kappaLabel(result.kappa as number)).toBe("almost perfect");
  });

  test("lengthLean counts characters, not UTF-16 units", () => {
    const run = runOf([{ winner: "A", votes: [], a: "😀" }]);
    expect(lengthLean(run)).toBeNull();
  });

  test("judgeUsage separates partial totals from complete ones", () => {
    const usage = (pricedCalls: number) => ({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 0,
      totalCost: 0.1,
      calls: 1,
      pricedCalls,
    });
    const run = runOf([{ winner: "A", votes: [] }]);
    const entry = run.entries[0];
    if (!entry) {
      throw new Error("entry missing");
    }
    entry.comparison.tokenUsage = usage(1) as never;
    const complete = judgeUsage(run);
    expect(complete.totalTokens).toBe(3);
    expect(complete.costComplete).toBe(true);
    entry.comparison.tokenUsage = usage(0) as never;
    expect(judgeUsage(run).costPartial).toBe(true);
  });

  test("comparisonFlags reports splits, flips and missing judges", () => {
    const run = runOf([
      {
        winner: "A",
        votes: [vote("j1", "A", { flipped: true }), vote("x", "B")],
      },
    ]);
    expect(comparisonFlags(run.entries[0] as never, run.judges)).toEqual({
      split: true,
      thrownOut: true,
      judgeFailed: true,
    });
  });

  test("trustSignals keep their display order", () => {
    const run = runOf([
      { winner: "A", votes: [vote("j1", "A"), vote("j2", "A")] },
    ]);
    expect(trustSignals(run).map((signal) => signal.label)).toEqual([
      "Decided",
      "Votes thrown out",
      "Judge agreement",
      "Position bias",
      "Length",
      "Judge failures",
    ]);
  });
});

describe("pairwise report rendering", () => {
  test("position bias is null for a judge with no completed pair", () => {
    const run = runOf([
      { winner: "A", votes: [vote("j1", "A", { completed: false })] },
    ]);
    const judges = buildReportSections(run)[1]?.data as JudgesData;
    expect(judges.rows[0]?.positionBias).toBeNull();
    expect(judges.observedSwap).toBe(false);
  });

  test("the report escapes user text and renders every section", async () => {
    const run = runOf(
      [{ winner: "inconclusive", votes: [vote("<j>", null)] }],
      { runName: "<run>" },
    );
    const body = await renderReportBody(run);
    expect(body).toContain("<h1>&lt;run&gt;</h1>");
    expect(body).toContain('id="pairwise_consensus"');
    expect(body).toContain('id="pairwise_judges"');
    expect(body).toContain('id="pairwise_comparisons"');
    expect(body).toContain("status-badge--warn");
  });

  test("classifier percentages keep near-ties and tiny values visible", async () => {
    const run = runOf([
      {
        winner: "A",
        votes: [
          vote("j1", "A", {
            observations: [
              {
                ordering: "ba",
                repetition: 0,
                rawOutput: {
                  type: "choice",
                  choice: "A",
                  confidence: 0.4995,
                  probabilities: { A: 0.00001, B: 1.2345e-9 },
                },
              },
            ],
          }),
        ],
      },
    ]);
    const body = await renderReportBody(run);
    expect(body).toContain("swapped order, pass 1");
    expect(body).toContain("choice New");
    expect(body).toContain("confidence 49.95%");
    expect(body).toContain("New 0.001%");
    expect(body).toContain("Old 1.234e-7%");
  });

  test("exportHtml is a standalone document without banned dashes", async () => {
    const html = await exportHtml(runOf([{ winner: "A", votes: [] }]));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>demo - Pairwise Report</title>");
    expect(html).not.toMatch(/[–—]/);
  });
});
