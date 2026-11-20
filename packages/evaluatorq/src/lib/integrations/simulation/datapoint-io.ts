import type { z } from "zod/v4";

import { parseJsonOrValue } from "../../common/messages.js";
import { pythonStrip } from "../../common/sanitize.js";
import type { DataPoint } from "../../types.js";
import {
  DatapointSchema,
  PersonaSchema,
  ScenarioSchema,
} from "./contract-schemas.js";
import type { SimulationInput } from "./runner/run-input.js";
import type { Datapoint, Persona, Scenario } from "./types.js";

function persona(value: z.output<typeof PersonaSchema>): Persona {
  return {
    ...value,
    emotional_arc: value.emotional_arc ?? undefined,
    cultural_context: value.cultural_context ?? undefined,
  };
}
function scenario(value: z.output<typeof ScenarioSchema>): Scenario {
  return {
    ...value,
    context: value.context ?? undefined,
    starting_emotion: value.starting_emotion ?? undefined,
    criteria: value.criteria ?? undefined,
    is_edge_case: value.is_edge_case ?? undefined,
    conversation_strategy: value.conversation_strategy ?? undefined,
    ground_truth: value.ground_truth ?? undefined,
    input_format: value.input_format ?? undefined,
  };
}
function shape(
  value: unknown,
  label: string,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected '${label}' to be an object`);
  for (const key of keys)
    if (!Object.hasOwn(value, key))
      throw new Error(`Invalid '${label}': missing required field '${key}'`);
}
function full(value: unknown, label: string): Datapoint {
  shape(value, label, ["persona", "scenario", "first_message"]);
  shape(value.persona, `${label}.persona`, ["name"]);
  shape(value.scenario, `${label}.scenario`, ["name", "goal"]);
  const parsed = DatapointSchema.parse(value);
  return {
    ...parsed,
    persona: persona(parsed.persona),
    scenario: scenario(parsed.scenario),
  };
}

export function extractSingleDatapoint(
  data: DataPoint,
  source = "wrapSimulationAgent DataPoint",
): Datapoint {
  const inputs = data.inputs;
  if (Object.hasOwn(inputs, "datapoint"))
    return full(parseJsonOrValue(inputs.datapoint), "datapoint");
  if (Object.hasOwn(inputs, "datapoints")) {
    const values = parseJsonOrValue(inputs.datapoints);
    if (!Array.isArray(values))
      throw new Error("Expected 'datapoints' to be an array");
    if (values.length !== 1)
      throw new Error(
        `${source} must encode exactly one datapoint, got ${values.length}. Use one row per conversation.`,
      );
    return full(parseJsonOrValue(values[0]), "datapoints[]");
  }
  let p: unknown, s: unknown;
  if (Object.hasOwn(inputs, "persona") && Object.hasOwn(inputs, "scenario")) {
    p = parseJsonOrValue(inputs.persona);
    s = parseJsonOrValue(inputs.scenario);
    shape(p, "persona", ["name"]);
    shape(s, "scenario", ["name", "goal"]);
  } else if (
    Object.hasOwn(inputs, "personas") &&
    Object.hasOwn(inputs, "scenarios")
  ) {
    if (!Array.isArray(inputs.personas) || !Array.isArray(inputs.scenarios))
      throw new Error("Expected 'personas' and 'scenarios' to be arrays");
    if (inputs.personas.length !== 1 || inputs.scenarios.length !== 1)
      throw new Error(
        `${source} must encode exactly one persona-scenario pair, got ${inputs.personas.length} persona(s) x ${inputs.scenarios.length} scenario(s). Use one row per conversation.`,
      );
    [p] = inputs.personas;
    [s] = inputs.scenarios;
    shape(p, "personas[]", ["name"]);
    shape(s, "scenarios[]", ["name", "goal"]);
  } else
    throw new Error(
      "Expected data.inputs to contain 'persona' + 'scenario', 'datapoint', 'datapoints', or 'personas' + 'scenarios'",
    );
  const parsedPersona = persona(PersonaSchema.parse(p));
  const parsedScenario = scenario(ScenarioSchema.parse(s));
  const first = Object.hasOwn(inputs, "first_message")
    ? inputs.first_message
    : "";
  if (typeof first !== "string")
    throw new Error("Expected 'first_message' to be a string");
  return {
    id: `${parsedPersona.name}-${parsedScenario.name}`,
    persona: parsedPersona,
    scenario: parsedScenario,
    user_system_prompt: "",
    first_message: first,
  };
}

export function extractSingleInput(data: DataPoint): SimulationInput {
  const dp = extractSingleDatapoint(data);
  if (
    Object.hasOwn(data.inputs, "datapoint") ||
    Object.hasOwn(data.inputs, "datapoints")
  )
    return { datapoint: dp };
  return {
    persona: dp.persona,
    scenario: dp.scenario,
    firstMessage: pythonStrip(dp.first_message) ? dp.first_message : undefined,
  };
}
