import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import goldens from "../fixtures/otel-emit-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.cases.entries())
  test(`Python ATIF to OTel emission ${i}`, () => {
    const emit = () => new AtifTrajectory(row.input).toOtel();
    if (!row.ok) expect(emit).toThrow();
    else
      expect(emit().toModelDict()).toEqual(
        row.expected as Record<string, unknown>,
      );
  });
