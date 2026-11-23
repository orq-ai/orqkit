// Ported from res-697 tests/dashboard/test_pairwise_tabs.py and the report-page tests of
// test_pairwise_views.py; goldens from scripts/gen_pairwise_tabs.py.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const { evaluatorqVersion, pairwiseReportTabs, withEntries } = await import(
  "../../../src/lib/dashboard/pairwise-tabs.js"
);
const { trustSignals, verdict } = await import(
  "../../../src/lib/pairwise-reports/stats.js"
);
const { PairwiseRun } = await import("../../../src/lib/pairwise-run.js");
type Run = InstanceType<typeof PairwiseRun>;

const golden = (await import("./fixtures/pairwise-tabs-golden.json"))
  .default as {
  runs: Record<string, unknown>;
  cases: {
    run: string;
    sub: number[] | null;
    opts: { focus?: number; hero_actions_html?: string };
    html: string;
  }[];
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

const kpis = (html: string): Record<string, string> =>
  Object.fromEntries(
    [
      ...html.matchAll(
        /<div class="kpi-value">(.*?)<\/div><div class="kpi-label">(.*?)<\/div>/g,
      ),
    ].map((m) => [m[2], m[1]]),
  );

const ENV = [
  "ORQ_API_KEY",
  "ORQ_WORKSPACE",
  "ORQ_WORKSPACE_SLUG",
  "ORQ_BASE_URL",
  "EVALUATORQ_DASHBOARD_SETTINGS",
];
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "pairwise-tabs-"));
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(tmp, "settings.json");
});

afterEach(() => {
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

describe("golden parity with Python pairwise_report_tabs", () => {
  for (const [i, c] of golden.cases.entries())
    it(`case ${i} ${c.run} sub=${JSON.stringify(c.sub)} ${JSON.stringify(c.opts)}`, async () => {
      const run = load(c.run);
      const entries = c.sub
        ? c.sub.map((k) => run.entries[k] as (typeof run.entries)[number])
        : null;
      const html = await pairwiseReportTabs("rid0", run, entries, {
        focus: c.opts.focus,
        heroActionsHtml: c.opts.hero_actions_html,
      });
      expect(
        html.replace(`evaluatorq ${evaluatorqVersion()}`, "evaluatorq VERSION"),
      ).toBe(c.html);
    });
});

describe("pairwise report tabs", () => {
  it("does not mutate the caller's run when narrowing", async () => {
    const run = load("base");
    const html = await pairwiseReportTabs("rid", run, run.entries.slice(0, 1));
    expect(kpis(html).Comparisons).toBe("1");
    expect(html).toContain('Comparisons <span class="tab-count">1</span>');
    expect(run.entries.length).toBe(4);
  });

  it("withEntries recomputes the rollup", () => {
    const run = load("base");
    const narrowed = withEntries(run, run.entries.slice(0, 1));
    expect(narrowed.report?.comparisons).toBe(1);
    expect(narrowed).toBeInstanceOf(PairwiseRun);
    expect(run.entries.length).toBe(4);
  });

  it("verdict state matches the outcomes", () => {
    expect(verdict(load("clear")).state).toBe("clear");
    expect(verdict(load("close")).state).toBe("too_close");
  });

  it("trust table lists the six signals", () => {
    expect(trustSignals(load("base")).map((s) => s.label)).toEqual([
      "Decided",
      "Votes thrown out",
      "Judge agreement",
      "Position bias",
      "Length",
      "Judge failures",
    ]);
  });

  it("filtered render keeps the verdict on the full run", async () => {
    const run = load("base");
    const card = (html: string) =>
      (
        html.match(/<div class="pw-verdict[\s\S]*?<\/div><\/div>/)?.[0] ?? ""
      ).replace(/<p class="pw-verdict-scope">.*?<\/p>/, "");
    const full = await pairwiseReportTabs("rid", run);
    const html = await pairwiseReportTabs("rid", run, [
      run.entries[2] as (typeof run.entries)[number],
    ]);
    expect(card(html)).toBe(card(full));
    expect(html).toContain("Show all 4");
    expect(html).toContain('id="cmp-3"');
    expect(html).not.toContain('id="cmp-1"');
  });

  it("empty run still renders every tab", async () => {
    const html = await pairwiseReportTabs("rid", load("empty"));
    expect(html.split('class="tab-label"').length - 1).toBe(5);
    expect(html).toContain("No comparisons in this run.");
  });

  it("a filter matching nothing shows the note, not a verdict", async () => {
    const html = await pairwiseReportTabs("rid", load("base"), []);
    expect(kpis(html)).toEqual({});
    expect(html).toContain("pw-filtered-clear");
  });

  it("formats tiny costs, ratios and latency deltas like Python", async () => {
    expect(await pairwiseReportTabs("rid", load("partial"))).toContain(
      "$1e-08",
    );
    expect(await pairwiseReportTabs("rid", load("usage"))).toContain(
      "$0.500000",
    );
    expect(await pairwiseReportTabs("rid", load("usage"))).toContain(
      "2,400 total",
    );
  });
});

describe("pairwise report routes", () => {
  async function client(copies = 1) {
    const dir = join(tmp, "pairwise-runs");
    mkdirSync(dir, { recursive: true });
    let path = "";
    for (let i = 0; i < copies; i++) {
      const p = await load(copies === 1 ? "base" : "base").save(
        join(dir, `run${i}.json`),
      );
      if (i === 0) path = p;
    }
    const handle = createDashboardHandler({ roots: [dir] });
    const get = async (p: string, init?: RequestInit) => {
      const resp = await handle(new Request(`http://localhost${p}`, init));
      return { status: resp.status, text: await resp.text() };
    };
    return { get, rid: reportId(path), dir };
  }

  const post = (data: Record<string, string>) => ({
    method: "POST",
    body: new URLSearchParams(data),
  });

  it("serves the tabbed page with the comparisons list", async () => {
    const c = await client();
    const resp = await c.get(`/r/${c.rid}`);
    expect(resp.status).toBe(200);
    expect(kpis(resp.text).Comparisons).toBe("4");
    expect(resp.text).toContain("pw-row-list-");
    expect(resp.text).toContain('id="cmp-1"');
  });

  it("filter route returns the tabbed body", async () => {
    const c = await client();
    const resp = await c.get(`/r/${c.rid}/filter`, post({}));
    expect(resp.status).toBe(200);
    expect(kpis(resp.text).Comparisons).toBe("4");
  });

  it("filter by winner narrows the comparisons tab", async () => {
    const c = await client();
    const html = (
      await c.get(`/r/${c.rid}/filter`, post({ winner: "prompt-v3" }))
    ).text;
    expect(html).toContain('Comparisons <span class="tab-count">1</span>');
    expect(html).toContain('id="cmp-3"');
    expect(html).not.toContain('id="cmp-1"');
    expect(kpis(html).Comparisons).toBe("1");
  });

  it("compare control needs a second pairwise run and survives filtering", async () => {
    const one = await client();
    expect((await one.get(`/r/${one.rid}`)).text).not.toContain(
      'action="/compare/pairwise"',
    );
    rmSync(one.dir, { recursive: true, force: true });
    const two = await client(2);
    expect((await two.get(`/r/${two.rid}`)).text).toContain(
      'action="/compare/pairwise"',
    );
    expect((await two.get(`/r/${two.rid}/filter`, post({}))).text).toContain(
      'action="/compare/pairwise"',
    );
  });

  function checkedTab(html: string): string {
    const checked = [
      ...html.matchAll(
        /<input class="tab-radio" type="radio" name="pwtab" id="([^"]+)"( checked)?>/g,
      ),
    ].filter((m) => m[2]);
    expect(checked.length).toBe(1);
    const id = checked[0]?.[1] as string;
    return (
      html.match(
        new RegExp(`<label class="tab-label" for="${id}">(.*?)</label>`),
      )?.[1] ?? ""
    );
  }

  const rows = (html: string) =>
    new Map(
      [
        ...html.matchAll(
          /<tbody class="pw-cmp-group" id="cmp-(\d+)"><tr><td><details class="pw-cmp-row"( open)?/g,
        ),
      ].map((m) => [Number(m[1]), Boolean(m[2])]),
    );

  async function bigClient() {
    const dir = join(tmp, "big-runs");
    mkdirSync(dir, { recursive: true });
    const run = load("clear");
    run.entries = [...run.entries, ...run.entries, ...run.entries].map((e) =>
      structuredClone(e),
    );
    const path = await run.save(join(dir, "big.json"));
    const handle = createDashboardHandler({ roots: [dir] });
    return {
      rid: reportId(path),
      get: async (p: string) =>
        (await handle(new Request(`http://localhost${p}`))).text(),
    };
  }

  it("?cmp opens the comparisons tab on that row", async () => {
    const c = await bigClient();
    const html = await c.get(`/r/${c.rid}?cmp=30`);
    expect(checkedTab(html).startsWith("Comparisons")).toBe(true);
    const r = rows(html);
    expect(r.get(30)).toBe(true);
    expect([...r.keys()]).toEqual([26, 27, 28, 29, 30]);
  });

  it("opens on overview without cmp", async () => {
    const c = await bigClient();
    const html = await c.get(`/r/${c.rid}`);
    expect(checkedTab(html).startsWith("Overview")).toBe(true);
    expect([...rows(html).values()].some(Boolean)).toBe(false);
  });

  for (const cmp of ["0", "31", "abc", ""])
    it(`ignores an invalid cmp ${JSON.stringify(cmp)}`, async () => {
      const c = await bigClient();
      const html = await c.get(`/r/${c.rid}?cmp=${cmp}`);
      expect(checkedTab(html).startsWith("Overview")).toBe(true);
      expect([...rows(html).keys()]).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
    });

  it("dots fetch the row list focused on their comparison", async () => {
    const c = await bigClient();
    const html = await c.get(`/r/${c.rid}`);
    const dots = [
      ...html.matchAll(
        /<a class="pw-dot[^"]*" href="([^"]+)"[^>]*hx-get="([^"]+)"/g,
      ),
    ];
    expect(dots.length).toBe(30);
    const [, href, hxGet] = dots[29] as RegExpMatchArray;
    expect(
      rows(await c.get((href as string).replaceAll("&amp;", "&"))).get(30),
    ).toBe(true);
    const r = rows(await c.get((hxGet as string).replaceAll("&amp;", "&")));
    expect([...r.keys()]).toEqual([26, 27, 28, 29, 30]);
    expect(r.get(30)).toBe(true);
  });
});
