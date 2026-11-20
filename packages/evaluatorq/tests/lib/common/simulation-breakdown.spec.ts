import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { stableSimulationEntries } from "../../../src/lib/dashboard/report-tabs.js";
import {
  type SimulationDashboardEntry,
  setFailureFullRunIndexes,
  simulationEntityContext,
} from "../../../src/lib/dashboard/simulation-entities.js";
import {
  simulationBreakdown,
  simulationFailureModes,
} from "../../../src/lib/dashboard/simulation-report-tabs.js";
import {
  capTableText,
  criteriaDots,
} from "../../../src/lib/integrations/simulation/reports/html-sections.js";
import { buildSimulationReportSections } from "../../../src/lib/integrations/simulation/reports/sections.js";
import { parseSimulationResult } from "../../../src/lib/integrations/simulation/run-store.js";
import goldens from "../fixtures/simulation-breakdown-python-goldens.json" with {
  type: "json",
};

const hash = (html: string) => createHash("sha256").update(html).digest("hex");
for (const [index, row] of goldens.cases.entries())
  test(`Python simulation breakdown ${row.name} ${index}`, () => {
    const results = row.results.map(parseSimulationResult),
      selected = row.indexes
        .map((i) => results[i])
        .filter((r) => r !== undefined),
      entries = stableSimulationEntries(
        { results },
        selected,
      ) as unknown as SimulationDashboardEntry[],
      full = new Map(
        buildSimulationReportSections(results).map((s) => [s.kind, s]),
      ),
      sections = new Map(
        buildSimulationReportSections(selected).map((s) => [s.kind, s]),
      ),
      context = simulationEntityContext(full, entries, selected, 'r<&"');
    setFailureFullRunIndexes(sections.get("failures_first"), entries);
    expect(hash(simulationBreakdown(sections, 'r<&"', context))).toBe(
      row.normal,
    );
    expect(
      hash(
        simulationBreakdown(sections, 'r<&"', context, { standalone: true }),
      ),
    ).toBe(row.standalone);
  });
for (const [index, row] of goldens.criteria.entries())
  test(`Python criterion dots ${index}`, () =>
    expect(criteriaDots(row.input)).toBe(row.expected));
for (const [index, row] of goldens.caps.entries())
  test(`Python table excerpt ${index}`, () =>
    expect(capTableText(row.input, row.maxChars)).toBe(row.expected));
for (const [index, row] of goldens.modes.entries())
  test(`Python failure modes ${index}`, () =>
    expect(
      simulationFailureModes(row.input as [string, number][], {
        standalone: row.standalone,
      }),
    ).toBe(row.expected));
