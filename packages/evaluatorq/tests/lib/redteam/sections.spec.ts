import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import { buildRedteamReportSections } from "../../../src/lib/redteam/reports/sections.js";
import goldens from "../fixtures/redteam-report-sections-python-goldens.json" with {
  type: "json",
};

let warning: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());
for (const row of goldens.cases)
  it(`matches all pinned report sections ${row.label}`, () => {
    const actual = JSON.parse(
      JSON.stringify(buildRedteamReportSections(new RedTeamReport(row.input))),
    );
    expect(actual).toEqual(row.expected);
  });
