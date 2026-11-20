import { describe, expect, spyOn, test } from "bun:test";

import OpenAI from "openai";

import {
  DatapointGenerator,
  FirstMessageGenerator,
  PersonaGenerator,
  ScenarioGenerator,
  SimulationGenerationError,
} from "../../../../src/lib/integrations/simulation/generators/index.js";
import { isSchemaRejection } from "../../../../src/lib/integrations/simulation/utils/strict-schema.js";
import { expectStrictSchema, makeFakeClient } from "./fake-client.js";

function makeListClient(script: Parameters<typeof makeFakeClient>[0] = {}) {
  return makeFakeClient({
    ...script,
    ...(script.generator
      ? {
          generator: (request, options) => {
            const reply = script.generator?.(request, options) as {
              content: string;
              finishReason?: string;
            };
            try {
              const data: unknown = JSON.parse(reply.content);
              if (Array.isArray(data)) {
                const format = request.response_format as
                  | { json_schema?: { name?: string } }
                  | undefined;
                return {
                  ...reply,
                  content: JSON.stringify({
                    [format?.json_schema?.name ?? "items"]: data,
                  }),
                };
              }
            } catch {}
            return reply;
          },
        }
      : {}),
  });
}

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
  const { client } = makeListClient({
    generator: () => ({ content, finishReason }),
  });
  return new PersonaGenerator({ client });
}

type SchemaNode = {
  enum?: string[];
  type?: string;
  anyOf?: SchemaNode[];
  required?: string[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

const generateOne = (generator: PersonaGenerator) =>
  generator.generate({ agentDescription: "A support bot", numPersonas: 1 });

describe("PersonaGenerator", () => {
  test("reads a Responses structured list and its usage", async () => {
    const { client } = makeFakeClient({
      generator: () => ({
        content: JSON.stringify({ personas: [validPersona] }),
      }),
    });
    const create = spyOn(client.responses, "create");
    const generator = new PersonaGenerator({ client });
    expect((await generateOne(generator))[0]?.name).toBe("Dana");
    const body = create.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("openai/gpt-6-luna");
    expect(body.max_output_tokens).toBe(4000);
    expect(body).not.toHaveProperty("temperature");
    const format = (
      body.text as { format: { strict: boolean; schema: unknown } }
    ).format;
    expect(format.strict).toBe(true);
    expectStrictSchema(format.schema);
    expect(generator.getUsage()?.totalTokens).toBe(2);
  });
  test("rejects malformed Responses output without accepting a fenced bare list", async () => {
    await expect(
      generateOne(personaGenerator("```json\n[]\n```")),
    ).rejects.toThrow(SimulationGenerationError);
  });
  test("rejects truncated output and retains billed usage", async () => {
    const generator = personaGenerator('{"personas": [', "length");
    await expect(generateOne(generator)).rejects.toThrow("token limit");
    expect(generator.getUsage()?.totalTokens).toBe(2);
  });
  test("rejects invalid structured JSON", async () => {
    await expect(generateOne(personaGenerator("sorry, no"))).rejects.toThrow(
      "did not validate",
    );
  });
  test("a non-schema 400 aborts without a fallback", async () => {
    const { client } = makeFakeClient({
      generator: () => {
        throw new OpenAI.APIError(
          400,
          { message: "context too long" },
          "context too long",
          {},
        );
      },
    });
    const create = spyOn(client.responses, "create");
    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "context too long",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("an auth error aborts without a fallback", async () => {
    const { client } = makeFakeClient({
      generator: () => {
        throw new OpenAI.APIError(401, { message: "bad key" }, "bad key", {});
      },
    });
    const create = spyOn(client.responses, "create");
    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "bad key",
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("a schema rejection falls back to the shared chat ladder", async () => {
    const { client, requests } = makeListClient({
      generator: () => ({ content: JSON.stringify([validPersona]) }),
    });
    spyOn(client.responses, "create").mockRejectedValue(
      new OpenAI.APIError(
        400,
        { message: "response_format unsupported" },
        "response_format unsupported",
        {},
      ),
    );
    expect((await generateOne(new PersonaGenerator({ client })))[0]?.name).toBe(
      "Dana",
    );
    expect(requests.generator).toHaveLength(1);
    expect(requests.generator[0]?.response_format?.type).toBe("json_schema");
  });
});

describe("PersonaGenerator traits", () => {
  test("rejects a structured list containing an invalid trait", async () => {
    await expect(
      generateOne(
        personaGenerator(
          JSON.stringify([
            { ...validPersona, name: "Bad", patience: "high" },
            validPersona,
          ]),
        ),
      ),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test.each([
    ["a missing trait", { patience: undefined }],
    ["a blank trait", { patience: "" }],
    ["a list as a trait", { patience: [] }],
    ["a missing style", { communication_style: undefined }],
    ["an unknown style", { communication_style: "shouty" }],
    ["a missing background", { background: undefined }],
  ])("rejects a persona with %s", async (_label, bad) => {
    await expect(
      generateOne(
        personaGenerator(
          JSON.stringify([
            { ...validPersona, name: "Bad", ...bad },
            validPersona,
          ]),
        ),
      ),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test("preserves a numeric trait outside the conventional range, as Python does", async () => {
    const [persona] = await generateOne(
      personaGenerator(JSON.stringify([{ ...validPersona, patience: 7 }])),
    );

    expect(persona?.patience).toBe(7);
  });

  test("asks the model for every required field", async () => {
    const { client, requests } = makeListClient({
      generator: () => ({ content: JSON.stringify([validPersona]) }),
    });
    await generateOne(new PersonaGenerator({ client }));

    expect(JSON.stringify(requests.generator[0]?.response_format)).toContain(
      '"emotional_arc"',
    );
  });

  test("uses the shared transport timeout instead of an SDK retry budget", async () => {
    let timeout: number | undefined;
    const { client } = makeListClient({
      generator: (_request, options) => {
        timeout = options?.timeout;
        return { content: JSON.stringify([validPersona]) };
      },
    });
    await generateOne(new PersonaGenerator({ client }));

    expect(timeout).toBeUndefined();
  });
});

describe("generator token budgets", () => {
  const description = { agentDescription: "A support bot" };
  const budget = async (
    call: (client: OpenAI) => Promise<unknown>,
  ): Promise<number | null | undefined> => {
    const { client, requests } = makeFakeClient();
    await call(client).catch(() => undefined);
    return requests.generator[0]?.max_tokens;
  };
  const scenarios = (client: OpenAI) => new ScenarioGenerator({ client });
  const personas = (client: OpenAI) => new PersonaGenerator({ client });

  test.each([
    ["generate", 1, 4000],
    ["generate", 20, 12000],
    ["generateWithCoverage", 1, 4000],
    ["generateWithCoverage", 20, 12000],
  ] as const)("personas %s n=%d asks for %d", async (method, count, want) => {
    const got = await budget((client) =>
      personas(client)[method]({ ...description, numPersonas: count }),
    );
    expect(got).toBe(want);
  });

  test.each([
    ["generate", 1, 6000],
    ["generate", 20, 10000],
    ["generateWithCoverage", 1, 6000],
    ["generateWithCoverage", 20, 10000],
    ["generateBoundaryScenarios", 1, 6000],
    ["generateBoundaryScenarios", 20, 10000],
    ["generateSecurityScenarios", 1, 6000],
    ["generateSecurityScenarios", 20, 10000],
  ] as const)("scenarios %s n=%d asks for %d", async (method, count, want) => {
    const got = await budget((client) =>
      scenarios(client)[method]({ ...description, numScenarios: count }),
    );
    expect(got).toBe(want);
  });

  test.each([
    [1, 6000],
    [20, 10000],
  ])("scenarios generateEdgeCases n=%d asks for %d", async (count, want) => {
    const got = await budget((client) =>
      scenarios(client).generateEdgeCases({
        ...description,
        numEdgeCases: count,
      }),
    );
    expect(got).toBe(want);
  });
});

describe("ScenarioGenerator criteria", () => {
  const generate = (criteria: unknown) => {
    const { client } = makeListClient({
      generator: () => ({
        content: JSON.stringify([{ name: "S", goal: "G", criteria }]),
      }),
    });
    return new ScenarioGenerator({ client }).generate({
      agentDescription: "A support bot",
      numScenarios: 1,
    });
  };

  test("keeps a scenario with valid criteria", async () => {
    const [scenario] = await generate([
      { description: "offers a refund", type: "must_happen" },
    ]);
    expect(scenario?.criteria).toHaveLength(1);
  });

  test.each([
    ["an unknown type", { description: "offers a refund", type: "should" }],
  ])("drops a scenario with a criterion of %s", async (_label, bad) => {
    await expect(
      generate([{ description: "fine", type: "must_happen" }, bad]),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test("preserves an empty criterion description, as Python does", async () => {
    expect(
      (await generate([{ description: "  ", type: "must_happen" }]))[0]
        ?.criteria?.[0]?.description,
    ).toBe("  ");
  });

  test.each([
    ["an object", { description: "x", type: "must_happen" }],
    ["a string", "x"],
  ])("drops a scenario whose criteria is %s", async (_label, bad) => {
    await expect(generate(bad)).rejects.toThrow(SimulationGenerationError);
  });

  test("keeps a scenario with no criteria key", async () => {
    const [scenario] = await generate(undefined);
    expect(scenario?.criteria).toEqual([]);
  });

  const generateWith = (extra: Record<string, unknown>) => {
    const { client } = makeListClient({
      generator: () => ({
        content: JSON.stringify([{ name: "S", goal: "G", ...extra }]),
      }),
    });
    return new ScenarioGenerator({ client }).generate({
      agentDescription: "A support bot",
      numScenarios: 1,
    });
  };

  test.each([
    ["emotion", { starting_emotion: "furious-ish" }],
    ["strategy", { conversation_strategy: "chaotic-ish" }],
  ])("drops a scenario with an unknown %s", async (_label, bad) => {
    await expect(generateWith(bad)).rejects.toThrow(SimulationGenerationError);
  });

  test("leaves a missing emotion and strategy unset", async () => {
    const [scenario] = await generateWith({});
    expect(scenario?.starting_emotion).toBeUndefined();
    expect(scenario?.conversation_strategy).toBeUndefined();
  });

  test("asks the model for criteria", async () => {
    const { client, requests } = makeListClient({
      generator: () => ({
        content: JSON.stringify([{ name: "S", goal: "G", criteria: [] }]),
      }),
    });
    await new ScenarioGenerator({ client }).generate({
      agentDescription: "A support bot",
      numScenarios: 1,
    });

    expect(JSON.stringify(requests.generator[0]?.response_format)).toContain(
      '"ground_truth"',
    );
  });

  test("asks for a strict schema every model can enforce", async () => {
    const { client, requests } = makeListClient({
      generator: () => ({
        content: JSON.stringify([{ name: "S", goal: "G", criteria: [] }]),
      }),
    });
    await new ScenarioGenerator({ client }).generate({
      agentDescription: "A support bot",
      numScenarios: 1,
    });

    const format = requests.generator[0]?.response_format as {
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(format.json_schema.name).toBe("scenarios");
    expect(format.json_schema.strict).toBe(true);
    expectStrictSchema(format.json_schema.schema);

    const item = (format.json_schema.schema as SchemaNode).properties?.scenarios
      ?.items;
    const criterion = item?.properties?.criteria?.anyOf?.find(
      (node) => node.type === "array",
    )?.items;
    expect(item?.required).toContain("criteria");
    expect(criterion?.properties?.type?.enum).toEqual([
      "must_happen",
      "must_not_happen",
    ]);
    expect(
      criterion?.properties?.evaluator?.anyOf?.map((option) => option.type),
    ).toEqual(["string", "null"]);
  });

  test("reads a null strategy and evaluator as unset", async () => {
    const [scenario] = await generateWith({
      context: "Bought headphones",
      starting_emotion: "neutral",
      is_edge_case: false,
      conversation_strategy: null,
      criteria: [
        {
          description: "offers a refund",
          type: "must_happen",
          evaluator: null,
        },
      ],
    });

    expect(scenario?.conversation_strategy).toBeUndefined();
    expect(scenario?.criteria?.[0]?.evaluator).toBeNull();
  });

  test("rejects an evaluator that is not a string", async () => {
    await expect(
      generateWith({
        criteria: [
          { description: "offers a refund", type: "must_happen", evaluator: 5 },
        ],
      }),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test("carries ground truth and input format into generated scenarios", async () => {
    const [scenario] = await generateWith({
      ground_truth: "The refund is 10 EUR",
      input_format: "form_data",
    });
    expect(scenario?.ground_truth).toBe("The refund is 10 EUR");
    expect(scenario?.input_format).toBe("form_data");
  });
});

describe("ScenarioGenerator", () => {
  test("raises instead of returning a default scenario", async () => {
    const { client } = makeListClient({
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
  test("uses the shared transport timeout instead of an SDK retry budget", async () => {
    let timeout: number | undefined;
    const { client } = makeListClient({
      firstMessage: (_request, options) => {
        timeout = options?.timeout;
        return "Hello";
      },
    });
    await new FirstMessageGenerator({ client }).generate(persona, scenario);

    expect(timeout).toBeUndefined();
  });

  test("raises instead of falling back to a generic opener", async () => {
    const { client } = makeListClient({ firstMessage: () => "   " });

    await expect(
      new FirstMessageGenerator({ client }).generate(persona, scenario),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test("retries an empty reply", async () => {
    const replies = ["  ", "", "Hi there"];
    const { client, requests } = makeListClient({
      firstMessage: () => replies.shift() ?? "",
    });

    const message = await new FirstMessageGenerator({ client }).generate(
      persona,
      scenario,
    );

    expect(message).toBe("Hi there");
    expect(requests.firstMessage).toHaveLength(3);
  });

  test("gives up after three empty replies", async () => {
    const { client, requests } = makeListClient({ firstMessage: () => "" });

    await expect(
      new FirstMessageGenerator({ client }).generate(persona, scenario),
    ).rejects.toThrow(SimulationGenerationError);
    expect(requests.firstMessage).toHaveLength(3);
  });

  test("raises on truncation without retrying", async () => {
    const { client, requests } = makeListClient({
      firstMessage: () => ({ content: "Hi, I wan", finishReason: "length" }),
    });

    await expect(
      new FirstMessageGenerator({ client }).generate(persona, scenario),
    ).rejects.toThrow("truncated");
    expect(requests.firstMessage).toHaveLength(1);
  });
});

describe("DatapointGenerator.generateFromCombinations", () => {
  const scenarios = [
    { name: "A", goal: "Goal A", criteria: [] },
    { name: "B", goal: "Goal B", criteria: [] },
  ];
  const generatorWith = (firstMessage: (scenario: string) => string) => {
    const { client } = makeFakeClient();
    const generator = new DatapointGenerator({ client, rateLimitDelay: 0 });
    const first = (
      generator as unknown as { firstMessageGenerator: FirstMessageGenerator }
    ).firstMessageGenerator;
    spyOn(first, "generate").mockImplementation(async (_persona, scenario) => {
      const text = firstMessage(scenario.name);
      if (!text) throw new SimulationGenerationError("empty message");
      return text;
    });
    return generator;
  };

  test("drops a pair with no usable first message and keeps the rest", async () => {
    const datapoints = await generatorWith((name) =>
      name === "A" ? "" : "Hello",
    ).generateFromCombinations([persona], scenarios);

    expect(datapoints.map((dp) => dp.scenario.name)).toEqual(["B"]);
  });

  test("raises when every pair failed", async () => {
    await expect(
      generatorWith(() => "").generateFromCombinations([persona], scenarios),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test.each([429, 503])(
    "a %d from the provider drops only that pair",
    async (status) => {
      const generator = generatorWith((name) => {
        if (name === "A") {
          throw new OpenAI.APIError(status, { message: "busy" }, "busy", {});
        }
        return "Hello";
      });

      const datapoints = await generator.generateFromCombinations(
        [persona],
        scenarios,
      );

      expect(datapoints.map((dp) => dp.scenario.name)).toEqual(["B"]);
    },
  );

  test("an unexpected error aborts the batch", async () => {
    const generator = generatorWith((name) => {
      if (name === "A") {
        throw new TypeError("bug in the prompt builder");
      }
      return "Hello";
    });

    await expect(
      generator.generateFromCombinations([persona], scenarios),
    ).rejects.toThrow("bug in the prompt builder");
  });

  test("an auth error aborts the batch", async () => {
    const generator = generatorWith((name) => {
      if (name === "A") {
        throw new OpenAI.APIError(401, { message: "bad key" }, "bad key", {});
      }
      return "Hello";
    });

    await expect(
      generator.generateFromCombinations([persona], scenarios),
    ).rejects.toThrow("bad key");
  });
});

describe("isSchemaRejection", () => {
  const apiError = (status: number, message: string) =>
    new OpenAI.APIError(status, { message }, message, {});

  test.each([
    "Invalid schema for response_format 'item': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    "[openai] Invalid schema for function 'finish': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    "[anthropic] tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
    "response_format is not supported by this model",
    "This model does not support structured outputs",
    "'strict' is not a permitted parameter",
    "Schema keyword 'minimum' is not supported",
    "anyOf is not allowed at this location",
  ])("a 400 saying %s is a rejection", (message) => {
    expect(isSchemaRejection(apiError(400, message))).toBe(true);
  });

  test.each([
    "This model's maximum context length is 8192 tokens",
    "Unsupported value: 'temperature' does not support 0.2",
    "unsupported",
    "Model x is restricted for this workspace",
  ])("a 400 saying %s is not", (message) => {
    expect(isSchemaRejection(apiError(400, message))).toBe(false);
  });

  test("other statuses and errors are not", () => {
    expect(isSchemaRejection(apiError(500, "Invalid schema"))).toBe(false);
    expect(isSchemaRejection(new Error("Invalid schema"))).toBe(false);
  });
});
