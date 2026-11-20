import { expect, test } from "bun:test";

import type { ReportSection } from "../../../src/lib/contracts.js";
import {
  simulationAvgQualityTiles,
  simulationTurnCountBar,
  simulationTurnDeltaCallout,
  simulationTurnQuality,
} from "../../../src/lib/dashboard/simulation-report-tabs.js";
import goldens from "../fixtures/simulation-turn-quality-python-goldens.json" with {
  type: "json",
};

for (const row of goldens.cases)
  test(`Python simulation turn quality ${row.name}`, () => {
    const sections = new Map(
        (row.sections as ReportSection[]).map((s) => [s.kind, s]),
      ),
      timeline = sections.get("turn_quality_timeline")?.data ?? {},
      metrics = sections.get("turn_metrics")?.data ?? {};
    expect(
      simulationTurnDeltaCallout(
        (timeline.series ?? {}) as Record<string, (number | null)[]>,
      ),
    ).toBe(row.delta);
    expect(
      simulationAvgQualityTiles(
        (metrics.avg_quality_metrics ?? {}) as Record<string, number>,
      ),
    ).toBe(row.average);
    expect(
      simulationTurnCountBar(
        (metrics.turn_count_distribution ?? {}) as Record<string, number>,
      ),
    ).toBe(row.distribution);
    expect(simulationTurnQuality(sections)).toBe(row.quality);
  });
