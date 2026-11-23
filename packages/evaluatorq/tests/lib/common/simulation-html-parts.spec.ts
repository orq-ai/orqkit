import { expect, test } from "bun:test";

import type { ReportSection } from "../../../src/lib/contracts.js";
import { csrfToken } from "../../../src/lib/dashboard/security.js";
import { simulationRecommendations } from "../../../src/lib/dashboard/simulation-report-tabs.js";
import {
  directionArrow,
  prettyEvaluator,
  SIMULATION_TAB_RENDERERS,
  scoreIsLowerBetter,
} from "../../../src/lib/integrations/simulation/reports/html-sections.js";
import { SimulationRun } from "../../../src/lib/integrations/simulation/run-store.js";
import goldens from "../fixtures/simulation-html-parts-python-goldens.json" with {
  type: "json",
};

for (const row of goldens.sections)
  test(`Python simulation HTML ${row.label}`, async () => {
    const section = row.input as ReportSection,
      render = SIMULATION_TAB_RENDERERS[section.kind];
    if (!render) throw Error("missing renderer");
    expect(await render(section)).toBe(row.expected);
  });
for (const row of goldens.recommendations)
  test(`Python simulation recommendation ${row.label}`, () => {
    expect(
      simulationRecommendations('r<&"', new SimulationRun(row.input), {
        standalone: row.standalone,
      }).replaceAll(csrfToken(), "CSRF"),
    ).toBe(row.expected);
  });
for (const row of goldens.labels)
  test(`Python metric label ${row.input}`, () => {
    expect(prettyEvaluator(row.input)).toBe(row.pretty);
    expect(directionArrow(row.input)).toBe(row.arrow);
    expect(scoreIsLowerBetter(row.input)).toBe(row.lower);
  });
