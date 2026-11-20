import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  redteamAgentPill,
  redteamAgentRow,
  redteamAgentStats,
  redteamAgentsUnderTest,
  redteamExecSummary,
  redteamHero,
  redteamKpiBand,
  redteamOverview,
  redteamRunName,
} from "../../../src/lib/dashboard/redteam-report-tabs.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import { buildRedteamReportSections } from "../../../src/lib/redteam/reports/sections.js";
import goldens from "../fixtures/redteam-overview-python-goldens.json" with {
  type: "json",
};
import reports from "../fixtures/redteam-report-sections-python-goldens.json" with {
  type: "json",
};

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let original: NodeJS.ProcessEnv, directory: string;
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-report-overview-"));
  for (const key of [
    "ORQ_WORKSPACE",
    "ORQ_WORKSPACE_SLUG",
    "ORQ_API_KEY",
    "ORQ_UI_BASE_URL",
  ])
    delete process.env[key];
  process.env.PATH = directory;
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(directory, "settings.json");
  await writeFile(process.env.EVALUATORQ_DASHBOARD_SETTINGS, "{}");
});
afterEach(async () => {
  process.env = original;
  await rm(directory, { recursive: true, force: true });
});
for (const row of goldens.cases)
  test(`Python report overview ${row.index}`, async () => {
    const report = new RedTeamReport(reports.cases[row.index]?.input),
      sections = new Map(
        buildRedteamReportSections(report).map((s) => [s.kind, s]),
      ),
      stats = redteamAgentStats(report),
      summary = sections.get("summary")?.data ?? {};
    expect<unknown>(Object.fromEntries(stats)).toEqual(row.stats);
    expect(hash(redteamExecSummary(summary, sections))).toBe(row.summary);
    expect(hash(redteamKpiBand(summary))).toBe(row.kpi);
    expect(hash(redteamOverview(sections, report))).toBe(row.overview);
    expect(hash(redteamAgentsUnderTest(report))).toBe(row.table);
    expect(hash(await redteamHero(report))).toBe(row.hero);
    expect([...stats.values()].map((s) => hash(redteamAgentRow(s)))).toEqual(
      row.agentRows,
    );
    expect([...stats.values()].map((s) => hash(redteamAgentPill(s)))).toEqual(
      row.pills,
    );
  });
for (const [index, row] of goldens.summaries.entries())
  test(`Python unknown coverage ${index}`, () => {
    expect(hash(redteamExecSummary(row.input, new Map()))).toBe(row.summary);
    expect(hash(redteamKpiBand(row.input))).toBe(row.kpi);
  });
for (const [index, row] of goldens.names.entries())
  test(`Python report name ${index}`, () => {
    const report = new RedTeamReport({
      ...reports.cases[0]?.input,
      description: row.description,
      testedAgents: row.agents,
    });
    expect(redteamRunName(report)).toBe(row.expected);
  });
