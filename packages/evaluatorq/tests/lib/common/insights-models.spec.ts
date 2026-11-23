import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ensureUniqueTraceIds,
  InsightsPopulation,
  LabelSpec,
  labelKey,
  labelOrder,
  populationSource,
  readsOrq,
  realAssistantErrors,
  TraceSummarySchema,
} from "../../../src/lib/insights/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-model-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  labels: {
    spec: unknown;
    values: unknown[];
    keys: string[];
    order: string[];
  }[];
  population: { input: unknown; valid: boolean; value: unknown }[];
  sources: { input: Record<string, unknown>; source: string; orq: boolean }[];
  errors: string[];
};
for (const c of gold.labels)
  test(`label keys and order ${JSON.stringify(c.spec)}`, () => {
    const spec = new LabelSpec(c.spec);
    expect(c.values.map((value) => labelKey(spec, value))).toEqual(c.keys);
    expect(labelOrder(spec)).toEqual(c.order);
  });
for (const [i, c] of gold.population.entries())
  test(`population validation ${i}`, () => {
    if (!c.valid) {
      expect(() => new InsightsPopulation(c.input)).toThrow();
      return;
    }
    const p = new InsightsPopulation(c.input);
    expect<unknown>({
      query: p.query,
      facets: {
        project: [...p.facets.project].sort(),
        model: [...p.facets.model].sort(),
        provider: [...p.facets.provider].sort(),
        status: [...p.facets.status].sort(),
        product: [...p.facets.product].sort(),
        trace_type: [...p.facets.traceType].sort(),
        agent_name: [...p.facets.agentName].sort(),
        tool_name: [...p.facets.toolName].sort(),
      },
      project_id: p.facets.projectId,
      numeric: {
        tokens_min: p.numeric.tokensMin,
        tokens_max: p.numeric.tokensMax,
        duration_ms_min: p.numeric.durationMsMin,
        duration_ms_max: p.numeric.durationMsMax,
      },
      start: p.start,
      end: p.end,
      time_origin: p.timeOrigin,
      window_days: p.windowDays,
      filter_selection: p.filterSelection,
      limit: p.limit,
      finder_export: p.finderExport,
      snapshot_path: p.snapshotPath,
    }).toEqual(c.value);
  });
test("population source and placeholder errors match Python", () => {
  for (const c of gold.sources) {
    expect<string>(populationSource(c.input)).toBe(c.source);
    expect(readsOrq(c.input)).toBe(c.orq);
  }
  const summary = TraceSummarySchema.parse({
    summary: "x",
    request: null,
    task: null,
    topic: null,
    sentimentExplanation: null,
    assistantErrors: [
      " None. ",
      "N/A",
      "no errors were made...",
      "keep",
      "NO ERROR",
      "unexpected.",
    ],
  });
  expect(realAssistantErrors(summary)).toEqual(gold.errors);
});

test("label questions validate kind-specific criteria and preserve state", () => {
  const good = new LabelSpec({
    name: "sentiment",
    kind: "choice",
    instructions: "Which?",
    criteria: { positive: "good", negative: "bad" },
  });
  expect(good.toQuestion({ text: "hello" })).toMatchObject({
    kind: "choice",
    criteria: { positive: "good", negative: "bad" },
    state: { text: "hello" },
    noulThreshold: 0.5,
  });
  const invalid = new LabelSpec({
    name: "score",
    kind: "score",
    instructions: "Rate",
    criteria: ["only one"],
  });
  expect(() => invalid.toQuestion("hello")).toThrow();
  expect(
    () => new LabelSpec({ name: "__match__", kind: "noul", instructions: "Q" }),
  ).toThrow();
});

test("duplicate trace IDs are rejected including special object keys", () => {
  expect(() =>
    ensureUniqueTraceIds([{ traceId: "__proto__" }, { traceId: "__proto__" }]),
  ).toThrow("duplicate trace_id='__proto__'");
  expect(() =>
    ensureUniqueTraceIds([{ traceId: "a" }, { traceId: "b" }]),
  ).not.toThrow();
});
