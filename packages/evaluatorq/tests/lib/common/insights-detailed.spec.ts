import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { hasTruncatedSourceText } from "../../../src/lib/common/model-input.js";
import { detailedConversationView } from "../../../src/lib/insights/transcript.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-detailed-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { trace: unknown; budget: number; text: string; truncated: boolean }[];
for (const [i, c] of gold.entries())
  test(`detailed transcript ${i}`, () => {
    const result = detailedConversationView(new TraceRecord(c.trace), c.budget);
    expect(String(result)).toBe(c.text);
    expect(hasTruncatedSourceText(result)).toBe(c.truncated);
  });
