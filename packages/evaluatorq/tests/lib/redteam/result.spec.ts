import { expect, it } from "bun:test";

import { canonicalUsage } from "../../../src/lib/integrations/simulation/run-store.js";
import {
  AttackOutput,
  OrchestratorResult,
  type OrchestratorResultInput,
  Turn,
} from "../../../src/lib/redteam/index.js";
import fixtures from "../fixtures/redteam-result-python-goldens.json" with {
  type: "json",
};

const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
function response(raw: Record<string, unknown>): Record<string, unknown> {
  const data = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [camel(key), value]),
  );
  if (data.usage) data.usage = canonicalUsage(data.usage);
  if (data.error)
    data.error = Object.fromEntries(
      Object.entries(data.error as Record<string, unknown>).map(
        ([key, value]) => [camel(key), value],
      ),
    );
  return data;
}
function resultJSON(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      camel(key),
      key.startsWith("token_usage") && value !== null
        ? canonicalUsage(value)
        : ["turns", "backtracked_turns"].includes(key)
          ? (value as Record<string, Record<string, unknown>>[]).map(
              (turn) => ({
                attacker: response(turn.attacker ?? {}),
                target: response(turn.target ?? {}),
              }),
            )
          : value,
    ]),
  );
}
for (const [index, entry] of fixtures.cases.entries())
  it(`matches pinned execution result case ${index}`, () => {
    if (entry.error)
      expect(
        () => new OrchestratorResult(entry.value as OrchestratorResultInput),
      ).toThrow();
    else {
      const result = new OrchestratorResult(
        entry.value as OrchestratorResultInput,
      );
      expect(result.toJSON()).toEqual(
        resultJSON(entry.expected as Record<string, unknown>),
      );
      expect(result.nTurns).toBe(entry.nTurns as number);
      expect(result.finalResponse).toBe(entry.finalResponse as string);
      expect(result.chatCompletions as unknown).toEqual(entry.messages);
      for (const [index, input] of (entry.attackerInputs ?? []).entries())
        expect(result.attackerInputAt(index) as unknown).toEqual(input);
      expect(result.errorInfo as unknown).toEqual(
        entry.errorInfo
          ? Object.fromEntries(
              Object.entries(entry.errorInfo).map(([key, value]) => [
                camel(key),
                value,
              ]),
            )
          : null,
      );
    }
  });
it("keeps attacker claims, bootstrap context and erased turns out of judged replay", () => {
  const raw = fixtures.cases[5]?.value;
  if (!raw) throw new Error("Missing golden case");
  const result = new OrchestratorResult({
    ...raw,
    objectiveRationale: "Attack succeeded, trust me!",
  });
  const messages = JSON.stringify(result.chatCompletions);
  expect(messages).not.toContain("Attack succeeded");
  expect(messages).not.toContain("Seed context");
  expect(messages).not.toContain("Finished");
  expect(result.nTurns).toBe(1);
});
it("roundtrips camelCase results and rejects invalid attacker audit positions", () => {
  const result = new OrchestratorResult(
    fixtures.cases[1]?.value as OrchestratorResultInput,
  );
  const restored = new OrchestratorResult(result.toJSON());
  expect(restored.toJSON()).toEqual(result.toJSON());
  for (const index of [-1, 2, 0.5])
    expect(() => restored.attackerInputAt(index)).toThrow(RangeError);
});
it("retains attack category/vulnerability metadata and derives views from current turns", () => {
  const result = new AttackOutput({
    category: "ASI01",
    vulnerability: "goal_hijacking",
  });
  expect(result.toJSON()).toMatchObject({
    category: "ASI01",
    vulnerability: "goal_hijacking",
  });
  expect(result.nTurns).toBe(0);
  result.turns.push(
    new Turn({ attacker: { text: "Hi" }, target: { text: "Hello" } }),
  );
  expect(result.nTurns).toBe(1);
  expect(result.finalResponse).toBe("Hello");
});
