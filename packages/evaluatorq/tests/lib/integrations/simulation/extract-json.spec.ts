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

  test("extracts first balanced structure when multiple exist", () => {
    // extractBalanced finds arrays before objects, and finds the first match
    // So "[1,2]" inside a string value is found before the outer object
    const input = 'Some text {"text": "array [1,2] and {obj}"} more text';
    // The extractor finds [1,2] first (array search runs before object search)
    expect(extractJsonFromResponse(input)).toBe("[1,2]");
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
