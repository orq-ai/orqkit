import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import OpenAI from "openai";
import { z } from "zod/v4";

import {
  executeChatCompletion,
  isBadRequest,
  type NamedSchema,
} from "../../../src/lib/common/llm-call.js";
import {
  clearModelOverrides,
  getModelInfo,
  ModelInfo,
  parseCatalogue,
  priceUsage,
  registerModel,
  resetCatalogueCache,
} from "../../../src/lib/common/model-catalogue.js";
import {
  generateStructured,
  resetStructuredWarnings,
  StructuredGenerationError,
  sumStructuredUsage,
  tokenBudgetForItems,
  usageFromException,
} from "../../../src/lib/common/structured-output.js";
import {
  truncateForSpan,
  withLlmSpan,
  withSpan,
} from "../../../src/lib/common/tracing.js";

interface Scripted {
  status: number;
  body: unknown;
}

let script: Scripted[] = [];
let requests: { path: string; body: Record<string, unknown> }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") {
      return Response.json([]);
    }
    requests.push({
      path: new URL(request.url).pathname.split("/v3/router").at(-1) ?? "",
      body: (await request.json()) as Record<string, unknown>,
    });
    const next = script.shift() ?? { status: 500, body: { error: {} } };
    return Response.json(next.body, { status: next.status });
  },
});

afterAll(() => server.stop(true));

const client = () =>
  new OpenAI({
    apiKey: "k",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 0,
  });

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

const chat = (
  message: Record<string, unknown>,
  finishReason = "stop",
): Scripted => ({
  status: 200,
  body: {
    id: "c",
    object: "chat.completion",
    created: 1,
    model: "served",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", ...message },
      },
    ],
    usage,
  },
});

const rejected: Scripted = {
  status: 400,
  body: { error: { message: "response_format is not supported" } },
};

const Answer = z.object({ answer: z.string() });
const format: NamedSchema<typeof Answer> = { name: "Answer", schema: Answer };
const base = {
  model: "m",
  messages: [{ role: "user", content: "q" }],
  responseFormat: format,
  maxTokens: 100,
  label: "test",
};

beforeEach(() => {
  script = [];
  requests = [];
  resetCatalogueCache();
  clearModelOverrides();
  resetStructuredWarnings();
});

describe("executeChatCompletion", () => {
  const call = (extra: Record<string, unknown> = {}) =>
    executeChatCompletion({
      client: client(),
      model: "m",
      messages: [{ role: "user", content: "q" }],
      span: undefined,
      timeoutMs: 5000,
      ...extra,
    });

  test("sends only the params that are set and reports usage", async () => {
    script = [chat({ content: "hi" })];
    const { response, usage: billed } = await call({
      temperature: null,
      maxTokens: 7,
      tools: [{ type: "function", function: { name: "f" } }],
    });
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(7);
    expect(body.tool_choice).toBe("auto");
    expect(response.choices[0]?.message.content).toBe("hi");
    expect(billed).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  test("extraKwargs cannot override a structural key", async () => {
    await expect(call({ extraKwargs: { messages: [] } })).rejects.toThrow(
      "messages",
    );
    expect(requests).toHaveLength(0);
  });

  test("a 400 surfaces as a bad request", async () => {
    script = [rejected];
    const error = await call().catch((caught: unknown) => caught);
    expect(isBadRequest(error)).toBe(true);
  });
});

describe("generateStructured", () => {
  test("the strict rung parses and bills one call", async () => {
    script = [chat({ content: '{"answer":"yes"}' })];
    const result = await generateStructured(client(), base);
    expect(result.parsed).toEqual({ answer: "yes" });
    expect(result.usage).toMatchObject({ inputTokens: 10, calls: 1 });
    const sent = requests[0]?.body.response_format as {
      type: string;
      json_schema: { strict: boolean; name: string };
    };
    expect(sent.type).toBe("json_schema");
    expect(sent.json_schema).toMatchObject({ name: "Answer", strict: true });
  });

  test("a rejected rung falls through to the next one", async () => {
    script = [rejected, chat({ content: '{"answer":"later"}' })];
    const result = await generateStructured(client(), base);
    expect(result.parsed).toEqual({ answer: "later" });
    expect(requests).toHaveLength(2);
    const second = requests[1]?.body.response_format as {
      json_schema: { strict?: boolean };
    };
    expect(second.json_schema.strict).toBe(false);
  });

  test("the forced tool rung reads the tool arguments", async () => {
    script = [
      rejected,
      rejected,
      chat({
        content: null,
        tool_calls: [
          {
            id: "t",
            type: "function",
            function: { name: "Answer", arguments: '{"answer":"tool"}' },
          },
        ],
      }),
    ];
    const result = await generateStructured(client(), base);
    expect(result.parsed).toEqual({ answer: "tool" });
    expect(requests[2]?.body.tool_choice).toMatchObject({ type: "function" });
  });

  test("a truncated reply fails with the usage it billed", async () => {
    script = [chat({ content: '{"ans' }, "length")];
    const error = await generateStructured(client(), base).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StructuredGenerationError);
    expect(usageFromException(error)).toMatchObject({ inputTokens: 10 });
  });

  test("responses goes first when asked for", async () => {
    script = [rejected, chat({ content: '{"answer":"chat"}' })];
    const result = await generateStructured(client(), {
      ...base,
      api: "responses",
    });
    expect(requests[0]?.path).toBe("/responses");
    expect(requests[1]?.path).toBe("/chat/completions");
    expect(result.parsed).toEqual({ answer: "chat" });
  });

  test("structural keys in extraKwargs are refused before any call", async () => {
    await expect(
      generateStructured(client(), {
        ...base,
        extraKwargs: { response_format: {} },
      }),
    ).rejects.toThrow("response_format");
    expect(requests).toHaveLength(0);
  });

  test("usage helpers sum what billed and size the budget", () => {
    expect(sumStructuredUsage([null, undefined])).toBeNull();
    expect(tokenBudgetForItems(3, { perItem: 100, minimum: 500 })).toBe(500);
    expect(tokenBudgetForItems(30, { perItem: 100, minimum: 500 })).toBe(3000);
  });
});

describe("model catalogue", () => {
  const entries = [
    {
      model_id: "gpt-x",
      provider: "azure",
      model_developer: "openai",
      input_cost: 1,
      output_cost: 2,
    },
    {
      model_id: "gpt-x",
      provider: "openai",
      model_developer: "openai",
      input_cost: 3,
      output_cost: 4,
      metadata: { supports_responses_api: true, supports_classify: true },
      parameters: [
        {
          parameter: "reasoningEffort",
          config: {
            default: "low",
            options: [{ value: "low" }, { value: "high" }],
          },
        },
      ],
    },
    { model_id: 3, provider: "bad" },
  ];

  test("the bare id prefers the developer's own host", () => {
    const models = parseCatalogue(entries);
    expect(models.get("gpt-x")?.inputCostPer1k).toBe(3);
    expect(models.get("azure/gpt-x")?.inputCostPer1k).toBe(1);
    expect(models.get("gpt-x")?.supportsResponses).toBe(true);
    expect(models.get("gpt-x")?.supportsClassify).toBe(true);
    expect(models.get("gpt-x")?.defaultReasoningEffort).toBe("low");
    expect([...(models.get("gpt-x")?.reasoningEfforts ?? [])]).toEqual([
      "low",
      "high",
    ]);
  });

  test("a non-USD price is refused and one rate alone prices nothing", () => {
    const models = parseCatalogue([
      {
        model_id: "eur",
        provider: "p",
        input_cost: 1,
        input_currency: "eur",
        output_cost: 2,
      },
    ]);
    expect(models.get("eur")?.inputCostPer1k).toBeNull();
    expect(models.get("eur")?.outputCostPer1k).toBeNull();
  });

  test("a non-list payload parses to an empty catalogue", () => {
    expect(parseCatalogue({}).size).toBe(0);
  });

  const info = new ModelInfo({
    inputCostPer1k: 1,
    outputCostPer1k: 2,
    provider: "p",
    supportsResponses: false,
  });
  const billed = {
    inputTokens: 1000,
    outputTokens: 500,
    calls: 1,
    totalCost: null,
  };

  test("registerModel overrides the lookup and prices a call", async () => {
    registerModel("priced", info);
    expect(await getModelInfo("priced")).toBe(info);
    const priced = await priceUsage(billed as never, "priced");
    expect(priced).toMatchObject({
      inputCost: 1,
      outputCost: 1,
      totalCost: 2,
      pricedCalls: 1,
    });
  });

  test("usage that is already priced or spans calls stays as it is", async () => {
    registerModel("priced", info);
    const multi = { ...billed, calls: 2 };
    expect(await priceUsage(multi as never, "priced")).toBe(multi as never);
    expect(await priceUsage(null, "priced")).toBeNull();
  });
});

describe("tracing without a tracer", () => {
  test("truncateForSpan leaves text under the limit and stringifies values", () => {
    expect(truncateForSpan("short", 10)).toBe("short");
    expect(truncateForSpan({ a: 1 }, 100)).toContain('"a"');
    expect(truncateForSpan("x".repeat(100), 40).length).toBeLessThanOrEqual(40);
  });

  test("withSpan and withLlmSpan run the callback and return its value", async () => {
    expect(await withSpan("s", {}, async () => 1)).toBe(1);
    expect(await withLlmSpan({ model: "m" }, async () => 2)).toBe(2);
  });

  test("a thrown error reaches the caller once", async () => {
    let runs = 0;
    await expect(
      withLlmSpan({ model: "m" }, async () => {
        runs += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(runs).toBe(1);
  });
});
