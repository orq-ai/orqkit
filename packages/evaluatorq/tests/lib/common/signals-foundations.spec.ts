import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { z } from "zod/v4";

import { AtifTrajectory, atifWire } from "../../../src/lib/formats/atif.js";
import {
  SignalsConfig,
  TagThresholds,
} from "../../../src/lib/signals/config.js";
import {
  EvidenceSchema,
  PreconditionSchema,
  SignalReportSchema,
  SignalResultSchema,
  signalResult,
} from "../../../src/lib/signals/models.js";
import {
  calls,
  callToolSchemas,
  finishReasons,
  hasUnmappedToolActivity,
  inferProvider,
  invocation,
  isLlmStep,
  llmTimes,
  rawToolArguments,
  resultText,
  SignalContext,
  stepModel,
  toolSchemas,
  toolTimes,
  walk,
} from "../../../src/lib/signals/walk.js";

type Row = Record<string, unknown>;
const goldens = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signals-foundations-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  models: { model: string; input: unknown; ok: boolean; expected: unknown }[];
  results: { conditions: unknown[]; evidence: unknown[]; expected: unknown }[];
  configs: {
    input: Row;
    fromFile: boolean;
    ok: boolean;
    expected: Row;
    version: string;
  }[];
  thresholds: {
    input: unknown;
    ok: boolean;
    expected: unknown;
    quantiles: { q: number; value: number }[];
  }[];
  walks: {
    input: Row;
    entries: unknown;
    calls: unknown;
    schemas: unknown;
    unmapped: string[];
  }[];
  providers: { input: string | null; expected: string | null }[];
};
const schemas: Record<string, z.ZodType<unknown>> = {
  Evidence: EvidenceSchema,
  Precondition: PreconditionSchema,
  SignalReport: SignalReportSchema,
  SignalResult: SignalResultSchema,
};
const free = new Set([
  "value",
  "tool_roles",
  "alert_thresholds",
  "tag_percentiles",
  "thresholds",
  "percentiles",
  "results",
]);
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        free.has(key)
          ? key === "results"
            ? Object.fromEntries(
                Object.entries(v as Row).map(([k, r]) => [k, native(r)]),
              )
            : v
          : native(v),
      ]),
    );
  return value;
}
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.models.entries())
  test(`Python signal model ${i}`, () => {
    const parse = () => schemas[row.model]?.parse(row.input);
    if (!row.ok) expect(parse).toThrow();
    else expect(parse()).toEqual(native(row.expected));
  });
for (const [i, row] of goldens.results.entries())
  test(`Python signal result preconditions and evidence ${i}`, () => {
    expect<unknown>(
      signalResult(
        "x",
        "B",
        7,
        row.evidence.map((v) => EvidenceSchema.parse(v)),
        row.conditions.map((v) => PreconditionSchema.parse(v)),
        { approximate: true, reason: "rule", ruleVersion: "v" },
      ),
    ).toEqual(native(row.expected));
  });
for (const [i, row] of goldens.configs.entries())
  test(`Python signal configuration ${i}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-config-"));
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify(row.input));
      const parse = () =>
        row.fromFile
          ? SignalsConfig.fromFile(file)
          : new SignalsConfig(row.input);
      if (!row.ok) expect(parse).toThrow();
      else {
        const config = parse(),
          actual = {
            ...config.toJSON(),
            emptyValues: [...config.emptyValues].sort(),
          };
        expect<unknown>(actual).toEqual(native(row.expected));
        expect(config.version).toBe(row.version);
        expect(config.toolRole("unregistered")).toBe("other");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
for (const [i, row] of goldens.thresholds.entries())
  test(`Python signal threshold tables ${i}`, () => {
    const parse = () => new TagThresholds(row.input);
    if (!row.ok) expect(parse).toThrow();
    else {
      const table = parse();
      expect<unknown>(table).toEqual(native(row.expected));
      for (const q of row.quantiles)
        expect(table.cohortThreshold("x", q.q)).toBe(q.value);
    }
  });
for (const [i, row] of goldens.walks.entries())
  test(`Python signal walk and paired calls ${i}`, () => {
    const trajectory = new AtifTrajectory(row.input),
      walked = walk(trajectory),
      records = calls(walked);
    const entries = walked.map((e) => ({
      step_id: e.step.stepId,
      agent_path: e.agentPath,
      depth: e.depth,
      unlinked: e.unlinked,
      trajectory_id: e.trajectory.trajectoryId,
      model: stepModel(e),
      is_llm: isLlmStep(e),
      times: llmTimes(e),
      finish_reasons: finishReasons(e.step),
      invocation: invocation(e.step),
    }));
    const paired = records.map((r) => ({
      seq: r.seq,
      step_id: r.step.step.stepId,
      agent_path: r.step.agentPath,
      call_id: r.call.toolCallId,
      result: r.result ? atifWire(r.result) : null,
      is_error: r.isError,
      raw: rawToolArguments(r.call),
      schemas: callToolSchemas(r, trajectory),
      text: r.result ? resultText(r.result) : null,
      times: r.result ? toolTimes(r.result) : null,
    }));
    expect<unknown>(entries).toEqual(row.entries);
    expect<unknown>(paired).toEqual(row.calls);
    expect<unknown>(toolSchemas(trajectory)).toEqual(row.schemas);
    expect(hasUnmappedToolActivity(walked)).toEqual(row.unmapped);
  });
for (const [i, row] of goldens.providers.entries())
  test(`Python signal provider ${i}`, () =>
    expect(inferProvider(row.input)).toBe(row.expected));
test("Signal configuration and context keep independent mutable payloads", () => {
  const first = TagThresholds.bundled(),
    second = TagThresholds.bundled();
  const key = Object.keys(first.thresholds)[0] as string;
  first.thresholds[key] = -1;
  expect(second.thresholds[key]).not.toBe(-1);
  const a = new SignalsConfig(),
    b = new SignalsConfig();
  a.toolRoles.custom = "bash";
  expect(b.toolRole("custom")).toBe("other");
  const context = SignalContext.build(
    new AtifTrajectory({
      agent: { name: "a", version: "v" },
      steps: [{ stepId: 1, source: "agent", message: "" }],
    }),
    b,
  );
  expect(Object.isFrozen(context)).toBe(true);
  context.results.test = SignalResultSchema.parse({
    name: "test",
    group: "A",
    value: 1,
  });
  expect(context.results.test.value).toBe(1);
});
