import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import * as pre from "../../../src/lib/signals/preconditions.js";
import { SignalContext } from "../../../src/lib/signals/walk.js";

const source = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signals-foundations-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { walks: { input: unknown }[] };
const goldens = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signals-preconditions-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: { walkIndex: number; errorDetection: string; expected: unknown }[];
  subagents: { count: number; expected: unknown }[];
};
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.cases.entries())
  test(`Python signal preconditions ${i}`, () => {
    const ctx = SignalContext.build(
      new AtifTrajectory(source.walks[row.walkIndex]?.input),
      new SignalsConfig({ errorDetection: row.errorDetection }),
    );
    const actual = {
      has_tool_calls: pre.hasToolCalls(ctx),
      source_tool_coverage: pre.sourceToolCoverage(ctx),
      has_tool_results: pre.hasToolResults(ctx),
      results_matched: pre.resultsMatched(ctx),
      explicit_error_status: pre.explicitErrorStatus(ctx),
      args_parseable: pre.argsParseable(ctx),
      result_content_available: pre.resultContentAvailable(ctx),
      tool_schemas_coverage: pre.toolSchemasCoverage(ctx),
      model_present: pre.modelPresent(ctx),
      token_usage_complete: pre.tokenUsageComplete(ctx),
      provider_derivable: pre.providerDerivable(ctx),
      finish_reason_present: pre.finishReasonPresent(ctx),
      subagent_linkage: pre.subagentLinkage(ctx),
      timestamps: pre.timestamps(ctx),
      tool_timestamps: pre.toolTimestamps(ctx),
    };
    expect<unknown>(actual).toEqual(row.expected);
  });
for (const [i, row] of goldens.subagents.entries())
  test(`Python subagent precondition ${i}`, () =>
    expect<unknown>(pre.hasSubagents(row.count)).toEqual(row.expected));
test("Tool role and percentile lookups use declared dictionary entries", () => {
  const config = new SignalsConfig();
  expect(config.toolRole("constructor")).toBe("other");
  expect(config.toolRole("toString")).toBe("other");
  expect(() =>
    config.resolvedTagThresholds().cohortThreshold("constructor", 10),
  ).toThrow();
});
