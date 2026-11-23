import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { pythonJson } from "../../../src/lib/formats/json.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import { TOOL_SIGNALS } from "../../../src/lib/signals/tools.js";
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
    new URL("../fixtures/signals-tools-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  shared: {
    inputs: { walkIndex: number; config: unknown }[];
    expected: Record<string, unknown>;
  }[];
  custom: {
    input: unknown;
    config: unknown;
    expected: Record<string, unknown>;
  }[];
  strings: { input: unknown; sort: boolean; expected: string }[];
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
function check(
  input: unknown,
  config: unknown,
  expected: Record<string, unknown>,
): void {
  const ctx = SignalContext.build(
    new AtifTrajectory(input),
    new SignalsConfig(config),
  );
  expect<unknown>(
    Object.fromEntries(
      [...TOOL_SIGNALS]
        .filter(([name]) => Object.hasOwn(expected, name))
        .map(([name, fn]) => [name, fn(ctx)]),
    ),
  ).toEqual(
    Object.fromEntries(
      Object.entries(expected).map(([name, result]) => [name, native(result)]),
    ),
  );
}
for (const [group, row] of goldens.shared.entries())
  for (const [variant, input] of row.inputs.entries())
    test(`Python tool signals shared ${group}.${variant}`, () =>
      check(source.walks[input.walkIndex]?.input, input.config, row.expected));
for (const [i, row] of goldens.custom.entries())
  test(`Python tool signal edge cases ${i}`, () =>
    check(row.input, row.config, row.expected));
for (const [i, row] of goldens.strings.entries())
  test(`Python unescaped JSON string ${i}`, () =>
    expect(
      pythonJson(row.input, { sortKeys: row.sort, ensureAscii: false }),
    ).toBe(row.expected));
