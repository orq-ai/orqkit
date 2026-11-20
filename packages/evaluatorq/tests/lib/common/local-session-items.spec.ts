import { expect, test } from "bun:test";

import {
  blocksText,
  compactionSummary,
  functionCall,
  functionCallOutput,
  trimToolText,
} from "../../../src/lib/local-sessions/items.js";

test("session item text handles blocks and preserves Unicode truncation boundaries", () => {
  expect(
    blocksText([
      { type: "text", text: "hello" },
      { type: "image" },
      { type: "file" },
    ]),
  ).toBe("hello\n[image]\n[file]");
  const result = trimToolText("😀".repeat(20010));
  expect(result).toContain("[truncated 10 chars]");
  expect(Array.from(result).filter((char) => char === "😀")).toHaveLength(
    20000,
  );
  expect(functionCallOutput("id", "failure", true).output).toBe(
    "Error: failure",
  );
  expect(compactionSummary("facts").content[0]?.text).toContain("facts");
});
test("trimmed structured tool arguments remain valid JSON", () => {
  const item = functionCall("id", "tool", {
    nested: "x".repeat(25000),
    stable: 3,
  });
  const parsed = JSON.parse(item.arguments) as Record<string, unknown>;
  expect(typeof parsed).toBe("object");
  expect(item.arguments).toContain("truncated");
  expect(functionCall("id", "tool", "plain text").arguments).toBe("plain text");
});
