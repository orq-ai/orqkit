import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ApplyRecommendationsResult } from "../../../src/lib/common/apply.js";
import { reportId } from "../../../src/lib/common/dashboard/library.js";
import { createDashboardHandler } from "../../../src/lib/dashboard/app.js";
import {
  type ApplyClients,
  type ApplyRouteDeps,
  clearApplyPreviews,
} from "../../../src/lib/dashboard/apply-routes.js";
import { recordAppliedOnReport } from "../../../src/lib/dashboard/apply-ui.js";
import { DashboardAuth } from "../../../src/lib/dashboard/auth.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";
import type { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

const rtGolden = (await import("./fixtures/redteam-views-golden.json"))
  .default as unknown as Record<string, { report: Record<string, unknown> }>;
const simGolden = (await import("./fixtures/sim-views-golden.json"))
  .default as { run: Record<string, unknown> };

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const AREA = {
  category: "LLM01",
  category_name: "Prompt injection",
  risk_score: 2.25,
  traces_analyzed: 3,
  recommendations: ["Refuse role overrides", "Quote user input"],
  patterns_observed: "Override attempts <b>",
};
const SIM_REC = {
  result_index: 1,
  datapoint_id: null,
  persona: "Impatient user",
  scenario: "Refund request",
  triggers: ["asked twice", "threatened"],
  suggestions: ["Confirm the order id", "Offer escalation"],
};

class FakeOrq {
  instructions = "Be helpful.";
  updates: { body: Record<string, unknown>; key: string }[] = [];
  closed = 0;
  failUpdate = false;
  agents = {
    retrieve: async (_key: string) => ({ instructions: this.instructions }),
    update: async (body: Record<string, unknown>, key: string) => {
      if (this.failUpdate) throw new Error("boom");
      this.updates.push({ body, key });
      return { version: "1.1" };
    },
  };
  close() {
    this.closed += 1;
  }
}

let orq = new FakeOrq();
let apiKey = "key-1";
let applyCalls: { items: unknown[]; agentKey: string; applied: string[] }[] =
  [];

function fakeApply(field: "recommendations" | "suggestions") {
  return async (
    items: unknown[],
    agentKey: string,
    _clients: ApplyClients,
    applied: string[],
  ): Promise<ApplyRecommendationsResult> => {
    applyCalls.push({ items, agentKey, applied });
    const recs = items
      .flatMap((i) => (i as Record<string, string[]>)[field] ?? [])
      .filter((r) => !applied.includes(r));
    const next = `${orq.instructions}\n${recs.join("\n")}`;
    return {
      agentKey,
      recommendations: recs,
      originalInstructions: orq.instructions,
      newInstructions: recs.length ? next : orq.instructions,
      diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n Be helpful.\n+new line\n-old",
      applied: false,
      newVersion: null,
      mergeFailed: false,
    };
  };
}

const deps = (): ApplyRouteDeps => ({
  selectedAuth: async () => ({
    auth: new DashboardAuth("environment", apiKey, "https://my.orq.ai"),
    settings: {
      orqWorkspace: "ws",
      orqProjectId: null,
    } as unknown as DashboardSettings,
  }),
  buildClients: async () => ({
    orq: orq as never,
    llm: {} as never,
    model: "m",
  }),
  closeClients: async (c) => {
    (c.orq as unknown as FakeOrq).close();
  },
  applyRedteam: fakeApply("recommendations"),
  applySim: fakeApply("suggestions"),
});

async function setup(kind: "redteam" | "sim", patch: Record<string, unknown>) {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-apply-")));
  dirs.push(dir);
  const path =
    kind === "redteam"
      ? join(dir, "rt_apply_20260101_000000.json")
      : join(dir, "sim_20261117_090130.json");
  const base =
    kind === "redteam"
      ? (rtGolden.single?.report as Record<string, unknown>)
      : simGolden.run;
  await writeFile(path, JSON.stringify({ ...base, ...patch }));
  const handle = createDashboardHandler({ roots: [dir], apply: deps() });
  return { path, rid: reportId(path), handle };
}

const post = (
  handle: (r: Request) => Promise<Response>,
  url: string,
  fields: Record<string, string>,
  csrf = csrfToken(),
) =>
  handle(
    new Request(`http://x${url}`, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...fields }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );

const token = (html: string) =>
  /name="confirm_token" value="([^"]+)"/.exec(html)?.[1] ?? "";

beforeEach(() => {
  orq = new FakeOrq();
  apiKey = "key-1";
  applyCalls = [];
  clearApplyPreviews();
});

describe("apply dismiss", () => {
  it("returns an empty fragment", async () => {
    const { handle } = await setup("redteam", {});
    const res = await handle(new Request("http://x/apply/dismiss"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("red-team apply", () => {
  const rt = () => setup("redteam", { focus_area_recommendations: [AREA] });

  it("previews all pending recommendations and writes on confirm", async () => {
    const { rid, handle, path } = await rt();
    const res = await post(handle, `/r/${rid}/redteam/apply/preview`, {
      agent_key: "solo-agent",
    });
    const html = await res.text();
    expect(html).toContain("Preview changes");
    expect(html).toContain("2 recommendations to fold in");
    expect(html).toContain("Read this diff before applying.");
    expect(html).toContain(
      '<span class="rt-diff-line rt-diff-file">--- a</span>',
    );
    expect(html).toContain(
      '<span class="rt-diff-line rt-diff-add">+new line</span>',
    );
    expect(html).toContain(
      '<span class="rt-diff-line rt-diff-del">-old</span>',
    );
    expect(html).toContain('<span class="rt-diff-line rt-diff-hunk">');
    expect(html).toContain(
      '<span class="rt-diff-line rt-diff-ctx"> Be helpful.</span>',
    );
    expect(orq.closed).toBe(1);

    const confirm = await post(handle, `/r/${rid}/redteam/apply/confirm`, {
      confirm_token: token(html),
    });
    const done = await confirm.text();
    expect(done).toContain("Applied 2 recommendation(s)");
    expect(done).toContain('<span class="rt-applied-version">v1.1</span>');
    expect(orq.updates).toHaveLength(1);
    expect(orq.updates[0]?.key).toBe("solo-agent");
    expect(orq.updates[0]?.body.versionDescription).toBe(
      "Applied 2 red-team remediation recommendation(s)",
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.applied_recommendations).toEqual([
      "Refuse role overrides",
      "Quote user input",
    ]);
  });

  it("narrows to one bullet and shows the focus-area breakdown", async () => {
    const { rid, handle } = await rt();
    const html = await (
      await post(handle, `/r/${rid}/redteam/apply/preview`, {
        agent_key: "solo-agent",
        rec: " Quote user input ",
        category: "LLM01",
      })
    ).text();
    expect(applyCalls[0]?.items).toHaveLength(1);
    expect(applyCalls[0]?.items[0]).toMatchObject({
      category: "LLM01",
      recommendations: ["Quote user input"],
    });
    expect(html).toContain("Recommendation to fold in");
    expect(html).toContain("P1 · Critical priority");
    expect(html).toContain("risk 2.2 · 3 failed trace(s) analyzed");
    expect(html).toContain("Override attempts &lt;b&gt;");
  });

  it("rejects a bullet that is gone or already applied", async () => {
    const { rid, handle } = await rt();
    const gone = await post(handle, `/r/${rid}/redteam/apply/preview`, {
      agent_key: "solo-agent",
      rec: "Nope",
      category: "LLM01",
    });
    expect(await gone.text()).toContain(
      "That recommendation is no longer on the report; reload the page.",
    );
    const applied = await setup("redteam", {
      focus_area_recommendations: [AREA],
      applied_recommendations: ["Quote user input"],
    });
    const res = await post(
      applied.handle,
      `/r/${applied.rid}/redteam/apply/preview`,
      { agent_key: "solo-agent", rec: "Quote user input", category: "LLM01" },
    );
    expect(await res.text()).toContain(
      "That recommendation is already applied to the agent.",
    );
  });

  it("refuses multi-agent runs and missing reports", async () => {
    const { rid, handle } = await setup("redteam", {
      tested_agents: ["a", "b"],
      focus_area_recommendations: [AREA],
    });
    const res = await post(handle, `/r/${rid}/redteam/apply/preview`, {});
    expect(await res.text()).toContain(
      "Applying recommendations is available for single-agent runs; this run compared several agents.",
    );
    const missing = await post(handle, "/r/deadbeef/redteam/apply/preview", {});
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Report deadbeef not found");
    const gone = await post(handle, "/r/deadbeef/redteam/apply/confirm", {});
    expect(await gone.text()).toContain(
      "That report is no longer available; reload the page.",
    );
  });

  it("needs an agent key and a valid csrf token", async () => {
    const { rid, handle } = await rt();
    const noAgent = await post(handle, `/r/${rid}/redteam/apply/preview`, {});
    expect(await noAgent.text()).toContain(
      "This run does not record which agent it tested, so there is nothing to apply to.",
    );
    const bad = await post(
      handle,
      `/r/${rid}/redteam/apply/preview`,
      { agent_key: "solo-agent" },
      "wrong",
    );
    expect(await bad.text()).toContain("Stale or missing form token");
    expect(applyCalls).toHaveLength(0);
  });

  it("uses single-use tokens and guards against lost updates", async () => {
    const { rid, handle } = await rt();
    const preview = async () =>
      token(
        await (
          await post(handle, `/r/${rid}/redteam/apply/preview`, {
            agent_key: "solo-agent",
          })
        ).text(),
      );
    const first = await preview();
    orq.instructions = "Changed elsewhere.";
    const stale = await post(handle, `/r/${rid}/redteam/apply/confirm`, {
      confirm_token: first,
    });
    expect(await stale.text()).toContain(
      "The agent instructions changed after this preview was made",
    );
    const reused = await post(handle, `/r/${rid}/redteam/apply/confirm`, {
      confirm_token: first,
    });
    expect(await reused.text()).toContain(
      "This preview has expired or was already applied; run the preview again.",
    );
    expect(orq.updates).toHaveLength(0);
  });

  it("refuses a confirm after the credentials change", async () => {
    const { rid, handle } = await rt();
    const t = token(
      await (
        await post(handle, `/r/${rid}/redteam/apply/preview`, {
          agent_key: "solo-agent",
        })
      ).text(),
    );
    apiKey = "key-2";
    const res = await post(handle, `/r/${rid}/redteam/apply/confirm`, {
      confirm_token: t,
    });
    expect(await res.text()).toContain(
      "The Orq credentials changed after this preview; run the preview again.",
    );
  });

  it("refuses a sim confirm on a red-team report", async () => {
    const { rid, handle } = await rt();
    const t = token(
      await (
        await post(handle, `/r/${rid}/redteam/apply/preview`, {
          agent_key: "solo-agent",
        })
      ).text(),
    );
    const res = await post(handle, `/r/${rid}/sim/apply/confirm`, {
      confirm_token: t,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("That report is no longer available");
  });

  it("reports an agent update failure", async () => {
    const { rid, handle } = await rt();
    const t = token(
      await (
        await post(handle, `/r/${rid}/redteam/apply/preview`, {
          agent_key: "solo-agent",
        })
      ).text(),
    );
    orq.failUpdate = true;
    const res = await post(handle, `/r/${rid}/redteam/apply/confirm`, {
      confirm_token: t,
    });
    expect(await res.text()).toContain("Agent update failed: boom");
  });

  it("shows the empty message and the unchanged drawer", async () => {
    const all = await setup("redteam", {
      focus_area_recommendations: [AREA],
      applied_recommendations: AREA.recommendations,
    });
    const res = await post(all.handle, `/r/${all.rid}/redteam/apply/preview`, {
      agent_key: "solo-agent",
    });
    expect(await res.text()).toContain(
      "No new recommendations to apply \u2014 everything is already applied.",
    );
  });
});

describe("simulation apply", () => {
  const sim = (patch: Record<string, unknown> = {}) =>
    setup("sim", {
      target_kind: "orq_agent",
      target: "support-agent",
      recommendations: [SIM_REC],
      ...patch,
    });

  it("previews with the run target and records applied suggestions", async () => {
    const { rid, handle, path } = await sim();
    const html = await (
      await post(handle, `/r/${rid}/sim/apply/preview`, {
        rec: "Offer escalation",
        result_index: "1",
      })
    ).text();
    expect(applyCalls[0]?.agentKey).toBe("support-agent");
    expect(html).toContain("Simulation finding");
    expect(html).toContain("Impatient user");
    expect(html).toContain("asked twice; threatened");
    const done = await (
      await post(handle, `/r/${rid}/sim/apply/confirm`, {
        confirm_token: token(html),
      })
    ).text();
    expect(done).toContain("Applied 1 recommendation(s)");
    expect(orq.updates[0]?.body.versionDescription).toBe(
      "Applied 1 simulation remediation suggestion(s)",
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.applied_suggestions).toEqual(["Offer escalation"]);
  });

  it("needs an orq agent target", async () => {
    const { rid, handle } = await sim({ target_kind: "openai_model" });
    const res = await post(handle, `/r/${rid}/sim/apply/preview`, {});
    expect(await res.text()).toContain(
      "Applying suggestions needs a run that targeted an orq agent.",
    );
  });

  it("rejects a bad result index", async () => {
    const { rid, handle } = await sim();
    const res = await post(handle, `/r/${rid}/sim/apply/preview`, {
      rec: "Offer escalation",
      result_index: "x",
    });
    expect(await res.text()).toContain(
      "That suggestion is no longer on the report; reload the page.",
    );
  });
});

describe("recordAppliedOnReport", () => {
  it("dedups, keeps other fields, and escapes non-ASCII like json.dumps", async () => {
    const dir = resolve(await mkdtemp(join(tmpdir(), "eq-record-")));
    dirs.push(dir);
    const path = join(dir, "r.json");
    await writeFile(path, JSON.stringify({ a: 1, applied_suggestions: ["x"] }));
    await Promise.all([
      recordAppliedOnReport(path, ["x ", "café"], "applied_suggestions"),
      recordAppliedOnReport(path, ["y"], "applied_suggestions"),
    ]);
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual({
      a: 1,
      applied_suggestions: ["x", "café", "y"],
    });
    expect(text).toContain('"caf\\u00e9"');
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
