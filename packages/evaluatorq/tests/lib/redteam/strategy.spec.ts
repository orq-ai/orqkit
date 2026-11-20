import { expect, it } from "bun:test";

import {
  AttackStrategySchema,
  RunErrorSchema,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/redteam-strategy-python-goldens.json" with {
  type: "json",
};

for (const [index, entry] of goldens.cases.entries())
  it(`matches pinned strategy case ${index}`, () => {
    const parsed = AttackStrategySchema.safeParse(entry.value);
    expect(parsed.success).toBe(!entry.error);
    if (parsed.success) expect(parsed.data as unknown).toEqual(entry.expected);
  });
it("keeps the strategy immutable while reading camelCase fields", () => {
  const expected = goldens.cases[0]?.expected;
  if (!expected) throw new Error("Missing golden case");
  const parsed = AttackStrategySchema.parse(expected);
  expect(parsed as unknown).toEqual(expected);
  expect(Object.isFrozen(parsed)).toBe(true);
});
it("keeps structured run error details and accepts legacy error_type", () => {
  const error = RunErrorSchema.parse({
    message: "Failed",
    error_type: "target_error",
    details: { raw_status: 401 },
    turn: 1,
  });
  expect(error).toEqual({
    message: "Failed",
    errorType: "target_error",
    stage: null,
    code: null,
    details: { raw_status: 401 },
    turn: 1,
  });
  expect(Object.isFrozen(error)).toBe(true);
});
