import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import { schemaViolation } from "../../../src/lib/signals/schema.js";
import { invalidSchemaToolCallCount } from "../../../src/lib/signals/tools.js";
import { SignalContext } from "../../../src/lib/signals/walk.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/signals-schema-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    schema: Record<string, unknown>;
    input: unknown;
    invalidSchema: boolean;
    expected: string | null;
  }[];
  signals: {
    input: unknown;
    expected: Record<string, unknown>;
    invalidSchema: boolean;
  }[];
};
for (const [i, row] of goldens.cases.entries())
  test(`Python tool JSON Schema ${i}`, () => {
    const validate = () => schemaViolation(row.schema, row.input);
    if (row.invalidSchema) expect(validate).toThrow();
    else expect(validate()).toBe(row.expected);
  });
for (const [i, row] of goldens.signals.entries())
  test(`Python tool schema signal ${i}`, () => {
    const ctx = SignalContext.build(
        new AtifTrajectory(row.input),
        new SignalsConfig(),
      ),
      result = invalidSchemaToolCallCount(ctx);
    if (row.invalidSchema) {
      expect(result.noBasis).toBeString();
      expect(result.value).toBeNull();
      expect(result.preconditions.at(-1)?.met).toBe(false);
    } else {
      expect(result.value).toEqual(row.expected.value);
      expect<unknown>(result.noBasis).toEqual(row.expected.no_basis);
      expect(result.evidence.map((e) => e.reason)).toEqual(
        (row.expected.evidence as { reason: string }[]).map((e) => e.reason),
      );
    }
  });
