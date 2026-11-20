import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vega from "../../../src/lib/common/reports/vega.js";
import type { ReportSectionKind } from "../../../src/lib/contracts.js";
import {
  redteamAgents,
  redteamAttacks,
  redteamConfig,
  redteamReportTabs,
} from "../../../src/lib/dashboard/redteam-report-tabs.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";
import { exportRedteamHtml } from "../../../src/lib/redteam/reports/export-html.js";
import { REPORT_TAB_RENDERERS } from "../../../src/lib/redteam/reports/html-sections.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import { buildRedteamReportSections } from "../../../src/lib/redteam/reports/sections.js";
import goldens from "../fixtures/redteam-html-python-goldens.json" with {
  type: "json",
};
import reports from "../fixtures/redteam-report-sections-python-goldens.json" with {
  type: "json",
};

const hash = (html: string) =>
  createHash("sha256")
    .update(html.replaceAll(csrfToken(), "CSRF"))
    .digest("hex");
let original: NodeJS.ProcessEnv,
  directory: string,
  render: ReturnType<typeof spyOn<typeof vega, "renderSvg">>;
let captured: vega.VegaSpec[];
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-redteam-html-"));
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
  captured = [];
  render = spyOn(vega, "renderSvg").mockImplementation(async (spec) => {
    captured.push(spec);
    return Object.keys(spec).length ? '<svg data-fixture="chart"></svg>' : "";
  });
});
afterEach(async () => {
  render.mockRestore();
  process.env = original;
  await rm(directory, { recursive: true, force: true });
});
for (const row of goldens.cases)
  test(`Python complete HTML report ${row.index}`, async () => {
    const report = new RedTeamReport(reports.cases[row.index]?.input),
      sections = new Map(
        buildRedteamReportSections(report).map((s) => [s.kind, s]),
      );
    for (const expected of row.sections) {
      const section = sections.get(expected.kind as ReportSectionKind),
        renderer = REPORT_TAB_RENDERERS[expected.kind as ReportSectionKind];
      expect(section).toBeDefined();
      expect(renderer).toBeDefined();
      if (!section || !renderer) throw Error("missing section");
      captured = [];
      expect(hash(await renderer(section))).toBe(expected.hash);
      expect<unknown>(captured).toEqual(expected.charts);
    }
    captured = [];
    expect(hash(await redteamAgents(sections, report))).toBe(row.agents);
    expect<unknown>(captured).toEqual(row.agentCharts);
    captured = [];
    expect(hash(await redteamConfig(sections, report))).toBe(row.config);
    expect<unknown>(captured).toEqual(row.configCharts);
    captured = [];
    expect(
      hash(await redteamAttacks(report, 'r<&"', { standalone: true })),
    ).toBe(row.attacks);
    expect<unknown>(captured).toEqual(row.attackCharts);
    captured = [];
    expect(hash(await redteamReportTabs('r<&"', report))).toBe(row.tabs);
    expect<unknown>(captured).toEqual(row.tabCharts);
    captured = [];
    expect(
      hash(await redteamReportTabs("", report, { standalone: true })),
    ).toBe(row.expanded);
    expect<unknown>(captured).toEqual(row.expandedCharts);
    captured = [];
    expect(hash(await exportRedteamHtml(report))).toBe(row.document);
    expect<unknown>(captured).toEqual(row.expandedCharts);
  });
test("standalone report carries all evidence with no interactive apply or lazy loaders", async () => {
  const report = new RedTeamReport(reports.cases[3]?.input),
    html = await exportRedteamHtml(report);
  expect(html).toStartWith("<!DOCTYPE html>");
  expect(
    html.match(/class="rt-attack-row export-attack export-evidence"/g)?.length,
  ).toBe(report.results.length);
  expect(html).not.toContain("hx-post=");
  expect(html).not.toContain("hx-get=");
  expect(html).not.toContain('src="https://');
  expect(html).toContain("base64,");
  expect(html).toContain('id="rttab-config"');
  expect(html).toContain('id="attack-1"');
});
