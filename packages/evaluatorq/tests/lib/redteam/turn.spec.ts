import { expect, it } from "bun:test";

import { AgentResponse } from "../../../src/lib/contracts.js";
import { canonicalUsage } from "../../../src/lib/integrations/simulation/run-store.js";
import { Turn, turnsToMessages } from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/redteam-turn-python-goldens.json" with {
  type: "json",
};

function camelResponse(raw: Record<string, unknown>) {
  const value = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
      value,
    ]),
  );
  if (value.usage) value.usage = canonicalUsage(value.usage);
  if (value.error)
    value.error = Object.fromEntries(
      Object.entries(value.error as Record<string, unknown>).map(
        ([key, value]) => [key === "error_type" ? "errorType" : key, value],
      ),
    );
  return value;
}
for (const [index, entry] of goldens.responses.entries())
  it(`loads pinned response JSON case ${index}`, () => {
    const expected = camelResponse(entry.expected as Record<string, unknown>);
    expect({ ...AgentResponse.fromJSON(entry.value) } as unknown).toEqual(
      expected,
    );
    expect({
      ...AgentResponse.fromJSON(JSON.stringify(entry.value)),
    } as unknown).toEqual(expected);
    expect({ ...AgentResponse.fromJSON(expected) } as unknown).toEqual(
      expected,
    );
  });
for (const [index, entry] of goldens.cases.entries())
  it(`replays pinned ordered turn sequence ${index}`, () => {
    const turns = entry.turns.map((value) => new Turn(value));
    expect(turnsToMessages(turns) as unknown).toEqual(entry.messages);
    expect(turnsToMessages(turns, { skipErrors: true }) as unknown).toEqual(
      entry.withoutErrors,
    );
    expect(turns.filter((turn) => turn.errored)).toHaveLength(
      index === 5 ? 1 : 0,
    );
  });
it("loads legacy attacker prompts and preserves finish metadata and target trace handles", () => {
  const turn = new Turn(goldens.legacy.value);
  expect(turn.attacker.text).toBe("Old prompt");
  expect(turn.attacker.finishReason).toBe("length");
  expect(turn.attacker.usage?.totalTokens).toBe(0);
  expect(turn.target.traceId).toBe("trace");
  expect(turn.target.spanId).toBe("span");
  expect(turn.target.responseId).toBe("reply");
  expect(turnsToMessages([turn]) as unknown).toEqual(goldens.legacy.messages);
  expect(Object.isFrozen(turn)).toBe(true);
});
it("preserves response identity, validates malformed records and honors explicit camelCase nulls", () => {
  const response = new AgentResponse({ text: "ok" });
  expect(AgentResponse.fromJSON(response)).toBe(response);
  expect(
    AgentResponse.fromJSON({ text: "ok", traceId: null }).traceId,
  ).toBeNull();
  expect(() =>
    AgentResponse.fromJSON({ text: "ok", traceId: null, trace_id: "legacy" }),
  ).toThrow("Conflicting");
  for (const raw of [
    null,
    [],
    1,
    { usage: "invalid" },
    { text: "both", output: [] },
  ])
    expect(() => AgentResponse.fromJSON(raw)).toThrow();
});
it("preserves recorded totals, flat cached tokens and null costs instead of treating them as a provider reply", () => {
  const response = AgentResponse.fromJSON({
    text: "hi",
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      cached_tokens: 1,
      input_cost: null,
      prompt_cost: 0.05,
      cost_usd: 0.02,
    },
  });
  expect(response.usage).toMatchObject({
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 0,
    cachedTokens: 1,
    inputCost: null,
    totalCost: 0.02,
    calls: 0,
  });
  const cache = AgentResponse.fromJSON({
    usage: { cache_creation_1h_tokens: 4, cache_creation_5m_tokens: 2 },
  });
  expect(cache.usage).toMatchObject({
    cacheCreation1hTokens: 4,
    cacheCreation5mTokens: 2,
  });
});
