import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  redteamAgentCard,
  redteamAgentStats,
  redteamAttackRow,
  redteamBreakdowns,
  redteamBreakdownsDepthSection,
  redteamBreakdownsTurnScopeGrid,
  redteamFocus,
} from "../../../src/lib/dashboard/redteam-report-tabs.js";
import {
  csrfField,
  csrfToken,
  requestRejected,
} from "../../../src/lib/dashboard/security.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import { buildRedteamReportSections } from "../../../src/lib/redteam/reports/sections.js";
import goldens from "../fixtures/redteam-components-python-goldens.json" with {
  type: "json",
};
import reports from "../fixtures/redteam-report-sections-python-goldens.json" with {
  type: "json",
};

const hash = (value: string) =>
  createHash("sha256")
    .update(value.replaceAll(csrfToken(), "CSRF"))
    .digest("hex");
let original: NodeJS.ProcessEnv, directory: string;
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-report-components-"));
  for (const key of [
    "ORQ_WORKSPACE",
    "ORQ_WORKSPACE_SLUG",
    "ORQ_API_KEY",
    "ORQ_UI_BASE_URL",
  ])
    delete process.env[key];
  process.env.ORQ_BASE_URL = "https://fallback.example";
  process.env.PATH = directory;
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(directory, "settings.json");
  await writeFile(process.env.EVALUATORQ_DASHBOARD_SETTINGS, "{}");
});
afterEach(async () => {
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(original, key)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(directory, { recursive: true, force: true });
});
for (const row of goldens.cases)
  test(`Python report components ${row.index}`, async () => {
    const report = new RedTeamReport(reports.cases[row.index]?.input),
      sections = new Map(
        buildRedteamReportSections(report).map((s) => [s.kind, s]),
      ),
      stats = redteamAgentStats(report);
    expect(hash(redteamFocus(sections, 'r<&"', report))).toBe(row.focus);
    expect(
      hash(redteamFocus(sections, 'r<&"', report, { standalone: true })),
    ).toBe(row.focusStandalone);
    expect(hash(redteamBreakdowns(sections))).toBe(row.breakdowns);
    expect(hash(redteamBreakdownsDepthSection(sections))).toBe(row.depth);
    expect(hash(redteamBreakdownsTurnScopeGrid(sections))).toBe(row.scope);
    const contexts = (sections.get("agent_context")?.data.agents ??
      []) as Record<string, unknown>[];
    for (const card of row.cards) {
      const context = contexts.find((c) => c.key === card.key) ?? null;
      expect(
        hash(
          await redteamAgentCard(
            context,
            card.key,
            stats.get(card.key) ?? {},
            report.experimentUrl,
          ),
        ),
      ).toBe(card.hash);
    }
    const first = report.results[0];
    if (first) {
      expect(hash(await redteamAttackRow(first, 'r<&"', 4))).toBe(
        row.attack as string,
      );
      expect(
        hash(await redteamAttackRow(first, 'r<&"', 4, { standalone: true })),
      ).toBe(row.attackStandalone as string);
    }
  });
test("preview forms carry process token and reject stale or cross-site requests", () => {
  const form = new FormData();
  form.set("csrf", csrfToken());
  expect(csrfField()).toContain(csrfToken());
  for (const site of ["same-origin", "none", ""]) {
    const headers = new Headers(site ? { "sec-fetch-site": site } : {});
    expect(requestRejected({ headers }, form)).toBeNull();
  }
  for (const site of ["cross-site", "same-site"]) {
    expect(
      requestRejected(
        { headers: new Headers({ "sec-fetch-site": site }) },
        form,
      ),
    ).toBe("Cross-origin request rejected.");
  }
  form.set("csrf", "stale");
  expect(requestRejected({ headers: new Headers() }, form)).toBe(
    "Stale or missing form token; reload the page and try again.",
  );
  form.delete("csrf");
  expect(requestRejected({ headers: new Headers() }, form)).not.toBeNull();
});

test("local agent cards render without an inferred platform host", async () => {
  const names = ["ORQ_BASE_URL", "ROUTER_BASE_URL"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  delete process.env.ORQ_BASE_URL;
  process.env.ROUTER_BASE_URL = "https://proxy.example/custom";
  try {
    const html = await redteamAgentCard(
      { target_kind: "agent", id: "a", workspace_id: "workspace" },
      "fixture",
      {},
    );
    expect(html).toContain("fixture");
    expect(html).not.toContain("Open in Studio");
    const explicit = await redteamAgentCard(
      { target_kind: "agent", id: "a" },
      "fixture",
      {},
      "https://staging.example/workspace/experiments/e",
    );
    expect(explicit).toContain(
      'href="https://staging.example/workspace/agents/a"',
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
