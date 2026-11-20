import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import OpenAI from "openai";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
  resetCatalogueCache,
} from "../../../src/lib/common/model-catalogue.js";
import { LLMCallConfig } from "../../../src/lib/contracts.js";
import {
  COMPILER_INSTRUCTIONS,
  CompiledPlan,
  CompileError,
  compileQuery,
} from "../../../src/lib/trace-finder/compiler.js";
import {
  FilterSelectionError,
  selectFiltersWithResponse,
  selectLlmFiltersWithResponse,
} from "../../../src/lib/trace-finder/filter-selector.js";
import {
  FacetCatalogueSchema,
  NumericFilters,
} from "../../../src/lib/trace-finder/models.js";

const model = "acme/trace-query",
  now = "2026-11-10T12:00:00Z";
let script: { status: number; body: unknown }[] = [],
  requests: { path: string; body: Record<string, unknown> }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json([]);
    requests.push({
      path: new URL(request.url).pathname,
      body: (await request.json()) as Record<string, unknown>,
    });
    const next = script.shift() ?? {
      status: 400,
      body: { error: { message: "unexpected request" } },
    };
    return Response.json(next.body, { status: next.status });
  },
});
afterAll(() => server.stop(true));
const client = () =>
  new OpenAI({
    apiKey: "synthetic",
    baseURL: `http://127.0.0.1:${server.port}/v3/router`,
    maxRetries: 3,
  });
const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
const response = (wire: unknown) => ({
  status: 200,
  body: {
    id: "r",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    output: [
      {
        type: "message",
        id: "m",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: JSON.stringify(wire), annotations: [] },
        ],
      },
    ],
    usage,
  },
});
const dimension = {
  name: "Concern",
  task: {
    kind: "noul",
    instructions: "Does the conversation show concern?",
    choice_criteria: null,
    score_criteria: null,
    noul_threshold: 0.5,
  },
  selection: { kind: "values", values: [true] },
};
const numeric = {
  tokens_min: null,
  tokens_max: null,
  duration_ms_min: null,
  duration_ms_max: null,
};
const wire = {
  dimensions: [dimension],
  numeric,
  calendar_day: false,
  start: null,
  end: null,
  unsupported_reason: null,
};
const filters = {
  project: [],
  model: [],
  provider: [],
  status: [],
  product: [],
  trace_type: [],
  agent_name: [],
  tool_name: [],
  numeric,
  calendar_day: false,
  start: null,
  end: null,
};
let warn: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>;
beforeEach(() => {
  script = [];
  requests = [];
  resetCatalogueCache();
  clearModelOverrides();
  registerModel(
    model,
    new ModelInfo({
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      provider: "acme",
      supportsResponses: true,
      supportsClassify: true,
    }),
  );
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  clearModelOverrides();
});
test("compiler uses Responses strict wire format and preserves its complete input", async () => {
  script = [
    response({
      ...wire,
      numeric: { ...numeric, tokens_min: 100 },
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-02T00:00:00Z",
      calendar_day: true,
    }),
  ];
  const query = `concern over 0.1k tokens ${"λ".repeat(6000)}`,
    result = await compileQuery(client(), model, query, { now });
  expect(result.numeric.tokensMin).toBe(101);
  expect(result.dimensions).toHaveLength(1);
  expect(result.time?.calendarDay).toBe(true);
  expect(result.usages).toHaveLength(1);
  expect(result.usages[0]?.totalTokens).toBe(18);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/v3/router/responses");
  expect(requests[0]?.body.max_output_tokens).toBe(2000);
  const input = requests[0]?.body.input as { role: string; content: string }[];
  expect(input[0]?.content).toBe(COMPILER_INSTRUCTIONS);
  expect(input[1]?.content).toBe(
    `${query}\n\nCurrent UTC time: 2026-11-10T12:00:00+00:00`,
  );
  expect(JSON.stringify(result)).not.toContain('"usages"');
  const text = requests[0]?.body.text as {
    format: { schema: Record<string, unknown>; strict: boolean };
  };
  expect(text.format.strict).toBe(true);
  expect(text.format.schema).toMatchObject({ additionalProperties: false });
});
test("compiler corrects an invalid plan once and retains each billed usage", async () => {
  script = [
    response({
      ...wire,
      dimensions: [dimension, { ...dimension, name: "CONCERN" }],
    }),
    response(wire),
  ];
  const result = await compileQuery(client(), model, "concern", { now });
  expect(requests).toHaveLength(2);
  expect(result.usages).toHaveLength(2);
  expect(requests[1]?.body.input).toHaveLength(4);
  expect(JSON.stringify(requests[1]?.body.input)).toContain(
    "dimension names must be unique",
  );
});
test("compiler retries contradictory strict bounds and stops after two invalid plans", async () => {
  script = [
    response({
      ...wire,
      numeric: { ...numeric, tokens_min: 20, tokens_max: 20 },
    }),
    response({
      ...wire,
      numeric: { ...numeric, tokens_min: 20, tokens_max: 30 },
    }),
  ];
  const result = await compileQuery(client(), model, "over 20 tokens", { now });
  expect(result.numeric.tokensMin).toBe(21);
  expect(requests).toHaveLength(2);
  requests = [];
  script = [
    response({ ...wire, dimensions: Array(4).fill(dimension) }),
    response({ ...wire, dimensions: Array(4).fill(dimension) }),
  ];
  await expect(
    compileQuery(client(), model, "concern", { now }),
  ).rejects.toBeInstanceOf(CompileError);
  expect(requests).toHaveLength(2);
});
test("compiler refuses empty queries and naive reference times before requests", async () => {
  await expect(compileQuery(client(), model, " ", { now })).rejects.toThrow(
    "Enter a semantic",
  );
  await expect(
    compileQuery(client(), model, "query", { now: "2026-11-10T12:00:00" }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
  const plan = new CompiledPlan({
    dimensions: [],
    numeric: new NumericFilters(),
  });
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.dimensions)).toBe(true);
});
test("LLM filter selection uses exact catalogue enums, collision-safe sentinels and strict bounds", async () => {
  const catalogue = FacetCatalogueSchema.parse({
    model: ["none", "a"],
    provider: ["acme"],
  });
  script = [
    response({
      ...filters,
      model: ["a", "none_"],
      provider: ["acme"],
      numeric: { ...numeric, duration_ms_min: 30000 },
    }),
  ];
  const result = await selectLlmFiltersWithResponse(
    client(),
    model,
    catalogue,
    "acme slower than 30 seconds",
    { now },
  );
  expect([...result.selection.model]).toEqual([]);
  expect([...result.selection.provider]).toEqual(["acme"]);
  expect(result.numeric?.durationMsMin).toBe(30001);
  expect(result.usage?.totalTokens).toBe(18);
  expect(requests[0]?.body.max_output_tokens).toBe(1600);
  const text = requests[0]?.body.text as {
    format: { schema: { properties: Record<string, unknown> } };
  };
  expect(text.format.schema.properties.model).toMatchObject({
    items: { enum: ["none", "a", "none_"] },
  });
});
test("LLM selector retries an invalid numeric plan once and sums usage", async () => {
  script = [
    response({
      ...filters,
      numeric: { ...numeric, tokens_min: 10, tokens_max: 10 },
    }),
    response({
      ...filters,
      numeric: { ...numeric, tokens_min: 10, tokens_max: 20 },
    }),
  ];
  const result = await selectLlmFiltersWithResponse(
    client(),
    model,
    FacetCatalogueSchema.parse({}),
    "over 10 tokens",
    { now },
  );
  expect(result.numeric?.tokensMin).toBe(11);
  expect(result.usage?.totalTokens).toBe(36);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.body.input).toHaveLength(4);
  requests = [];
  script = [
    response({
      ...filters,
      numeric: { ...numeric, tokens_min: 10, tokens_max: 10 },
    }),
    response({
      ...filters,
      numeric: { ...numeric, tokens_min: 10, tokens_max: 10 },
    }),
  ];
  await expect(
    selectLlmFiltersWithResponse(
      client(),
      model,
      FacetCatalogueSchema.parse({}),
      "over 10 tokens",
      { now },
    ),
  ).rejects.toBeInstanceOf(FilterSelectionError);
  expect(requests).toHaveLength(2);
});
test("classify selector uses one request for explicit alternatives and keeps its response", async () => {
  script = [
    {
      status: 200,
      body: {
        answers: {
          model_0: { type: "noul", noul: 1 },
          model_1: { type: "noul", noul: 0 },
          status: { type: "choice", choice: "none" },
        },
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        model,
      },
    },
  ];
  const result = await selectFiltersWithResponse(
    client(),
    model,
    FacetCatalogueSchema.parse({ model: ["a", "b"], status: ["ok", "error"] }),
    "a or b tool errors",
  );
  expect([...result.selection.model]).toEqual(["a"]);
  expect([...result.selection.status]).toEqual([]);
  expect(result.response?.answers.model_0?.noul).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/v3/router/decisions");
  expect(requests[0]?.body.state).toMatchObject({
    query: "a or b tool errors",
  });
});
test("classify selector skips empty catalogues and rejects oversized question sets before requests", async () => {
  const empty = await selectFiltersWithResponse(
    client(),
    model,
    FacetCatalogueSchema.parse({}),
    "q",
  );
  expect(empty.response).toBeNull();
  const values = Array.from({ length: 101 }, (_, i) => `m${i}`);
  await expect(
    selectFiltersWithResponse(
      client(),
      model,
      FacetCatalogueSchema.parse({ model: values }),
      values.join(" or "),
    ),
  ).rejects.toThrow("maximum is 100");
  expect(requests).toHaveLength(0);
});
test("classify selector owns exactly one transport retry layer", async () => {
  script = [
    { status: 503, body: { error: { message: "synthetic unavailable" } } },
    {
      status: 200,
      body: {
        answers: { model: { type: "choice", choice: "a" } },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model,
      },
    },
  ];
  const result = await selectFiltersWithResponse(
    client(),
    model,
    FacetCatalogueSchema.parse({ model: ["a"] }),
    "a",
    { config: new LLMCallConfig({ model, retryCount: 1 }) },
  );
  expect([...result.selection.model]).toEqual(["a"]);
  expect(requests).toHaveLength(2);
});
test("compiler wire validation counts column-name Unicode code points", async () => {
  const name = "😀".repeat(30);
  script = [response({ ...wire, dimensions: [{ ...dimension, name }] })];
  const result = await compileQuery(client(), model, "semantic query", { now });
  expect(result.dimensions[0]?.name).toBe(name);
  expect(requests).toHaveLength(1);
});
