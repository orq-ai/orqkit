import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { effectiveTraceInputChars } from "../../../src/lib/common/model-input.js";
import {
  callArguments,
  fullConversationViewWithMessageSpans,
  rawCallArguments,
  shellCommand,
} from "../../../src/lib/insights/transcript.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";
import {
  contentToolCallStatus,
  type ProjectionOptions,
  projectTrace,
  projectTraceWithCap,
  toolCallStatus,
  toolResultCategory,
} from "../../../src/lib/trace-finder/projection.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/trace-projection-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<
  string,
  {
    args: unknown[];
    kwargs: Record<string, unknown>;
    ok: boolean;
    expected?: unknown;
  }[]
>;
let warning: ReturnType<typeof spyOn>;
beforeEach(() => {
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());
function wire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        key === "payload" ? JSON.parse(JSON.stringify(item)) : wire(item),
      ]),
    );
  return value;
}
for (const [group, rows] of Object.entries(fixture))
  for (const [index, row] of rows.entries())
    test(`Python projection ${group} ${index}`, () => {
      const args = row.args as [unknown, Record<string, unknown>[]],
        run = () => {
          if (group === "statuses") return toolCallStatus(...args);
          if (group === "categories") return toolResultCategory(...args);
          if (group === "content")
            return contentToolCallStatus(args[0] as string);
          if (group === "arguments") {
            const call = args[0] as Record<string, unknown>;
            return [
              rawCallArguments(call),
              callArguments(call),
              shellCommand(callArguments(call)),
            ];
          }
          if (group === "whole") {
            const [text, spans, count] = fullConversationViewWithMessageSpans(
              new TraceRecord(args[0]),
            );
            return [String(text), spans, count];
          }
          if (group === "projection") {
            const options: ProjectionOptions & { traceInputChars: number } = {
              model: row.kwargs.model as string | undefined,
              traceInputChars: row.kwargs.trace_input_chars as number,
              questionPayloads: row.kwargs.question_payloads as
                | Record<string, unknown>
                | null
                | undefined,
            };
            return wire(projectTraceWithCap(new TraceRecord(args[0]), options));
          }
          throw new Error(group);
        };
      if (row.ok) expect(run()).toEqual(row.expected);
      else expect(run).toThrow();
    });
test("standalone projection reads the persisted cap asynchronously", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eq-projection-")),
    path = join(directory, "settings.json"),
    previous = process.env.EVALUATORQ_DASHBOARD_SETTINGS;
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = path;
  try {
    await writeFile(path, JSON.stringify({ traceInputChars: 4096 }));
    expect(await effectiveTraceInputChars()).toBe(4096);
    const source = new TraceRecord(fixture.whole?.at(-1)?.args[0]),
      result = await projectTrace(source, { model: "openai/synthetic" });
    expect(result.omittedMessages).toBeGreaterThan(0);
    expect(Array.from(result.serialized).length).toBeLessThanOrEqual(4096);
    await writeFile(path, JSON.stringify({ traceInputChars: 500000 }));
    expect(await effectiveTraceInputChars()).toBe(500000);
    expect(
      (await projectTrace(source, { model: "openai/synthetic" }))
        .omittedMessages,
    ).toBe(0);
  } finally {
    if (previous === undefined)
      delete process.env.EVALUATORQ_DASHBOARD_SETTINGS;
    else process.env.EVALUATORQ_DASHBOARD_SETTINGS = previous;
    await rm(directory, { recursive: true });
  }
});
