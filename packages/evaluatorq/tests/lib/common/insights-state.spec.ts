import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { hasTruncatedSourceText } from "../../../src/lib/common/model-input.js";
import {
  prepareClassifierState,
  prepareState,
} from "../../../src/lib/insights/labeling.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";

const gold = JSON.parse(
  readFileSync(
    new URL("../fixtures/insights-state-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  traces: {
    trace: unknown;
    model: string;
    state: unknown;
    truncated: boolean;
  }[];
  states: {
    input: string | Record<string, unknown>;
    model: string;
    state: unknown;
  }[];
};
for (const [i, c] of gold.traces.entries())
  test(`classifier trace state ${i}`, () => {
    const state = prepareClassifierState(new TraceRecord(c.trace), {
      model: c.model,
      charCap: 4096,
    });
    expect<unknown>(JSON.parse(JSON.stringify(state))).toEqual(c.state);
    expect(hasTruncatedSourceText(state)).toBe(c.truncated);
  });
for (const [i, c] of gold.states.entries())
  test(`classifier generic state ${i}`, () => {
    const state = prepareState(c.input, c.model, 4096);
    expect<unknown>(JSON.parse(JSON.stringify(state))).toEqual(c.state);
  });
