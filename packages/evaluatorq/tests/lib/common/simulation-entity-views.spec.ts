import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { stableSimulationEntries } from "../../../src/lib/dashboard/report-tabs.js";
import {
  type SimulationDashboardEntry,
  simulationConfigCriteriaSplit,
  simulationCriterionDetail,
  simulationEntityContext,
  simulationEntityModal,
  simulationPassRateBadge,
  simulationTraitMinis,
} from "../../../src/lib/dashboard/simulation-entities.js";
import { simulationConfig } from "../../../src/lib/dashboard/simulation-report-tabs.js";
import { buildSimulationReportSections } from "../../../src/lib/integrations/simulation/reports/sections.js";
import {
  parseSimulationResult,
  SimulationRun,
} from "../../../src/lib/integrations/simulation/run-store.js";
import goldens from "../fixtures/simulation-entity-views-python-goldens.json" with {
  type: "json",
};

const hash = (html: string) => createHash("sha256").update(html).digest("hex");
for (const [index, row] of goldens.cases.entries())
  test(`Python simulation entity views ${row.name} ${index}`, () => {
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
      context = simulationEntityContext(sections, entries, selected, 'r<&"'),
      run = new SimulationRun(row.run);
    expect(hash(simulationEntityModal(context))).toBe(row.modal);
    expect(hash(simulationEntityModal(context, { standalone: true }))).toBe(
      row.modalStandalone,
    );
    expect(hash(simulationConfig(sections, run, context))).toBe(row.config);
    expect(
      hash(simulationConfig(sections, run, context, { standalone: true })),
    ).toBe(row.configStandalone);
  });
for (const [i, row] of goldens.traits.entries())
  test(`Python trait minis ${i}`, () =>
    expect(simulationTraitMinis(row.input)).toBe(row.expected));
for (const [i, row] of goldens.rates.entries())
  test(`Python pass-rate badge ${i}`, () =>
    expect(simulationPassRateBadge(row.input)).toBe(row.expected));
for (const [i, row] of goldens.criteria.entries())
  test(`Python criterion detail ${i}`, () => {
    expect(simulationConfigCriteriaSplit(row.input)).toBe(row.split);
    expect(row.input.map(simulationCriterionDetail)).toEqual(row.details);
  });
