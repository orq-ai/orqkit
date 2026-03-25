import { describe, expect, test } from "bun:test";

import type {
  Persona,
  Scenario,
} from "../../../../src/lib/integrations/simulation/types.js";
import {
  buildDatapointSystemPrompt,
  buildPersonaSystemPrompt,
  buildScenarioUserContext,
  generateDatapoint,
} from "../../../../src/lib/integrations/simulation/utils/prompt-builders.js";

const persona: Persona = {
  name: "Impatient User",
  patience: 0.1,
  assertiveness: 0.9,
  politeness: 0.2,
  technical_level: 0.8,
  communication_style: "terse",
  background: "A senior engineer with no time",
  emotional_arc: "escalating",
  cultural_context: "direct",
};

const scenario: Scenario = {
  name: "Refund Request",
  goal: "Get refund for order #123",
  context: "Wrong item shipped",
  starting_emotion: "frustrated",
  criteria: [
    { description: "Agent offers refund", type: "must_happen" },
    { description: "Agent blames customer", type: "must_not_happen" },
  ],
  conversation_strategy: "contradictory",
  input_format: "with_url",
};

describe("buildPersonaSystemPrompt", () => {
  test("includes persona name", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("Impatient User");
  });

  test("maps low patience to 'very impatient'", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("very impatient");
  });

  test("maps high assertiveness to 'very assertive'", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("very assertive");
  });

  test("maps low politeness to 'rude'", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("rude");
  });

  test("maps high technical_level to 'technical expert'", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("technical expert");
  });

  test("includes emotional arc instructions when set", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("Emotional Arc");
    expect(prompt).toContain("escalat");
  });

  test("includes cultural context instructions when set", () => {
    const prompt = buildPersonaSystemPrompt(persona);
    expect(prompt).toContain("Cultural Communication Style");
  });

  test("omits emotional arc for 'stable'", () => {
    const stablePersona = { ...persona, emotional_arc: "stable" as const };
    const prompt = buildPersonaSystemPrompt(stablePersona);
    expect(prompt).not.toContain("Emotional Arc");
  });

  test("omits cultural context for 'neutral'", () => {
    const neutralPersona = {
      ...persona,
      cultural_context: "neutral" as const,
    };
    const prompt = buildPersonaSystemPrompt(neutralPersona);
    expect(prompt).not.toContain("Cultural Communication Style");
  });
});

describe("buildScenarioUserContext", () => {
  test("includes scenario goal", () => {
    const ctx = buildScenarioUserContext(scenario);
    expect(ctx).toContain("Get refund for order #123");
  });

  test("includes must_happen criteria", () => {
    const ctx = buildScenarioUserContext(scenario);
    expect(ctx).toContain("Agent offers refund");
  });

  test("includes must_not_happen criteria", () => {
    const ctx = buildScenarioUserContext(scenario);
    expect(ctx).toContain("Agent blames customer");
  });

  test("includes conversation strategy", () => {
    const ctx = buildScenarioUserContext(scenario);
    expect(ctx).toContain("contradict");
  });

  test("includes input format instructions", () => {
    const ctx = buildScenarioUserContext(scenario);
    expect(ctx).toContain("URL");
  });

  test("handles scenario with no criteria", () => {
    const simple: Scenario = {
      name: "Simple",
      goal: "Get help",
    };
    const ctx = buildScenarioUserContext(simple);
    expect(ctx).toContain("Get help");
  });
});

describe("buildDatapointSystemPrompt", () => {
  test("combines persona and scenario prompts", () => {
    const prompt = buildDatapointSystemPrompt(persona, scenario);
    expect(prompt).toContain("Impatient User");
    expect(prompt).toContain("Get refund for order #123");
    expect(prompt).toContain("---");
  });
});

describe("generateDatapoint", () => {
  test("creates a datapoint with correct structure", () => {
    const dp = generateDatapoint(persona, scenario, "Hello!");
    expect(dp.id).toMatch(/^dp_/);
    expect(dp.persona).toBe(persona);
    expect(dp.scenario).toBe(scenario);
    expect(dp.first_message).toBe("Hello!");
    expect(dp.user_system_prompt).toBeTruthy();
  });

  test("generates unique IDs", () => {
    const dp1 = generateDatapoint(persona, scenario);
    const dp2 = generateDatapoint(persona, scenario);
    expect(dp1.id).not.toBe(dp2.id);
  });

  test("defaults first_message to empty string", () => {
    const dp = generateDatapoint(persona, scenario);
    expect(dp.first_message).toBe("");
  });
});
