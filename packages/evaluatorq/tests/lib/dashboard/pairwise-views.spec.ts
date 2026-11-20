// Ported from res-697 tests/dashboard/test_pairwise_views.py; goldens from scripts/gen_pairwise_views.py.
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
  renderPairwiseComparisonDetail,
  renderPairwiseComparisons,
  renderPairwiseRowList,
  validFocus,
} = await import("../../../src/lib/dashboard/pairwise-views.js");
const { PairwiseComparisonSchema } = await import(
  "../../../src/lib/pairwise.js"
);
const { newRun } = await import("../../../src/lib/pairwise-run.js");
type Run = InstanceType<
  typeof import("../../../src/lib/pairwise-run.js").PairwiseRun
>;

const golden = (await import("./fixtures/pairwise-views-golden.json"))
  .default as {
  cases: {
    kind: string;
    run: string;
    sub?: number[] | null;
    opts?: Record<string, unknown>;
    focus?: number;
    idx?: number;
    html: string;
  }[];
};

const JUDGES = ["judge-one", "judge-two", "judge-three"];
type Verdict = "A" | "B" | "tie" | null;
const vote = (model: string, value: Verdict, flipped = false) => ({
  model,
  vote: value,
  flipped,
  explanation: `${model} says ${value ?? "None"}`,
});
const comparison = (
  values: Verdict[],
  winner: string,
  flipped = false,
  traceId: string | null = null,
) =>
  PairwiseComparisonSchema.parse({
    winner,
    traceId,
    votes: values.map((v, i) => vote(JUDGES[i] as string, v, flipped)),
  });

function small(responseA4 = "a4 <i>"): Run {
  const r = newRun({
    runName: "v2 vs v3",
    labelA: "prompt-v2",
    labelB: "prompt-v3",
    judges: JUDGES,
    criteria: "accuracy",
  });
  r.add(comparison(["B", "B", "B"], "B"), {
    question: "q1",
    responseA: "a1",
    responseB: "b1",
  });
  r.add(comparison(["A", "B", "tie"], "tie"), {
    question: "q2",
    responseA: "a2",
    responseB: "b2",
  });
  r.add(comparison(["A", "A", "A"], "A"), {
    question: "q3",
    responseA: "a3",
    responseB: "b3",
  });
  r.add(comparison([null, null, null], "inconclusive", true), {
    question: "q4",
    responseA: responseA4,
    responseB: "b4",
  });
  return r;
}

function big(): Run {
  const r = newRun({ runName: "big", judges: JUDGES });
  for (let i = 0; i < 30; i++)
    r.add(comparison(["A", "A", "A"], "A"), {
      question: `q${i}`,
      responseA: "a",
      responseB: "b",
    });
  return r;
}

function obs(): Run {
  const r = newRun({
    runName: "obs",
    labelA: "old",
    labelB: "new",
    judges: ["j"],
  });
  r.add(
    PairwiseComparisonSchema.parse({
      winner: "B",
      votes: [
        {
          model: "j",
          vote: "B",
          explanation: "reconciled",
          observations: [
            {
              ordering: "ab",
              repetition: 0,
              verdict: "B",
              explanation: "first look",
            },
            {
              ordering: "ba",
              repetition: 0,
              verdict: "B",
              explanation: "second look",
            },
            {
              ordering: "ba",
              repetition: 1,
              verdict: "A",
              explanation: "third look",
            },
          ],
        },
      ],
    }),
    { question: "q", responseA: "a", responseB: "b" },
  );
  return r;
}

function single(traceId: string | null, question = "q", responseA = "a"): Run {
  const r = newRun({ runName: "one", judges: ["j"] });
  r.add(
    PairwiseComparisonSchema.parse({
      winner: "A",
      traceId,
      votes: [vote("j", "A")],
    }),
    { question, responseA, responseB: "ok" },
  );
  return r;
}

const RUNS: Record<string, () => Run> = { small: () => small(), big, obs };

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
  tmp = mkdtempSync(join(tmpdir(), "pairwise-views-"));
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(tmp, "settings.json");
  scope.cli = null;
});

afterEach(() => {
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

async function client(run: Run) {
  const dir = join(tmp, "pairwise-runs");
  mkdirSync(dir, { recursive: true });
  const path = await run.save(join(dir, "run.json"));
  const handle = createDashboardHandler({ roots: [dir] });
  const get = async (p: string) => {
    const resp = await handle(new Request(`http://localhost${p}`));
    return { status: resp.status, text: await resp.text() };
  };
  return { get, rid: reportId(path) };
}

const numbers = (html: string) =>
  [...html.matchAll(/<tbody class="pw-cmp-group" id="cmp-(\d+)"/g)].map((m) =>
    Number(m[1]),
  );

function rows(html: string): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const m of html.matchAll(
    /<tbody class="pw-cmp-group" id="cmp-(\d+)"><tr><td><details class="pw-cmp-row"( open)?/g,
  ))
    out.set(Number(m[1]), Boolean(m[2]));
  return out;
}

const range = (a: number, b: number) =>
  Array.from({ length: b - a }, (_, i) => a + i);

describe("golden parity with Python renderers", () => {
  for (const [i, c] of golden.cases.entries())
    it(`case ${i} ${c.kind} ${c.run}`, async () => {
      const run = (RUNS[c.run] as () => Run)();
      const entries = c.sub
        ? c.sub.map((k) => run.entries[k] as (typeof run.entries)[number])
        : run.entries;
      let html: string;
      if (c.kind === "rowList") {
        const o = c.opts ?? {};
        html = await renderPairwiseRowList("rid0", run, entries, {
          sort: o.sort as string | undefined,
          direction: o.direction as string | undefined,
          page: o.page as number | undefined,
          pageSize: o.page_size as number | undefined,
          focus: o.focus as number | undefined,
        });
      } else if (c.kind === "comparisons")
        html = await renderPairwiseComparisons("rid0", run, entries, {
          focus: c.focus,
        });
      else html = renderPairwiseComparisonDetail(run, c.idx as number);
      expect(html).toBe(c.html);
    });
});

describe("pairwise row list route", () => {
  it("renders one group per comparison", async () => {
    const c = await client(small());
    const resp = await c.get(`/r/${c.rid}/pairwise/row-list`);
    expect(resp.status).toBe(200);
    expect(numbers(resp.text)).toEqual([1, 2, 3, 4]);
    expect(resp.text).toContain("4 comparisons");
  });

  it("split filter narrows the list and keeps numbering", async () => {
    const c = await client(small());
    expect(
      numbers((await c.get(`/r/${c.rid}/pairwise/row-list?split=yes`)).text),
    ).toEqual([2, 4]);
  });

  it("sorts by winner A, B, tie, inconclusive", async () => {
    const c = await client(small());
    expect(
      numbers((await c.get(`/r/${c.rid}/pairwise/row-list?sort=winner`)).text),
    ).toEqual([3, 1, 2, 4]);
    expect(
      numbers(
        (await c.get(`/r/${c.rid}/pairwise/row-list?sort=winner&dir=desc`))
          .text,
      ),
    ).toEqual([4, 2, 1, 3]);
  });

  it("falls back on an invalid sort and direction", async () => {
    const c = await client(small());
    expect(
      numbers(
        (await c.get(`/r/${c.rid}/pairwise/row-list?sort=nope&dir=sideways`))
          .text,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("second page keeps original numbers", async () => {
    const c = await client(big());
    const resp = await c.get(`/r/${c.rid}/pairwise/row-list?page=2`);
    expect(numbers(resp.text)).toEqual([26, 27, 28, 29, 30]);
    expect(resp.text).toContain("Page 2 of 2 · 30 comparisons");
  });

  it("clamps the page", async () => {
    const c = await client(big());
    const at = async (p: string) =>
      numbers((await c.get(`/r/${c.rid}/pairwise/row-list?page=${p}`)).text);
    expect(await at("99")).toEqual([26, 27, 28, 29, 30]);
    expect(await at("-3")).toEqual(range(1, 26));
    expect(await at("abc")).toEqual(range(1, 26));
  });

  it("focus renders the page holding the row with it open", async () => {
    const c = await client(big());
    const html = (await c.get(`/r/${c.rid}/pairwise/row-list?focus=30`)).text;
    const r = rows(html);
    expect([...r.keys()]).toEqual([26, 27, 28, 29, 30]);
    expect([...r].filter(([, o]) => o).map(([n]) => n)).toEqual([30]);
    expect(html).toContain(
      (await c.get(`/r/${c.rid}/pairwise/comparison?idx=29`)).text,
    );
  });

  it("focus overrides the page parameter", async () => {
    const c = await client(big());
    const html = (await c.get(`/r/${c.rid}/pairwise/row-list?page=1&focus=30`))
      .text;
    expect([...rows(html).keys()]).toEqual([26, 27, 28, 29, 30]);
  });

  it("focus follows the sort order", async () => {
    const c = await client(big());
    const r = rows(
      (await c.get(`/r/${c.rid}/pairwise/row-list?dir=desc&focus=3`)).text,
    );
    expect([...r.keys()]).toEqual([5, 4, 3, 2, 1]);
    expect(r.get(3)).toBe(true);
  });

  for (const focus of ["0", "31", "-1", "abc", ""])
    it(`invalid focus ${JSON.stringify(focus)} falls back to the requested page`, async () => {
      const c = await client(big());
      const r = rows(
        (await c.get(`/r/${c.rid}/pairwise/row-list?page=2&focus=${focus}`))
          .text,
      );
      expect([...r.keys()]).toEqual([26, 27, 28, 29, 30]);
      expect([...r.values()].some(Boolean)).toBe(false);
    });

  it("ignores focus on a filtered-out row", async () => {
    const c = await client(small());
    const r = rows(
      (await c.get(`/r/${c.rid}/pairwise/row-list?split=yes&focus=1`)).text,
    );
    expect([...r.keys()]).toEqual([2, 4]);
    expect([...r.values()].some(Boolean)).toBe(false);
  });

  it("rows are closed without focus", async () => {
    const c = await client(small());
    const r = rows((await c.get(`/r/${c.rid}/pairwise/row-list`)).text);
    expect([...r.values()].some(Boolean)).toBe(false);
  });

  it("pager buttons scroll to the list top, sort buttons do not", async () => {
    const c = await client(big());
    const html = (await c.get(`/r/${c.rid}/pairwise/row-list?page=1`)).text;
    expect(html).toContain(
      `hx-swap="outerHTML show:#pw-row-list-${c.rid}:top"`,
    );
    const sortBtn = html.match(/<button[^>]*pw-th-sort[^>]*>/)?.[0] ?? "";
    expect(sortBtn).not.toBe("");
    expect(sortBtn).not.toContain("show:");
  });

  it("idle sort button has a hint and an aria label", async () => {
    const c = await client(small());
    const html = (
      await c.get(`/r/${c.rid}/pairwise/row-list?sort=index&dir=asc`)
    ).text;
    expect(html).not.toContain("aria-sort");
    expect(html).toContain('aria-label="Sort by winner"');
    expect(html).toContain(
      'aria-label="Number, sorted ascending. Activate to sort descending."',
    );
    expect(html).toContain(`id="pw-sort-winner-${c.rid}"`);
    expect(html).toContain(`id="pw-sort-index-${c.rid}"`);
    expect(html.split("pw-sort-hint").length - 1).toBe(1);
  });

  it("edge pager buttons are aria-disabled without hx", async () => {
    const c = await client(big());
    const html = (await c.get(`/r/${c.rid}/pairwise/row-list?page=1`)).text;
    expect(html).toContain('aria-label="Comparison pages"');
    const prev = html.match(/<button[^>]*id="pw-prev-[^>]*>/)?.[0] ?? "";
    const next = html.match(/<button[^>]*id="pw-next-[^>]*>/)?.[0] ?? "";
    expect(prev).toContain('aria-disabled="true"');
    expect(prev).not.toContain("hx-");
    expect(prev).not.toContain(" disabled");
    expect(next).toContain("hx-");
    expect(next).not.toContain("aria-disabled");
  });
});

describe("pairwise comparison detail route", () => {
  it("shows both responses, every judge and the flip tag", async () => {
    const c = await client(small("a4"));
    const resp = await c.get(`/r/${c.rid}/pairwise/comparison?idx=3`);
    expect(resp.status).toBe(200);
    expect(resp.text).toContain("a4");
    expect(resp.text).toContain("b4");
    for (const j of JUDGES) expect(resp.text).toContain(j);
    expect(resp.text).toContain(
      "⚖ flipped when sides swapped, vote thrown out",
    );
    expect(
      (await c.get(`/r/${c.rid}/pairwise/comparison?idx=0`)).text,
    ).not.toContain("⚖");
  });

  it("lists each pass with ordering labels", async () => {
    const c = await client(obs());
    const text = (await c.get(`/r/${c.rid}/pairwise/comparison?idx=0`)).text;
    for (const s of [
      "original order",
      "swapped order",
      "pass 2",
      "first look",
      "second look",
      "third look",
    ])
      expect(text).toContain(s);
  });

  for (const idx of ["abc", "-1", "99", ""])
    it(`bad idx ${JSON.stringify(idx)} is a 200 empty state`, async () => {
      const c = await client(small());
      const resp = await c.get(`/r/${c.rid}/pairwise/comparison?idx=${idx}`);
      expect(resp.status).toBe(200);
      expect(resp.text).toContain("No comparison at that index.");
    });

  it("escapes response markup", async () => {
    const c = await client(
      single(null, "<script>q</script>", "<img onerror=alert(1)>"),
    );
    const detail = (await c.get(`/r/${c.rid}/pairwise/comparison?idx=0`)).text;
    expect(detail).not.toContain("<img");
    expect(detail).toContain("&lt;img");
    expect((await c.get(`/r/${c.rid}/pairwise/row-list`)).text).not.toContain(
      "<script>",
    );
  });
});

describe("unknown and invalid runs", () => {
  it("unknown rid is 404", async () => {
    const c = await client(small());
    expect((await c.get("/r/does-not-exist/pairwise/row-list")).status).toBe(
      404,
    );
    expect(
      (await c.get("/r/does-not-exist/pairwise/comparison?idx=0")).status,
    ).toBe(404);
  });

  for (const [name, dirName, body] of [
    ["a non-pairwise rid", "sim-runs", '{"mode": "simulation"}'],
    [
      "a pairwise file that fails validation",
      "pairwise-runs",
      '{"judging": "pairwise", "entries": "not-a-list"}',
    ],
  ] as const)
    it(`${name} is 404`, async () => {
      const dir = join(tmp, dirName);
      mkdirSync(dir);
      const path = join(dir, "x.json");
      writeFileSync(path, body);
      const handle = createDashboardHandler({ roots: [dir] });
      const rid = reportId(path);
      for (const p of ["row-list", "comparison?idx=0"]) {
        const resp = await handle(
          new Request(`http://localhost/r/${rid}/pairwise/${p}`),
        );
        expect(resp.status).toBe(404);
      }
    });
});

describe("trace links", () => {
  it("appear with a workspace", async () => {
    process.env.ORQ_WORKSPACE = "acme";
    const c = await client(single("abc123def456"));
    expect((await c.get(`/r/${c.rid}/pairwise/row-list`)).text).toContain(
      "abc123def456",
    );
  });

  it("are absent without a workspace", async () => {
    const c = await client(single("abc123def456"));
    const text = (await c.get(`/r/${c.rid}/pairwise/row-list`)).text;
    expect(text).not.toContain("abc123def456");
    expect(text).not.toContain("trace-link");
  });

  it("row list discovers the CLI workspace once per render", async () => {
    scope.cli = "/usr/bin/orq";
    let calls = 0;
    scope.discover = async () => {
      calls += 1;
      return {
        workspaceKey: "acme",
        workspaceId: null,
        projects: [],
        error: null,
      };
    };
    const r = newRun({ runName: "traced", judges: ["j"] });
    for (let i = 0; i < 10; i++)
      r.add(
        comparison(["A"], "A", false, `trace${String(i).padStart(8, "0")}`),
        {
          question: `q${i}`,
          responseA: "a",
          responseB: "b",
        },
      );
    const c = await client(r);
    const text = (await c.get(`/r/${c.rid}/pairwise/row-list`)).text;
    expect(text).toContain("trace00000003");
    expect(calls).toBe(1);
  });
});

describe("validFocus", () => {
  it("keeps only numbers present in the entries", () => {
    const run = small();
    const sub = [run.entries[1], run.entries[3]] as typeof run.entries;
    expect(validFocus(run, sub, 2)).toBe(2);
    expect(validFocus(run, sub, 1)).toBeNull();
    expect(validFocus(run, sub, null)).toBeNull();
  });
});
