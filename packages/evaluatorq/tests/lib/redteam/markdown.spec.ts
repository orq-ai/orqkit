import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import {
  exportRedteamMarkdown,
  redteamVerdictLabel,
} from "../../../src/lib/redteam/reports/export-md.js";
import { RedTeamReport } from "../../../src/lib/redteam/reports/models.js";
import goldens from "../fixtures/redteam-markdown-python-goldens.json" with {
  type: "json",
};

let warning: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());
for (const row of goldens.cases)
  it(`renders pinned complete Markdown report ${row.label}`, async () => {
    expect(await exportRedteamMarkdown(new RedTeamReport(row.input))).toBe(
      row.expected,
    );
  });
it("keeps unevaluated distinct from resistant", () => {
  expect(redteamVerdictLabel(null)).toBe("NOT EVALUATED");
  expect(redteamVerdictLabel(false)).toBe("RESISTANT");
  expect(redteamVerdictLabel(true)).toBe("VULNERABLE");
});
