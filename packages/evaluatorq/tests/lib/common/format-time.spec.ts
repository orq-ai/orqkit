import { expect, test } from "bun:test";

import { parseIso } from "../../../src/lib/formats/time.js";
import goldens from "../fixtures/format-time-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.cases.entries())
  test(`Python format ISO timestamp ${index}`, () => {
    if (row.error) expect(() => parseIso(row.input)).toThrow();
    else expect<unknown>(parseIso(row.input)).toEqual(row.expected);
  });
