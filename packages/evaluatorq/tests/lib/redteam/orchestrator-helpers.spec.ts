import { expect, it } from "bun:test";

import {
  AgentContextSchema,
  MessageSchema,
  UsageSchema,
} from "../../../src/lib/contracts.js";
import {
  AttackStrategySchema,
  accumulateTargetUsage,
  buildAdversarialSystemPrompt,
  mergeAttackUsage,
  parseObjectiveMarker,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/orchestrator-helper-python-goldens.json" with {
  type: "json",
};

for (const [index, fixture] of goldens.markers.entries())
  it(`matches Python objective marker parsing ${index}`, () => {
    expect(parseObjectiveMarker(fixture.value)).toEqual(
      fixture.expected as [boolean, string | null, string],
    );
  });
for (const [index, fixture] of goldens.prompts.entries())
  it(`matches Python attacker context prompt ${index}`, () => {
    const raw = fixture.context as Record<string, unknown>;
    const context = AgentContextSchema.parse({
      ...raw,
      displayName: raw.display_name,
      memoryStores: raw.memory_stores,
    });
    expect(
      buildAdversarialSystemPrompt(
        "Objective {agent_name}",
        AttackStrategySchema.parse(goldens.strategy),
        context,
        3,
        {
          attackerInstructions: "Operator {max_turns}",
          toolChainPlan: fixture.plan,
          seedContext:
            fixture.seed?.map((message) => MessageSchema.parse(message)) ??
            null,
        },
      ),
    ).toBe(fixture.expected);
  });
it("normalizes forgotten target call counts, preserves tool rounds and merges priced usage", () => {
  const empty = UsageSchema.parse({});
  expect(accumulateTargetUsage(empty, null)).toBe(empty);
  const one = accumulateTargetUsage(
    empty,
    UsageSchema.parse({ inputTokens: 3, totalTokens: 3, totalCost: 0.01 }),
  );
  expect(one).toMatchObject({ calls: 1, pricedCalls: 1, totalCost: 0.01 });
  const two = accumulateTargetUsage(
    one,
    UsageSchema.parse({ calls: 2, totalTokens: 5 }),
  );
  expect(two.calls).toBe(3);
  expect(mergeAttackUsage(one, two)?.calls).toBe(4);
  expect(mergeAttackUsage(null, undefined)).toBeNull();
});
