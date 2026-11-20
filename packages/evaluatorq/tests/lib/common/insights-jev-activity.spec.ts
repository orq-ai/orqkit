import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  jevStateCharLimit,
  serializedChars,
} from "../../../src/lib/common/model-input.js";
import { jevToolActivityChunks } from "../../../src/lib/insights/transcript.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/insights-jev-activity-python-goldens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { trace: unknown; budget: number; chunks?: unknown[]; valid: boolean }[];
for (const [i, c] of gold.entries())
  test(`Jev tool activity ${i}`, () => {
    const trace = new TraceRecord(c.trace);
    if (!c.valid) {
      expect(() =>
        jevToolActivityChunks(trace, {
          traceInputChars: 4096,
          budget: c.budget,
        }),
      ).toThrow();
      return;
    }
    expect<unknown>(
      JSON.parse(
        JSON.stringify(
          jevToolActivityChunks(trace, {
            traceInputChars: 4096,
            budget: c.budget,
          }),
        ),
      ),
    ).toEqual(c.chunks);
  });

test("Jev chunks retain every call within the reserved question budget", () => {
  const fixture = gold[8];
  if (!fixture) throw new Error("missing fixture");
  const trace = new TraceRecord(fixture.trace);
  const questions = {
    risk: {
      kind: "noul",
      instructions: "Classify the tool activity.",
      criteria: null,
      state: {},
      noulThreshold: 0.5,
    },
  };
  const chunks = jevToolActivityChunks(trace, {
    traceInputChars: 4096,
    budget: 1500,
    questionPayloads: questions,
  });
  const limit = jevStateCharLimit(questions, { globalCharCap: 1500 });
  let calls = 0;
  for (const chunk of chunks) {
    if (typeof chunk === "string") continue;
    expect(serializedChars(chunk)).toBeLessThanOrEqual(limit);
    calls += chunk.messages.filter(
      (message) => message.type === "tool_call",
    ).length;
  }
  expect(calls).toBe(40);
});
