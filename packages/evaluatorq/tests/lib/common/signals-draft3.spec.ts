import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { schemaViolation } from "../../../src/lib/signals/schema.js";

const cases = JSON.parse(
  readFileSync(
    new URL("../fixtures/signals-draft3-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  schema: Record<string, unknown>;
  input: unknown;
  invalidSchema: boolean;
  expected: string | null;
}[];
for (const [i, row] of cases.entries())
  test(`Python draft-03 tool schema ${i}`, () => {
    const validate = () => schemaViolation(row.schema, row.input);
    if (row.invalidSchema) expect(validate).toThrow();
    else expect(validate()).toBe(row.expected);
  });
