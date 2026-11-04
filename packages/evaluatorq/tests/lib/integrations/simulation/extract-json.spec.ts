import { describe, expect, test } from "bun:test";

import { extractJsonFromResponse } from "../../../../src/lib/integrations/simulation/utils/extract-json.js";

describe("extractJsonFromResponse", () => {
  test("returns empty string for empty input", () => {
    expect(extractJsonFromResponse("")).toBe("");
  });

  test("extracts JSON from ```json code block", () => {
    const input = '```json\n[{"name": "test"}]\n```';
    expect(extractJsonFromResponse(input)).toBe('[{"name": "test"}]');
  });

  test("extracts JSON from ``` code block (no language)", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJsonFromResponse(input)).toBe('{"key": "value"}');
  });

  test("extracts bare JSON array", () => {
    const input = 'Here are the results: [{"a": 1}, {"b": 2}]';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  test("extracts bare JSON object", () => {
    const input = 'Result: {"key": "value"}';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({
      key: "value",
    });
  });

  test("returns the outer object, not an array inside one of its strings", () => {
    const input = 'Some text {"text": "array [1,2] and {obj}"} more text';
    expect(extractJsonFromResponse(input)).toBe(
      '{"text": "array [1,2] and {obj}"}',
    );
  });

  test("returns the outer object, not an array nested in it", () => {
    const input = 'Result: {"personas": [{"name": "a"}]}';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({
      personas: [{ name: "a" }],
    });
  });

  test("prefers a json block over an earlier illustrative block", () => {
    const input = '```python\nprint("hi")\n```\n```json\n{"a": 1}\n```';
    expect(extractJsonFromResponse(input)).toBe('{"a": 1}');
  });

  test("falls through an invalid json block to the next valid one", () => {
    const input = '```json\n{not json}\n```\n```json\n{"a": 1}\n```';
    expect(extractJsonFromResponse(input)).toBe('{"a": 1}');
  });

  test("a backslash outside a string does not swallow the next quote", () => {
    const input = 'path C:\\"x\\ then {"a": "b"}';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({ a: "b" });
  });

  test("handles nested objects/arrays", () => {
    const json = '[{"items": [1, [2, 3]], "obj": {"a": {"b": 1}}}]';
    const input = `Result: ${json}`;
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual([
      { items: [1, [2, 3]], obj: { a: { b: 1 } } },
    ]);
  });

  test("returns trimmed content as fallback", () => {
    const input = "  just plain text  ";
    expect(extractJsonFromResponse(input)).toBe("just plain text");
  });

  test("prefers code block over bare JSON", () => {
    const input = '```json\n["from_block"]\n```\n["from_bare"]';
    expect(extractJsonFromResponse(input)).toBe('["from_block"]');
  });

  test("handles escaped quotes in JSON strings", () => {
    const json = '{"text": "say \\"hello\\""}';
    const input = `Result: ${json}`;
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({
      text: 'say "hello"',
    });
  });
});
