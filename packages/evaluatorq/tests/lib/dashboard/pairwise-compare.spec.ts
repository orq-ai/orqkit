// Ported from res-697 tests/dashboard/test_pairwise_compare.py and the interval-bar test of
// test_pairwise_tabs.py; goldens from scripts/gen_pairwise_compare.py.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as realScope from "../../../src/lib/dashboard/orq-scope.js";

beforeEach(() => {
  spyOn(realScope, "findOrqCli").mockImplementation(async () => null);
});
afterEach(() => mock.restore());

const { reportId } = await import(
  "../../../src/lib/common/dashboard/library.js"
);
const { createDashboardHandler } = await import(
  "../../../src/lib/dashboard/app.js"
);
const { matchComparisons, pairwiseMatchRate, renderPairwiseComparePage } =
  await import("../../../src/lib/dashboard/pairwise-compare.js");
const { intervalBar } = await import(
  "../../../src/lib/dashboard/pairwise-tabs.js"
);
const { verdictEyebrow } = await import(
  "../../../src/lib/dashboard/pairwise-palette.js"
);
const { verdict } = await import("../../../src/lib/pairwise-reports/stats.js");
const { PairwiseComparisonSchema } = await import(
  "../../../src/lib/pairwise.js"
);
const { newRun, PairwiseRun } = await import(
  "../../../src/lib/pairwise-run.js"
);
type Run = InstanceType<typeof PairwiseRun>;

const golden = (await import("./fixtures/pairwise-compare-golden.json"))
  .default as {
  runs: Record<string, unknown>;
  cases: { a: string; b: string; html: string }[];
};

const camel = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(camel);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        camel(v),
      ]),
    );
  return value;
};
const load = (key: string): Run =>
  new PairwiseRun(camel(golden.runs[key]) as never);

const JUDGES = ["j1", "j2"];
const cmp = (winner: string) =>
  PairwiseComparisonSchema.parse({
    winner,
    votes: JUDGES.map((model) => ({
      model,
      vote: winner,
      flipped: false,
      completed: true,
      explanation: "x",
    })),
  });

function run(
  name: string,
  rows: [string, string][],
  labels: { a?: string; b?: string } = {},
): Run {
  const r = newRun({
    runName: name,
    labelA: labels.a ?? "old",
    labelB: labels.b ?? "new",
    judges: JUDGES,
    criteria: "c",
  });
  for (const [question, w] of rows)
    r.add(cmp(w), { question, responseA: "ra", responseB: "rb" });
  return r;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pairwise-compare-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("golden parity with Python render_pairwise_compare_page", () => {
  for (const c of golden.cases)
    it(`${c.a} vs ${c.b}`, () => {
      expect(renderPairwiseComparePage("ra", "rb", load(c.a), load(c.b))).toBe(
        c.html,
      );
    });
});

describe("matchComparisons", () => {
  it("pairs by question and reports leftovers", () => {
    const m = matchComparisons(
      run("a", [
        ["q1", "A"],
        ["q2", "B"],
        ["only-a", "A"],
      ]),
      run("b", [
        ["q2", "A"],
        ["q1", "B"],
        ["only-b", "B"],
      ]),
    );
    expect([...m.matched].sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(m.aOnly).toEqual([2]);
    expect(m.bOnly).toEqual([2]);
    expect(pairwiseMatchRate(m)).toBeCloseTo(2 / 3);
  });

  it("pairs duplicate questions positionally", () => {
    const m = matchComparisons(
      run("a", [
        ["q", "A"],
        ["q", "B"],
        ["q", "A"],
      ]),
      run("b", [
        ["q", "A"],
        ["q", "B"],
      ]),
    );
    expect(m.matched).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(m.aOnly).toEqual([2]);
    expect(m.bOnly).toEqual([]);
  });

  it("pairs the same entry object by position", () => {
    const a = run("same", [["q", "A"]]);
    a.entries = [a.entries[0], a.entries[0]] as typeof a.entries;
    const b = run("other", [["q", "B"]]);
    b.entries = [b.entries[0], b.entries[0]] as typeof b.entries;
    const m = matchComparisons(a, b);
    expect(m.matched).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(m.aOnly).toEqual([]);
    expect(m.bOnly).toEqual([]);
  });

  it("keeps the actual zero total for empty runs", () => {
    const m = matchComparisons(run("a", []), run("b", []));
    expect(m.total).toBe(0);
    expect(pairwiseMatchRate(m)).toBe(0);
  });
});

describe("renderPairwiseComparePage", () => {
  const render = (a: Run, b: Run) =>
    renderPairwiseComparePage("ra", "rb", a, b);

  it("renamed labels do not change the same winning slot", () => {
    const html = render(
      run("a", [["q", "A"]]),
      run("b", [["q", "A"]], { a: "renamed", b: "different" }),
    );
    expect(html).toContain("old");
    expect(html).toContain("renamed");
    expect(html).not.toContain("pw-changed");
  });

  it("swapped labels do not hide a changed winning slot", () => {
    const html = render(
      run("a", [["q", "A"]]),
      run("b", [["q", "B"]], { a: "new", b: "old" }),
    );
    expect(html.split("pw-changed").length - 1).toBe(1);
  });

  it("changed rows come first and each run shows an interval bar", () => {
    const html = render(
      run("a", [
        ["same", "A"],
        ["moved", "A"],
      ]),
      run("b", [
        ["same", "A"],
        ["moved", "B"],
      ]),
    );
    expect(html.indexOf("moved")).toBeLessThan(html.indexOf("same"));
    expect(html.split("pw-cmp-run-ci").length - 1).toBe(2);
    expect(html).toContain('class="pw-vchip"');
  });

  it("both runs report the B side win rate and the diff counts changes", () => {
    const html = render(
      run(
        "a",
        [
          ["same", "A"],
          ["moved", "A"],
        ],
        { b: "newer" },
      ),
      run(
        "b",
        [
          ["same", "A"],
          ["moved", "B"],
        ],
        { b: "newer" },
      ),
    );
    expect(html.split("newer win rate").length - 1).toBe(2);
    expect(html).toContain("2 compared · 1 changed");
  });

  it("leftover counts only show when non-zero", () => {
    const a = run("a", [["q", "A"]]);
    const clean = render(a, run("b", [["q", "A"]]));
    expect(clean).not.toContain("Only in run A");
    expect(clean).not.toContain("only in A");
    const extra = render(
      a,
      run("b", [
        ["q", "A"],
        ["r", "B"],
      ]),
    );
    expect(extra).toContain("Only in run B");
    expect(extra).toContain("0 only in A, 1 only in B");
  });

  it("a run without a leader uses the report's verdict wording", () => {
    const tied = () =>
      run("tied", [
        ["q1", "A"],
        ["q2", "B"],
      ]);
    const v = verdict(tied());
    expect(v.state).toBe("too_close");
    expect(v.leader).toBeNull();
    expect(render(tied(), tied())).toContain(verdictEyebrow(v.state));
  });
});

describe("intervalBar", () => {
  it("plots the requested side", () => {
    const v = verdict(
      run("x", [
        ["a", "A"],
        ["b", "A"],
        ["c", "A"],
        ["d", "B"],
      ]),
    );
    expect([v.winsA, v.winsB]).toEqual([3, 1]);
    const html = intervalBar(v, { side: "B", label: "prompt-v3" });
    expect(html).toContain("left:25.0%");
    expect(html).toContain("prompt-v3 win rate");
    expect(html).not.toContain("left:75.0%");
    expect(intervalBar(v, { side: "A", label: "prompt-v2" })).toContain(
      "left:75.0%",
    );
    expect(intervalBar(verdict(run("t", [["q", "tie"]])))).toBe("");
  });
});

describe("compare route", () => {
  async function setup(rows?: [string, string][]) {
    const d = join(tmp, "runs");
    mkdirSync(d);
    const pa = await run(
      "alpha run",
      rows ?? [
        ["q1", "A"],
        ["q2", "B"],
      ],
    ).save(join(d, "a.json"));
    const pb = await run(
      "beta run",
      rows ?? [
        ["q1", "B"],
        ["q2", "B"],
      ],
    ).save(join(d, "b.json"));
    const handle = createDashboardHandler({ roots: [d] });
    const get = async (p: string) => {
      const resp = await handle(new Request(`http://localhost${p}`));
      return { status: resp.status, text: await resp.text() };
    };
    return { get, a: reportId(pa), b: reportId(pb), d };
  }

  it("renders both run names and links into each report", async () => {
    const c = await setup();
    const resp = await c.get(`/compare/pairwise?a=${c.a}&b=${c.b}`);
    expect(resp.status).toBe(200);
    expect(resp.text).toContain("alpha run");
    expect(resp.text).toContain("beta run");
    expect(resp.text).toContain(`/r/${c.a}?cmp=1`);
    expect(resp.text).toContain(`/r/${c.b}?cmp=2`);
  });

  it("is 400 when b is missing or the same", async () => {
    const c = await setup();
    expect((await c.get(`/compare/pairwise?a=${c.a}`)).status).toBe(400);
    expect((await c.get(`/compare/pairwise?a=${c.a}&b=${c.a}`)).status).toBe(
      400,
    );
  });

  it("is 404 for an unknown or simulation run", async () => {
    const c = await setup();
    expect((await c.get(`/compare/pairwise?a=${c.a}&b=deadbeef`)).status).toBe(
      404,
    );
    const sim = join(c.d, "sim.json");
    writeFileSync(
      sim,
      JSON.stringify({ mode: "run", run_name: "s", entries: [] }),
    );
    expect(
      (await c.get(`/compare/pairwise?a=${c.a}&b=${reportId(sim)}`)).status,
    ).toBe(404);
  });

  for (const [name, body] of [
    ["truncated JSON", '{"judging": "pairwise", '],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
    ["a schema failure", '{"judging": "pairwise", "entries": "nope"}'],
  ] as const)
    it(`is 422 for ${name}`, async () => {
      const c = await setup();
      const bad = join(c.d, "bad.json");
      writeFileSync(bad, body);
      expect(
        (await c.get(`/compare/pairwise?a=${c.a}&b=${reportId(bad)}`)).status,
      ).toBe(422);
    });

  it("compare links open the report on that comparison", async () => {
    const c = await setup(
      Array.from({ length: 30 }, (_, i) => [`q${i}`, "A"] as [string, string]),
    );
    const page = (await c.get(`/compare/pairwise?a=${c.a}&b=${c.b}`)).text;
    const link = `/r/${c.a}?cmp=30`;
    expect(page).toContain(link);
    expect((await c.get(link)).text).toContain('id="cmp-30"');
  });
});
