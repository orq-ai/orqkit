/**
 * Prompt building utilities for personas, scenarios, and datapoints.
 *
 * These are the TypeScript equivalents of:
 * - Python Persona.to_system_prompt()
 * - Python Scenario.to_user_context()
 * - Python Datapoint.generate() / Datapoint._build_system_prompt()
 */

import type { Datapoint, Persona, Scenario } from "../types.js";
import {
  CULTURAL_CONTEXT_INSTRUCTIONS,
  EMOTIONAL_ARC_INSTRUCTIONS,
  INPUT_FORMAT_INSTRUCTIONS,
  STRATEGY_INSTRUCTIONS,
} from "../types.js";
import { delimit } from "./sanitize.js";

// ---------------------------------------------------------------------------
// Persona → system prompt
// ---------------------------------------------------------------------------

/**
 * Convert a persona to a system prompt for the user simulator.
 *
 * Mirrors Python `Persona.to_system_prompt()`.
 */
export function buildPersonaSystemPrompt(persona: Persona): string {
  const patienceDesc =
    persona.patience < 0.3
      ? "very impatient"
      : persona.patience > 0.7
        ? "patient"
        : "moderately patient";

  const assertiveDesc =
    persona.assertiveness > 0.7
      ? "very assertive and direct"
      : persona.assertiveness < 0.3
        ? "passive"
        : "balanced";

  const politeDesc =
    persona.politeness < 0.3
      ? "rude and curt"
      : persona.politeness > 0.7
        ? "very polite"
        : "neutral in tone";

  const techDesc =
    persona.technical_level < 0.3
      ? "a complete novice"
      : persona.technical_level > 0.7
        ? "a technical expert"
        : "somewhat technical";

  let arcText = "";
  const arcKey = persona.emotional_arc ?? "stable";
  const arcInstruction = EMOTIONAL_ARC_INSTRUCTIONS[arcKey];
  if (arcInstruction) {
    arcText = `\n\nEmotional Arc: ${arcInstruction}`;
  }

  let culturalText = "";
  const culturalKey = persona.cultural_context ?? "neutral";
  const culturalInstruction = CULTURAL_CONTEXT_INSTRUCTIONS[culturalKey];
  if (culturalInstruction) {
    culturalText = `\n\nCultural Communication Style: ${culturalInstruction}`;
  }

  return `You are simulating a user with the following characteristics:

Name: ${delimit(persona.name)}
Patience: You are ${patienceDesc}
Assertiveness: You are ${assertiveDesc}
Politeness: You are ${politeDesc}
Technical Level: You are ${techDesc}
Communication Style: ${delimit(persona.communication_style)}

Background: ${delimit(persona.background)}
${arcText}${culturalText}
Stay in character throughout the conversation. Your responses should reflect these traits consistently.
Do not break character or acknowledge that you are a simulation.`;
}

// ---------------------------------------------------------------------------
// Scenario → user context
// ---------------------------------------------------------------------------

const EMOTION_INSTRUCTIONS: Record<string, string> = {
  neutral: "You approach this conversation calmly.",
  frustrated: "You are frustrated and may express irritation.",
  confused: "You are confused and may ask for clarification.",
  happy: "You are in a good mood and friendly.",
  urgent: "This is urgent and you need a quick resolution.",
};

/**
 * Convert a scenario to context for the user simulator.
 *
 * Mirrors Python `Scenario.to_user_context()`.
 */
export function buildScenarioUserContext(scenario: Scenario): string {
  let criteriaText = "";
  if (scenario.criteria && scenario.criteria.length > 0) {
    const mustHappen = scenario.criteria
      .filter((c) => c.type === "must_happen")
      .map((c) => delimit(c.description));
    const mustNot = scenario.criteria
      .filter((c) => c.type === "must_not_happen")
      .map((c) => delimit(c.description));

    if (mustHappen.length > 0) {
      criteriaText += `\n\nYou expect the agent to: ${mustHappen.join(", ")}`;
    }
    if (mustNot.length > 0) {
      criteriaText += `\n\nYou would be dissatisfied if: ${mustNot.join(", ")}`;
    }
  }

  let strategyText = "";
  const strategyKey = scenario.conversation_strategy ?? "cooperative";
  const strategyInstruction = STRATEGY_INSTRUCTIONS[strategyKey];
  if (strategyInstruction) {
    strategyText = `\n\nConversation Strategy: ${strategyInstruction}`;
  }

  let formatText = "";
  const formatKey = scenario.input_format ?? "plain_text";
  const formatInstruction = INPUT_FORMAT_INSTRUCTIONS[formatKey];
  if (formatInstruction) {
    formatText = `\n\nMessage Format: ${formatInstruction}`;
  }

  const emotionText =
    EMOTION_INSTRUCTIONS[scenario.starting_emotion ?? "neutral"] ?? "";

  return `Scenario: ${delimit(scenario.name)}

Your Goal: ${delimit(scenario.goal)}

Context: ${delimit(scenario.context ?? "")}

Emotional State: ${emotionText}
${criteriaText}${strategyText}${formatText}

Work towards your goal naturally. React authentically based on how the agent responds.`;
}

// ---------------------------------------------------------------------------
// Datapoint helpers
// ---------------------------------------------------------------------------

/**
 * Build the combined system prompt from persona and scenario.
 *
 * Mirrors Python `Datapoint._build_system_prompt()`.
 */
export function buildDatapointSystemPrompt(
  persona: Persona,
  scenario: Scenario,
): string {
  const personaPrompt = buildPersonaSystemPrompt(persona);
  const scenarioContext = buildScenarioUserContext(scenario);

  return `${personaPrompt}\n\n---\n\n${scenarioContext}`;
}

/**
 * Generate a datapoint from persona and scenario.
 *
 * Mirrors Python `Datapoint.generate()`.
 */
export function generateDatapoint(
  persona: Persona,
  scenario: Scenario,
  firstMessage = "",
): Datapoint {
  return {
    id: `dp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    persona,
    scenario,
    user_system_prompt: buildDatapointSystemPrompt(persona, scenario),
    first_message: firstMessage,
  };
}
