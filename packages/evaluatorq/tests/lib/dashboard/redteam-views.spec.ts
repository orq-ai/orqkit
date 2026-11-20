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
import { join, resolve } from "node:path";

import * as realScope from "../../../src/lib/dashboard/orq-scope.js";

beforeEach(() => {
  spyOn(realScope, "findOrqCli").mockImplementation(async () => null);
  spyOn(realScope, "discoverOrqScope").mockResolvedValue({
    workspaceKey: null,
    workspaceId: null,
    projects: [],
    error: "not mocked",
  });
});
afterEach(() => mock.restore());

const { reportId } = await import(
  "../../../src/lib/common/dashboard/library.js"
);
const { createDashboardHandler } = await import(
  "../../../src/lib/dashboard/app.js"
);

interface GoldenResponse {
  url: string;
  status: number;
  text: string;
}
const golden = (await import("./fixtures/redteam-views-golden.json"))
  .default as unknown as Record<
  string,
  { report: unknown; responses: GoldenResponse[] }
>;

const ISLAND =
  /(<script type="application\/json" data-vega-for="[^"]*">)(.*?)(<\/script>)/gs;

function splitIslands(html: string): { shell: string; specs: unknown[] } {
  const specs: unknown[] = [];
  const shell = html.replace(
    ISLAND,
    (_, open: string, body: string, close: string) => {
      specs.push(JSON.parse(body.replaceAll("<\\/", "</")));
      return `${open}SPEC${close}`;
    },
  );
  return { shell, specs };
}

const ENV = [
  "ORQ_API_KEY",
  "ORQ_BASE_URL",
  "ORQ_PROFILE",
  "ORQ_WORKSPACE",
  "ORQ_PROJECT",
  "EVALUATORQ_DASHBOARD_SETTINGS",
];
let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  tmp = resolve(mkdtempSync(join(tmpdir(), "redteam-views-")));
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(tmp, "settings.json");
});

afterEach(() => {
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

function setup(name: string) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rt_${name}_20260101_000000.json`);
  writeFileSync(path, JSON.stringify(golden[name]?.report));
  const handle = createDashboardHandler({ roots: [dir] });
  return { rid: reportId(path), handle };
}

describe("redteam view routes match the Python goldens", () => {
  for (const [name, scenario] of Object.entries(golden)) {
    it(name, async () => {
      const { rid, handle } = setup(name);
      for (const expected of scenario.responses) {
        const res = await handle(
          new Request(`http://x${expected.url.replace("RID", rid)}`),
        );
        const body = (await res.text()).replaceAll(rid, "RID");
        const got = splitIslands(body);
        const want = splitIslands(expected.text);
        expect({ url: expected.url, status: res.status, ...got }).toEqual({
          url: expected.url,
          status: expected.status,
          ...want,
        });
      }
    });
  }
});

describe("report page wiring", () => {
  it("mounts the view routes behind the filter form", async () => {
    const { rid, handle } = setup("multi");
    const res = await handle(new Request(`http://x/r/${rid}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/redteam/attack");
    expect(html).toContain('hx-include="#filter-form"');
    expect(html).toContain('id="filter-form"');
  });

  it("emits the filter-changed trigger on filter posts", async () => {
    const { rid, handle } = setup("multi");
    for (const body of ["", "result=Vulnerable"]) {
      const res = await handle(
        new Request(`http://x/r/${rid}/filter`, {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("hx-trigger") ?? "").toContain(
        "orq:filter-changed",
      );
    }
  });
});
