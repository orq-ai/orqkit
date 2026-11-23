import { expect, test } from "bun:test";

import { AtifStepSchema } from "../../../src/lib/formats/atif.js";
import { finalMetrics } from "../../../src/lib/formats/shared.js";
import goldens from "../fixtures/format-summation-python-goldens.json" with {
  type: "json",
};

for (const [i, row] of goldens.entries())
  test(`Python ATIF floating cost sum ${i}`, () => {
    const steps = row.costs.map((costUsd, index) =>
      AtifStepSchema.parse({
        stepId: index + 1,
        source: "agent",
        message: "",
        metrics: { costUsd },
      }),
    );
    expect(finalMetrics(steps)?.totalCostUsd).toBe(row.expected);
  });
