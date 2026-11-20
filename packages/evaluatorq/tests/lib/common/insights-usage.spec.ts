import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseUsage, UsageSchema } from "../../../src/lib/contracts.js";
import { UsageLedger } from "../../../src/lib/insights/usage.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-usage-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as { totals: Record<string, unknown>; warnings: boolean[] };
test("usage ledger matches Python including unpriced calls and scoped records", () => {
  const ledger = new UsageLedger();
  ledger.add("summary", null);
  ledger.add(
    "summary",
    UsageSchema.parse({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      calls: 1,
      pricedCalls: 1,
      inputCost: 0.1,
      outputCost: 0.2,
      totalCost: 0.3,
    }),
  );
  ledger.add("embedding", null);
  const scoped = ledger.scoped("labels");
  scoped.add(
    "ignored",
    UsageSchema.parse({ inputTokens: 3, totalTokens: 3, calls: 1 }),
  );
  scoped.scoped("other").add("x", null);
  expect(ledger.totals()).toEqual(
    Object.fromEntries(
      Object.entries(gold.totals).map(([k, v]) => [k, parseUsage(v)]),
    ),
  );
  expect([
    ledger.claimWarning("x"),
    scoped.claimWarning("x"),
    scoped.claimWarning("y"),
    ledger.claimWarning("y"),
  ]).toEqual(gold.warnings);
  expect(scoped.totals()).toEqual(ledger.totals());
});
