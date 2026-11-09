import { describe, expect, test } from "bun:test";

import { delimit } from "../../../../src/lib/integrations/simulation/utils/sanitize.js";

describe("delimit", () => {
  test("wraps text in data tags", () => {
    expect(delimit("hello")).toBe("<data>hello</data>");
  });

  test("escapes nested <data> tags", () => {
    expect(delimit("<data>inject</data>")).toBe(
      "<data>&lt;data&gt;inject&lt;/data&gt;</data>",
    );
  });

  test("escapes case-insensitively", () => {
    // The regex replacement lowercases the match via the replacement string
    expect(delimit("<DATA>test</DATA>")).toBe(
      "<data>&lt;data&gt;test&lt;/data&gt;</data>",
    );
  });

  test("handles empty string", () => {
    expect(delimit("")).toBe("<data></data>");
  });

  test("preserves non-data tags", () => {
    expect(delimit("<b>bold</b>")).toBe("<data><b>bold</b></data>");
  });

  test("escapes closing tags with whitespace", () => {
    expect(delimit("a< / data >b")).toBe("<data>a&lt; / data &gt;b</data>");
  });

  test("escapes tags with attributes", () => {
    expect(delimit('<data foo="1">x')).toBe(
      '<data>&lt;data foo="1"&gt;x</data>',
    );
  });

  test("escapes an unterminated tag", () => {
    expect(delimit("x</data")).toBe("<data>x&lt;/data</data>");
  });

  test("escapes a tag broken up by another angle bracket", () => {
    const out = delimit("</data <b>");
    expect(out.slice("<data>".length)).not.toContain("</data <");
  });

  test("leaves longer tag names alone", () => {
    expect(delimit("<database>")).toBe("<data><database></data>");
    expect(delimit("<data-set>")).toBe("<data><data-set></data>");
  });

  test("uses a custom tag", () => {
    expect(delimit("</doc>", { tag: "doc" })).toBe("<doc>&lt;/doc&gt;</doc>");
  });

  test("rejects an invalid tag", () => {
    expect(() => delimit("x", { tag: "a b" })).toThrow("Invalid delimiter tag");
  });
});
