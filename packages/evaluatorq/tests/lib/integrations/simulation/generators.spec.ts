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

type SchemaNode = {
  enum?: string[];
  anyOf?: { type: string }[];
  required?: string[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

const REJECTED_SCHEMA =
  "Invalid schema for response_format 'personas': In context=(), 'additionalProperties' is required to be supplied and to be false.";

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

  const rejectingClient = (
    rejects: (
      format: { json_schema?: { strict?: boolean } } | undefined,
    ) => boolean,
  ) => {
    const seen: (
      | { json_schema?: { strict?: boolean; schema?: unknown } }
      | undefined
    )[] = [];
    const timeouts: unknown[] = [];
    const create = async (
      request: { response_format?: { json_schema?: { strict?: boolean } } },
      options: { timeout?: number },
    ) => {
      seen.push(request.response_format);
      timeouts.push(options.timeout);
      if (rejects(request.response_format)) {
        throw new OpenAI.APIError(
          400,
          { message: REJECTED_SCHEMA },
          REJECTED_SCHEMA,
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
    return { client, seen, timeouts };
  };

  test("stops at the strict schema when the model accepts it", async () => {
    const { client, seen } = rejectingClient(() => false);

    await generateOne(new PersonaGenerator({ client }));

    expect(seen.map((format) => format?.json_schema?.strict)).toEqual([true]);
  });

  test("a 400 on strict retries with the same schema, not strict", async () => {
    const { client, seen } = rejectingClient(
      (format) => format?.json_schema?.strict === true,
    );

    const personas = await generateOne(new PersonaGenerator({ client }));

    expect(personas).toHaveLength(1);
    expect(seen.map((format) => format?.json_schema?.strict)).toEqual([
      true,
      false,
    ]);
    expect(seen[1]?.json_schema?.schema).toEqual(seen[0]?.json_schema?.schema);
  });

  test("a 400 on any schema retries without response_format", async () => {
    const { client, seen, timeouts } = rejectingClient(
      (format) => format !== undefined,
    );

    const personas = await generateOne(new PersonaGenerator({ client }));

    expect(personas).toHaveLength(1);
    expect(seen.map((format) => format?.json_schema?.strict)).toEqual([
      true,
      false,
      undefined,
    ]);
    expect(seen[2]).toBeUndefined();
    expect(timeouts).toEqual([300_000, 300_000, 300_000]);
  });

  test("a 400 with no response_format raises", async () => {
    const { client, seen } = rejectingClient(() => true);

    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "Invalid schema",
    );
    expect(seen).toHaveLength(3);
  });

  test("a 400 that does not name the schema raises without a retry", async () => {
    const seen: unknown[] = [];
    const message = "This model's maximum context length is 8192 tokens";
    const create = async (request: { response_format?: unknown }) => {
      seen.push(request.response_format);
      throw new OpenAI.APIError(400, { message }, message, {});
    };
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "maximum context length",
    );
    expect(seen).toHaveLength(1);
  });

  test("a step down names the reason in a warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { client } = rejectingClient(
      (format) => format?.json_schema?.strict === true,
    );

    await generateOne(new PersonaGenerator({ client }));

    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "retrying without strict",
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain("Invalid schema");
    warn.mockRestore();
  });

  test("an error other than a 400 on the second step raises", async () => {
    const seen: unknown[] = [];
    const create = async (request: {
      response_format?: { json_schema?: { strict?: boolean } };
    }) => {
      seen.push(request.response_format);
      if (request.response_format?.json_schema?.strict) {
        throw new OpenAI.APIError(
          400,
          { message: REJECTED_SCHEMA },
          REJECTED_SCHEMA,
          {},
        );
      }
      throw new OpenAI.APIError(500, { message: "boom" }, "boom", {});
    };
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "boom",
    );
    expect(seen).toHaveLength(2);
  });

  test("a refusal is reported as a refusal, not as an empty response", async () => {
    const create = async () => ({
      choices: [
        {
          finish_reason: "stop",
          message: { content: null, refusal: "I cannot write these" },
        },
      ],
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "model refused: I cannot write these",
    );
  });

  test("an error other than a 400 raises without a retry", async () => {
    const seen: unknown[] = [];
    const create = async (request: { response_format?: unknown }) => {
      seen.push(request.response_format);
      throw new OpenAI.APIError(500, { message: "boom" }, "boom", {});
    };
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await expect(generateOne(new PersonaGenerator({ client }))).rejects.toThrow(
      "boom",
    );
    expect(seen).toHaveLength(1);
  });

  test("asks for a strict schema every model can enforce", async () => {
    const { client, requests } = makeFakeClient({
      generator: () => ({ content: JSON.stringify([validPersona]) }),
    });
    await generateOne(new PersonaGenerator({ client }));

    const format = requests.generator[0]?.response_format as {
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(format.json_schema.name).toBe("personas");
    expect(format.json_schema.strict).toBe(true);
    expectStrictSchema(format.json_schema.schema);

    const item = (format.json_schema.schema as SchemaNode).properties?.personas
      ?.items;
    expect(item?.properties?.communication_style?.enum).toEqual([
      "formal",
      "casual",
      "terse",
      "verbose",
    ]);
  });
});

describe("PersonaGenerator traits", () => {
  test("drops a persona whose trait is not a number", async () => {
    const generator = personaGenerator(
      JSON.stringify([
        { ...validPersona, name: "Bad", patience: "high" },
        validPersona,
      ]),
    );

    const personas = await generateOne(generator);

    expect(personas.map((p) => p.name)).toEqual(["Dana"]);
    expect(personas[0]?.patience).toBe(0.5);
  });

  test.each([
    ["a missing trait", { patience: undefined }],
    ["a blank trait", { patience: "" }],
    ["a list as a trait", { patience: [] }],
    ["a missing style", { communication_style: undefined }],
    ["an unknown style", { communication_style: "shouty" }],
    ["a missing background", { background: undefined }],
  ])("drops a persona with %s", async (_label, bad) => {
    const personas = await generateOne(
      personaGenerator(
        JSON.stringify([
          { ...validPersona, name: "Bad", ...bad },
          validPersona,
        ]),
      ),
    );

    expect(personas.map((p) => p.name)).toEqual(["Dana"]);
  });

  test("clamps a trait out of range", async () => {
    const [persona] = await generateOne(
      personaGenerator(JSON.stringify([{ ...validPersona, patience: 7 }])),
    );

    expect(persona?.patience).toBe(1);
  });

  test("asks the model for every required field", async () => {
    const { client, requests } = makeFakeClient({
      generator: () => ({ content: JSON.stringify([validPersona]) }),
    });
    await generateOne(new PersonaGenerator({ client }));

    expect(JSON.stringify(requests.generator[0]?.response_format)).toContain(
      '"required":["name","patience","assertiveness","politeness","technical_level","communication_style","background"]',
    );
  });

  test("bounds the call with a timeout", async () => {
    let timeout: number | undefined;
    const { client } = makeFakeClient({
      generator: (_request, options) => {
        timeout = options?.timeout;
        return { content: JSON.stringify([validPersona]) };
      },
    });
    await generateOne(new PersonaGenerator({ client }));

    expect(timeout).toBe(300_000);
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
    const { client } = makeFakeClient({
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
    ["an empty description", { description: "  ", type: "must_happen" }],
  ])("drops a scenario with a criterion of %s", async (_label, bad) => {
    await expect(
      generate([{ description: "fine", type: "must_happen" }, bad]),
    ).rejects.toThrow(SimulationGenerationError);
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
    const { client } = makeFakeClient({
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
    const { client, requests } = makeFakeClient({
      generator: () => ({
        content: JSON.stringify([{ name: "S", goal: "G", criteria: [] }]),
      }),
    });
    await new ScenarioGenerator({ client }).generate({
      agentDescription: "A support bot",
      numScenarios: 1,
    });

    expect(JSON.stringify(requests.generator[0]?.response_format)).toContain(
      '"required":["name","goal","context","starting_emotion","criteria","is_edge_case","conversation_strategy"]',
    );
  });

  test("asks for a strict schema every model can enforce", async () => {
    const { client, requests } = makeFakeClient({
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
    const criterion = item?.properties?.criteria?.items;
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

  test("reads an evaluator that is not a string as unset", async () => {
    const [scenario] = await generateWith({
      criteria: [
        { description: "offers a refund", type: "must_happen", evaluator: 5 },
      ],
    });

    expect(scenario?.criteria?.[0]?.evaluator).toBeNull();
  });

  test("gives the model the allowed emotions and strategies", async () => {
    const { client, requests } = makeFakeClient({
      generator: () => ({
        content: JSON.stringify([{ name: "S", goal: "G", criteria: [] }]),
      }),
    });
    await new ScenarioGenerator({ client }).generate({
      agentDescription: "A support bot",
      numScenarios: 1,
    });

    const schema = JSON.stringify(requests.generator[0]?.response_format);
    expect(schema).toContain(
      '"starting_emotion":{"type":"string","enum":["neutral","frustrated","confused","happy","urgent"]}',
    );
    expect(schema).toContain(
      '"conversation_strategy":{"anyOf":[{"type":"string","enum":["cooperative","topic_switching","contradictory","multi_intent","evasive","repetitive","ambiguous"]},{"type":"null"}]}',
    );
  });

  test("names the rejected value when it drops a scenario", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await generateWith({ starting_emotion: "disappointed" }).catch(() => {});
      expect(warn.mock.calls.flat().join(" ")).toContain("disappointed");
    } finally {
      warn.mockRestore();
    }
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
  test("bounds the call with a timeout", async () => {
    let timeout: number | undefined;
    const { client } = makeFakeClient({
      firstMessage: (_request, options) => {
        timeout = options?.timeout;
        return "Hello";
      },
    });
    await new FirstMessageGenerator({ client }).generate(persona, scenario);

    expect(timeout).toBe(60_000);
  });

  test("raises instead of falling back to a generic opener", async () => {
    const { client } = makeFakeClient({ firstMessage: () => "   " });

    await expect(
      new FirstMessageGenerator({ client }).generate(persona, scenario),
    ).rejects.toThrow(SimulationGenerationError);
  });

  test("retries an empty reply", async () => {
    const replies = ["  ", "", "Hi there"];
    const { client, requests } = makeFakeClient({
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
    const { client, requests } = makeFakeClient({ firstMessage: () => "" });

    await expect(
      new FirstMessageGenerator({ client }).generate(persona, scenario),
    ).rejects.toThrow(SimulationGenerationError);
    expect(requests.firstMessage).toHaveLength(3);
  });

  test("raises on truncation without retrying", async () => {
    const { client, requests } = makeFakeClient({
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
    const { client } = makeFakeClient({
      firstMessage: (request) =>
        firstMessage(
          String(request.messages[1]?.content).includes("Goal A") ? "A" : "B",
        ),
    });
    return new DatapointGenerator({ client, rateLimitDelay: 0 });
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
