import { expect, test } from "bun:test";

import { parseIso, parseSavedDateTime } from "../../../src/lib/formats/time.js";
import goldens from "../fixtures/format-time-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.cases.entries())
  test(`Python format ISO timestamp ${index}`, () => {
    if (row.error) expect(() => parseIso(row.input)).toThrow();
    else expect<unknown>(parseIso(row.input)).toEqual(row.expected);
  });

const savedValues = (
  await import("../fixtures/saved-run-scalars-python-golden.json", {
    with: { type: "json" },
  })
).default;
for (const [index, row] of savedValues.datetimes.entries())
  test(`pinned saved datetime scalar ${index}`, () => {
    if (row.error) expect(() => parseSavedDateTime(row.input)).toThrow();
    else expect(parseSavedDateTime(row.input)).toBe(row.expected as string);
  });
