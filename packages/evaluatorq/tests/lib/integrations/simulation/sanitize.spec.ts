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
});
