import { expect, test } from "bun:test";

import type { ReportSection } from "../../../src/lib/contracts.js";
import { stableSimulationEntries } from "../../../src/lib/dashboard/report-tabs.js";
import {
  type SimulationDashboardEntry,
  setFailureFullRunIndexes,
  simulationEntityContext,
  simulationPairEntries,
} from "../../../src/lib/dashboard/simulation-entities.js";
import { buildSimulationReportSections } from "../../../src/lib/integrations/simulation/reports/sections.js";
import { parseSimulationResult } from "../../../src/lib/integrations/simulation/run-store.js";
import goldens from "../fixtures/simulation-entities-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.cases.entries())
  test(`Python filtered cohort context ${row.name} ${index}`, () => {
    const results = row.results.map(parseSimulationResult),
      selected = row.indexes
        .map((i) => results[i])
        .filter((r) => r !== undefined),
      entries = stableSimulationEntries(
        { results },
        selected,
      ) as unknown as SimulationDashboardEntry[],
      sections = new Map(
        buildSimulationReportSections(results).map((s) => [s.kind, s]),
      ),
      filtered = new Map(
        buildSimulationReportSections(selected).map((s) => [s.kind, s]),
      ),
      context = simulationEntityContext(sections, entries, selected, 'r<&"');
    const members = (map: Map<string, SimulationDashboardEntry[]>) =>
      Object.fromEntries(
        [...map].map(([id, es]) => [id, es.map((e) => e.index)]),
      );
    const actual = {
      rid: context.rid,
      personas: context.personas,
      scenarios: context.scenarios,
      personaStats: Object.fromEntries(context.personaStats),
      scenarioStats: Object.fromEntries(context.scenarioStats),
      cohorts: {
        persona: members(context.cohorts.persona),
        scenario: members(context.cohorts.scenario),
      },
      pairs: [...context.pairs].map(([pair, es]) => [
        JSON.parse(pair),
        es.map((e) => e.index),
      ]),
      personaDomIds: Object.fromEntries(context.personaDomIds),
      scenarioDomIds: Object.fromEntries(context.scenarioDomIds),
    };
    expect<unknown>(JSON.parse(JSON.stringify(actual))).toEqual(row.expected);
    setFailureFullRunIndexes(filtered.get("failures_first"), entries);
    expect(
      (
        (filtered.get("failures_first")?.data.rows ?? []) as Record<
          string,
          unknown
        >[]
      ).map((r) => r.index),
    ).toEqual(row.failureIndexes);
    for (const [pair, members] of context.pairs) {
      const [p, s] = JSON.parse(pair) as [string, string];
      expect(simulationPairEntries(context, p, s)).toBe(members);
    }
    expect(simulationPairEntries(context, "unknown", "unknown")).toEqual([]);
  });
test("cohort association and failure indexing reject mismatched inputs", () => {
  const section: ReportSection = {
    kind: "failures_first",
    title: "Failures",
    data: { rows: [{}] },
  };
  expect(() => setFailureFullRunIndexes(section, [])).toThrow("equal lengths");
  const row = goldens.cases.find((c) => c.results.length)?.results[0];
  if (!row) throw Error("missing fixture");
  expect(() =>
    simulationEntityContext(new Map(), [], [parseSimulationResult(row)]),
  ).toThrow("equal lengths");
});
