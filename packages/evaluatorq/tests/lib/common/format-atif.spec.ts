import { expect, test } from "bun:test";

import * as atif from "../../../src/lib/formats/atif.js";
import { pythonJson } from "../../../src/lib/formats/json.js";
import goldens from "../fixtures/atif-python-goldens.json" with {
  type: "json",
};

const schemas: Record<
  string,
  typeof atif.AtifStepSchema | typeof atif.AtifTrajectorySchema
> = Object.fromEntries(
  Object.entries(atif).filter(([name]) => name.endsWith("Schema")),
) as Record<
  string,
  typeof atif.AtifStepSchema | typeof atif.AtifTrajectorySchema
>;
const free = new Set(["extra", "arguments", "tool_definitions"]);
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]?.[0] === "$number") {
      return entries[0][1] === "nan"
        ? NaN
        : entries[0][1] === "inf"
          ? Infinity
          : -Infinity;
    }
    return Object.fromEntries(
      entries.map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        free.has(key) ? item : native(item),
      ]),
    );
  }
  return value;
}
for (const [i, row] of goldens.cases.entries())
  test(`Python ATIF ${row.model} validation ${i}`, () => {
    const schema = schemas[`${row.model}Schema`] as typeof atif.AtifStepSchema;
    const result = schema.safeParse(row.input);
    expect(result.success).toBe(row.ok);
    if (result.success)
      expect<unknown>(result.data).toEqual(native(row.expected));
  });
for (const [i, row] of goldens.exports.entries())
  test(`Python ATIF version and serialization ${i}`, () => {
    const trajectory = new atif.AtifTrajectory(row.input),
      options = {
        version: row.version as "1.7" | "1.8" | undefined,
        indent: row.indent,
      };
    expect(trajectory.hasAudio()).toBe(row.audio);
    if (!row.ok) expect(() => trajectory.toJsonDict(options)).toThrow();
    else {
      expect(trajectory.toJsonDict(options)).toEqual(
        row.expected as unknown as Record<string, unknown>,
      );
      expect(trajectory.toJson(options)).toBe(row.text as string);
    }
  });
for (const [i, row] of goldens.reads.entries())
  test(`Python ATIF document parsing ${i}`, () => {
    for (const input of [
      row.input,
      JSON.stringify(row.input),
      new TextEncoder().encode(JSON.stringify(row.input)),
    ]) {
      const read = () =>
        atif.AtifTrajectory.fromJson(
          input as Parameters<typeof atif.AtifTrajectory.fromJson>[0],
        );
      if (!row.ok) expect(read).toThrow();
      else
        expect(read().toJsonDict()).toEqual(
          row.expected as unknown as Record<string, unknown>,
        );
    }
  });
for (const [i, row] of goldens.pretty.entries())
  test(`Python indented JSON ${i}`, () =>
    expect(
      pythonJson(row.input, {
        indent: row.indent,
        sortKeys: row.sort,
        compact: row.compact,
      }),
    ).toBe(row.expected));
test("ATIF native aliases preserve payload keys and isolate serialized output", () => {
  const trajectory = new atif.AtifTrajectory({
    agent: { name: "a", version: "1", modelName: "model" },
    steps: [
      {
        stepId: 1,
        source: "agent",
        message: "done",
        toolCalls: [
          {
            toolCallId: "c",
            functionName: "f",
            arguments: { free_key: null, camelKey: 1 },
          },
        ],
      },
    ],
    extra: { free_key: { inner_key: null } },
  });
  expect(trajectory.agent.modelName).toBe("model");
  expect(Object.isFrozen(trajectory)).toBe(true);
  expect(Object.isFrozen(trajectory.steps[0])).toBe(true);
  const wire = trajectory.toJsonDict();
  expect((wire.extra as Record<string, unknown>).free_key).toEqual({
    inner_key: null,
  });
  (wire.extra as Record<string, unknown>).free_key = "changed";
  expect(trajectory.extra?.free_key).toEqual({ inner_key: null });
  expect(JSON.parse(JSON.stringify(trajectory))).toHaveProperty(
    "schemaVersion",
    "ATIF-v1.7",
  );
  expect(() =>
    atif.AtifAgentSchema.parse({
      name: "a",
      version: "1",
      modelName: "a",
      model_name: "b",
    }),
  ).toThrow("Conflicting");
  expect(
    atif.AtifAgentSchema.parse({
      name: "a",
      version: "1",
      modelName: "a",
      model_name: "a",
    }).modelName,
  ).toBe("a");
});
