import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import OpenAI from "openai";

import { Orq } from "@orq-ai/node";

import {
  clearModelOverrides,
  ModelInfo,
  registerModel,
  resetCatalogueCache,
} from "../../../src/lib/common/model-catalogue.js";
import {
  FacetCatalogueSchema,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
} from "../../../src/lib/trace-finder/models.js";
import {
  offerConfirmedCandidates,
  planQuery,
} from "../../../src/lib/trace-finder/planner.js";

type Row = Record<string, unknown>;
let script: Row[] = [],
  requests: { path: string; body: Row }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json([]);
    const path = new URL(request.url).pathname,
      body = (await request.json()) as Row;
    requests.push({ path, body });
    const next = script.shift();
    if (!next)
      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 400 },
      );
    if (path.endsWith("/decisions"))
      return Response.json({
        answers: next,
        model: "test/jev",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    return Response.json({
      id: "r",
      object: "response",
      created_at: 1,
      model: "test/compiler",
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
            {
              type: "output_text",
              text: JSON.stringify(next),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  },
});
afterAll(() => server.stop(true));
let warning: ReturnType<typeof spyOn>,
  error: ReturnType<typeof spyOn>,
  info: ReturnType<typeof spyOn>;
beforeEach(() => {
  script = [];
  requests = [];
  clearModelOverrides();
  resetCatalogueCache();
  for (const [name, classify] of [
    ["test/compiler", false],
    ["test/fast", false],
    ["test/jev", true],
  ] as const)
    registerModel(
      name,
      new ModelInfo({
        provider: "test",
        supportsResponses: !classify,
        supportsClassify: classify,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
      }),
    );
  warning = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  warning.mockRestore();
  error.mockRestore();
  info.mockRestore();
  clearModelOverrides();
});
const client = () =>
    new OpenAI({
      apiKey: "synthetic",
      baseURL: `http://127.0.0.1:${server.port}/v3/router`,
      maxRetries: 0,
    }),
  orq = { _options: {}, _baseURL: null } as unknown as Orq,
  now = "2026-11-10T12:00:00Z",
  options = () => ({
    client: client(),
    orq,
    compilerModel: "test/compiler",
    classifierModel: "test/jev",
    fastFilterModel: "test/fast",
    now,
  });
const numeric = {
  tokens_min: null,
  tokens_max: null,
  duration_ms_min: null,
  duration_ms_max: null,
};
const dimension = {
  name: "Frustration",
  task: {
    kind: "noul",
    instructions: "Is the user frustrated?",
    choice_criteria: null,
    score_criteria: null,
    noul_threshold: 0.8,
  },
  selection: { kind: "values", values: [true] },
};
const compiled = {
  dimensions: [dimension],
  numeric: { ...numeric, tokens_min: 20 },
  calendar_day: true,
  start: "2026-11-01T00:00:00Z",
  end: "2026-11-02T00:00:00Z",
  unsupported_reason: null,
};
test("planner joins real compiler and classifier wire calls with scoped candidate confirmation", async () => {
  script = [
    compiled,
    {
      model: { type: "choice", choice: "none" },
      status: { type: "choice", choice: "error" },
    },
  ];
  const loads: Row[] = [],
    confirm: Row[] = [];
  const result = await planQuery(
    "failed traces for model ns/new with a frustrated user over 20 tokens",
    new PopulationRequest(),
    {
      ...options(),
      catalogueLoader: async (_orq, scope) => {
        loads.push(scope as unknown as Row);
        return FacetCatalogueSchema.parse({
          model: ["old"],
          status: ["ok", "error"],
        });
      },
      candidateConfirmer: async (_orq, name, value, start, end) => {
        confirm.push({ name, value, start, end });
        return name === "model" && value === "ns/new";
      },
    },
  );
  expect(requests.map((request) => request.path)).toEqual([
    "/v3/router/responses",
    "/v3/router/decisions",
  ]);
  expect(loads).toHaveLength(1);
  expect(loads[0]).toMatchObject({
    start: "2026-11-01T00:00:00Z",
    end: "2026-11-02T00:00:00Z",
    limit: 50,
  });
  expect(confirm).toHaveLength(1);
  expect([...result.generatedFacets.model]).toEqual(["ns/new"]);
  expect([...result.effectivePopulation.facets.status]).toEqual(["error"]);
  expect(result.effectivePopulation.numeric.tokensMin).toBe(21);
  expect(result.effectivePopulation.endExclusive).toBe(true);
  expect(result.dimensions[0]?.task.noulThreshold).toBe(0.8);
  expect(result.modelCalls).toHaveLength(2);
  expect(result.provenance).toMatchObject({
    filter_mode: "llm+jev",
    facets: "jev",
    numeric: "compiler",
    time: "query",
  });
});
test("LLM selector reloads the generated window and uses its new catalogue vocabulary", async () => {
  const empty = {
      dimensions: [],
      numeric,
      calendar_day: false,
      start: null,
      end: null,
      unsupported_reason: null,
    },
    filters = {
      project: [],
      model: [],
      provider: [],
      status: ["error"],
      product: [],
      trace_type: [],
      agent_name: [],
      tool_name: [],
      numeric,
      calendar_day: true,
      start: "2026-11-01T00:00:00Z",
      end: "2026-11-02T00:00:00Z",
    };
  script = [empty, filters, filters];
  let loads = 0;
  const result = await planQuery(
    "failed traces yesterday",
    new PopulationRequest(),
    {
      ...options(),
      filterSelection: "llm",
      catalogueLoader: async () =>
        FacetCatalogueSchema.parse({
          status: loads++ === 0 ? ["error"] : ["ok", "error"],
        }),
      candidateConfirmer: async () => false,
    },
  );
  expect(loads).toBe(2);
  expect(requests).toHaveLength(3);
  expect(
    requests.every((request) => request.path === "/v3/router/responses"),
  ).toBe(true);
  expect([...result.effectivePopulation.facets.status]).toEqual(["error"]);
  expect(result.modelCalls).toHaveLength(3);
  expect(result.emptyMatch).toBe(false);
  const first = requests[1]?.body.text as {
      format: {
        schema: { properties: { status: { items: { enum: string[] } } } };
      };
    },
    second = requests[2]?.body.text as typeof first;
  expect(first.format.schema.properties.status.items.enum).toEqual([
    "error",
    "none",
  ]);
  expect(second.format.schema.properties.status.items.enum).toEqual([
    "ok",
    "error",
    "none",
  ]);
});
test("cancellation during catalogue loading is propagated rather than degraded", async () => {
  script = [compiled];
  const controller = new AbortController(),
    reason = new Error("cancel catalogue");
  const result = planQuery("query", new PopulationRequest(), {
    ...options(),
    signal: controller.signal,
    catalogueLoader: async (_orq, scope) => {
      controller.abort(reason);
      scope.signal?.throwIfAborted();
      return FacetCatalogueSchema.parse({});
    },
  }).then(
    () => null,
    (error) => error,
  );
  expect(await result).toBe(reason);
  expect(requests).toHaveLength(1);
});
test("cancellation aborts an active provider request before planner fallbacks", async () => {
  let active = 0,
    notify: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      notify = resolve;
    }),
    controller = new AbortController(),
    reason = new Error("cancel compiler");
  const synthetic = new OpenAI({
    apiKey: "synthetic",
    baseURL: "http://synthetic.invalid/v3/router",
    maxRetries: 0,
    fetch: async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing signal");
      active++;
      notify();
      return new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            active--;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    },
  });
  const pending = planQuery("query", new PopulationRequest(), {
    ...options(),
    client: synthetic,
    signal: controller.signal,
    catalogueLoader: async () => {
      throw new Error("must not load catalogue");
    },
  }).then(
    () => null,
    (error) => error,
  );
  await ready;
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(active).toBe(0);
});
test("candidate confirmation sends exact scoped OQL through the real Orq SDK", async () => {
  const seen: Row[] = [],
    stamp = "2026-11-10T10:00:00Z";
  const backend = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v2/projects")
        return Response.json({
          object: "list",
          data: [
            {
              project_id: "p",
              name: "Project",
              key: "project",
              is_archived: false,
              is_default: true,
              teams: [],
              created_at: stamp,
              updated_at: stamp,
            },
          ],
          has_more: false,
        });
      if (path === "/v3/traces/query") {
        const body = (await request.json()) as Row;
        seen.push(body);
        const found = String(body.oql).includes('"new-model"');
        return Response.json({
          object: "query",
          search: {
            object: "list",
            data: found
              ? [
                  {
                    object: "trace",
                    trace_id: "t",
                    leading_span_id: "root",
                    project_id: "p",
                    status: "ok",
                    product: "agents",
                    type: "span.agent",
                    models: ["new-model"],
                    providers: ["provider"],
                    started_at: stamp,
                    ended_at: stamp,
                    agent: { name: "agent" },
                  },
                ]
              : [],
            has_more: false,
          },
        });
      }
      return Response.json({ error: "unexpected path" }, { status: 404 });
    },
  });
  try {
    const actual = new Orq({
        apiKey: "synthetic",
        serverURL: `http://127.0.0.1:${backend.port}`,
      }),
      catalogue = FacetCatalogueSchema.parse({ model: ["old"] });
    const result = await offerConfirmedCandidates(
      actual,
      catalogue,
      [
        ["model", "new-model"],
        ["provider", "unknown"],
      ],
      {
        start: "2026-11-01T00:00:00Z",
        end: "2026-11-10T00:00:00Z",
        facets: new FacetSelection({ projectId: "p", status: ["ok"] }),
        numeric: new NumericFilters({ tokensMin: 50 }),
      },
    );
    expect(result.model).toEqual(["old", "new-model"]);
    expect(result.provider).toEqual([]);
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.limit).toBe(1);
      expect(String(request.oql)).toContain('project_id in ("p")');
      expect(String(request.oql)).toContain('status in ("ok")');
      expect(String(request.oql)).toContain("total_tokens >= 50");
    }
    expect(String(seen[0]?.oql)).toContain('model in ("new-model")');
    expect(String(seen[1]?.oql)).toContain('provider in ("unknown")');
  } finally {
    backend.stop(true);
  }
});

test("Insights query refuses to broaden when the facet catalogue fails", async () => {
  const { InsightsPopulation } = await import(
    "../../../src/lib/insights/models.js"
  );
  const { resolveQueryPopulation } = await import(
    "../../../src/lib/insights/population.js"
  );
  const { UsageLedger } = await import("../../../src/lib/insights/usage.js");
  script = [compiled];
  const usage = new UsageLedger();
  const result = await resolveQueryPopulation(
    new InsightsPopulation({ query: "failed traces" }),
    {
      ...options(),
      now: new Date(now),
      usage,
    },
  );
  expect(result.echo.mode).toBe("query");
  expect(result.echo.empty_match).toBe(true);
  expect(typeof result.echo.filter_selection_error).toBe("string");
  expect(result.traces).toEqual([]);
  expect(result.compiled?.[0]?.name).toBe("Frustration");
  expect(usage.totals().population?.calls).toBe(1);
  expect(requests).toHaveLength(1);
});
