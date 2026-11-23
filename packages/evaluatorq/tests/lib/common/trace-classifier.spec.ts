import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  EvaluatorResponsePayload,
  type JudgeOutcome,
} from "../../../src/lib/common/judge.js";
import * as classifier from "../../../src/lib/trace-finder/classifier.js";
import { CompiledQuerySchema } from "../../../src/lib/trace-finder/models.js";
import type { DataPointResult } from "../../../src/lib/types.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-classifier-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<
  string,
  { args: unknown[]; ok: boolean; expected?: unknown; error?: string }[]
>;
type Row = Record<string, unknown>;
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        wire(item),
      ]),
    );
  return value;
}
function native(value: unknown, key = ""): unknown {
  if (key === "error" && typeof value === "string")
    return value ? new Error(value) : undefined;
  if (Array.isArray(value)) return value.map((item) => native(item));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
        ["inputs", "raw_output"].includes(name) ? item : native(item, name),
      ]),
    );
  return value;
}
function withoutRawResult(value: unknown): unknown {
  const { raw_result: _, ...rest } = value as Row;
  return rest;
}
let warning: ReturnType<typeof spyOn>;
beforeEach(() => {
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());
for (const [group, rows] of Object.entries(fixture))
  for (const [index, row] of rows.entries())
    test(`Python trace classifier ${group} ${index}`, () => {
      const a = row.args,
        run = () => {
          if (group === "matches")
            return classifier.matchesSelection(
              a[0],
              CompiledQuerySchema.parse(a[1]),
            );
          if (group === "answers")
            return classifier.dimensionAnswer(
              a[0],
              CompiledQuerySchema.parse(a[1]),
            );
          if (group === "details")
            return classifier.classificationDetails(a[0] as Row | null);
          if (group === "raw") return classifier.rawAnswer(a[0] as Row | null);
          if (group === "outcomes") {
            const input = a[0] as Row,
              result = classifier.outcomeResult(
                {
                  payload:
                    input.payload == null
                      ? null
                      : new EvaluatorResponsePayload(input.payload),
                  errorKind: input.error_kind as JudgeOutcome["errorKind"],
                  errorMessage: input.error_message as string | null,
                  rawOutput: input.raw_output as Row | null,
                  rawContent: (input.raw_content as string) ?? "",
                  errorExc: null,
                  tokenUsage: null,
                  timeoutMs: null,
                  endpoint: null,
                },
                "test",
              );
            return wire(result);
          }
          if (group === "datapoints") {
            const input = native(a[0]) as DataPointResult,
              result = classifier.parseDatapointResult(input, [
                CompiledQuerySchema.parse(a[1]),
              ]);
            expect(result.rawResult).toEqual(
              JSON.parse(
                JSON.stringify(input, (_, value) =>
                  value instanceof Error ? value.message : value,
                ),
              ),
            );
            return withoutRawResult(wire(result));
          }
          throw new Error(group);
        };
      if (!row.ok) {
        expect(run).toThrow(row.error);
        return;
      }
      let expected = row.expected;
      if (group === "outcomes") {
        const { pass_: _, ...rest } = expected as Row;
        expected = rest;
      }
      if (group === "datapoints") expected = withoutRawResult(expected);
      expect(wire(run())).toEqual(expected);
    });
