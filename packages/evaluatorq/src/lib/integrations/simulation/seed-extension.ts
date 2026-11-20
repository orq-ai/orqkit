import { envRaw } from "../../common/env-config.js";
import { renderTemplate } from "../../common/template-engine.js";
import type { LLMCallConfig } from "../../contracts.js";
import { createRouterClient } from "./client.js";
import { PersonaSchema, ScenarioSchema } from "./contract-schemas.js";
import { DatapointGenerator } from "./generators/datapoint-generator.js";
import type { Datapoint } from "./types.js";

export function requireOrqApiKey(
  apiKey: string | undefined,
  purpose: string,
): string {
  const key = apiKey || envRaw("ORQ_API_KEY");
  if (!key)
    throw new Error(
      `ORQ_API_KEY environment variable is not set. Set it to ${purpose}.`,
    );
  return key;
}
export function describeAgent(seeds: readonly Datapoint[]): string {
  const goals = [
    ...new Set(seeds.map((seed) => seed.scenario.goal).filter(Boolean)),
  ];
  if (!goals.length) {
    console.warn(
      `All ${seeds.length} seed scenario(s) have a blank goal; falling back to a generic agent description for datapoint generation. The generated personas/scenarios will be less targeted.`,
    );
    return "A general-purpose assistant agent; extend the seed personas and scenarios below.";
  }
  return renderTemplate(
    "An agent whose users pursue goals such as: {{goals}}",
    { goals: goals.slice(0, 10).join("; ") },
  );
}
function omitNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, omitNulls(v)]),
    );
  return value;
}
export function seedContext(seeds: readonly Datapoint[]): string {
  const personas = [
    ...new Set(
      seeds.map((seed) =>
        JSON.stringify(omitNulls(PersonaSchema.parse(seed.persona))),
      ),
    ),
  ];
  const scenarios = [
    ...new Set(
      seeds.map((seed) =>
        JSON.stringify(omitNulls(ScenarioSchema.parse(seed.scenario))),
      ),
    ),
  ];
  return [
    "The following personas and scenarios come from a previous run. Generate NEW personas and scenarios in the same domain and style that EXTEND this coverage - do not duplicate or trivially rephrase them.",
    "",
    "Seed personas:",
    ...personas.map((payload) =>
      renderTemplate("- {{persona}}", { persona: payload }),
    ),
    "",
    "Seed scenarios:",
    ...scenarios.map((payload) =>
      renderTemplate("- {{scenario}}", { scenario: payload }),
    ),
  ].join("\n");
}
export interface SeedExtensionOptions {
  numPersonas?: number;
  numScenarios?: number;
  llmConfig?: LLMCallConfig;
  agentDescription?: string;
  apiKey?: string;
}
export async function extendFromSeeds(
  seeds: readonly Datapoint[],
  options: SeedExtensionOptions,
): Promise<Datapoint[]> {
  const numPersonas = options.numPersonas ?? 3,
    numScenarios = options.numScenarios ?? 5;
  if (
    !Number.isInteger(numPersonas) ||
    numPersonas < 1 ||
    !Number.isInteger(numScenarios) ||
    numScenarios < 1
  )
    throw new RangeError(
      "numPersonas and numScenarios must be positive integers",
    );
  const client =
    options.llmConfig?.client ?? createRouterClient(options.apiKey);
  const generator = new DatapointGenerator({
    llmConfig: options.llmConfig,
    client: client as import("openai").default,
  });
  return generator.generateFromDescription({
    agentDescription: options.agentDescription || describeAgent(seeds),
    context: seedContext(seeds),
    numPersonas,
    numScenarios,
  });
}
