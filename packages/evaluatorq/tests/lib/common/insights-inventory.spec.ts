import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  firstCommand,
  isRiskyCommand,
  toolInventory,
  toolStats,
} from "../../../src/lib/insights/transcript.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-inventory-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  commands: { command: string; first: string; risky: boolean }[];
  traces: { input: unknown; stats: unknown; inventory: string }[];
};
for (const [i, c] of gold.commands.entries())
  test(`shell inventory ${i}`, () => {
    expect(firstCommand(c.command)).toBe(c.first);
    expect(isRiskyCommand(c.command)).toBe(c.risky);
  });
for (const [i, c] of gold.traces.entries())
  test(`tool inventory ${i}`, () => {
    const trace = new TraceRecord(c.input);
    expect<unknown>(toolStats(trace)).toEqual(c.stats);
    expect(toolInventory(trace)).toBe(c.inventory);
  });
