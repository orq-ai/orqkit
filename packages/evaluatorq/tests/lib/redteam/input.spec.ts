import { expect, it } from "bun:test";

import {
  inferFramework,
  isModelTargetKind,
  normalizeCategory,
  normalizeFramework,
  parseTarget,
  RedTeamInputSchema,
  RedTeamSampleSchema,
  StaticDatasetSchema,
  SUPPORTED_TARGET_KINDS,
  TargetConfigSchema,
  TargetKind,
} from "../../../src/lib/redteam/index.js";
import fixtures from "../fixtures/redteam-input-python-goldens.json" with {
  type: "json",
};

for (const entry of fixtures.targets)
  it(`matches pinned target parsing for ${JSON.stringify(entry.value)}`, () => {
    if (entry.error) expect(() => parseTarget(entry.value)).toThrow(RangeError);
    else expect(parseTarget(entry.value) as unknown).toEqual(entry.expected);
  });
for (const entry of fixtures.frameworks)
  it(`matches pinned framework normalization for ${JSON.stringify(entry.value)}`, () => {
    if (entry.error) expect(() => normalizeFramework(entry.value)).toThrow();
    else
      expect(normalizeFramework(entry.value) as unknown).toBe(entry.expected);
  });
for (const entry of fixtures.categories)
  it(`matches pinned category inference for ${JSON.stringify(entry.value)}`, () => {
    expect(normalizeCategory(entry.value)).toBe(entry.normalized);
    expect(inferFramework(entry.value)).toBe(entry.inferred);
  });
for (const [index, entry] of fixtures.inputs.entries())
  it(`matches pinned input contract case ${index}`, () => {
    const parsed = RedTeamInputSchema.safeParse(entry.value);
    expect(parsed.success).toBe(!entry.error);
    if (parsed.success) expect(parsed.data as unknown).toEqual(entry.expected);
  });
it("accepts camelCase input and preserves free metadata without mutating its caller", () => {
  const value = {
    id: "case",
    category: "ASI01",
    severity: "high",
    vulnerabilityDomain: "agent",
    turnType: "single",
    source: "fixture",
    deliveryMethod: "unknown-new-method",
    additionalMetadata: { free_key: { untouched_value: 2 } },
  };
  const parsed = RedTeamInputSchema.parse(value);
  expect(parsed).toMatchObject({ ...value, vulnerability: "goal_hijacking" });
  expect(value).not.toHaveProperty("vulnerability");
  expect(parsed.additionalMetadata).toEqual(value.additionalMetadata);
});
it("validates complete static datasets and typed messages", () => {
  const input = fixtures.inputs[0]?.value;
  const dataset = StaticDatasetSchema.parse({
    samples: [
      {
        input,
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"hello"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call", content: "found" },
        ],
      },
    ],
    extra: "ignored",
  });
  expect(dataset.samples[0]?.messages).toHaveLength(3);
  expect(dataset.samples[0]?.input.vulnerability).toBe("goal_hijacking");
  expect(dataset).not.toHaveProperty("extra");
  expect(RedTeamSampleSchema.safeParse({ input, messages: [] }).success).toBe(
    false,
  );
  expect(
    RedTeamSampleSchema.safeParse({
      input,
      messages: [{ role: "invalid", content: "Hi" }],
    }).success,
  ).toBe(false);
  expect(StaticDatasetSchema.safeParse({ samples: [] }).success).toBe(false);
});
it("uses the pinned pipeline target policy and model-kind classification", () => {
  expect(
    Object.fromEntries(
      Object.entries(SUPPORTED_TARGET_KINDS).map(([pipeline, kinds]) => [
        pipeline,
        [...kinds].sort(),
      ]),
    ) as unknown,
  ).toEqual(fixtures.supportedTargets);
  expect(isModelTargetKind(TargetKind.OPENAI)).toBe(true);
  expect(isModelTargetKind(TargetKind.AGENT)).toBe(false);
  expect(isModelTargetKind(TargetKind.DIRECT)).toBe(false);
  expect(Object.isFrozen(SUPPORTED_TARGET_KINDS.static)).toBe(true);
});
it("reads target system prompts in both file conventions", () => {
  expect(TargetConfigSchema.parse({ system_prompt: "Prompt" })).toEqual({
    systemPrompt: "Prompt",
  });
  expect(TargetConfigSchema.parse({ systemPrompt: "Prompt" })).toEqual({
    systemPrompt: "Prompt",
  });
  expect(TargetConfigSchema.parse({})).toEqual({ systemPrompt: null });
});
