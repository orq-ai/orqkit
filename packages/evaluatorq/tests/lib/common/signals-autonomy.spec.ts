import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { AUTONOMY_SIGNALS } from "../../../src/lib/signals/autonomy.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import { SignalContext } from "../../../src/lib/signals/walk.js";

const source = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signals-foundations-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { walks: { input: unknown }[] };
const goldens = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signals-autonomy-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  shared: { walkIndices: number[]; expected: Record<string, unknown> }[];
  custom: { input: unknown; expected: Record<string, unknown> }[];
};
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        key === "value" ? item : native(item),
      ]),
    );
  return value;
}
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
function check(input: unknown, expected: Record<string, unknown>): void {
  const ctx = SignalContext.build(
    new AtifTrajectory(input),
    new SignalsConfig(),
  );
  expect<unknown>(
    Object.fromEntries(
      [...AUTONOMY_SIGNALS].map(([name, fn]) => [name, fn(ctx)]),
    ),
  ).toEqual(
    Object.fromEntries(
      Object.entries(expected).map(([name, result]) => [name, native(result)]),
    ),
  );
}
for (const row of goldens.shared)
  for (const index of row.walkIndices)
    test(`Python autonomy signals shared ${index}`, () =>
      check(source.walks[index]?.input, row.expected));
for (const [i, row] of goldens.custom.entries())
  test(`Python autonomy timing edge cases ${i}`, () =>
    check(row.input, row.expected));
