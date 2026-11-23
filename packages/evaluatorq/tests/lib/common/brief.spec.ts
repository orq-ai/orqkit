import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import {
  findingRowsRedteam,
  findingRowsSimulation,
  recommendationExcerpt,
  redteamBrief,
  simulationBrief,
} from "../../../src/lib/common/reports/brief.js";
import type { ReportSection } from "../../../src/lib/contracts.js";
import { donut } from "../../../src/lib/dashboard/report-kit.js";
import { SimulationRun } from "../../../src/lib/integrations/simulation/run-store.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import { buildRedteamReportSections } from "../../../src/lib/redteam/reports/sections.js";
import goldens from "../fixtures/brief-python-goldens.json" with {
  type: "json",
};

let warning: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());
for (const [index, row] of goldens.redteam.entries())
  it(`matches pinned redteam HTML brief ${index}`, () => {
    const report = new RedTeamReport(row.input),
      sections = new Map(
        buildRedteamReportSections(report).map((section) => [
          section.kind,
          section,
        ]),
      );
    expect<unknown>(findingRowsRedteam(report, sections)).toEqual(row.findings);
    expect(redteamBrief(report, sections)).toBe(row.expected);
  });
for (const row of goldens.simulation)
  it(`matches pinned simulation HTML brief ${row.name}`, () => {
    const run = new SimulationRun({
        ...row.run,
        runName: "brief",
        createdAt: "2026-11-10T12:00:00Z",
        mode: "simulate",
        evaluatorNames: [],
        scorerAverages: {},
        results: [],
      }),
      sections = new Map(
        (row.sections as ReportSection[]).map((section) => [
          section.kind,
          section,
        ]),
      );
    expect<unknown>(findingRowsSimulation(run, sections)).toEqual(row.findings);
    expect(simulationBrief(run, sections)).toBe(row.expected);
  });
for (const [index, row] of goldens.excerpts.entries())
  it(`matches pinned recommendation excerpt ${index}`, () =>
    expect(recommendationExcerpt(row.text, row.limit)).toBe(row.expected));
for (const [index, row] of goldens.donuts.entries())
  it(`matches pinned outcome donut ${index}`, () =>
    expect(donut(row.segments, "<total>", "things")).toBe(row.expected));
