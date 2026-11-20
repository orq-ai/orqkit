// Ported from res-697 tests/dashboard/test_pairwise_surface.py (artifact, scanner and adapter tests).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reportId,
  scan,
  sniffKind,
} from "../../../src/lib/common/dashboard/library.js";
import {
  createDashboardHandler,
  csvSafe,
} from "../../../src/lib/dashboard/app.js";
import {
  ADAPTERS,
  type SurfaceAdapter,
} from "../../../src/lib/dashboard/surfaces.js";
import {
  type PairwiseComparison,
  PairwiseComparisonSchema,
} from "../../../src/lib/pairwise.js";
import {
  newRun,
  type PairwiseEntry,
  PairwiseRun,
} from "../../../src/lib/pairwise-run.js";

const JUDGES = ["judge-one", "judge-two", "judge-three"];
type Verdict = "A" | "B" | "tie" | null;

const vote = (
  model: string,
  value: Verdict,
  k: { flipped?: boolean; replacement?: boolean } = {},
) => ({
  model,
  vote: value,
  flipped: k.flipped ?? false,
  completed: true,
  replacement: k.replacement ?? false,
  explanation: `${model} says ${value}`,
});
const comparison = (
  values: Verdict[],
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

function fixture(): PairwiseRun {
  const r = newRun({
    runName: "v2 vs v3",
    labelA: "prompt-v2",
    labelB: "prompt-v3",
    judges: JUDGES,
    criteria: "accuracy",
  });
  r.add(comparison(["A", "A", "A"], "A"), {
    question: "q1",
    responseA: "a1",
    responseB: "b1",
  });
  r.add(comparison(["A", "B", "tie"], "tie"), {
    question: "q2",
    responseA: "a2",
    responseB: "b2",
  });
  r.add(comparison(["B", "B", "B"], "B"), {
    question: "q3",
    responseA: "a3",
    responseB: "b3",
  });
  r.add(comparison([null, null, null], "inconclusive", { flipped: true }), {
    question: "q4",
    responseA: "a4",
    responseB: "b4",
  });
  return r;
}

const adapter = ADAPTERS.pairwise as unknown as SurfaceAdapter<
  PairwiseRun,
  PairwiseEntry
>;
let tmp: string;
const savedEnv = process.env.EVALUATORQ_DIR;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "eq-pairwise-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.EVALUATORQ_DIR;
  else process.env.EVALUATORQ_DIR = savedEnv;
});

async function saved() {
  const run = fixture();
  const runsDir = join(tmp, "pairwise-runs");
  mkdirSync(runsDir);
  return { run, runsDir, path: await run.save(join(runsDir, "run.json")) };
}

describe("pairwise run artifact", () => {
  it("round trips through JSON and stores the rollup", async () => {
    const { run, path } = await saved();
    const loaded = await PairwiseRun.load(path);
    expect(loaded.runName).toBe(run.runName);
    expect([loaded.labelA, loaded.labelB]).toEqual(["prompt-v2", "prompt-v3"]);
    expect(loaded.entries).toHaveLength(4);
    expect(loaded.entries[0]?.question).toBe("q1");
    expect(loaded.entries[0]?.comparison.winner).toBe("A");
    const report = loaded.report;
    expect(report?.comparisons).toBe(4);
    expect(report?.aWinRate).toBeCloseTo(0.5);
    expect(report?.bWinRate).toBeCloseTo(0.5);
    expect(report?.tieRate).toBeCloseTo(0.25);
    expect(report?.inconclusiveRate).toBeCloseTo(0.25);
  });

  it("defaults labels to slot letters and recomputes a missing rollup", () => {
    const r = newRun({ runName: "unnamed sides" });
    expect([r.labelA, r.labelB]).toEqual(["A", "B"]);
    const run = fixture();
    expect(run.report).toBeNull();
    expect(run.rollup().comparisons).toBe(4);
  });

  it("does not overwrite a same-second run on the default path", async () => {
    process.env.EVALUATORQ_DIR = tmp;
    const first = newRun({ runName: "same name" });
    first.add(comparison(["A", "A", "A"], "A"), {
      question: "q1",
      responseA: "a",
      responseB: "b",
    });
    const second = newRun({ runName: "same name" });
    second.add(comparison(["B", "B", "B"], "B"), {
      question: "q2",
      responseA: "a",
      responseB: "b",
    });
    second.createdAt = first.createdAt;
    const p1 = await first.save();
    const p2 = await second.save();
    expect(p1).not.toBe(p2);
    expect((await PairwiseRun.load(p1)).entries[0]?.question).toBe("q1");
    expect((await PairwiseRun.load(p2)).entries[0]?.question).toBe("q2");
  });
});

describe("pairwise scanner", () => {
  it("sniffs pairwise files and leaves other surfaces alone", () => {
    expect(sniffKind({ judging: "pairwise" })).toBe("pairwise");
    expect(sniffKind({ mode: "run" })).toBe("sim");
    expect(sniffKind({ pipeline: {} })).toBe("redteam");
    expect(sniffKind({ something: "else" })).toBeNull();
  });

  it("lists the run with a comparison headline", async () => {
    const { runsDir, path } = await saved();
    const cards = (await scan([runsDir])).filter(
      (c) => c.surface === "pairwise",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.name).toBe("v2 vs v3");
    expect(cards[0]?.headline).toBe("4 comparisons · even");
    expect(cards[0]?.error ?? null).toBeNull();
    expect(cards[0]?.id).toBe(reportId(path));
  });

  async function headline(winners: string[]) {
    const r = newRun({
      runName: "h",
      labelA: "prompt-v2",
      labelB: "prompt-v3",
      judges: JUDGES,
      criteria: "x",
    });
    winners.forEach((w, i) => {
      r.add(comparison(["A", "A", "A"], w), {
        question: `q${i}`,
        responseA: "a",
        responseB: "b",
      });
    });
    await r.save(join(tmp, "h.json"));
    return (await scan([tmp])).find((c) => c.surface === "pairwise")?.headline;
  }

  it("names the leading side, flags too-close leads, even and undecided runs", async () => {
    expect(await headline(["A", "B", "B", "B"])).toBe(
      "4 comparisons · prompt-v3 leads 75% · too close",
    );
    expect(await headline(Array(12).fill("B"))).toBe(
      "12 comparisons · prompt-v3 leads 100%",
    );
    expect(await headline(["A", "B"])).toBe("2 comparisons · even");
    expect(await headline(["tie"])).toBe("1 comparison");
  });

  it("flags a run missing its entries", async () => {
    const runsDir = join(tmp, "pairwise-runs");
    mkdirSync(runsDir);
    writeFileSync(
      join(runsDir, "broken.json"),
      JSON.stringify({ judging: "pairwise", run_name: "broken" }),
    );
    const card = (await scan([runsDir])).find((c) => c.surface === "pairwise");
    expect(card?.error).toBe("missing required field: entries");
  });
});

describe("pairwise adapter", () => {
  it("reads name and timestamp", async () => {
    const { run, path } = await saved();
    const loaded = await adapter.load(path);
    expect(adapter.name(loaded)).toBe("v2 vs v3");
    expect(adapter.createdAt(loaded)).toEqual(new Date(run.createdAt));
  });

  it("resolves every vote to a label", () => {
    const run = fixture();
    const rows = adapter.rows?.(run, run.entries) ?? [];
    expect(rows).toHaveLength(4);
    expect(rows[0]?.Question).toBe("q1");
    expect(rows[0]?.Winner).toBe("prompt-v2");
    expect(rows[0]?.["judge-one"]).toBe("prompt-v2");
    expect(rows[2]?.Winner).toBe("prompt-v3");
    expect(rows[3]?.Winner).toBe("inconclusive");
    expect(rows[3]?.["judge-one"]).toBe("abstained");
  });

  it("keeps identical keys when a judge joins late", () => {
    const r = newRun({ runName: "late judge", judges: ["j1"] });
    r.add(raw("A", [vote("j1", "A")]), {
      question: "q1",
      responseA: "a",
      responseB: "b",
    });
    r.add(
      raw("A", [vote("j1", "A"), vote("stand-in", "A", { replacement: true })]),
      {
        question: "q2",
        responseA: "a",
        responseB: "b",
      },
    );
    const rows = adapter.rows?.(r, r.entries) ?? [];
    const keys = (row: object) => Object.keys(row).sort();
    expect(rows.map(keys)).toEqual([keys(rows[0] ?? {}), keys(rows[0] ?? {})]);
    expect(rows[0]?.["stand-in"]).toBe("");
  });
});

describe("pairwise CSV export through the app", () => {
  const csvFor = async (run: PairwiseRun) => {
    const runsDir = join(tmp, "pairwise-runs");
    mkdirSync(runsDir, { recursive: true });
    const path = await run.save(join(runsDir, "run.json"));
    const handle = createDashboardHandler({ roots: [runsDir] });
    const r = await handle(
      new Request(`http://local/r/${reportId(path)}/export.csv`),
    );
    expect(r.status).toBe(200);
    return r.text();
  };

  it("survives a judge promoted mid run", async () => {
    const r = newRun({ runName: "late judge", judges: ["j1"] });
    r.add(raw("A", [vote("j1", "A")]), {
      question: "q1",
      responseA: "a",
      responseB: "b",
    });
    r.add(
      raw("A", [vote("j1", "A"), vote("stand-in", "A", { replacement: true })]),
      {
        question: "q2",
        responseA: "a",
        responseB: "b",
      },
    );
    expect(await csvFor(r)).toContain("stand-in");
  });

  it("neutralises formula injection in cells", async () => {
    const r = newRun({ runName: "injection", judges: JUDGES });
    r.add(comparison(["A", "A", "A"], "A"), {
      question: "=cmd|/c calc",
      responseA: "a",
      responseB: "b",
    });
    const body = await csvFor(r);
    expect(body).toContain("'=cmd|/c calc");
    expect(body).not.toContain(",=cmd");
  });

  it("leaves the n/a placeholder and signed numbers alone", () => {
    expect(csvSafe("-")).toBe("-");
    expect(csvSafe("-1.5")).toBe("-1.5");
    expect(csvSafe("+7")).toBe("+7");
    expect(csvSafe("normal text")).toBe("normal text");
    expect(csvSafe(3)).toBe(3);
    expect(csvSafe("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("escapes a hostile judge name in the header", async () => {
    const r = newRun({ runName: "hostile-judge", judges: ["=evil"] });
    r.add(raw("A", [{ ...vote("=evil", "A"), explanation: "x" }]), {
      question: "q",
      responseA: "a",
      responseB: "b",
    });
    const header = (await csvFor(r)).split(/\r?\n/)[0];
    expect(header).toContain("'=evil");
    expect(header).not.toContain(",=evil");
  });
});
