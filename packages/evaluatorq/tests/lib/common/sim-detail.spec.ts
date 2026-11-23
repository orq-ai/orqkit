import { expect, it } from "bun:test";

import {
  renderTranscriptFragment,
  type SimulationEntryView,
} from "../../../src/lib/common/reports/sim-detail.js";
import goldens from "../fixtures/sim-detail-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.cases.entries())
  it(`matches pinned simulation evidence fragment ${index}`, () => {
    expect(
      renderTranscriptFragment(row.input as SimulationEntryView, {
        personaEntityId: row.personaEntityId,
        scenarioEntityId: row.scenarioEntityId,
      }),
    ).toBe(row.expected);
  });
