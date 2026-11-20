import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildSummaryPromptWithCoverage } from "../../../src/lib/insights/summarize.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-summary-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  trace: unknown;
  cap: number;
  prompt?: string;
  truncated?: boolean;
  valid: boolean;
}[];
for (const [i, c] of gold.entries())
  test(`summary prompt ${i}`, () => {
    const trace = new TraceRecord(c.trace);
    if (!c.valid) {
      expect(() => buildSummaryPromptWithCoverage(trace, c.cap)).toThrow();
      return;
    }
    const [prompt, truncated] = buildSummaryPromptWithCoverage(trace, c.cap);
    expect<string | undefined>(prompt).toBe(c.prompt);
    expect<boolean | undefined>(truncated).toBe(c.truncated);
    expect(Array.from(prompt).length).toBeLessThanOrEqual(c.cap);
  });
