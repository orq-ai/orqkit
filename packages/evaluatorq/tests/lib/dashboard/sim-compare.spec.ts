// Ported from res-697 tests/dashboard/test_sim_compare.py; goldens from scripts/gen_sim_compare.py.
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

const scope = {
  cli: null as string | null,
  discover: async (
    _profile: string | null = null,
    _options: { useCliSession?: boolean } = {},
  ): Promise<realScope.OrqScope> => ({
    workspaceKey: null,
    workspaceId: null,
    projects: [],
    error: "not mocked",
  }),
};
beforeEach(() => {
  spyOn(realScope, "findOrqCli").mockImplementation(async () => scope.cli);
  spyOn(realScope, "discoverOrqScope").mockImplementation((profile, options) =>
    scope.discover(profile, options),
  );
});
afterEach(() => mock.restore());

const { reportId } = await import(
  "../../../src/lib/common/dashboard/library.js"
);
const { createDashboardHandler } = await import(
  "../../../src/lib/dashboard/app.js"
);
const {
  compareKpis,
  kpiDelta,
  matchEntries,
  renderComparePage,
  renderCompareTranscript,
  simCompareEntries,
  simCompareRuntime,
} = await import("../../../src/lib/dashboard/sim-compare.js");
const { threadTraceUrl } = await import(
  "../../../src/lib/dashboard/trace-links.js"
);
const { SimulationRun } = await import(
  "../../../src/lib/integrations/simulation/run-store.js"
);
const golden = (await import("./fixtures/sim-compare-golden.json")).default as {
  runs: Record<string, Record<string, unknown>>;
  cases: { a: string; b: string; html: string; specs: unknown[] }[];
  transcript: string;
};

const run = (key: string) =>
  new SimulationRun(structuredClone(golden.runs[key]) as never);

const ENV = [
  "ORQ_API_KEY",
  "ORQ_WORKSPACE",
  "ORQ_WORKSPACE_SLUG",
  "ORQ_BASE_URL",
  "EVALUATORQ_DASHBOARD_SETTINGS",
];
let saved: Record<string, string | undefined>;
let tmp: string;
let realRender: typeof simCompareRuntime.renderSvg;
let realTranscript: typeof simCompareRuntime.renderTranscriptFragment;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "sim-compare-"));
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(tmp, "settings.json");
  scope.cli = null;
  realRender = simCompareRuntime.renderSvg;
  realTranscript = simCompareRuntime.renderTranscriptFragment;
});

afterEach(() => {
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
  simCompareRuntime.renderSvg = realRender;
  simCompareRuntime.renderTranscriptFragment = realTranscript;
});

function stubCharts(): unknown[] {
  const specs: unknown[] = [];
  simCompareRuntime.renderSvg = async (spec) => {
    specs.push(spec);
    return `<svg data-chart="${specs.length}"></svg>`;
  };
  return specs;
}

function writeRuns(files: Record<string, unknown>): {
  roots: string[];
  rid: (name: string) => string;
} {
  const sim = join(tmp, "sim-runs");
  mkdirSync(sim, { recursive: true });
  for (const [name, body] of Object.entries(files))
    writeFileSync(
      join(sim, `${name}.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  return {
    roots: [join(tmp, "runs"), sim],
    rid: (name) => reportId(join(sim, `${name}.json`)),
  };
}

const get = (roots: string[], path: string) =>
  createDashboardHandler({ roots })(new Request(`http://local${path}`));

describe("golden pages", () => {
  for (const c of golden.cases)
    it(`${c.a} vs ${c.b} matches the Python render`, async () => {
      const specs = stubCharts();
      const html = await renderComparePage(
        `rid-${c.a}`,
        `rid-${c.b}`,
        run(c.a),
        run(c.b),
      );
      expect(html).toBe(c.html);
      expect(JSON.parse(JSON.stringify(specs))).toEqual(c.specs);
    });

  it("transcript fragment matches the Python render", async () => {
    const [ea] = simCompareEntries(run("A"));
    const [eb] = simCompareEntries(run("B"));
    expect(
      await renderCompareTranscript(
        ea as never,
        eb as never,
        "run-A",
        "run-B <b>",
      ),
    ).toBe(golden.transcript);
  });
});

describe("kpis and matching", () => {
  it("covers aggregates, scorers and terminated-by", () => {
    const a = run("A");
    const b = run("B");
    const rows = compareKpis(simCompareEntries(a), simCompareEntries(b), a, b);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by.Conversations?.a).toBe(3);
    expect(by.Conversations?.b).toBe(3);
    expect(by["Goal-achieved rate"]?.a).toBeCloseTo(2 / 3);
    expect(by["Goal-achieved rate"]?.b).toBeCloseTo(2 / 3);
    const criteria = by["Scorer: criteria_met"];
    expect(criteria?.a).toBe(0.5);
    expect(criteria?.b).toBeNull();
    expect(criteria && kpiDelta(criteria)).toBeNull();
    expect(by["Scorer: safety"]?.a).toBeNull();
    expect(by["Scorer: safety"]?.b).toBe(1);
    expect(by["Terminated: judge"]?.a).toBe(3);
    const maxTurns = by["Terminated: max_turns"];
    expect(maxTurns?.b).toBe(1);
    expect(maxTurns && kpiDelta(maxTurns)).toBe(1);
  });

  it("counts a repeated same object by position", () => {
    const [entry] = simCompareEntries(run("A"));
    const m = matchEntries([entry, entry] as never, [entry, entry] as never);
    expect(m.matched.map((p) => [p.a, p.b])).toEqual([
      [entry, entry],
      [entry, entry],
    ] as never);
    expect(m.aOnly).toEqual([]);
    expect(m.bOnly).toEqual([]);
  });

  it("pairs by persona and scenario and flags leftovers", () => {
    const m = matchEntries(
      simCompareEntries(run("A")),
      simCompareEntries(run("B")),
    );
    expect(
      new Set(m.matched.map((p) => `${p.a.persona}/${p.a.scenario}`)),
    ).toEqual(new Set(["alice/billing", "bob/refund"]));
    expect(m.aOnly.map((e) => [e.persona, e.scenario])).toEqual([
      ["carol", "onlyA"],
    ]);
    expect(m.bOnly.map((e) => [e.persona, e.scenario])).toEqual([
      ["dave", "onlyB"],
    ]);
  });
});

describe("routes", () => {
  const standard = () => writeRuns({ a: golden.runs.A, b: golden.runs.B });

  it("renders kpis, diffs and the flip", async () => {
    stubCharts();
    const { roots, rid } = standard();
    const resp = await get(roots, `/compare/sim?a=${rid("a")}&b=${rid("b")}`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    for (const needle of [
      "KPI deltas",
      "Outcome diffs",
      "run-A",
      "flip",
      "Only in A",
      "Only in B",
      "carol",
      "dave",
      "<svg",
      "Outcomes",
      "Scorer averages",
      "How conversations ended",
      "Per-conversation score change",
      "n/a",
      "shared scorers only",
    ])
      expect(html).toContain(needle);
  });

  it("shows both transcript sides", async () => {
    const { roots, rid } = standard();
    const resp = await get(
      roots,
      `/compare/sim/transcript?a=${rid("a")}&b=${rid("b")}&ia=0&ib=0`,
    );
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("hello A");
    expect(html).toContain("hello B");
    expect(html).toContain("cmp-transcript-grid");
  });

  it("scopes the CLI session slug to one response", async () => {
    scope.cli = "/usr/bin/orq";
    const slugs = ["first-workspace", "second-workspace"];
    let calls = 0;
    scope.discover = async (profile, options) => {
      calls += 1;
      expect(profile).toBeNull();
      expect(options?.useCliSession).toBe(true);
      return {
        workspaceKey: slugs[calls - 1] ?? null,
        workspaceId: null,
        projects: [],
        error: null,
      };
    };
    simCompareRuntime.renderTranscriptFragment = async (entry) =>
      (await threadTraceUrl(String(entry.index))) ?? "";
    const { roots, rid } = standard();
    const path = `/compare/sim/transcript?a=${rid("a")}&b=${rid("b")}&ia=0&ib=0`;
    const first = await (await get(roots, path)).text();
    expect(calls).toBe(1);
    expect(first.split("/first-workspace/traces?").length - 1).toBe(2);
    const second = await (await get(roots, path)).text();
    expect(calls).toBe(2);
    expect(second.split("/second-workspace/traces?").length - 1).toBe(2);
  });

  it("is 400 for a missing or repeated run and 404 for an unknown one", async () => {
    const { roots, rid } = standard();
    expect((await get(roots, `/compare/sim?a=${rid("a")}`)).status).toBe(400);
    expect(
      (await get(roots, `/compare/sim?a=${rid("a")}&b=${rid("a")}`)).status,
    ).toBe(400);
    expect(
      (await get(roots, `/compare/sim?a=${rid("a")}&b=deadbeef`)).status,
    ).toBe(404);
  });

  it("renders n/a kpis for empty runs", async () => {
    const { roots, rid } = writeRuns({ a: golden.runs.EA, b: golden.runs.EB });
    const html = await (
      await get(roots, `/compare/sim?a=${rid("a")}&b=${rid("b")}`)
    ).text();
    const kpi = [
      ...html.matchAll(/<div class="kpi-(?:value|label)">([^<]*)<\/div>/g),
    ]
      .map((m) => m[1])
      .join(" ");
    expect(kpi).toContain("Goal-achieved · n/a vs A");
    expect(kpi).toContain("Mean score · n/a vs A");
    expect(kpi).toContain("Mean turns · n/a vs A");
    expect(kpi).not.toContain("-100%");
    expect(html).not.toContain("kpi-card kpi-card--fail");
    expect(html).toContain("No outcome data");
  });

  it("keeps the outcomes panel for a partially empty pair", async () => {
    const { roots, rid } = writeRuns({ a: golden.runs.EA, b: golden.runs.NB });
    const html = await (
      await get(roots, `/compare/sim?a=${rid("a")}&b=${rid("b")}`)
    ).text();
    expect(html).toContain("Outcome data requires entries from both runs");
  });

  it("notes scorers measured by one run only", async () => {
    const { roots, rid } = writeRuns({
      a: golden.runs.OA,
      b: { ...golden.runs.EB, scorer_averages: { safety: 1 } },
    });
    const html = await (
      await get(roots, `/compare/sim?a=${rid("a")}&b=${rid("b")}`)
    ).text();
    expect(html).toContain("measured by one run only");
  });

  it("is 422 for invalid and syntactically corrupt reports", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const { roots, rid } = writeRuns({
        good: golden.runs.A,
        bad: '{"mode": "run", "results": "not-a-list"}',
        broken: "{not valid json at all",
      });
      expect(
        (await get(roots, `/compare/sim?a=${rid("good")}&b=${rid("bad")}`))
          .status,
      ).toBe(422);
      expect(
        (await get(roots, `/compare/sim?a=${rid("good")}&b=${rid("broken")}`))
          .status,
      ).toBe(422);
    } finally {
      console.warn = original;
    }
  });

  it("is 400 for an invalid transcript index", async () => {
    const { roots, rid } = standard();
    expect(
      (
        await get(
          roots,
          `/compare/sim/transcript?a=${rid("a")}&b=${rid("b")}&ia=x&ib=0`,
        )
      ).status,
    ).toBe(400);
  });

  it("keeps compare selectors off the sim overview", async () => {
    const { roots } = standard();
    const resp = await get(roots, "/?surface=sim");
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).not.toContain("Compare runs");
    expect(html).not.toContain('name="a"');
    expect(html).not.toContain('action="/compare/sim"');
    expect(html).toContain("Recent runs");
  });

  it("puts the compare control on the sim report", async () => {
    const { roots, rid } = standard();
    const html = await (await get(roots, `/r/${rid("a")}`)).text();
    expect(html).toContain(`name="a" value="${rid("a")}"`);
    expect(html).toContain(`<option value="${rid("b")}"`);
    expect(html).not.toContain(`<option value="${rid("a")}"`);
  });
});
