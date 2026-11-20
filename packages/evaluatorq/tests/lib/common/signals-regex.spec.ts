import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { pythonRegexEngine } from "../../../src/lib/signals/python-regex.js";
import { schemaViolation } from "../../../src/lib/signals/schema.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/signals-regex-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    pattern: string;
    input: string;
    invalid: boolean;
    expected: boolean | null;
  }[];
  schemas: {
    pattern: string;
    input: string;
    invalid: boolean;
    expected: string | null;
  }[];
};
for (const [i, row] of goldens.cases.entries())
  test(`Python signal regex ${i}`, () => {
    const match = () => pythonRegexEngine(row.pattern).test(row.input);
    if (row.invalid) expect(match).toThrow();
    else expect(match()).toBe(row.expected as boolean);
  });
for (const [i, row] of goldens.schemas.entries())
  test(`Python schema regex ${i}`, () => {
    const match = () => schemaViolation({ pattern: row.pattern }, row.input);
    if (row.invalid) expect(match).toThrow();
    else expect(match()).toBe(row.expected);
  });
