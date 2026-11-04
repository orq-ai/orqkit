import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import {
  FirstMessageGenerator,
  PersonaGenerator,
  ScenarioGenerator,
  SimulationGenerationError,
} from "../../../../src/lib/integrations/simulation/generators/index.js";
import { makeFakeClient } from "./fake-client.js";

const validPersona = {
  name: "Dana",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual",
  background: "A customer",
};

const persona = {
  name: "Dana",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual" as const,
  background: "A customer",
};

const scenario = { name: "Refund", goal: "Get a refund", criteria: [] };

function personaGenerator(content: string, finishReason?: string) {
  const { client } = makeFakeClient({
    generator: () => ({ content, finishReason }),
  });
  return new PersonaGenerator({ client });
}

const generateOne = (generator: PersonaGenerator) =>
  generator.generate({ agentDescription: "A support bot", numPersonas: 1 });

describe("PersonaGenerator", () => {
  test("parses a list wrapped in an object", async () => {
    const personas = await generateOne(
      personaGenerator(JSON.stringify({ personas: [validPersona] })),
    );
    expect(personas[0]?.name).toBe("Dana");
  });

  test("parses a bare list inside a code fence", async () => {
    const personas = await generateOne(
      personaGenerator(`\`\`\`json\n${JSON.stringify([validPersona])}\n\`\`\``),
    );
    expect(personas[0]?.name).toBe("Dana");
  });

  test("raises on truncation instead of parsing a partial list", async () => {
    await expect(
      generateOne(personaGenerator('{"personas": [', "length")),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test("raises on empty content", async () => {
    await expect(generateOne(personaGenerator("  "))).rejects.toThrow(
      "empty response",
    );
  });

  test("raises on content that is not JSON", async () => {
    await expect(generateOne(personaGenerator("sorry, no"))).rejects.toThrow(
      "not valid JSON",
    );
  });

  test("raises when every item is unusable", async () => {
    await expect(generateOne(personaGenerator("[1, 2]"))).rejects.toThrow(
      SimulationGenerationError,
    );
  });

  test("retries once without response_format on a 400", async () => {
    const seen: unknown[] = [];
    const create = async (request: { response_format?: unknown }) => {
      seen.push(request.response_format);
      if (request.response_format) {
        throw new OpenAI.APIError(
          400,
          { message: "unsupported" },
          "unsupported",
          {},
        );
      }
      return {
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify([validPersona]) },
          },
        ],
      };
    };
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const personas = await generateOne(new PersonaGenerator({ client }));

    expect(personas).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeUndefined();
  });
});

describe("ScenarioGenerator", () => {
  test("raises instead of returning a default scenario", async () => {
    const { client } = makeFakeClient({
      generator: () => ({ content: "[]" }),
    });

    await expect(
      new ScenarioGenerator({ client }).generate({
        agentDescription: "A support bot",
        numScenarios: 1,
      }),
    ).rejects.toThrow(SimulationGenerationError);
  });
});

describe("FirstMessageGenerator", () => {
  test("raises instead of falling back to a generic opener", async () => {
    const { client } = makeFakeClient({ firstMessage: () => "   " });

    await expect(
      new FirstMessageGenerator({ client }).generate(persona, scenario),
    ).rejects.toThrow(SimulationGenerationError);
  });
});
