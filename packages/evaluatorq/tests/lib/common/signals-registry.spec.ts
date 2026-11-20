import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AtifTrajectory } from "../../../src/lib/formats/atif.js";
import { ChatConversation } from "../../../src/lib/formats/chat.js";
import { SignalsConfig } from "../../../src/lib/signals/config.js";
import {
  signalEvaluator,
  signalEvaluators,
  toTrajectory,
} from "../../../src/lib/signals/evaluator.js";
import { SignalResultSchema } from "../../../src/lib/signals/models.js";
import {
  computeSignals,
  SIGNAL_NAMES,
  SIGNALS,
  TOOL_ACTIVITY_DEPENDENT_SIGNALS,
} from "../../../src/lib/signals/registry.js";
import {
  TAG_DEPENDENCIES,
  TAG_SIGNALS,
} from "../../../src/lib/signals/tags.js";
import { SignalContext } from "../../../src/lib/signals/walk.js";

const read = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/${name}-python-goldens.json`, import.meta.url),
      "utf8",
    ),
  );
const source = read("signals-foundations") as { walks: { input: unknown }[] };
type ExpectedReport = {
  trajectory_id: string | null;
  config_version: string;
  results: Record<string, number>;
};
const goldens = read("signals-registry") as {
  names: string[];
  toolDependent: string[];
  dependencies: Record<string, string[]>;
  resultTable: unknown[];
  shared: { walkIndices: number[]; expected: ExpectedReport }[];
  custom: {
    input: unknown;
    config: unknown;
    only: string[];
    expected: ExpectedReport;
  }[];
  tags: {
    name: string;
    metrics: Record<string, unknown>;
    config: unknown;
    expected: unknown;
  }[];
  evaluations: {
    walkIndex: number;
    name: string;
    threshold: number | null;
    expected: Record<string, unknown>;
  }[];
};
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        key === "value" ? item : native(item),
      ]),
    );
  return value;
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item)]),
    );
  if (typeof value === "string")
    return value
      .replace(/( = -?\d+)\.0$/, "$1")
      .replace(/(returned -?\d+)\.0(?=$|[ (])/, "$1")
      .replace(/(: -?\d+)\.0(?=[,}])/, "$1");
  return value;
}
const trajectory = (input: unknown) => new AtifTrajectory(input);
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
function reportExpected(expected: ExpectedReport) {
  return {
    trajectoryId: expected.trajectory_id,
    configVersion: expected.config_version,
    results: Object.fromEntries(
      Object.entries(expected.results).map(([key, index]) => [
        key,
        native(goldens.resultTable[index]),
      ]),
    ),
  };
}
for (const row of goldens.shared)
  for (const index of row.walkIndices)
    test(`Python signal registry shared ${index}`, () => {
      expect<unknown>(
        normalize(computeSignals(trajectory(source.walks[index]?.input))),
      ).toEqual(normalize(reportExpected(row.expected)));
    });
for (const [i, row] of goldens.custom.entries())
  test(`Python selected signals and source coverage ${i}`, () => {
    const result = computeSignals(trajectory(row.input), {
      config: new SignalsConfig(row.config),
      only: row.only,
    });
    expect<unknown>(normalize(result)).toEqual(
      normalize(reportExpected(row.expected)),
    );
    expect(result.values()).toEqual(
      Object.fromEntries(
        Object.entries(result.results)
          .filter(([, item]) => item.noBasis === null)
          .map(([name, item]) => [name, item.value]),
      ),
    );
  });
for (const [i, row] of goldens.tags.entries())
  test(`Python tag clause logic ${i} ${row.name}`, () => {
    const ctx = SignalContext.build(
      trajectory(source.walks[0]?.input),
      new SignalsConfig(row.config),
    );
    for (const [name, metric] of Object.entries(row.metrics))
      ctx.results[name] = SignalResultSchema.parse(metric);
    expect<unknown>(normalize(TAG_SIGNALS.get(row.name)?.(ctx))).toEqual(
      normalize(native(row.expected)),
    );
  });
for (const [i, row] of goldens.evaluations.entries())
  test(`Python signal evaluator ${i} ${row.name}`, async () => {
    const expected = {
      value: row.expected.value,
      pass: row.expected.pass,
      explanation: row.expected.explanation,
    };
    const output = trajectory(source.walks[row.walkIndex]?.input);
    const actual = await signalEvaluator(row.name, {
      threshold: row.threshold,
    }).scorer({
      data: { inputs: {} },
      output,
    });
    expect<unknown>(normalize(actual)).toEqual(normalize(expected));
  });
test("registry order, dependencies and public selector validation", () => {
  expect(SIGNAL_NAMES).toEqual(goldens.names);
  expect([...TOOL_ACTIVITY_DEPENDENT_SIGNALS].sort()).toEqual(
    goldens.toolDependent,
  );
  expect(TAG_DEPENDENCIES).toEqual(goldens.dependencies);
  expect(Object.isFrozen(SIGNALS)).toBe(true);
  expect(Object.values(SIGNALS).every(Object.isFrozen)).toBe(true);
  expect(signalEvaluators().map((e) => e.name)).toEqual(
    goldens.names.filter((n) => SIGNALS[n]?.[0] === "D"),
  );
  for (const group of ["A", "B", "C", "D"])
    expect(signalEvaluators(group).map((e) => e.name)).toEqual(
      goldens.names.filter((n) => SIGNALS[n]?.[0] === group),
    );
  expect(signalEvaluators("all").length).toBe(60);
  expect(signalEvaluators([])).toEqual([]);
  expect(() => signalEvaluators("missing")).toThrow("names must be");
  expect(() => signalEvaluator("__proto__")).toThrow("Unknown signal name");
  expect(() => signalEvaluators(["zzz", "aaa"])).toThrow(
    "Unknown signal names: aaa, zzz",
  );
  expect(() =>
    computeSignals(trajectory(source.walks[0]?.input), {
      only: ["zzz", "aaa"],
    }),
  ).toThrow("Unknown signal names: aaa, zzz");
});
test("all supported transcript models convert to ATIF without dropping message text", () => {
  const chat = new ChatConversation({
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
    }),
    atif = chat.toAtif();
  expect(toTrajectory(atif)).toBe(atif);
  for (const input of [
    chat,
    chat.messages,
    { messages: chat.messages },
    chat.toResponses(),
    chat.toOtel(),
  ]) {
    const out = toTrajectory(input);
    expect(out).not.toBeNull();
    expect(out?.steps.map((s) => s.message)).toContain("answer");
  }
  for (const input of [
    null,
    "text",
    1,
    false,
    [],
    [null],
    { messages: "text" },
    { messages: [{}] },
  ])
    expect(toTrajectory(input)).toBeNull();
});
test("unsupported output is inconclusive with a native type label", async () => {
  expect(
    await signalEvaluator("tool_call_count").scorer({
      data: { inputs: {} },
      output: "text",
    }),
  ).toEqual({
    value: null,
    pass: null,
    explanation:
      "Could not convert output of type string to an ATIF trajectory.",
  });
});
test("one signal throwing does not hide successful signals", () => {
  const input = new AtifTrajectory({
    agent: { name: "test", version: "1" },
    steps: [
      {
        stepId: 1,
        source: "agent",
        message: "",
        toolCalls: [{ toolCallId: "c", functionName: "f", arguments: {} }],
        observation: {
          results: [
            { sourceCallId: "c", content: String.fromCharCode(0xd800) },
          ],
        },
      },
    ],
  });
  const result = computeSignals(input, {
    only: ["max_depth", "max_tool_result_bytes"],
  });
  expect(result.results.max_depth?.noBasis).toBeNull();
  expect(result.results.max_tool_result_bytes?.value).toBeNull();
  expect(result.results.max_tool_result_bytes?.noBasis).toContain(
    "signal raised",
  );
});
