import { expect, it } from "bun:test";

import type { StandaloneItem } from "../../../src/lib/common/reports/standalone.js";
import type { ReportSection } from "../../../src/lib/contracts.js";
import {
  renderSections,
  reportTabs,
  stableSimulationEntries,
} from "../../../src/lib/dashboard/report-tabs.js";
import { parseSimulationResult } from "../../../src/lib/integrations/simulation/run-store.js";
import goldens from "../fixtures/tabs-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.cases.entries())
  it(`matches pinned report tab shell ${index}`, () =>
    expect(
      reportTabs(
        row.group,
        row.items as unknown as StandaloneItem[],
        row.options,
      ),
    ).toBe(row.expected));
for (const [index, row] of goldens.stable.entries())
  it(`keeps full-run evidence positions ${row.name} ${index}`, () => {
    const results = row.results.map(parseSimulationResult),
      subset = row.indexes
        .map((i) => results[i])
        .filter((value) => value != null);
    expect(
      JSON.parse(JSON.stringify(stableSimulationEntries({ results }, subset))),
    ).toEqual(row.expected);
  });
it("renders requested sections in order, skips absent sections and awaits renderers", async () => {
  const sections = new Map<ReportSection["kind"], ReportSection>([
      ["summary", { kind: "summary", title: "S", data: {} }],
      ["errors", { kind: "errors", title: "E", data: {} }],
    ]),
    order: string[] = [];
  const html = await renderSections(
    sections,
    {
      summary: async () => {
        await Promise.resolve();
        order.push("s");
        return "<p>s</p>";
      },
      errors: () => {
        order.push("e");
        return "<p>e</p>";
      },
    },
    ["summary", "token_usage", "errors"],
  );
  expect(order).toEqual(["s", "e"]);
  expect(html).toBe(
    '<div id="section-summary"><p>s</p></div><div id="section-errors"><p>e</p></div>',
  );
  await expect(
    renderSections(
      sections,
      {
        summary: async () => {
          throw new Error("render failed");
        },
      },
      ["summary"],
    ),
  ).rejects.toThrow("render failed");
});
it("rejects filtered result clones that have no full-run evidence identity", () => {
  expect(() =>
    stableSimulationEntries({ results: [] }, [
      parseSimulationResult(
        goldens.stable.find((row) => row.results.length)?.results[0],
      ),
    ]),
  ).toThrow("not part of the saved run");
});
