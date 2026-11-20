import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDatapoints } from "../../../../src/lib/integrations/simulation/cli-generate.js";
import type { Datapoint } from "../../../../src/lib/integrations/simulation/types.js";
import {
  exportDatapointsToJsonl,
  loadDatapointsFromJsonl,
} from "../../../../src/lib/integrations/simulation/utils/dataset-export.js";

const persona = {
  name: "Ann",
  patience: 0.2,
  assertiveness: 0.8,
  politeness: 0.5,
  technical_level: 0.3,
  communication_style: "terse",
  background: "b",
};
const scenario = { name: "Refund", goal: "g", context: "c", criteria: [] };
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
function write(lines: unknown[]): string {
  dir = mkdtempSync(join(tmpdir(), "dsx-"));
  const p = join(dir, "dp.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

test("reads raw sim generate lines with id and fields intact", () => {
  const [dp] = loadDatapointsFromJsonl(
    write([
      {
        id: "dp_abc",
        persona,
        scenario,
        first_message: "hi",
        user_system_prompt: "sp",
      },
    ]),
  );
  expect(dp?.id).toBe("dp_abc");
  expect(dp?.persona.name).toBe("Ann");
  expect(dp?.scenario.name).toBe("Refund");
  expect(dp?.first_message).toBe("hi");
});

test("still reads the orq dataset envelope", () => {
  const [dp] = loadDatapointsFromJsonl(
    write([{ inputs: { persona, scenario, first_message: "yo" } }]),
  );
  expect(dp?.persona.name).toBe("Ann");
  expect(dp?.first_message).toBe("yo");
});

test.each(["cli", "sdk"] as const)(
  "%s dataset export uses platform-compatible fields and preserves traits and criteria on import",
  (writer) => {
    dir = mkdtempSync(join(tmpdir(), "dsx-"));
    const path = join(dir, "dataset.jsonl");
    const datapoint: Datapoint = {
      id: "original",
      persona: {
        name: "Ann",
        patience: 0.2,
        assertiveness: 0.8,
        politeness: 0.5,
        technical_level: 0.3,
        communication_style: "terse",
        background: "Dutch customer",
        emotional_arc: "escalating",
        cultural_context: "direct",
      },
      scenario: {
        name: "Refund",
        goal: "Recover the payment",
        context: "The order never arrived",
        starting_emotion: "frustrated",
        criteria: [
          { description: "Offer a refund", type: "must_happen" },
          {
            description: "Reveal another customer's details",
            type: "must_not_happen",
          },
        ],
        is_edge_case: true,
        conversation_strategy: "multi_intent",
        ground_truth: "The order is eligible for a refund",
        input_format: "plain_text",
      },
      user_system_prompt: "Keep the saved persona instructions",
      first_message: "Where is my order?",
    };
    if (writer === "cli") writeDatapoints([datapoint], path, true);
    else exportDatapointsToJsonl([datapoint], path);
    const row = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof row.inputs.persona).toBe("string");
    expect(typeof row.inputs.scenario).toBe("string");
    expect(row.expected_output).toBe("");
    const [loaded] = loadDatapointsFromJsonl(path);
    expect(loaded?.persona).toMatchObject(datapoint.persona);
    expect(loaded?.scenario).toMatchObject(datapoint.scenario);
    expect(loaded?.scenario.criteria).toHaveLength(2);
    expect(loaded?.first_message).toBe(datapoint.first_message);
    expect(loaded?.user_system_prompt).toBe(datapoint.user_system_prompt);
  },
);

test("dataset envelope rows without ids retain separate generated ids", () => {
  const row = {
    inputs: {
      persona: JSON.stringify(persona),
      scenario: JSON.stringify(scenario),
      first_message: "hello",
    },
  };
  const [first, second] = loadDatapointsFromJsonl(write([row, row]));
  expect(first?.id).toMatch(/^dp_/);
  expect(second?.id).not.toBe(first?.id);
});
