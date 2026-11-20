import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { contentSeed, stableHex } from "../../../src/lib/formats/ids.js";
import { pythonJson } from "../../../src/lib/formats/json.js";
import {
  atifToolArguments,
  compactionExtra,
  joinText,
  jsonArgumentsText,
  partText,
} from "../../../src/lib/formats/shared.js";
import goldens from "../fixtures/format-foundations-python-goldens.json" with {
  type: "json",
};

let warning: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());
for (const [i, row] of goldens.serial.entries())
  test(`Python format JSON ${i}`, () =>
    expect(
      pythonJson(row.input, { compact: row.compact, sortKeys: row.sort }),
    ).toBe(row.expected));
for (const [i, row] of goldens.seeds.entries())
  test(`Python content seed ${i}`, () =>
    expect(contentSeed(row.input)).toBe(row.expected));
for (const [i, row] of goldens.hexes.entries())
  test(`Python stable hex ${i}`, () => {
    if (row.error) expect(() => stableHex(row.parts, row.length)).toThrow();
    else expect(stableHex(row.parts, row.length)).toBe(row.expected as string);
  });
for (const [i, row] of goldens.arguments.entries())
  test(`Python tool argument preservation ${i}`, () => {
    const [arguments_, raw] = atifToolArguments(row.input, "synthetic");
    expect<unknown>(arguments_).toEqual(row.arguments);
    expect(raw).toBe(row.raw);
    expect(jsonArgumentsText(arguments_)).toBe(row.text);
  });
for (const [i, row] of goldens.parts.entries())
  test(`Python part text ${i}`, () =>
    expect(partText(row.input, "test")).toBe(row.expected));
test("native JavaScript numbers use integer spelling for integral values", () => {
  expect(contentSeed(goldens.numberAmbiguity.value)).toBe(
    goldens.numberAmbiguity.intSeed,
  );
  expect(contentSeed(goldens.numberAmbiguity.value)).not.toBe(
    goldens.numberAmbiguity.floatSeed,
  );
});
test("shared helpers retain raw objects and free-form keys", () => {
  const raw = { __raw_arguments: "user value", nested: { free_key: null } },
    [parsed, provenance] = atifToolArguments(raw, "tool");
  expect(parsed).toBe(raw);
  expect(provenance).toBeNull();
  expect(jsonArgumentsText(parsed)).toBe(
    '{"__raw_arguments":"user value","nested":{"free_key":null}}',
  );
  expect(joinText(["first", "", " ", "last"])).toBe("first\n \nlast");
  const compactions = [{ type: "compaction", encrypted_content: "opaque" }];
  expect(compactionExtra(compactions)).toEqual({
    context_management: { type: "compaction", boundary: "replace" },
    "evaluatorq.compaction": compactions,
  });
});
test("JSON encoding rejects cycles, preserves non-finite values and supports explicit unknown-value fallback", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => pythonJson(cyclic)).toThrow("Circular");
  expect(() => jsonArgumentsText(cyclic)).toThrow("Circular");
  expect(pythonJson([Number.NaN, Infinity, -Infinity, -0])).toBe(
    "[NaN, Infinity, -Infinity, -0.0]",
  );
  expect(() => pythonJson(undefined)).toThrow("JSON-encodable");
  expect(pythonJson(undefined, { defaultString: true })).toBe('"undefined"');
  expect(pythonJson(12345678901234567890n)).toBe("12345678901234567890");
  expect(pythonJson(Array(2), { defaultString: true })).toBe(
    '["undefined", "undefined"]',
  );
});
