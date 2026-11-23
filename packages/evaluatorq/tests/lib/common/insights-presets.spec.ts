import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { LabelSpec } from "../../../src/lib/insights/models.js";
import * as presets from "../../../src/lib/insights/presets.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-presets-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;
for (const [name, value] of Object.entries(gold))
  test(`preset ${name} matches Python`, () => {
    const spec = (presets as unknown as Record<string, unknown>)[name];
    expect(spec).toEqual(new LabelSpec(value));
  });
test("preset groups and dimension sources preserve the Python ordering", () => {
  expect(presets.CODING_LABELS.map((spec) => spec.name)).toEqual([
    "coding_agent",
    "task_type",
    "outcome",
    "verified",
    "scope_creep",
    "user_corrections",
    "unfixed_error",
    "risky_action",
  ]);
  expect(Object.keys(presets.LABEL_PRESETS)).toEqual([
    "sentiment",
    "user_frustration",
    "customer_satisfaction",
    "made_errors",
    "concerning",
    "intent_taxonomy",
    "failure_taxonomy",
  ]);
  expect(presets.DIMENSION_FIELDS).toEqual({
    intent: "request",
    failure: "assistantErrors",
    sentiment: "sentimentExplanation",
  });
});
